use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use filex_contracts::{
    AppError, McpServerStatus, OperationResult, ProcessSortBy, RemoteState, SessionSummary,
};
use filex_local_terminal::LocalTerminalRuntime;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::Mutex as AsyncMutex,
};
use tokio_util::sync::CancellationToken;

use crate::{
    assistant_exec::{
        ASSISTANT_EXEC_MAX_OUTPUT_BYTES, ASSISTANT_EXEC_TIMEOUT_SECONDS,
        AssistantCommandExecutionResult, AssistantCommandRisk, classify_assistant_command,
        references_sensitive_target,
    },
    session_runtime::SessionRuntime,
};

const MAX_RING_BYTES_PER_SESSION: usize = 256 * 1024;
const MAX_TRACKED_SESSIONS: usize = 64;
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const HTTP_IO_TIMEOUT: Duration = Duration::from_secs(15);
const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const DEFAULT_MCP_PORT: u16 = 19_375;

#[derive(Default)]
pub struct TerminalOutputRing {
    buffers: Mutex<HashMap<String, VecDeque<u8>>>,
}

impl TerminalOutputRing {
    pub fn append(&self, session_id: &str, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let Ok(mut buffers) = self.buffers.lock() else {
            return;
        };
        if !buffers.contains_key(session_id) && buffers.len() >= MAX_TRACKED_SESSIONS {
            if let Some(evict_key) = buffers.keys().next().cloned() {
                buffers.remove(&evict_key);
            }
        }
        let ring = buffers
            .entry(session_id.to_owned())
            .or_insert_with(|| VecDeque::with_capacity(8192));
        if data.len() >= MAX_RING_BYTES_PER_SESSION {
            ring.clear();
            let start = data.len() - MAX_RING_BYTES_PER_SESSION;
            ring.extend(&data[start..]);
            return;
        }
        let overflow = ring
            .len()
            .saturating_add(data.len())
            .saturating_sub(MAX_RING_BYTES_PER_SESSION);
        if overflow > 0 {
            ring.drain(..overflow.min(ring.len()));
        }
        ring.extend(data);
    }

    pub fn remove(&self, session_id: &str) {
        if let Ok(mut buffers) = self.buffers.lock() {
            buffers.remove(session_id);
        }
    }

    pub fn read_tail(&self, session_id: &str, max_lines: usize, strip_ansi: bool) -> String {
        let bytes = {
            let Ok(buffers) = self.buffers.lock() else {
                return String::new();
            };
            let Some(ring) = buffers.get(session_id) else {
                return String::new();
            };
            ring.iter().copied().collect::<Vec<u8>>()
        };
        let raw = String::from_utf8_lossy(&bytes);
        let cleaned = if strip_ansi {
            strip_ansi_sequences(&raw)
        } else {
            raw.into_owned()
        };
        let redacted = redact_terminal_secrets(&cleaned);
        let lines = redacted.lines().collect::<Vec<_>>();
        let clamped_lines = max_lines.clamp(1, 2_000);
        let start = lines.len().saturating_sub(clamped_lines);
        lines[start..].join("\n")
    }
}

pub fn strip_ansi_sequences(input: &str) -> String {
    // Strip CSI, OSC, and simple 2-byte ESC sequences.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\x07' {
                            break;
                        }
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if ch == '\r' {
            continue;
        }
        out.push(ch);
    }
    out
}

pub fn redact_terminal_secrets(input: &str) -> String {
    let mut text = input.to_owned();
    let patterns = [
        (
            r"(?i)(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}",
            "${1}[REDACTED]",
        ),
        (
            r"(?i)(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*)([^\s'\x22,;]{4,})",
            "${1}[REDACTED]",
        ),
        (
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            "[REDACTED PRIVATE KEY]",
        ),
    ];
    for (pattern, replacement) in patterns {
        if let Ok(re) = Regex::new(pattern) {
            text = re.replace_all(&text, replacement).into_owned();
        }
    }
    text
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpRuntimeDiscovery {
    endpoint_url: String,
    auth_token: String,
    pid: u32,
}

struct McpRunningServer {
    port: u16,
    cancellation: CancellationToken,
    handle: tauri::async_runtime::JoinHandle<()>,
}

struct McpStateInner {
    enabled: bool,
    port: u16,
    auth_token: String,
    error: Option<String>,
    server: Option<McpRunningServer>,
}

pub struct McpDiagnosticsRuntime {
    data_directory: PathBuf,
    inner: AsyncMutex<McpStateInner>,
}

impl McpDiagnosticsRuntime {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            inner: AsyncMutex::new(McpStateInner {
                enabled: false,
                port: DEFAULT_MCP_PORT,
                auth_token: generate_auth_token(),
                error: None,
                server: None,
            }),
        }
    }

    pub async fn sync_config(&self, app: AppHandle, enabled: bool, port: u16) -> McpServerStatus {
        let mut inner = self.inner.lock().await;
        let already_matching =
            inner.enabled == enabled && inner.port == port && (!enabled || inner.server.is_some());
        if already_matching {
            return build_status(&inner);
        }

        if let Some(running) = inner.server.take() {
            running.cancellation.cancel();
            running.handle.abort();
        }
        remove_discovery_file(&self.data_directory);
        inner.enabled = enabled;
        inner.port = port;
        inner.error = None;

        if !enabled {
            return build_status(&inner);
        }

        let bind_addr = format!("127.0.0.1:{port}");
        match TcpListener::bind(&bind_addr).await {
            Ok(listener) => {
                let cancellation = CancellationToken::new();
                let token = inner.auth_token.clone();
                let endpoint_url = format!("http://{bind_addr}/mcp");
                let _ = write_discovery_file(
                    &self.data_directory,
                    &McpRuntimeDiscovery {
                        endpoint_url,
                        auth_token: token.clone(),
                        pid: std::process::id(),
                    },
                );
                let task_cancel = cancellation.clone();
                let handle = tauri::async_runtime::spawn(async move {
                    serve_mcp_loopback(listener, app, token, task_cancel).await;
                });
                inner.server = Some(McpRunningServer {
                    port,
                    cancellation,
                    handle,
                });
            }
            Err(err) => {
                inner.error = Some(format!("Failed to bind {bind_addr}: {err}"));
            }
        }
        build_status(&inner)
    }

    pub async fn regenerate_token(&self, app: AppHandle) -> McpServerStatus {
        let (enabled, port) = {
            let mut inner = self.inner.lock().await;
            inner.auth_token = generate_auth_token();
            if let Some(running) = inner.server.take() {
                running.cancellation.cancel();
                running.handle.abort();
            }
            (inner.enabled, inner.port)
        };
        self.sync_config(app, enabled, port).await
    }

    pub async fn status(&self) -> McpServerStatus {
        let inner = self.inner.lock().await;
        build_status(&inner)
    }

    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(running) = inner.server.take() {
            running.cancellation.cancel();
            running.handle.abort();
        }
        remove_discovery_file(&self.data_directory);
    }
}

fn generate_auth_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn build_status(inner: &McpStateInner) -> McpServerStatus {
    let port = inner.server.as_ref().map(|s| s.port).unwrap_or(inner.port);
    let bind_address = format!("127.0.0.1:{port}");
    let endpoint_url = format!("http://{bind_address}/mcp");
    let exe_display = std::env::current_exe()
        .ok()
        .map(|path| crate::normalize_local_display_path(&path))
        .unwrap_or_else(|| "filex".to_owned());
    McpServerStatus {
        enabled: inner.enabled,
        running: inner.server.is_some(),
        bind_address,
        endpoint_url,
        auth_token: inner.enabled.then(|| inner.auth_token.clone()),
        cli_command: format!("\"{exe_display}\" --mcp"),
        error: inner.error.clone(),
    }
}

fn discovery_file_path(data_directory: &Path) -> PathBuf {
    data_directory.join("mcp-runtime.json")
}

fn write_discovery_file(data_directory: &Path, info: &McpRuntimeDiscovery) -> std::io::Result<()> {
    std::fs::create_dir_all(data_directory)?;
    let path = discovery_file_path(data_directory);
    let temp = data_directory.join(format!(
        ".mcp-runtime-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let payload =
        serde_json::to_vec_pretty(info).map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(&temp, payload)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, &path)?;
    Ok(())
}

fn remove_discovery_file(data_directory: &Path) {
    let _ = std::fs::remove_file(discovery_file_path(data_directory));
}

pub fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    if left_bytes.len() != right_bytes.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left_bytes.iter().zip(right_bytes.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

async fn serve_mcp_loopback(
    listener: TcpListener,
    app: AppHandle,
    auth_token: String,
    cancellation: CancellationToken,
) {
    let token = Arc::new(auth_token);
    loop {
        tokio::select! {
            () = cancellation.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else {
                    break;
                };
                let conn_app = app.clone();
                let conn_token = token.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_http_connection(stream, &conn_app, &conn_token).await;
                });
            }
        }
    }
}

struct ParsedHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<ParsedHttpRequest, u16> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    let read_line = tokio::time::timeout(HTTP_IO_TIMEOUT, reader.read_line(&mut request_line))
        .await
        .map_err(|_| 408_u16)?
        .map_err(|_| 400_u16)?;
    if read_line == 0 {
        return Err(400);
    }
    let mut parts = request_line
        .trim_end_matches(&['\r', '\n'][..])
        .split_whitespace();
    let method = parts.next().ok_or(400_u16)?.to_owned();
    let path = parts.next().ok_or(400_u16)?.to_owned();

    let mut headers = HashMap::new();
    let mut header_bytes = read_line;
    loop {
        let mut line = String::new();
        let n = tokio::time::timeout(HTTP_IO_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| 408_u16)?
            .map_err(|_| 400_u16)?;
        header_bytes += n;
        if header_bytes > MAX_HTTP_HEADER_BYTES {
            return Err(431);
        }
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err(413);
    }
    let mut body = vec![0_u8; content_length];
    if content_length > 0 {
        tokio::time::timeout(HTTP_IO_TIMEOUT, reader.read_exact(&mut body))
            .await
            .map_err(|_| 408_u16)?
            .map_err(|_| 400_u16)?;
    }

    Ok(ParsedHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: Option<&[u8]>,
) -> std::io::Result<()> {
    let payload = body.unwrap_or(&[]);
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if !payload.is_empty() {
        stream.write_all(payload).await?;
    }
    stream.flush().await
}

async fn handle_http_connection(
    mut stream: TcpStream,
    app: &AppHandle,
    expected_token: &str,
) -> std::io::Result<()> {
    let request = match read_http_request(&mut stream).await {
        Ok(req) => req,
        Err(status) => {
            let body =
                serde_json::to_vec(&json!({ "error": "invalid_request" })).unwrap_or_default();
            return write_http_response(&mut stream, status, "Bad Request", Some(&body)).await;
        }
    };

    if request.method == "GET" && request.path == "/health" {
        let body = serde_json::to_vec(&json!({
            "status": "ok",
            "service": "filex-terminal-diagnostics",
            "version": env!("CARGO_PKG_VERSION"),
        }))
        .unwrap_or_default();
        return write_http_response(&mut stream, 200, "OK", Some(&body)).await;
    }

    let provided_token = request
        .headers
        .get("authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
        .unwrap_or("");
    if !constant_time_eq(provided_token, expected_token) {
        let body = serde_json::to_vec(&json!({ "error": "unauthorized" })).unwrap_or_default();
        return write_http_response(&mut stream, 401, "Unauthorized", Some(&body)).await;
    }

    if request.method != "POST" || (request.path != "/mcp" && request.path != "/") {
        let body = serde_json::to_vec(&json!({ "error": "not_found" })).unwrap_or_default();
        return write_http_response(&mut stream, 404, "Not Found", Some(&body)).await;
    }

    let rpc_request: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(_) => {
            let err = jsonrpc_error(Value::Null, -32700, "Parse error");
            let body = serde_json::to_vec(&err).unwrap_or_default();
            return write_http_response(&mut stream, 200, "OK", Some(&body)).await;
        }
    };

    match dispatch_jsonrpc_with_app(app, rpc_request).await {
        Some(response) => {
            let body = serde_json::to_vec(&response).unwrap_or_default();
            write_http_response(&mut stream, 200, "OK", Some(&body)).await
        }
        None => write_http_response(&mut stream, 202, "Accepted", None).await,
    }
}

pub fn mcp_tools_schema() -> Value {
    json!({
        "tools": [
            {
                "name": "list_terminal_sessions",
                "description": "List all active and open SSH and local terminal sessions in FILEX (non-sensitive metadata only).",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            },
            {
                "name": "read_terminal_output",
                "description": "Read recent terminal output lines from a FILEX terminal session buffer for diagnosis. Sensitive tokens are redacted.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string", "description": "Target session ID. Omit to use the first connected session." },
                        "maxLines": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 200 },
                        "stripAnsi": { "type": "boolean", "default": true }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_session_diagnostics",
                "description": "Collect bounded host health metrics (CPU, memory, disk, load, uptime, OS, network I/O) from a connected SSH session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string", "description": "Target connected SSH session ID." }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            {
                "name": "list_session_processes",
                "description": "Inspect running processes (PID, user, CPU, memory, command) on a connected SSH session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string", "description": "Target connected SSH session ID." }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            {
                "name": "get_session_network",
                "description": "Inspect network interfaces, addresses, and listening sockets on a connected SSH session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string", "description": "Target connected SSH session ID." }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            {
                "name": "run_diagnostic_command",
                "description": "Execute a strictly read-only diagnostic shell command (e.g. uname, df, free, ps, ss, systemctl status, journalctl -n, tail) on a connected SSH session. Mutating, chained, or sensitive commands are rejected.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string", "description": "Target connected SSH session ID." },
                        "command": { "type": "string", "description": "Read-only diagnostic command to run." }
                    },
                    "required": ["sessionId", "command"],
                    "additionalProperties": false
                }
            },
            {
                "name": "list_remote_files",
                "description": "List files and directories at a remote path over SFTP for a connected SSH session (read-only).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string" },
                        "path": { "type": "string", "default": "." }
                    },
                    "required": ["sessionId"],
                    "additionalProperties": false
                }
            },
            {
                "name": "read_remote_file",
                "description": "Read a bounded text preview of a remote log or configuration file over SFTP. Sensitive credential files are blocked.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sessionId": { "type": "string" },
                        "path": { "type": "string" }
                    },
                    "required": ["sessionId", "path"],
                    "additionalProperties": false
                }
            }
        ]
    })
}

pub fn handle_protocol_method(method: &str, id: Value, params: &Value) -> Option<Value> {
    match method {
        "initialize" => {
            let client_version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION);
            let negotiated = match client_version {
                "2024-11-05" | "2025-03-26" => client_version,
                _ => MCP_PROTOCOL_VERSION,
            };
            Some(jsonrpc_ok(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": { "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "filex-terminal-diagnostics",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            ))
        }
        "notifications/initialized" => None,
        "ping" => Some(jsonrpc_ok(id, json!({}))),
        "tools/list" => Some(jsonrpc_ok(id, mcp_tools_schema())),
        _ => None,
    }
}

async fn dispatch_jsonrpc_with_app(app: &AppHandle, request: Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let is_notification = request.get("id").is_none() || method.starts_with("notifications/");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "notifications/initialized" || is_notification && method != "tools/call" {
        return None;
    }

    if let Some(response) = handle_protocol_method(method, id.clone(), &params) {
        return Some(response);
    }

    if method != "tools/call" {
        return Some(jsonrpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        ));
    }

    let tool_name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let result = call_mcp_tool(app, tool_name, &args).await;
    Some(jsonrpc_ok(id, result))
}

fn tool_text_ok(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

fn tool_json_ok(value: &impl Serialize) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned());
    tool_text_ok(text)
}

fn tool_error(message: impl Into<String>) -> Value {
    json!({
        "content": [{ "type": "text", "text": message.into() }],
        "isError": true
    })
}

fn collect_all_sessions(app: &AppHandle) -> Result<Vec<SessionSummary>, String> {
    let ssh = app
        .state::<SessionRuntime>()
        .list()
        .map_err(|err| format!("Failed to list SSH sessions: {}", err.code))?;
    let local = app
        .state::<LocalTerminalRuntime>()
        .list()
        .map_err(|err| format!("Failed to list local terminal sessions: {}", err.code))?;
    let mut all = ssh;
    all.extend(local);
    Ok(all)
}

async fn call_mcp_tool(app: &AppHandle, tool_name: &str, args: &Value) -> Value {
    match tool_name {
        "list_terminal_sessions" => match collect_all_sessions(app) {
            Ok(sessions) => tool_json_ok(&json!({ "sessions": sessions })),
            Err(message) => tool_error(message),
        },
        "read_terminal_output" => {
            let max_lines = args
                .get("maxLines")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or(200);
            let strip_ansi = args
                .get("stripAnsi")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(id) if !id.trim().is_empty() => id.trim().to_owned(),
                _ => match collect_all_sessions(app) {
                    Ok(sessions) => match sessions
                        .iter()
                        .find(|s| s.state == filex_contracts::SessionState::Connected)
                        .or_else(|| sessions.first())
                    {
                        Some(s) => s.id.clone(),
                        None => return tool_error("No active terminal sessions found."),
                    },
                    Err(message) => return tool_error(message),
                },
            };
            let output =
                app.state::<TerminalOutputRing>()
                    .read_tail(&session_id, max_lines, strip_ansi);
            tool_json_ok(&json!({
                "sessionId": session_id,
                "output": output,
            }))
        }
        "get_session_diagnostics" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            match app
                .state::<SessionRuntime>()
                .collect_monitor(session_id)
                .await
            {
                Ok(snapshot) => tool_json_ok(&snapshot),
                Err(err) => tool_error(format!("Diagnostics failed: {}", err.code)),
            }
        }
        "list_session_processes" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            match app
                .state::<SessionRuntime>()
                .collect_process_snapshot(session_id, ProcessSortBy::Cpu)
                .await
            {
                Ok(snapshot) => tool_json_ok(&snapshot),
                Err(err) => tool_error(format!("Process inspection failed: {}", err.code)),
            }
        }
        "get_session_network" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            match app
                .state::<SessionRuntime>()
                .collect_network_snapshot(session_id)
                .await
            {
                Ok(snapshot) => tool_json_ok(&snapshot),
                Err(err) => tool_error(format!("Network inspection failed: {}", err.code)),
            }
        }
        "run_diagnostic_command" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            let Some(command) = args.get("command").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: command");
            };
            if let Err(reason) = validate_mcp_diagnostic_command(command) {
                return tool_error(reason);
            }
            let sessions = app.state::<SessionRuntime>();
            let summary = match sessions.summary(session_id) {
                Ok(summary) => summary,
                Err(err) => return tool_error(format!("Session unavailable: {}", err.code)),
            };
            match sessions
                .execute_assistant_command(
                    session_id,
                    summary.generation,
                    command,
                    ASSISTANT_EXEC_MAX_OUTPUT_BYTES,
                    Duration::from_secs(ASSISTANT_EXEC_TIMEOUT_SECONDS),
                )
                .await
            {
                Ok((exit_code, stdout, stderr, truncated, duration_ms)) => {
                    let result = AssistantCommandExecutionResult {
                        command: command.to_owned(),
                        risk: AssistantCommandRisk::ReadOnly,
                        exit_code,
                        stdout: redact_terminal_secrets(&stdout),
                        stderr: redact_terminal_secrets(&stderr),
                        truncated,
                        duration_ms,
                    };
                    tool_json_ok(&result)
                }
                Err(err) => tool_error(format!("Command execution failed: {}", err.code)),
            }
        }
        "list_remote_files" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
            match app
                .state::<SessionRuntime>()
                .list_remote_directory(session_id, path)
                .await
            {
                Ok(listing) => tool_json_ok(&listing),
                Err(err) => tool_error(format!("Directory listing failed: {}", err.code)),
            }
        }
        "read_remote_file" => {
            let Some(session_id) = args.get("sessionId").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: sessionId");
            };
            let Some(path) = args.get("path").and_then(Value::as_str) else {
                return tool_error("Missing required parameter: path");
            };
            if let Err(reason) = validate_mcp_read_path(path) {
                return tool_error(reason);
            }
            match app
                .state::<SessionRuntime>()
                .preview_remote_text(session_id, path, Some("utf-8"))
                .await
            {
                Ok(mut preview) => {
                    preview.content = redact_terminal_secrets(&preview.content);
                    tool_json_ok(&preview)
                }
                Err(err) => tool_error(format!("Remote file read failed: {}", err.code)),
            }
        }
        other => tool_error(format!("Unknown MCP tool: {other}")),
    }
}

pub fn validate_mcp_diagnostic_command(command: &str) -> Result<(), String> {
    match classify_assistant_command(command) {
        AssistantCommandRisk::ReadOnly => Ok(()),
        AssistantCommandRisk::RequiresConfirmation => Err(
            "Rejected by FILEX MCP security policy: only strictly read-only diagnostic commands are permitted."
                .to_owned(),
        ),
        AssistantCommandRisk::Destructive | AssistantCommandRisk::Blocked => Err(
            "Rejected by FILEX MCP security policy: command is blocked or destructive.".to_owned(),
        ),
    }
}

pub fn validate_mcp_read_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 4_096 || trimmed.contains('\0') {
        return Err("Invalid remote file path.".to_owned());
    }
    if references_sensitive_target(trimmed) {
        return Err(
            "Rejected by FILEX MCP security policy: sensitive file paths cannot be read via MCP."
                .to_owned(),
        );
    }
    Ok(())
}

fn jsonrpc_ok(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    })
}

#[tauri::command]
pub async fn get_mcp_server_status(
    mcp: State<'_, McpDiagnosticsRuntime>,
) -> Result<OperationResult<McpServerStatus>, ()> {
    Ok(OperationResult::success(mcp.status().await))
}

#[tauri::command]
pub async fn regenerate_mcp_token(
    app: AppHandle,
    mcp: State<'_, McpDiagnosticsRuntime>,
) -> Result<OperationResult<McpServerStatus>, ()> {
    Ok(OperationResult::success(mcp.regenerate_token(app).await))
}

/// Runs FILEX in stdio MCP bridge mode (`filex --mcp`), forwarding JSON-RPC 2.0
/// requests from stdin to the running FILEX desktop app's loopback HTTP MCP server.
pub fn run_mcp_stdio_bridge(args: &[String]) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("FILEX MCP bridge failed to initialize runtime: {err}");
            return 1;
        }
    };
    runtime.block_on(run_mcp_stdio_bridge_async(args))
}

fn resolve_bridge_target(args: &[String]) -> Option<(String, String)> {
    let mut cli_url = None;
    let mut cli_token = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--mcp-url" if index + 1 < args.len() => {
                cli_url = Some(args[index + 1].clone());
                index += 2;
            }
            "--mcp-token" if index + 1 < args.len() => {
                cli_token = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }
    let url = cli_url.or_else(|| std::env::var("FILEX_MCP_URL").ok());
    let token = cli_token.or_else(|| std::env::var("FILEX_MCP_TOKEN").ok());
    if let (Some(url), Some(token)) = (url, token) {
        return Some((url, token));
    }

    for candidate_dir in candidate_discovery_dirs() {
        let path = discovery_file_path(&candidate_dir);
        if let Ok(bytes) = std::fs::read(&path)
            && let Ok(discovery) = serde_json::from_slice::<McpRuntimeDiscovery>(&bytes)
        {
            return Some((discovery.endpoint_url, discovery.auth_token));
        }
    }
    None
}

fn candidate_discovery_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(&appdata).join("com.filex.desktop"));
        dirs.push(PathBuf::from(&appdata).join("FILEX"));
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        let support = PathBuf::from(home)
            .join("Library")
            .join("Application Support");
        dirs.push(support.join("com.filex.desktop"));
        dirs.push(support.join("FILEX"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(&xdg).join("com.filex.desktop"));
        dirs.push(PathBuf::from(&xdg).join("FILEX"));
    } else if let Ok(home) = std::env::var("HOME") {
        let share = PathBuf::from(home).join(".local").join("share");
        dirs.push(share.join("com.filex.desktop"));
        dirs.push(share.join("FILEX"));
    }
    dirs
}

async fn run_mcp_stdio_bridge_async(args: &[String]) -> i32 {
    use std::io::{BufRead, Write};

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(_) => return 1,
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                let err = jsonrpc_error(Value::Null, -32700, "Parse error");
                let _ = writeln!(stdout, "{err}");
                let _ = stdout.flush();
                continue;
            }
        };
        let id = parsed.get("id").cloned().unwrap_or(Value::Null);
        let method = parsed.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "notifications/initialized" || parsed.get("id").is_none() {
            continue;
        }
        if let Some(local_response) = handle_protocol_method(
            method,
            id.clone(),
            parsed.get("params").unwrap_or(&json!({})),
        ) {
            let _ = writeln!(stdout, "{local_response}");
            let _ = stdout.flush();
            continue;
        }

        let Some((url, token)) = resolve_bridge_target(args) else {
            let err = jsonrpc_error(
                id,
                -32001,
                "FILEX MCP diagnostics server is not running. Open FILEX Settings -> MCP Diagnostics and enable it.",
            );
            let _ = writeln!(stdout, "{err}");
            let _ = stdout.flush();
            continue;
        };

        let response = client
            .post(&url)
            .bearer_auth(&token)
            .json(&parsed)
            .send()
            .await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await
                    && !text.trim().is_empty()
                {
                    let _ = writeln!(stdout, "{}", text.trim());
                    let _ = stdout.flush();
                }
            }
            Ok(resp) => {
                let err = jsonrpc_error(
                    id,
                    -32002,
                    &format!("FILEX MCP server returned HTTP {}", resp.status().as_u16()),
                );
                let _ = writeln!(stdout, "{err}");
                let _ = stdout.flush();
            }
            Err(err) => {
                let rpc_err = jsonrpc_error(
                    id,
                    -32003,
                    &format!("Failed to reach FILEX MCP server at {url}: {err}"),
                );
                let _ = writeln!(stdout, "{rpc_err}");
                let _ = stdout.flush();
            }
        }
    }
    0
}

#[allow(dead_code)]
pub fn mcp_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_ring_strips_ansi_redacts_secrets_and_bounds_size() {
        let ring = TerminalOutputRing::default();
        ring.append(
            "sess-1",
            b"\x1b[32mINFO\x1b[0m server started\r\nAuthorization: Bearer supersecretvalue123\r\npassword=my_secret_pwd\r\n",
        );
        let output = ring.read_tail("sess-1", 50, true);
        assert!(output.contains("INFO server started"));
        assert!(!output.contains("supersecretvalue123"));
        assert!(!output.contains("my_secret_pwd"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn terminal_output_ring_respects_max_capacity() {
        let ring = TerminalOutputRing::default();
        let big = vec![b'a'; MAX_RING_BYTES_PER_SESSION + 4096];
        ring.append("sess-big", &big);
        let tail = ring.read_tail("sess-big", 10, false);
        assert_eq!(tail.len(), MAX_RING_BYTES_PER_SESSION);
    }

    #[test]
    fn mcp_policy_allows_readonly_and_blocks_mutating_or_sensitive_commands() {
        assert!(validate_mcp_diagnostic_command("uname -a").is_ok());
        assert!(validate_mcp_diagnostic_command("df -h").is_ok());
        assert!(validate_mcp_diagnostic_command("ps aux | head -n 20").is_ok());
        assert!(validate_mcp_diagnostic_command("rm -rf /tmp/foo").is_err());
        assert!(validate_mcp_diagnostic_command("uname -a && id").is_err());
        assert!(validate_mcp_diagnostic_command("cat /etc/shadow").is_err());
        assert!(validate_mcp_read_path("/var/log/nginx/error.log").is_ok());
        assert!(validate_mcp_read_path("/etc/shadow").is_err());
        assert!(validate_mcp_read_path("/home/dev/.ssh/id_ed25519").is_err());
    }

    #[test]
    fn mcp_protocol_handles_initialize_ping_and_tools_list() {
        let init = handle_protocol_method(
            "initialize",
            json!(1),
            &json!({ "protocolVersion": "2025-03-26" }),
        )
        .expect("initialize response");
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(
            init["result"]["serverInfo"]["name"],
            "filex-terminal-diagnostics"
        );

        let tools = handle_protocol_method("tools/list", json!(2), &json!({}))
            .expect("tools/list response");
        let list = tools["result"]["tools"].as_array().expect("tools array");
        assert_eq!(list.len(), 8);
        assert!(
            list.iter()
                .any(|item| item["name"] == "read_terminal_output")
        );
        assert!(
            list.iter()
                .any(|item| item["name"] == "run_diagnostic_command")
        );
    }

    #[test]
    fn constant_time_token_comparison_matches_exact_bytes() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc123", "abc12"));
    }
}
