# ADR-0004: Bounded process inspection and explicit termination

Status: accepted  
Date: 2026-11-03

## Context

Operators need to inspect processes on a connected host and stop an individual process from the workbench. Process names and remote process state are untrusted input, and PIDs can be reused between a list refresh and an action. Process arguments, environment variables, and working directories can expose credentials or private paths.

## Decision

- Add a Processes sub-view inside the existing Monitor inspector tab. Do not add a persisted inspector-tab value or a new top-level navigation mode.
- Collect at most 100 rows, with an 8-second command timeout and a 64 KiB combined output bound. Never collect command arguments, environment variables, working directories, or executable paths.
- Display only a sanitized process name, PID, state, CPU information when available, and resident memory. Show an explicit unsupported state when the host cannot provide the bounded probe.
- Keep only the latest process snapshot per SSH session in memory, and expire it after 60 seconds. The UI sends its snapshot ID and PID for a termination request; the backend rejects missing, expired, replaced, or mismatched snapshots.
- Before sending a signal, re-read the process start marker and name and compare them with the server-side snapshot. POSIX hosts receive SIGTERM. Windows hosts receive Stop-Process without the Force option. PID 0 and PID 1 are never eligible. No sudo, force-kill, arbitrary signal, or user-supplied command text is permitted.
- Require a danger confirmation that names the host, PID, process name, and action. Report that the request was sent rather than claiming the process has exited.
- Clear cached snapshots on disconnect and transport failure. If identity cannot be read or the process has changed, refuse the action and require a fresh list.

## Consequences

- Process inspection remains read-only until the user confirms a single-process termination request.
- Process data and action tokens are ephemeral and never enter SQLite, event history, or assistant context.
- Platforms without the required process utilities can still use the rest of the monitor panel and receive an explicit unsupported state.
- PID identity is checked immediately before signaling, but operating-system process APIs do not provide a portable atomic check-and-signal operation over SSH; a narrow PID-reuse race remains on POSIX systems.
- Build, type, runtime, and live-host verification are required before accepting this implementation for release.
