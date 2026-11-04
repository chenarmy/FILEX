# ADR-0020: Bounded, explicitly enabled terminal session logs

Status: accepted  
Date: 2026-11-03

## Context

The Settings model already persisted a terminal-logging preference, but no runtime writer consumed it. A visible switch that does nothing misrepresents the product's privacy posture. Terminal output may contain credentials, customer data, command output and control sequences, so logging cannot be silently enabled by a global preference.

## Decision

- Treat the persisted `terminal_logging` setting as a global capability gate. It is off by default and must be enabled in Settings before any session can request a log.
- Require an explicit per-session confirmation in the terminal toolbar. The confirmation names the host, identifies the local log-file directory, warns that raw output can contain sensitive data, and states the size cap.
- Capture PTY output bytes only. The sink never receives keyboard input, terminal selections, hidden password fields, SFTP content or assistant prompts.
- Write raw terminal bytes to a uniquely named file under the platform application-data `logs/terminal` directory. File names contain no host, username or profile name. Unix directories are restricted to owner access and files to owner read/write where the platform permits it.
- Pass output through a background queue capped at 64 messages and 64 KiB per message (about 4 MiB excluding transient chunk copies). When the queue is full, stop the log, flush the writer, remove it from the active registry and report an interrupted state. PTY delivery itself remains nonblocking.
- Allow at most eight concurrently active logs. This bounds aggregate queue and writer resources while leaving ordinary multi-tab work available.
- Cap each log at 16 MiB. Reaching the cap flushes the written bytes and reports `limit_reached`; subsequent output is not logged.
- Expose `active`, `inactive`, `limit_reached`, `interrupted` and `failed` states, the local path and written byte count through typed contracts and a session-scoped status event.
- Stop logging when the user disables it for the session, the PTY closes, the session disconnects, or the application shuts down. Saving the global Settings gate as off also stops every active log. The writer task flushes on every stop path.
- Retain at most 24 completed terminal log files plus currently active logs, and remove completed files older than 30 days during logging initialization. Cleanup considers only FILEX-created `terminal-*.log` files in the managed directory and never deletes a file that belongs to the active registry.
- Keep logs outside SQLite, backups, profile export, diagnostics, assistant context and event-console payloads.

## Alternatives considered

- **Log every session whenever the global setting is on.** Rejected because a settings toggle is not informed consent for each remote host.
- **Write directly on the terminal output loop.** Rejected because slow disks could delay PTY delivery.
- **Log through the front-end renderer.** Rejected because it adds IPC overhead, duplicates runtime state and would mix user-visible selection/editing state with the output stream.
- **Leave logs unbounded.** Rejected because terminal output can exhaust disk space.

## Consequences

- Terminal logging becomes an observable session capability instead of a decorative setting.
- Raw logs may contain sensitive text by design; the confirmation must make that risk visible, and automatic export or upload is not provided.
- Overflow and size-limit behavior can produce a partial log with an explicit terminal state.
- Runtime file-write, high-output queue, retention and cross-platform permission behavior remain pending verification until the environment is configured.
