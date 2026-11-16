# ADR-0027: Explicit elevated file access via bounded leases

Status: accepted
Date: 2026-11-15

## Context

Administrators connected as a non-root user sometimes need to inspect or edit protected paths (`/etc/nginx`, `/var/log`, etc.). Passive `sudo` password sniffing from interactive terminal keystreams creates severe security and compliance risks: credentials entered into an interactive prompt can leak across modes or be triggered unexpectedly by shell output.

FILEX requires an opt-in, time-bounded, non-persisted privilege elevation mechanism restricted to explicit remote file operations.

## Decision

### Explicit lease model (`ElevatedAccessLease`)

- Track elevation per active SSH session generation `(session_id, generation, host, port, username)` in an in-memory `ElevatedAccessManager`.
- Store the elevation password only inside `Zeroizing<String>` memory while active. Never write it to SQLite, `SafeSettings`, disk caches, logs, diagnostics, or frontend state.
- Require explicit opt-in via `ElevatedAccessDialog.vue` showing the exact `username@host:port`, TTL choices (`5m`, `15m`, `30m`), and explicit warning that elevated operations apply directly to the remote host.
- On acquisition, verify the credential with a non-interactive, fixed-argument remote probe (`sudo -S -k -p '' true`) over SSH exec, feeding the password via stdin and zeroizing buffers after write.
- Enforce automatic invalidation on TTL expiry, manual revocation, session disconnect, session generation bump, or profile/host change.

### Non-shell-interpolated elevated file operations

- Elevated remote file operations (`elevated_list_directory`, `elevated_create_directory`, `elevated_create_file`, `elevated_rename_entry`, `elevated_delete_entry`, `elevated_chmod_entry`, `elevated_preview_text`, `elevated_save_text`) execute bounded, non-shell-interpolated helper invocations (`sudo -S -k -p '' <binary> ...` with strict single-argument validation and symlink/path checks, rejecting root-like destructive targets).
- Every elevated operation revalidates the lease server-side before invoking remote `sudo`. The frontend cannot forge `PrivilegeState` flags or supply raw shell snippets.
- While active, UI chrome displays a persistent amber `Elevated` badge with remaining TTL countdown and a one-click `Revoke` control in both `FileBrowserPanel.vue` and `TerminalPane.vue`.

## Consequences

- Interactive terminal `sudo` remains isolated from FILEX's file browser and never silently captures keystrokes.
- Users get auditable, visually prominent root-scoped file operations with predictable auto-expiry and zero secret persistence.
- Hosts without `sudo` or accounts without sudoers rights fail cleanly with structured `AppError` (`ELEVATED_AUTH_FAILED` / `ELEVATED_NOT_SUPPORTED` / `ELEVATED_LEASE_EXPIRED`).
