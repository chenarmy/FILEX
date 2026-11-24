# ADR-0033: Local MCP Server for Read-Only Terminal Diagnostics

Status: accepted  
Date: 2026-11-24

## Context

Operators frequently use external AI coding assistants and diagnostic tools (such as Claude Desktop, Cursor, Windsurf, or Antigravity) alongside FILEX. Manually copying terminal logs, process tables, and system metrics across windows slows incident triage and increases the risk of leaking unredacted credentials.

## Decision

- Expose an opt-in, loopback-only (`127.0.0.1:<port>`, default `19375`, disabled by default) JSON-RPC 2.0 MCP server inside `src-tauri/src/mcp_diagnostics.rs`, plus a stdio bridge mode (`filex --mcp`) so both Streamable HTTP and stdio MCP clients can connect.
- Require constant-time Bearer token authentication on `/mcp` with an automatically generated high-entropy token per run and a runtime discovery file written with owner-only permissions on Unix and removed on stop/shutdown.
- Maintain a bounded per-session `TerminalOutputRing` (256 KiB per session, max 64 sessions) fed by SSH and local PTY output streams, stripped of ANSI escape sequences on request and redacted before returning.
- Expose strictly read-only diagnostic tools:
  - `list_terminal_sessions`
  - `read_terminal_output`
  - `get_session_diagnostics`
  - `list_session_processes`
  - `get_session_network`
  - `run_diagnostic_command` (enforced via `assistant_exec::classify_assistant_command`, rejecting any non-`ReadOnly` command)
  - `list_remote_files`
  - `read_remote_file` (rejecting sensitive targets via `references_sensitive_target`)
- Surface enable/disable, port, status, token rotation, and one-click JSON config copy in Settings -> MCP Terminal Diagnostics.

## Consequences

- External AI/developer tools can inspect live FILEX terminal output and host diagnostics without copying secrets into settings or exposing network ports beyond loopback.
- Mutating or destructive commands cannot be triggered via MCP, preserving FILEX's explicit human-confirmation invariant for remote state changes.
