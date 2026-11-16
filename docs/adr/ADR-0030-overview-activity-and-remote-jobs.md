# ADR-0030: Profile command history, optional compact composer, Overview, unified Activity center, and RemoteJob engine

Status: accepted
Date: 2026-11-15

## Context

FILEX keeps an intentionally tight terminal-first workbench where `TerminalWorkspace` fills the center without a permanent bottom composer bar (`e2e/workbench.spec.ts` asserts `.command-input-bar` is absent by default). At the same time, operators need:
1. Device-local per-profile command history that filters out likely secrets, plus an opt-in toggleable compact composer (`compactComposerOpen: false` by default).
2. A fast `Overview` hub accessible from the top-bar brand mark and command palette without permanently consuming a central workspace tab or replacing active terminals.
3. A unified `Activity` center consolidating active transfers, transfer history, tunnels, remote jobs, and diagnostics under filter pills.
4. A bounded, cancelable `RemoteJob` execution model for repeatable remote commands outside raw interactive PTY keystreams.

## Decision

### Per-profile command history & optional composer (Phase B4)

- Add SQLite Migration v9 (`profile_command_history` capped at 200 entries per profile). Ephemeral local/quick-connect sessions retain bounded memory-only history without persisting to SQLite.
- Reject or redact secret-bearing commands (`--password`, `-p=...`, `Authorization: Bearer`, `PRIVATE KEY`, inline tokens matching secret-redaction rules) before writing to SQLite.
- Add `compactComposerOpen: false` to `SafeSettings` (validated across Rust and TypeScript) so the compact `CommandInputBar.vue` stays hidden unless explicitly toggled on from the terminal toolbar or Settings.

### Overview surface and unified Activity center (Shell consolidation)

- clicking the FILEX brand button or running the `Overview` command palette action opens a non-destructive `OverviewDialog` (or switchable workbench overlay) displaying connection counts, active SSH + local sessions (clickable to focus), recent saved connections, and quick triggers (`New Connection`, `Quick Connect`, `Local Terminal`, `Key & Proxy Library`).
- Upgrade `TaskDrawer.vue` into the unified `Activity` center with filter pills: `All`, `Transfers`, `History`, `Tunnels`, `Remote Jobs`, and `Diagnostics`, preserving row detail inspection, cancellation, retries, and clean 960x640 drawer behavior.

### Bounded `RemoteJob` domain (Phase D)

- Introduce `RemoteJobRecord`, `RemoteJobState` (`queued | running | stopping | completed | failed | cancelled | outcome_uncertain`), and `StartRemoteJobInput` in `filex-contracts`.
- Bound concurrent jobs per session (max 4 active) and retain output in a bounded 256 KiB ring buffer queried by byte offset (`get_remote_job_output`) so long runs never bloat memory or IPC payloads.
- Track job ownership by `(session_id, generation)`:
  - `cancel_remote_job` requests graceful cancellation (`stopping` -> `cancelled`), followed by channel close / escalate on explicit `terminate`.
  - If the SSH session drops while a job is `running` or `stopping`, mark it `outcome_uncertain` rather than claiming `completed` or `cancelled`.
  - Clean up all running remote job tasks deterministically on session disconnect and app shutdown.

## Consequences

- Default initial paint remains clutter-free and passes existing dense-workbench layout checks.
- Long-running remote commands no longer hijack interactive PTY focus or lose exit/cancellation truth on disconnect.
- Transfers, history, tunnels, jobs, and diagnostics share one coherent inspection drawer.
