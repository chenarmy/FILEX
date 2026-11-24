use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use filex_contracts::{
    AppError, CapabilityKind, LocalShellKind, LocalShellOption, OpenLocalTerminalInput,
    RemoteState, SessionKind, SessionState, SessionSummary, capabilities_for_local,
};
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

pub const DEFAULT_COLUMNS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 32;
pub const MIN_COLUMNS: u16 = 20;
pub const MAX_COLUMNS: u16 = 500;
pub const MIN_ROWS: u16 = 5;
pub const MAX_ROWS: u16 = 200;

#[derive(Debug, Clone)]
pub enum LocalTerminalOutputEvent {
    Data(Vec<u8>),
    Exit(i32),
    Closed,
}

#[derive(Debug, Clone)]
pub struct LocalTerminalOpened {
    pub summary: SessionSummary,
    pub shell: LocalShellOption,
    pub working_directory: String,
    pub output_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<LocalTerminalOutputEvent>>>>,
}

trait PtySessionHandle: Send + Sync {
    fn write_bytes(&self, data: &[u8]) -> Result<(), AppError>;
    fn resize(&self, columns: u16, rows: u16) -> Result<(), AppError>;
    fn close(&self);
}

struct ManagedLocalSession {
    summary: SessionSummary,
    pty: Option<Arc<dyn PtySessionHandle>>,
}

#[derive(Default, Clone)]
pub struct LocalTerminalRuntime {
    sessions: Arc<std::sync::Mutex<HashMap<String, ManagedLocalSession>>>,
}

impl LocalTerminalRuntime {
    pub fn discover_shells(&self) -> Vec<LocalShellOption> {
        discover_local_shells()
    }

    pub fn open_session(
        &self,
        input: OpenLocalTerminalInput,
    ) -> Result<
        (
            SessionSummary,
            LocalShellOption,
            String,
            mpsc::UnboundedReceiver<LocalTerminalOutputEvent>,
        ),
        AppError,
    > {
        let shells = discover_local_shells();
        let shell = select_shell_option(&shells, input.shell_kind)?;
        let working_dir = resolve_working_directory(input.working_directory.as_deref())?;
        let (columns, rows) = clamp_terminal_size(input.columns, input.rows);

        let (tx, rx) = mpsc::unbounded_channel();
        let pty = spawn_platform_pty(&shell.executable_path, &working_dir, columns, rows, tx)?;

        let session_id = Uuid::new_v4().to_string();
        let working_dir_display = strip_windows_verbatim_prefix(&working_dir.to_string_lossy());
        let summary = SessionSummary {
            id: session_id.clone(),
            generation: 1,
            profile_id: format!("local:{}", shell_kind_id(shell.kind)),
            session_kind: SessionKind::Local,
            capabilities: capabilities_for_local(),
            state: SessionState::Connected,
            host: "localhost".to_owned(),
            port: 0,
            username: current_username(),
            last_error: None,
        };

        let mut sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
        sessions.insert(
            session_id,
            ManagedLocalSession {
                summary: summary.clone(),
                pty: Some(pty),
            },
        );

        Ok((summary, shell, working_dir_display, rx))
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), AppError> {
        let pty = {
            let sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
            let session = sessions
                .get(session_id)
                .ok_or_else(local_session_not_found_error)?;
            if session.summary.state != SessionState::Connected {
                return Err(local_session_disconnected_error());
            }
            session
                .pty
                .clone()
                .ok_or_else(local_session_disconnected_error)?
        };
        pty.write_bytes(&data)
    }

    pub fn resize(&self, session_id: &str, columns: u32, rows: u32) -> Result<(), AppError> {
        let (cols, rows) = clamp_terminal_size(Some(columns), Some(rows));
        let pty = {
            let sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
            let session = sessions
                .get(session_id)
                .ok_or_else(local_session_not_found_error)?;
            if session.summary.state != SessionState::Connected {
                return Err(local_session_disconnected_error());
            }
            session
                .pty
                .clone()
                .ok_or_else(local_session_disconnected_error)?
        };
        pty.resize(cols, rows)
    }

    pub fn close(&self, session_id: &str) -> Result<SessionSummary, AppError> {
        let (summary, pty) = {
            let mut sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(local_session_not_found_error)?;
            session.summary.state = SessionState::Disconnected;
            let pty = session.pty.take();
            (session.summary.clone(), pty)
        };
        if let Some(pty) = pty {
            pty.close();
        }
        Ok(summary)
    }

    pub fn mark_exited(&self, session_id: &str) -> Option<SessionSummary> {
        let mut sessions = self.sessions.lock().ok()?;
        let session = sessions.get_mut(session_id)?;
        session.summary.state = SessionState::Disconnected;
        session.pty = None;
        Some(session.summary.clone())
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>, AppError> {
        let sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
        Ok(sessions
            .values()
            .map(|entry| entry.summary.clone())
            .collect())
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(session_id))
            .unwrap_or(false)
    }

    pub fn summary(&self, session_id: &str) -> Result<SessionSummary, AppError> {
        let sessions = self.sessions.lock().map_err(|_| local_lock_error())?;
        sessions
            .get(session_id)
            .map(|entry| entry.summary.clone())
            .ok_or_else(local_session_not_found_error)
    }

    pub fn shutdown(&self) {
        let ptys: Vec<Arc<dyn PtySessionHandle>> = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .values_mut()
                .filter_map(|entry| {
                    entry.summary.state = SessionState::Disconnected;
                    entry.pty.take()
                })
                .collect(),
            Err(_) => return,
        };
        for pty in ptys {
            pty.close();
        }
    }
}

pub fn local_capabilities() -> Vec<CapabilityKind> {
    capabilities_for_local()
}

pub fn clamp_terminal_size(columns: Option<u32>, rows: Option<u32>) -> (u16, u16) {
    let cols = columns
        .unwrap_or(u32::from(DEFAULT_COLUMNS))
        .clamp(u32::from(MIN_COLUMNS), u32::from(MAX_COLUMNS)) as u16;
    let rows = rows
        .unwrap_or(u32::from(DEFAULT_ROWS))
        .clamp(u32::from(MIN_ROWS), u32::from(MAX_ROWS)) as u16;
    (cols, rows)
}

pub fn resolve_working_directory(requested: Option<&str>) -> Result<PathBuf, AppError> {
    if let Some(raw) = requested {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.contains('\0') {
            return Err(local_invalid_cwd_error());
        }
        let path = PathBuf::from(trimmed);
        if !path.exists() || !path.is_dir() {
            return Err(local_invalid_cwd_error());
        }
        return Ok(path);
    }

    if let Some(home) = default_home_directory()
        && home.exists()
        && home.is_dir()
    {
        return Ok(home);
    }

    env::current_dir().map_err(|_| local_invalid_cwd_error())
}

pub fn select_shell_option(
    shells: &[LocalShellOption],
    requested: Option<LocalShellKind>,
) -> Result<LocalShellOption, AppError> {
    match requested {
        Some(kind) => shells
            .iter()
            .find(|option| option.kind == kind)
            .cloned()
            .ok_or_else(local_shell_unsupported_error),
        None => shells
            .iter()
            .find(|option| option.is_default)
            .or_else(|| shells.first())
            .cloned()
            .ok_or_else(local_shell_unsupported_error),
    }
}

pub fn discover_local_shells() -> Vec<LocalShellOption> {
    let mut found = Vec::new();
    let mut seen_kinds = Vec::new();

    for (kind, label, candidates) in platform_shell_candidates() {
        if seen_kinds.contains(&kind) {
            continue;
        }
        if let Some(executable) = find_first_executable(&candidates) {
            seen_kinds.push(kind);
            found.push(LocalShellOption {
                kind,
                label: label.to_owned(),
                executable_path: executable.to_string_lossy().to_string(),
                is_default: false,
            });
        }
    }

    if let Some(preferred_idx) = preferred_shell_index(&found) {
        if let Some(option) = found.get_mut(preferred_idx) {
            option.is_default = true;
        }
    } else if let Some(first) = found.first_mut() {
        first.is_default = true;
    }

    found
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return rest.to_owned();
    }
    path.to_owned()
}

fn shell_kind_id(kind: LocalShellKind) -> &'static str {
    match kind {
        LocalShellKind::PowerShellCore => "pwsh",
        LocalShellKind::WindowsPowerShell => "powershell",
        LocalShellKind::Cmd => "cmd",
        LocalShellKind::Bash => "bash",
        LocalShellKind::Zsh => "zsh",
        LocalShellKind::Fish => "fish",
        LocalShellKind::Sh => "sh",
    }
}

fn current_username() -> String {
    #[cfg(windows)]
    let candidates = ["USERNAME", "USER"];
    #[cfg(not(windows))]
    let candidates = ["USER", "LOGNAME", "USERNAME"];

    for key in candidates {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    "local".to_owned()
}

fn default_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let keys = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let keys = ["HOME", "USERPROFILE"];

    for key in keys {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(PathBuf::from(trimmed));
            }
        }
    }
    None
}

fn find_first_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    for candidate in candidates {
        if is_valid_executable_file(candidate) {
            return Some(candidate.clone());
        }
    }
    None
}

fn is_valid_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && (metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if is_valid_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn platform_shell_candidates() -> Vec<(LocalShellKind, &'static str, Vec<PathBuf>)> {
    let system_root = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let program_files = env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));

    let mut pwsh_candidates = Vec::new();
    if let Some(found) = find_on_path("pwsh.exe") {
        pwsh_candidates.push(found);
    }
    pwsh_candidates.push(program_files.join("PowerShell").join("7").join("pwsh.exe"));

    let mut ps_candidates = Vec::new();
    if let Some(found) = find_on_path("powershell.exe") {
        ps_candidates.push(found);
    }
    ps_candidates.push(
        system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
    );

    let mut cmd_candidates = Vec::new();
    if let Some(comspec) = env::var_os("ComSpec") {
        let comspec_path = PathBuf::from(comspec);
        if comspec_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd.exe"))
        {
            cmd_candidates.push(comspec_path);
        }
    }
    if let Some(found) = find_on_path("cmd.exe") {
        cmd_candidates.push(found);
    }
    cmd_candidates.push(system_root.join("System32").join("cmd.exe"));

    let mut bash_candidates = Vec::new();
    if let Some(found) = find_on_path("bash.exe") {
        bash_candidates.push(found);
    }
    bash_candidates.push(program_files.join("Git").join("bin").join("bash.exe"));

    vec![
        (
            LocalShellKind::PowerShellCore,
            "PowerShell 7",
            pwsh_candidates,
        ),
        (
            LocalShellKind::WindowsPowerShell,
            "Windows PowerShell",
            ps_candidates,
        ),
        (
            LocalShellKind::Cmd,
            "Command Prompt (cmd.exe)",
            cmd_candidates,
        ),
        (LocalShellKind::Bash, "Git Bash", bash_candidates),
    ]
}

#[cfg(not(windows))]
fn platform_shell_candidates() -> Vec<(LocalShellKind, &'static str, Vec<PathBuf>)> {
    let mut list = Vec::new();
    for (kind, label, name, extra) in [
        (
            LocalShellKind::Zsh,
            "Zsh",
            "zsh",
            &["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"][..],
        ),
        (
            LocalShellKind::Bash,
            "Bash",
            "bash",
            &["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"][..],
        ),
        (
            LocalShellKind::Fish,
            "Fish",
            "fish",
            &[
                "/usr/bin/fish",
                "/opt/homebrew/bin/fish",
                "/usr/local/bin/fish",
            ][..],
        ),
        (
            LocalShellKind::Sh,
            "POSIX Shell (sh)",
            "sh",
            &["/bin/sh", "/usr/bin/sh"][..],
        ),
    ] {
        let mut candidates = Vec::new();
        if let Some(found) = find_on_path(name) {
            candidates.push(found);
        }
        for path in extra {
            candidates.push(PathBuf::from(path));
        }
        list.push((kind, label, candidates));
    }
    list
}

fn preferred_shell_index(options: &[LocalShellOption]) -> Option<usize> {
    #[cfg(not(windows))]
    if let Ok(shell_env) = env::var("SHELL")
        && let Some(idx) = options
            .iter()
            .position(|opt| Path::new(&opt.executable_path) == Path::new(&shell_env))
    {
        return Some(idx);
    }

    if options.is_empty() { None } else { Some(0) }
}

fn local_error(code: &str, message_key: &str, remote_state: RemoteState) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state,
        field: None,
    }
}

fn local_lock_error() -> AppError {
    local_error(
        "LOCAL_TERMINAL_LOCK_ERROR",
        "errors.localTerminalFailed",
        RemoteState::NotApplicable,
    )
}

fn local_shell_unsupported_error() -> AppError {
    local_error(
        "LOCAL_SHELL_UNSUPPORTED",
        "errors.localShellUnsupported",
        RemoteState::NotApplicable,
    )
}

fn local_invalid_cwd_error() -> AppError {
    local_error(
        "LOCAL_TERMINAL_INVALID_CWD",
        "errors.localTerminalInvalidDirectory",
        RemoteState::NotApplicable,
    )
}

fn local_spawn_error() -> AppError {
    local_error(
        "LOCAL_TERMINAL_SPAWN_FAILED",
        "errors.localTerminalSpawnFailed",
        RemoteState::NotApplicable,
    )
}

fn local_session_not_found_error() -> AppError {
    local_error(
        "LOCAL_TERMINAL_NOT_FOUND",
        "errors.sessionNotFound",
        RemoteState::Unknown,
    )
}

fn local_session_disconnected_error() -> AppError {
    local_error(
        "SESSION_DISCONNECTED",
        "errors.sessionDisconnected",
        RemoteState::NotApplicable,
    )
}

fn local_write_error() -> AppError {
    local_error(
        "TERMINAL_WRITE_FAILED",
        "errors.terminalWriteFailed",
        RemoteState::Unknown,
    )
}

fn local_resize_error() -> AppError {
    local_error(
        "TERMINAL_RESIZE_FAILED",
        "errors.terminalResizeFailed",
        RemoteState::Unknown,
    )
}

fn spawn_platform_pty(
    executable: &str,
    working_directory: &Path,
    columns: u16,
    rows: u16,
    output_tx: mpsc::UnboundedSender<LocalTerminalOutputEvent>,
) -> Result<Arc<dyn PtySessionHandle>, AppError> {
    #[cfg(windows)]
    {
        windows_pty::spawn_conpty(executable, working_directory, columns, rows, output_tx)
    }
    #[cfg(unix)]
    {
        unix_pty::spawn_openpty(executable, working_directory, columns, rows, output_tx)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (executable, working_directory, columns, rows, output_tx);
        Err(local_shell_unsupported_error())
    }
}

#[cfg(windows)]
mod windows_pty {
    use std::ffi::OsStr;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use filex_contracts::AppError;
    use tokio::sync::mpsc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Console::{
        COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
        GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    };

    use super::{
        LocalTerminalOutputEvent, PtySessionHandle, local_resize_error, local_spawn_error,
        local_write_error,
    };

    const S_OK_HRESULT: i32 = 0;
    const STILL_ACTIVE_CODE: u32 = 259;

    struct OwnedWinHandle(isize);

    impl OwnedWinHandle {
        fn new(handle: HANDLE) -> Option<Self> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(Self(handle as isize))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0 as HANDLE
        }
    }

    impl Drop for OwnedWinHandle {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: `self.0` holds an owned valid Win32 kernel handle wrapped once.
                unsafe {
                    let _ = CloseHandle(self.0 as HANDLE);
                }
            }
        }
    }

    struct PseudoConsoleState {
        hpc: Option<HPCON>,
        input_write: Option<OwnedWinHandle>,
    }

    struct WindowsConPtySession {
        state: Mutex<PseudoConsoleState>,
        process_handle: Arc<OwnedWinHandle>,
        closing: Arc<AtomicBool>,
    }

    impl WindowsConPtySession {
        fn close_internal(&self) {
            self.closing.store(true, Ordering::Release);
            let (hpc, input_write) = {
                let mut guard = match self.state.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                (guard.hpc.take(), guard.input_write.take())
            };
            drop(input_write);
            if let Some(hpc) = hpc {
                // SAFETY: `hpc` was returned by `CreatePseudoConsole` and is taken at most once.
                unsafe {
                    ClosePseudoConsole(hpc);
                }
            }
            // If shell ignores console close (e.g. non-interactive child still alive), wait briefly then terminate.
            // SAFETY: `process_handle` remains alive via Arc for the duration of this call.
            unsafe {
                let wait_status = WaitForSingleObject(self.process_handle.raw(), 250);
                if wait_status != 0 {
                    let _ = TerminateProcess(self.process_handle.raw(), 1);
                }
            }
        }
    }

    impl Drop for WindowsConPtySession {
        fn drop(&mut self) {
            self.close_internal();
        }
    }

    impl PtySessionHandle for WindowsConPtySession {
        fn write_bytes(&self, data: &[u8]) -> Result<(), AppError> {
            if data.is_empty() {
                return Ok(());
            }
            let guard = self.state.lock().map_err(|_| local_write_error())?;
            let Some(handle) = guard.input_write.as_ref() else {
                return Err(local_write_error());
            };
            let mut offset = 0usize;
            while offset < data.len() {
                let slice = &data[offset..];
                let chunk_len = slice.len().min(u32::MAX as usize) as u32;
                let mut written: u32 = 0;
                // SAFETY: `handle.raw()` is held under mutex while writing bounded slice bytes.
                let ok = unsafe {
                    WriteFile(
                        handle.raw(),
                        slice.as_ptr(),
                        chunk_len,
                        &mut written,
                        null_mut(),
                    )
                };
                if ok == 0 || written == 0 {
                    return Err(local_write_error());
                }
                offset += written as usize;
            }
            Ok(())
        }

        fn resize(&self, columns: u16, rows: u16) -> Result<(), AppError> {
            let guard = self.state.lock().map_err(|_| local_resize_error())?;
            let Some(hpc) = guard.hpc else {
                return Err(local_resize_error());
            };
            let size = COORD {
                X: columns as i16,
                Y: rows as i16,
            };
            // SAFETY: `hpc` is valid until `close_internal` takes and closes it under the same mutex.
            let hr = unsafe { ResizePseudoConsole(hpc, size) };
            if hr != S_OK_HRESULT {
                return Err(local_resize_error());
            }
            Ok(())
        }

        fn close(&self) {
            self.close_internal();
        }
    }

    pub fn spawn_conpty(
        executable: &str,
        working_directory: &Path,
        columns: u16,
        rows: u16,
        output_tx: mpsc::UnboundedSender<LocalTerminalOutputEvent>,
    ) -> Result<Arc<dyn PtySessionHandle>, AppError> {
        let mut pty_in_read: HANDLE = null_mut();
        let mut app_in_write: HANDLE = null_mut();
        let mut app_out_read: HANDLE = null_mut();
        let mut pty_out_write: HANDLE = null_mut();

        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 0,
        };

        // SAFETY: Output pipe pointers are valid writable slots on stack.
        if unsafe { CreatePipe(&mut pty_in_read, &mut app_in_write, &sa, 0) } == 0 {
            return Err(local_spawn_error());
        }
        let pty_in_read = OwnedWinHandle::new(pty_in_read).ok_or_else(local_spawn_error)?;
        let app_in_write = OwnedWinHandle::new(app_in_write).ok_or_else(local_spawn_error)?;

        // SAFETY: Output pipe pointers are valid writable slots on stack.
        if unsafe { CreatePipe(&mut app_out_read, &mut pty_out_write, &sa, 0) } == 0 {
            return Err(local_spawn_error());
        }
        let app_out_read = OwnedWinHandle::new(app_out_read).ok_or_else(local_spawn_error)?;
        let pty_out_write = OwnedWinHandle::new(pty_out_write).ok_or_else(local_spawn_error)?;

        let size = COORD {
            X: columns as i16,
            Y: rows as i16,
        };
        let mut hpc: HPCON = 0;
        // SAFETY: Pipe handles are valid non-null read/write ends; `hpc` is initialized on S_OK.
        let hr = unsafe {
            CreatePseudoConsole(size, pty_in_read.raw(), pty_out_write.raw(), 0, &mut hpc)
        };
        if hr != S_OK_HRESULT || hpc == 0 {
            return Err(local_spawn_error());
        }

        // Guard ensures ConPTY closes cleanly if attribute initialization or CreateProcessW fails.
        struct HpcCleanup(Option<HPCON>);
        impl Drop for HpcCleanup {
            fn drop(&mut self) {
                if let Some(hpc) = self.0.take() {
                    // SAFETY: `hpc` is closed only once if creation was not transferred.
                    unsafe { ClosePseudoConsole(hpc) };
                }
            }
        }
        let mut hpc_guard = HpcCleanup(Some(hpc));

        let mut attr_size: usize = 0;
        // SAFETY: Passing null list queries required byte size per Win32 documentation.
        unsafe {
            let _ = InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size);
        }
        if attr_size == 0 {
            return Err(local_spawn_error());
        }
        let word_len = attr_size.div_ceil(size_of::<u64>());
        let mut attr_storage = vec![0u64; word_len];
        let attr_list = attr_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;

        // SAFETY: `attr_storage` is 8-byte aligned and sized at least `attr_size` bytes.
        if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) } == 0 {
            return Err(local_spawn_error());
        }

        struct AttrListCleanup(LPPROC_THREAD_ATTRIBUTE_LIST);
        impl Drop for AttrListCleanup {
            fn drop(&mut self) {
                // SAFETY: `self.0` was successfully initialized above.
                unsafe { DeleteProcThreadAttributeList(self.0) };
            }
        }
        let _attr_guard = AttrListCleanup(attr_list);

        // SAFETY: For `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, `lpValue` must be `HPCON` directly.
        if unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const core::ffi::c_void,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(local_spawn_error());
        }

        // SAFETY: Zeroed STARTUPINFOEXW populated with exact cb and attribute list pointer.
        // Setting STARTF_USESTDHANDLES with null handles stops Windows from inheriting a caller's redirected stdout/stderr pipes over ConPTY.
        let mut si_ex: STARTUPINFOEXW = unsafe { zeroed() };
        si_ex.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        si_ex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si_ex.lpAttributeList = attr_list;

        let exe_wide = to_wide_null(OsStr::new(executable));
        let mut cmdline_wide = to_wide_null(OsStr::new(&format!("\"{executable}\"")));
        let cwd_wide = to_wide_null(working_directory.as_os_str());
        // SAFETY: Zeroed out-parameter populated on `CreateProcessW` success.
        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };

        // SAFETY: Wide string buffers stay alive across `CreateProcessW`; no inherited handles needed beyond ConPTY attribute.
        let created = unsafe {
            CreateProcessW(
                exe_wide.as_ptr(),
                cmdline_wide.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                null(),
                cwd_wide.as_ptr(),
                &si_ex.StartupInfo,
                &mut pi,
            )
        };
        if created == 0 {
            return Err(local_spawn_error());
        }

        // Parent no longer needs ConPTY-side pipe descriptors or primary thread handle.
        drop(pty_in_read);
        drop(pty_out_write);
        if !pi.hThread.is_null() {
            // SAFETY: Close unused child main thread handle immediately.
            unsafe {
                let _ = CloseHandle(pi.hThread);
            }
        }

        let process_handle =
            Arc::new(OwnedWinHandle::new(pi.hProcess).ok_or_else(local_spawn_error)?);
        let hpc = hpc_guard.0.take().ok_or_else(local_spawn_error)?;
        let closing = Arc::new(AtomicBool::new(false));
        let session = Arc::new(WindowsConPtySession {
            state: Mutex::new(PseudoConsoleState {
                hpc: Some(hpc),
                input_write: Some(app_in_write),
            }),
            process_handle: process_handle.clone(),
            closing: closing.clone(),
        });

        let reader_process = process_handle;
        let reader_session = Arc::downgrade(&session);
        std::thread::Builder::new()
            .name("filex-conpty-reader".to_owned())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    let mut read_len: u32 = 0;
                    // SAFETY: `app_out_read` is uniquely owned by this reader thread until thread returns.
                    let ok = unsafe {
                        ReadFile(
                            app_out_read.raw(),
                            buf.as_mut_ptr(),
                            buf.len() as u32,
                            &mut read_len,
                            null_mut(),
                        )
                    };
                    if ok == 0 || read_len == 0 {
                        break;
                    }
                    if output_tx
                        .send(LocalTerminalOutputEvent::Data(
                            buf[..read_len as usize].to_vec(),
                        ))
                        .is_err()
                    {
                        break;
                    }
                }

                // SAFETY: `reader_process` holds an `Arc<OwnedWinHandle>` so the Win32 handle remains open here.
                let exit_code = unsafe {
                    let _ = WaitForSingleObject(reader_process.raw(), 500);
                    let mut code: u32 = 0;
                    if GetExitCodeProcess(reader_process.raw(), &mut code) != 0
                        && code != STILL_ACTIVE_CODE
                    {
                        code as i32
                    } else {
                        0
                    }
                };
                if let Some(session_ref) = reader_session.upgrade() {
                    if let Ok(mut guard) = session_ref.state.lock() {
                        guard.input_write = None;
                        if let Some(hpc) = guard.hpc.take() {
                            // SAFETY: Closing ConPTY here releases any remaining resources if child exited naturally.
                            unsafe { ClosePseudoConsole(hpc) };
                        }
                    }
                }
                let _ = output_tx.send(LocalTerminalOutputEvent::Exit(exit_code));
                let _ = output_tx.send(LocalTerminalOutputEvent::Closed);
            })
            .map_err(|_| local_spawn_error())?;

        Ok(session)
    }

    fn to_wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }
}

#[cfg(unix)]
mod unix_pty {
    use std::ffi::CString;
    use std::os::fd::RawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use filex_contracts::AppError;
    use tokio::sync::mpsc;

    use super::{
        LocalTerminalOutputEvent, PtySessionHandle, local_resize_error, local_spawn_error,
        local_write_error,
    };

    struct UnixPtySession {
        master_fd: Mutex<Option<RawFd>>,
        child_pid: libc::pid_t,
        closing: AtomicBool,
    }

    impl UnixPtySession {
        fn close_internal(&self) {
            if self.closing.swap(true, Ordering::AcqRel) {
                return;
            }
            if let Ok(mut guard) = self.master_fd.lock()
                && let Some(fd) = guard.take()
            {
                // SAFETY: `fd` was obtained from `openpty` and is closed at most once.
                unsafe {
                    libc::close(fd);
                }
            }
            if self.child_pid > 0 {
                // SAFETY: Valid child PID owned by this process; request clean hangup then terminate if needed.
                unsafe {
                    libc::kill(self.child_pid, libc::SIGHUP);
                }
            }
        }
    }

    impl Drop for UnixPtySession {
        fn drop(&mut self) {
            self.close_internal();
        }
    }

    impl PtySessionHandle for UnixPtySession {
        fn write_bytes(&self, data: &[u8]) -> Result<(), AppError> {
            let guard = self.master_fd.lock().map_err(|_| local_write_error())?;
            let Some(fd) = *guard else {
                return Err(local_write_error());
            };
            let mut offset = 0usize;
            while offset < data.len() {
                let remaining = &data[offset..];
                // SAFETY: `fd` is held open under mutex while writing valid byte slice.
                let written =
                    unsafe { libc::write(fd, remaining.as_ptr().cast(), remaining.len()) };
                if written <= 0 {
                    return Err(local_write_error());
                }
                offset += written as usize;
            }
            Ok(())
        }

        fn resize(&self, columns: u16, rows: u16) -> Result<(), AppError> {
            let guard = self.master_fd.lock().map_err(|_| local_resize_error())?;
            let Some(fd) = *guard else {
                return Err(local_resize_error());
            };
            let winsize = libc::winsize {
                ws_row: rows,
                ws_col: columns,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: Valid PTY master fd and initialized winsize struct.
            let status = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &winsize) };
            if status != 0 {
                return Err(local_resize_error());
            }
            Ok(())
        }

        fn close(&self) {
            self.close_internal();
        }
    }

    pub fn spawn_openpty(
        executable: &str,
        working_directory: &Path,
        columns: u16,
        rows: u16,
        output_tx: mpsc::UnboundedSender<LocalTerminalOutputEvent>,
    ) -> Result<Arc<dyn PtySessionHandle>, AppError> {
        let mut master: RawFd = -1;
        let mut slave: RawFd = -1;
        let mut winsize = libc::winsize {
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // macOS/BSD libc::openpty takes *mut winsize while glibc takes *const winsize.
        // SAFETY: Valid stack descriptors and winsize pointer.
        #[allow(clippy::unnecessary_mut_passed)]
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                null_mut(),
                null_mut(),
                &mut winsize,
            )
        } != 0
        {
            return Err(local_spawn_error());
        }

        let exe_c = CString::new(executable).map_err(|_| local_spawn_error())?;
        let cwd_c = CString::new(working_directory.as_os_str().as_bytes())
            .map_err(|_| local_spawn_error())?;

        // SAFETY: Async-signal-safe child setup before execv.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            unsafe {
                libc::close(master);
                libc::close(slave);
            }
            return Err(local_spawn_error());
        }

        if pid == 0 {
            unsafe {
                libc::close(master);
                libc::setsid();
                let _ = libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
                libc::dup2(slave, libc::STDIN_FILENO);
                libc::dup2(slave, libc::STDOUT_FILENO);
                libc::dup2(slave, libc::STDERR_FILENO);
                if slave > libc::STDERR_FILENO {
                    libc::close(slave);
                }
                let _ = libc::chdir(cwd_c.as_ptr());
                let argv = [exe_c.as_ptr(), null_mut()];
                libc::execv(exe_c.as_ptr(), argv.as_ptr());
                libc::_exit(127);
            }
        }

        // SAFETY: Parent does not need slave end after fork.
        unsafe {
            libc::close(slave);
        }

        let session = Arc::new(UnixPtySession {
            master_fd: Mutex::new(Some(master)),
            child_pid: pid,
            closing: AtomicBool::new(false),
        });
        let reader_session = Arc::downgrade(&session);

        std::thread::Builder::new()
            .name("filex-unix-pty-reader".to_owned())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    let fd = match reader_session.upgrade() {
                        Some(s) => match s.master_fd.lock() {
                            Ok(guard) => *guard,
                            Err(_) => None,
                        },
                        None => None,
                    };
                    let Some(fd) = fd else {
                        break;
                    };
                    // SAFETY: Valid PTY master fd while held open until close_internal.
                    let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                    if n <= 0 {
                        break;
                    }
                    if output_tx
                        .send(LocalTerminalOutputEvent::Data(buf[..n as usize].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                let mut status: libc::c_int = 0;
                let exit_code = unsafe {
                    if libc::waitpid(pid, &mut status, 0) == pid && libc::WIFEXITED(status) {
                        libc::WEXITSTATUS(status)
                    } else {
                        0
                    }
                };
                let _ = output_tx.send(LocalTerminalOutputEvent::Exit(exit_code));
                let _ = output_tx.send(LocalTerminalOutputEvent::Closed);
            })
            .map_err(|_| local_spawn_error())?;

        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, timeout};

    #[test]
    fn size_clamping_stays_within_bounds() {
        assert_eq!(clamp_terminal_size(None, None), (120, 32));
        assert_eq!(clamp_terminal_size(Some(2), Some(1)), (20, 5));
        assert_eq!(clamp_terminal_size(Some(9999), Some(9999)), (500, 200));
    }

    #[test]
    fn working_directory_rejects_invalid_and_nul_paths() {
        let missing = resolve_working_directory(Some("i:\\definitely-nonexistent-filex-dir-99999"));
        assert_eq!(
            missing.expect_err("missing directory must fail").code,
            "LOCAL_TERMINAL_INVALID_CWD"
        );
        let nul = resolve_working_directory(Some("C:\\bad\0path"));
        assert_eq!(
            nul.expect_err("nul path must fail").code,
            "LOCAL_TERMINAL_INVALID_CWD"
        );
    }

    #[test]
    fn discovers_at_least_one_allowlisted_local_shell() {
        let shells = discover_local_shells();
        assert!(!shells.is_empty(), "expected at least one local shell");
        assert!(shells.iter().any(|item| item.is_default));
    }

    #[tokio::test]
    async fn local_pty_spawns_echoes_resizes_and_closes_cleanly() {
        let runtime = LocalTerminalRuntime::default();
        let shells = runtime.discover_shells();
        assert!(!shells.is_empty());

        #[cfg(windows)]
        let preferred_kind = shells
            .iter()
            .find(|s| s.kind == LocalShellKind::Cmd)
            .or_else(|| shells.first())
            .map(|s| s.kind);
        #[cfg(not(windows))]
        let preferred_kind = shells
            .iter()
            .find(|s| s.kind == LocalShellKind::Sh)
            .or_else(|| shells.first())
            .map(|s| s.kind);

        let (summary, _shell, _cwd, mut rx) = runtime
            .open_session(OpenLocalTerminalInput {
                shell_kind: preferred_kind,
                working_directory: None,
                columns: Some(100),
                rows: Some(30),
            })
            .expect("open local pty");

        assert_eq!(summary.session_kind, SessionKind::Local);
        assert!(summary.capabilities.contains(&CapabilityKind::LocalShell));
        assert!(!summary.capabilities.contains(&CapabilityKind::Sftp));
        assert!(!summary.capabilities.contains(&CapabilityKind::RemoteShell));

        runtime
            .resize(&summary.id, 132, 40)
            .expect("resize local pty");

        let marker = "FILEX_LOCAL_PTY_OK";
        runtime
            .write(&summary.id, format!("echo {marker}\r\n").into_bytes())
            .expect("write echo command");

        let mut collected = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        let mut saw_marker = false;
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(LocalTerminalOutputEvent::Data(bytes))) => {
                    collected.extend_from_slice(&bytes);
                    let text = String::from_utf8_lossy(&collected);
                    if text.contains(marker) {
                        saw_marker = true;
                        break;
                    }
                }
                Ok(Some(LocalTerminalOutputEvent::Closed)) | Ok(None) => break,
                Ok(Some(LocalTerminalOutputEvent::Exit(_))) | Err(_) => {}
            }
        }
        assert!(
            saw_marker,
            "expected local PTY output to contain marker, got: {}",
            String::from_utf8_lossy(&collected)
        );

        let closed = runtime.close(&summary.id).expect("close local pty");
        assert_eq!(closed.state, SessionState::Disconnected);
    }
}
