# ADR-0026: Local terminal sessions via bounded PTY abstraction

Status: accepted
Date: 2026-11-15

## Context

Users working inside FILEX frequently need a local shell alongside SSH sessions without switching out of the workbench. Prior to this slice, sessions in FILEX were strictly SSH/SFTP sessions bound to remote host profiles, and terminal input/resize events assumed an active SSH channel.

Launching a local shell introduces platform-specific PTY handling (Windows ConPTY and POSIX `openpty`) plus strict capability boundaries: local terminals must not fake SSH/SFTP capabilities, trigger host-key trust prompts, emit remote telemetry probes, or load SSH secrets.

## Decision

### Workspace crate (`filex-local-terminal`)

Isolate OS PTY spawning and shell discovery inside a dedicated workspace crate `crates/filex-local-terminal`:

- Discover only allow-listed local shells verified on disk (`powershell` / `pwsh`, `cmd` on Windows; `sh`, `bash`, `zsh`, `fish` on POSIX, plus configurable safe default). Never pass raw unsanitized command lines through shell wrappers.
- Validate starting directory (reject NUL bytes, path must resolve to an existing directory when specified, otherwise fall back safely to user home directory).
- On Windows, allocate a real ConPTY using `windows-sys` (`CreatePseudoConsole`, `ResizePseudoConsole`, `ClosePseudoConsole`, `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `CreateProcessW`), backed by anonymous pipes for I/O and explicit `Drop` cleanup so child processes and pseudo-consoles do not leak on disconnect or app exit.
- On Unix/macOS, allocate a real PTY via `libc::openpty` and spawn the validated shell in its own session (`setsid`, `TIOCSCTTY`), wired to async pipes/FD readers.

### Shared session contracts and frontend integration

- Extend `SessionSummary` with `sessionKind: "ssh" | "local"` and `capabilities: CapabilityKind[]` (derived from session kind and privilege state: SSH sessions expose `remote_shell`, `sftp`, `remote_edit`, `host_monitoring`, `tunneling`, `remote_jobs`; local sessions expose only `local_shell`, `local_files`).
- Add typed commands `list_local_shell_options`, `open_local_terminal`, `write_local_terminal`, `resize_local_terminal`, `close_local_terminal` and register them in `tauri::Builder::invoke_handler`, with full cleanup on `RunEvent::Exit`.
- Expose a typed domain facade `src/api/domain/localTerminalApi.ts` and integrate local sessions into `src/stores/sessions.ts`, `TerminalPane.vue`, `TerminalWorkspace.vue`, `LocalTerminalDialog.vue`, `WorkbenchShell.vue`, and the command palette.
- Local tabs clearly display their `LOCAL` badge and disable SSH-only panels (SFTP target for that tab remains unpaired unless another SSH session is active; Ops telemetry and tunnels do not probe the local machine under SSH semantics).

## Consequences

- Local shells share the exact xterm.js viewport, theme tokens, split/tab shortcuts, and keyboard accessibility of remote SSH terminals.
- All PTY handles are tracked per session ID and terminated deterministically on close or application shutdown.
- Local terminal state requires no OS keyring access or network permissions.
