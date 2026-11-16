# FileTerm feature review and FILEX supplement plan

Status: design and acceptance review  
Review date: 2026-11-15  
Market reference: FileTerm  
Target product: FILEX

## 1. Purpose and scope

This review answers two questions:

1. Which user-facing capabilities does FileTerm currently expose?
2. Which of those capabilities should FILEX add, adapt, or deliberately avoid?

FileTerm is treated only as a market reference. FILEX must keep its own product identity, security model, architecture boundaries, terminology, and interaction design. The review does not authorize copying FileTerm implementation, copy, artwork, packaging, services, or feature-specific behavior without a separate product decision.

The user's phrase "filteterm" is interpreted as FileTerm.

## 2. Evidence

| Evidence level | Source | Use in this review |
| --- | --- | --- |
| A: live UI | The running FileTerm desktop window was inspected with Computer Use. The visible host rail, workspace tabs, connection list, overview, navigation, session states, and top-level actions were read from the accessibility tree. | Confirms the current information architecture and visible feature entry points. |
| A: official product documentation | FileTerm `README_ZH.md`, `docs/roadmap.md`, `docs/plans/completed/tauri-migration-progress.md`, and `docs/fileterm-cli.md` were read through the browser. | Confirms protocol scope, high-level behavior, agent bridge rules, implementation status, and known acceptance gaps. |
| B: official source tree | FileTerm renderer and Rust source paths were inspected for settings, background sessions, MCP call records, root access, SMB, WebDAV, transfers, and local terminal. | Identifies capabilities whose code exists but that were not exhaustively exercised in the live UI during this review. |
| A: FILEX live UI and repository | The running FILEX desktop window, `docs/PRODUCT_DESIGN.md`, `docs/ROADMAP.md`, contracts, components, and storage code were inspected. | Establishes FILEX's current implemented slice and remaining work. |

Limitations:

- FileTerm's Tauri window screenshot channel timed out and accessibility element clicks could not obtain input geometry. The main shell and navigation were verified from the live accessibility tree; interior settings and workflows were cross-checked against official documentation and source.
- Source presence does not prove release readiness. FileTerm's own roadmap says several SSH, FTP, Telnet, Serial, proxy, SMB/WebDAV, and platform scenarios remain real-device or cross-platform acceptance work.
- FILEX documentation includes implementation evidence of varying age. Features described in this report as existing are present in the current code or verified UI; they are not all equally production-hardened.

## 3. FileTerm product shape

FileTerm is a desktop workbench focused on frequent remote operations:

`connection discovery -> open session -> terminal/file work -> transfer or tunnel -> inspect status -> recover`

Its live shell has a persistent host rail, workspace tabs, a home/overview page, and a dense session workspace. FileTerm also exposes dedicated management destinations:

- Overview
- Connection manager
- Proxy and tunnel manager
- Command manager
- SSH key manager
- Background sessions
- MCP call records
- File transfer
- Settings

The overview shows total connections, SSH/SFTP, Telnet, and FTP counts, recent connections, all connections, and quick actions. Sessions remain visible in a host rail and tab strip. A focus mode can reduce surrounding panes.

## 4. FileTerm capability inventory

### 4.1 Connection and protocol coverage

| Capability | Current FileTerm behavior | Evidence |
| --- | --- | --- |
| SSH/SFTP | Profiles have create, edit, delete, folders/groups, ordering, persistence, metadata, and connection defaults. SSH shell and SFTP file access share a logical session while using separate channels. | Live UI; official README and roadmap. |
| FTP/FTPS | Separate connection model and file-only workspace. Code supports plain FTP, explicit FTPS, and implicit FTPS. | Official README and roadmap. |
| Telnet | Raw terminal transport with RFC 854 negotiation, terminal type, window size, and proxy support. | Official roadmap and source tree. |
| Serial | Serial terminal profiles with baud/data/stop/parity and hardware/software flow control. Source also contains XMODEM, YMODEM, and ZMODEM transfer support. | Official roadmap and source tree; real-device acceptance remains open. |
| Local terminal | Local shell sessions on Windows, macOS, and Linux, including configurable local shell selection. | Live navigation; official settings/source. |
| SSH Config and JSON profiles | Preview and commit import for SSH config and external JSON, plus FileTerm/compatible export. | Official migration document and source tree. |
| Multiple simultaneous workspaces | Connection tabs can stay active in parallel; visible and background sessions can be moved between the tab strip and the background-session page without reconnecting. | Live UI; official CLI documentation and source. |

Important FileTerm gaps stated by its own documentation:

- Real OpenSSH scenarios for PAM MFA, jump hosts, remote forwarding, root access, CWD events, and complete metrics still need release-candidate acceptance.
- Real FTP/FTPS, Telnet, WebDAV, and Serial devices/services are not uniformly covered across all three platforms.
- Some remote metrics are unavailable on macOS remote hosts.

### 4.2 SSH authentication, trust, routing, and recovery

FileTerm supports:

- Password, private-key, SSH Agent, and keyboard-interactive authentication.
- Multi-round MFA and interactive private-key passphrase requests.
- Host verification during connection establishment.
- A managed SSH key library with key metadata and passphrase interaction.
- Automatic reconnect with a delay and bounded guards.
- Transcript hydration after reconnect.
- Jump hosts; the current roadmap describes multi-level jump support up to eight hops.
- Outbound SOCKS5 and HTTP CONNECT proxies, including authentication.
- SSH local (`-L`), remote (`-R`), and dynamic SOCKS5 (`-D`) forwarding.
- Connection readiness and session-context queries through its local CLI bridge.

FILEX already has stronger identity and trust semantics:

- Strict SHA-256 host-key verification.
- Append-only host trust history with searchable current-versus-previous fingerprints.
- Explicit import of OpenSSH `known_hosts` with preview and transactional commit.
- Structured connection errors and no silent changed-host acceptance.

Recommended FILEX position:

- Keep FILEX's host-trust experience as a product advantage.
- Add central proxy profiles and outbound SOCKS5/HTTP CONNECT later.
- Do not weaken host verification to match FileTerm's broader convenience model.

### 4.3 Terminal workspace

FileTerm terminal capabilities include:

- xterm.js terminal rendering, resize, input/output, clipboard integration, and search.
- A floating command composer.
- Per-profile command history and command-send preferences.
- Command templates with folders, parameter placeholders, previews, and one-click sending.
- Terminal and SFTP working-directory synchronization through shell integration.
- `sudo` and `su` detection so file access can follow the terminal's current privilege context.
- System-resource summaries in the host rail, with a compact CPU/memory/swap summary when collapsed.
- Full focus mode that hides auxiliary panes.
- Multiple tabs, duplicate sessions, split panes, reconnect, and session state persistence.
- Optional session lock screen.

FILEX already has:

- xterm PTY with resize, search, selection menus, paste, ANSI/truecolor, high-contrast selection, and local clear.
- Multi-tab sessions, duplicate session, vertical/horizontal split, reconnect, retained scrollback, and focus mode.
- Terminal themes and selectable monospace typography.
- Command snippets with folders, placeholders, preview, target confirmation, and SQLite persistence.
- OSC 7 terminal directory tracking plus a verified POSIX `cd` fallback.
- Bounded terminal-output recording controls.

The main FileTerm advantage here is less a missing primitive than stronger connection between terminal history, commands, elevated access, and file operations.

### 4.4 File browser and editor

FileTerm file capabilities include:

- Local/remote dual-pane browsing and remote-to-remote transfer support in current source.
- Virtualized large-directory rendering.
- Directory tree, path bookmarks, copy path, refresh, and context actions.
- Remote read, write, create file/directory, copy, move, rename, delete, and chmod.
- Recursive chmod with apply-to-all/files/directories scope.
- Remote file content encoding support for UTF-8, UTF-16, GBK, Big5, EUC-JP, Shift-JIS, EUC-KR, and other `encoding_rs` encodings.
- Monaco editing with syntax highlighting, find/replace, language and encoding controls.
- Conflict handling and editor line-ending support.
- Root-mode SFTP using `sudo`, including staged writes and root transfer handling.
- Explicit capability reporting when the server rejects SFTP.
- SMB share and credential dialogs exist in the current source tree; release status was not independently confirmed.

FILEX already has:

- Lazy local/remote directory trees, dual-pane mode, resizable panes, and virtualized lists.
- Follow-terminal directory behavior.
- File creation, folders, upload, download, rename, move, copy, delete, chmod, and symbol-link-aware handling.
- Monaco editor, external managed editing, conflict checks, transactional overwrite, and recovery copies.
- Streaming SHA-256 comparison and read-only directory-difference preview.
- Bounded 5,000-entry comparison scans and explicit cancellation.

The important FILEX gaps are elevated file access and encoding coverage. FILEX should not automatically mimic FileTerm's passive `sudo`/`su` detection. It should add an explicit, auditable elevated-access mode instead.

### 4.5 Transfer system

FileTerm's transfer subsystem includes:

- A unified transfer center for uploads and downloads.
- Recursive folder manifests and transfers.
- Per-task progress, speed, state, pause, resume, cancel, retry, discard, and cleanup.
- Persistent transfer journal and interrupted-task recovery.
- Identity, size, and hash checks.
- Conflict policy.
- Remote-to-remote copy queues.
- Root-mode staging through a temporary location followed by a same-directory partial file and final commit.
- FTP resumable upload/download behavior and SSH transfer-channel recreation.
- Idle-sleep inhibition while transfers are active.

FILEX already has:

- A SQLite-backed durable upload/download queue.
- Conflict policies, streaming temporary files, commit-on-success, cancellation, retry, pause/resume on the same live stream, progress throttling, and interrupted-task recovery.
- Transfer activity in the task drawer and file-browser footer.
- A deliberate limitation: no byte-range resume across disconnects or full application restarts.

FILEX should close the real reliability gap before adding protocol breadth:

1. Prove transfer resumption and recovery on real disconnects.
2. Add byte-range/checkpoint resume only where protocol and file identity make it safe.
3. Add remote-to-remote transfer as a separate, confirmed operation with both source and destination visible.

### 4.6 Monitoring

FileTerm provides session-status and system-resource summaries, process views, network history, and a compact collapsed view. Its roadmap acknowledges remaining platform and real-host acceptance work.

FILEX's current implementation is materially deeper:

- CPU, memory, swap, load averages, disks, and network history.
- Process list with safe metadata and confirmed POSIX/Windows termination.
- Network interfaces, sockets, and routes.
- Listening ports.
- Systemd services.
- Disk and inode diagnostics.
- System/kernel logs.
- Docker daemon, container, image, log, and lifecycle actions.
- Session-scoped snapshots, bounded collectors, stale-state protection, and structured unsupported/permission-denied states.

FILEX should preserve this advantage. It does not need FileTerm parity in monitoring.

### 4.7 Management, security, and desktop services

FileTerm exposes or contains code for:

- SSH key manager.
- Proxy manager.
- Tunnel manager.
- Background session manager with source labels for GUI, CLI, and MCP sessions.
- MCP call-record viewer with action, approval state, result, duration, and JSON detail.
- Agent and MCP settings.
- AI Copilot provider/model settings, including cloud and local OpenAI-compatible endpoints.
- Conversation and history surfaces.
- Session lock.
- WebDAV/S3 configuration sync and encrypted backup concepts.
- Diagnostic logs and log-directory access.
- Signed Windows updates and multi-platform package delivery.
- Interface, local-terminal, AI, agent, connection, security, sync, update, tool, system, and language settings pages.

FILEX already has:

- OS credential-store secrets and non-serializable secret leases.
- AI provider presets, OS credential references, opt-in external-data consent, redaction, cancellation, timeouts, and bounded history.
- Explain and draft modes; generated commands and change plans are display-only and never execute.
- SQLite backup/restore, rollback protection, scheduled backups, diagnostics export, signed update feeds, and explicit update installation.
- Theme, font, layout, locale, shortcut, and update preferences.

The most important FileTerm advantage is its local CLI/MCP bridge. It is not merely a chat assistant:

- External clients connect to the running desktop app over local stdio.
- Sessions remain owned by the desktop application.
- Background sessions can be listed, attached, and hidden without reconnecting.
- Bounded remote commands can run in the background with output offsets and command IDs.
- Read-only, safe-operation, and full-access permission modes exist.
- Mutating actions can require an in-app user approval.
- Requests have request IDs, bounded concurrency and queueing, cancellation, safe-to-retry metadata, and unknown-outcome handling.
- Calls are auditable through the MCP call-record page.

FILEX should not begin with a "full access" automation mode. A read-only bridge and approval-gated operations are the defensible path.

## 5. Feature comparison

| Domain | FileTerm | FILEX now | Decision |
| --- | --- | --- | --- |
| SSH terminal | Password/key/agent/MFA, reconnect, transcript, search, command bar | Password/key/agent, ProxyJump route, reconnect, split panes, search, recording, rich terminal controls | Keep FILEX baseline; add selected workflow polish. |
| Host trust | Host verification | Append-only trust ledger, fingerprint history, previewed `known_hosts` import | Preserve FILEX advantage. |
| Protocol breadth | SSH, SFTP, FTP/FTPS, Telnet, Serial, local terminal | SSH/SFTP only | Add local terminal first; evaluate FTPS, then FTP/Telnet/Serial through separate slices. |
| Profiles | SSH/FTP/Telnet/serial, folders, import/export | SSH profiles, favorites, groups, recent, SSH config import, JSON export | Add complete JSON import and encrypted portable export; keep safe export defaults. |
| Proxy and routing | Outbound proxies, jump hosts, `-L/-R/-D` | ProxyJump routes, local/remote/dynamic tunnels | Add outbound proxy profiles; keep strict endpoint validation. |
| File browser | Local/remote, remote-to-remote, bookmarks, large-list virtualization | Local/remote, virtualized, follow-terminal, context actions, comparison and diff | Add remote-to-remote transfer and path bookmarks. |
| File privileges | Root synchronization via `sudo`/`su` | SFTP under the SSH account only | Add explicit elevated-access lease with confirmation, not passive password capture. |
| File encoding | Broad remote content encoding | Mostly UTF-8 text editing/preview | Add configurable supported encodings for editor and terminal. |
| Transfer | Unified center, resume, recursive, remote-to-remote | Durable queue, recursive, pause/resume in live stream, recovery, no cross-restart byte resume | Close reconnect/restart resume acceptance, then remote-to-remote. |
| Monitoring | Resource summaries and process/network views | Deeper monitoring, Docker, DevOps, process controls | Preserve FILEX advantage and finish platform verification. |
| Command reuse | Command manager, per-profile history, floating composer | Snippets with folders/placeholders, no separate command history UI | Add per-profile history and optional compact composer after UX validation. |
| Background work | Background sessions, long jobs, CLI/MCP call audit | Transfers, tunnels, monitor cancellations; no persistent remote-job domain | Add an internal operation center, then a read-only bridge. |
| AI | Copilot and external agent bridge | Safe explain/draft assistant with opt-in context | Preserve safety model; add explicit copy-to-terminal and later staged tools. |
| Secrets | Key manager; some local plaintext-secret fallback described in migration history | OS credential store and zeroized secret leases | Preserve FILEX advantage; never adopt plaintext fallback. |
| Backup/sync | Backup/security and WebDAV/S3 sync surfaces | SQLite backup/restore, scheduled local backup, diagnostics | Add encrypted portable backup before any remote sync. |
| Theme/settings | Rich presets, imported fonts, AI/agent/sync/session-lock pages | Themes, fonts, layout, locale, shortcuts, AI, security, storage, updates | Add custom palette import/export and session lock only if user research supports them. |
| Desktop | Focus mode, manager pages, transitions | Focus mode, command palette, resizable panes, signed updates | Preserve FILEX shell grammar; add a compact overview/activity destination. |

## 6. What FILEX should inherit, adapt, or replace

| Area | Inherit | Adapt | Replace or avoid |
| --- | --- | --- | --- |
| Dense desktop shell | Host rail, tabs, resizable panes, focus mode, compact status | Add overview and activity filters to FILEX's existing shell | FileTerm branding, exact tabs, copy, window flow, artwork |
| Terminal UX | Search, selection, history access, command reuse | Per-profile history, optional compact composer | Hidden send, automatic command execution, floating-bar duplication by default |
| File UX | Dual panes, virtual lists, editor, recursive permissions | Explicit elevated mode, encoding selector, remote-to-remote copy | Passive `sudo` tracking and plaintext credential fallback |
| Transfer UX | Unified queue, bounded progress, retry and recovery | Identity-aware restart resume and two-endpoint target review | Claims that every protocol can resume safely |
| Monitoring | Compact summaries | FILEX's richer process/network/Docker/DevOps flows | FileTerm's feature scope as a ceiling |
| Management pages | Overview, connections, keys, transfers, background jobs, settings | One activity center with filters instead of several disconnected drawers | Duplicated managers that each own separate session state |
| AI and automation | Local bridge, approval model, explicit source and audit record | Read-only first, typed operations, no silent mutation | "Full access" mode, autonomous loops, plaintext secrets, raw transport access |
| Protocol expansion | Separate protocol controllers and file-only modes | Secure-default FTPS; explicit warnings for legacy protocols | Letting legacy protocol complexity leak into the SSH session model |
| Persistence | JSON/SQLite choices not required | SQLite migrations, atomic writes, structured errors | GITBX/FileTerm storage keys, data shapes, or release identifiers |

## 7. Recommended FILEX supplement plan

### Phase A: close the current acceptance baseline

This phase is mandatory before broad feature expansion. FILEX already has a large implementation surface, but several high-risk paths remain platform- or host-gated.

Scope:

- Complete private-key and SSH Agent live authentication acceptance.
- Complete mapped ProxyJump route acceptance, including upstream teardown and reconnect.
- Verify tunnel start/stop/session-disconnect/app-exit behavior on real hosts.
- Verify SFTP upload/download resume and recovery after actual network interruption and application restart.
- Verify monitoring collectors and Docker/DevOps parsers on representative Linux and Windows hosts; record macOS support or limits explicitly.
- Verify terminal encoding, external editing, conflict detection, and recovery under failed saves.
- Run minimum-window, enlarged-font, keyboard, dark/light, and localization checks for the current shell.

Exit criteria:

- Every advertised capability has a live acceptance record or an explicit unsupported/not-yet-verified note.
- No secret reaches ordinary settings, logs, prompts, transfer history, or diagnostics.
- No destructive action can proceed without clear host, path, process, container, or endpoint context.

### Phase B: high-value parity with low protocol risk

#### B1. Local terminal

Add a local PTY session type without pretending it is an SSH profile.

- Domain object: `LocalShellProfile` with shell kind, executable path, working directory, environment allowlist, and safe layout preference.
- Capabilities: shell selection, new tab, resize, search, copy/paste, terminate, local directory follow.
- Security: executable allowlist or explicit picker confirmation; no arbitrary environment dump; no shell command injection through profile fields.
- Reuse the existing terminal renderer; do not reuse SSH credentials or remote monitoring adapters.

Why first: it adds immediate utility, follows FileTerm, has no new remote protocol or credential surface, and strengthens FILEX's position as a local-first workbench.

#### B2. Explicit elevated file access

Add an opt-in `ElevatedAccessLease` for SFTP operations.

- Initiated by the user from the file browser or session details.
- Explains the target host, account, file scope, and elevated account.
- Accepts a password only through a secure interaction dialog; never through a normal profile or command string.
- Holds secrets in a zeroizing, non-serializable lease.
- Labels the file pane and transfer target visibly while elevated.
- Expires on timeout, session close, host change, or explicit revoke.
- Does not infer passwords from terminal keystrokes and does not require terminal `sudo` parsing.
- Backend revalidates the session identity and operation scope for every write, chmod, delete, or transfer.

This adapts a useful FileTerm workflow while improving its security posture.

#### B3. Central key and proxy libraries

Add management surfaces for:

- Imported SSH keys: metadata, algorithm, fingerprint, source, last use, and associated profiles.
- Key actions: validate, attach to profile, rotate reference, and confirmed delete.
- No key-content export from the UI.
- Outbound SOCKS5/HTTP CONNECT proxy profiles with endpoint validation, OS-credential references, and connection preflight.

Both libraries should be typed application services. Presentation must not read key files or open sockets directly.

#### B4. Per-profile command history and optional composer

- Keep history device-local and bounded.
- Exclude secret-bearing input, hidden terminal input, and terminal password prompts.
- Provide search, copy, insert, execute-after-confirmation, and clear.
- Make the compact composer optional so it does not consume terminal space by default.
- Keep snippet variables, validation, preview, and target context consistent with the existing snippet workflow.

Exit criteria:

- Local terminal, elevated access, key/proxy libraries, and command history all have keyboard, empty, loading, error, disconnected, and stale-target behavior.
- Elevated operations are impossible through a stale lease.

### Phase C: file and transfer completeness

#### C1. Remote content encoding

- Add `encoding_rs`-backed decode/encode for editor previews, saves, and terminal input where applicable.
- Start with UTF-8, UTF-16LE/BE, GBK/GB18030, Big5, Shift-JIS, EUC-JP, and EUC-KR.
- Detect unsupported mappings explicitly and refuse lossy input.
- Show the chosen encoding beside the file path and persist it per file type or user preference.

#### C2. Remote-to-remote transfers

- Add a two-endpoint transfer target explicitly showing source host/path and destination host/path.
- Require confirmation when either side differs from the active saved profile.
- Use the existing transfer journal and state machine rather than a second task system.
- Define a staging policy, conflict policy, size/hash verification, cancellation, and cleanup behavior for every source/destination protocol pair.
- Never imply direct peer-to-peer transfer when FILEX actually relays through the local client.

#### C3. Restart-safe resume

- Store an operation identity containing profile, protocol, canonical paths, file size, modification identity, conflict policy, and protocol-specific checkpoint.
- Resume only when identity checks pass.
- Verify final size/hash and commit atomically.
- Surface "safe to resume", "restart from beginning", and "identity changed" as separate states.

#### C4. Path bookmarks and transfer history

- Add bounded local/remote path bookmarks with rename and confirmed delete.
- Add a transfer-history view separate from the durable active-task journal.
- Exclude secrets and avoid retaining remote paths in AI or diagnostics unless the user explicitly selects them.

Exit criteria:

- Interrupted, offline, permission-denied, changed-file, and destination-conflict cases are first-class.
- No transfer claims universal resume across protocols where the server cannot support it.

### Phase D: internal operation center and long-running jobs

FileTerm's CLI/MCP bridge depends on a robust session-owned background-command model. FILEX should build that internal model first.

Add a `RemoteJob` domain:

- Fields: job ID, session ID, target snapshot, command or operation kind, risk class, state, timestamps, bounded output, exit state, and recovery metadata.
- Commands are fixed requests; no hidden shell fragments assembled by the UI.
- One session may have a bounded number of jobs.
- Output is streamed into a ring buffer with offsets and retention limits.
- Pause is supported only where meaningful; cancel and terminate are distinct.
- Completion, cancellation, uncertain outcome, and session loss remain distinct.
- All jobs appear in one Activity center alongside transfers and tunnels.
- No unattended loops, batch command broadcasting, or background mutation.

UI:

- Add one compact Activity destination with filters for Transfer, Tunnel, Remote job, and Diagnostic.
- Each row exposes target host, operation, state, duration, cancellation, and safe next action.
- Selecting a row opens details without replacing the active terminal.

Exit criteria:

- Every long-running operation is cancellable, bounded, observable, and cleaned up on app exit.
- Unknown outcomes are never presented as definite failure or silently retried.

### Phase E: read-only local automation bridge

Only after the operation center is stable should FILEX expose a local integration surface.

Start with a read-only bridge:

- Local stdio only.
- Short-lived capability token or process-bound authentication.
- Read-only actions: list profiles without secrets, inspect connection state, list sessions, list bounded remote jobs, inspect transfer/tunnel state, and retrieve structured error codes.
- No file write, terminal send, tunnel start, process signal, Docker mutation, or credentials.
- Every request has an ID, timeout, cancellation, bounded queue, and structured error.
- External sessions are labeled `CLI` or `MCP` and auditable.

Then add approval-gated draft or mutation operations one capability at a time:

- The proposal includes target host, operation, parameters, risk class, expected effect, and retention.
- The desktop window shows the request source and exact confirmation.
- Reject stale targets and changed host identity.
- Never provide a silent "full access" mode in the first release.
- Keep interactive MFA, password prompts, and device unlock in FILEX's own UI.

This creates a defensible alternative to FileTerm's broad bridge while preserving FILEX's product invariants.

### Phase F: protocol expansion through separate design slices

Protocol expansion should be sequenced by user value and threat model, not by copying FileTerm's feature list.

Recommended order:

1. FTPS and FTP file-only workspace.
2. Telnet terminal workspace.
3. Serial terminal workspace.
4. SMB/WebDAV/S3 sync only if user research justifies the complexity.

FTPS/FTP requirements:

- A separate `FileConnection` model and protocol controller.
- Default to FTPS; plain FTP requires an explicit insecure warning.
- Explicit and implicit TLS support.
- No SSH monitor/tunnel/session assumptions.
- File operations, transfer queue, cancellation, conflict policy, and cleanup reuse shared transfer contracts.
- Pretend no monitoring or terminal capability exists for file-only profiles.

Telnet/Serial requirements:

- Separate terminal transports.
- Explicit "no encryption" warning for Telnet.
- No secret-bearing command history by default.
- Serial device allowlist, flow control, disconnect handling, and bounded reconnect.
- Hardware protocols such as XMODEM/YMODEM/ZMODEM require their own cancellation and integrity design.

Do not place FTP, Telnet, or Serial behind the SSH profile type merely to reduce branching. Separate models prevent cross-protocol capability leakage and are easier to test.

## 8. UI and interaction recommendations

Keep FILEX's current dense workbench and add capability without turning it into FileTerm's visual clone.

### Workbench shell

- Preserve the connection rail, top session tabs, terminal, file browser, inspector, AI panel, and status bar.
- Add a compact `Overview` destination reachable from the FILEX product mark or command palette.
- Add a single `Activity` destination with filters rather than separate permanent drawers for transfers, tunnels, and jobs.
- Keep management pages as detail surfaces or modal workspaces; do not duplicate live session state in each page.

### State language

- Host identity: trusted, unknown, changed.
- Session: connecting, connected, degraded, reconnecting, disconnected, closed.
- Privilege: normal, elevated, expired, permission denied.
- Transfer/job/tunnel: queued, running, paused, stopping, completed, failed, cancelled, outcome uncertain.
- Every state uses text and icon in addition to color.

### Elevated access

- Show a persistent amber `Elevated` badge in the terminal footer and file browser.
- Include host and effective account in the tooltip and confirmation.
- Require explicit reauthorization after session identity changes.
- Do not show the password or retain it in component state longer than the secure interaction requires.

### External automation

- Show `Local`, `CLI`, or `MCP` source beside sessions and operations.
- Show approval scope in one dialog that names target, source, operation, and effect.
- Provide a one-click revoke capability for external bridge sessions.

## 9. Architecture recommendations

Introduce capability-focused modules rather than expanding the existing SSH runtime:

```text
crates/
  filex-contracts/
  filex-core/
  filex-local-terminal/
  filex-privilege/
  filex-remote-jobs/
  filex-file-protocols/
  filex-proxy/
  filex-local-bridge/
```

The exact crate split should follow a vertical slice, not be created wholesale.

Suggested contracts:

```ts
type CapabilityKind =
  | 'terminal'
  | 'file'
  | 'monitor'
  | 'tunnel'
  | 'remoteJob'

type PrivilegeState =
  | { kind: 'normal' }
  | { kind: 'elevated'; leaseId: string; expiresAt: string; account: string }
  | { kind: 'expired' }
  | { kind: 'denied'; error: AppError }

type RemoteJobState =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcomeUncertain'
```

Rules:

- Presentation calls typed domain facades only.
- Protocol adapters implement shared capability interfaces but may report unsupported capabilities.
- Session identity and target snapshots are captured before each mutating request.
- Long operations hold a generation/run handle, not an unbounded component callback.
- All output and queues are bounded.
- All secrets enter through secure interaction or OS credential references.
- Every write uses atomic/commit-on-success behavior and preserves structured errors.

## 10. Delivery sequencing and acceptance gates

| Order | Slice | Why | Primary acceptance |
| --- | --- | --- | --- |
| 1 | Current-risk acceptance closure | Existing breadth outruns verification | Live SSH/key/agent/ProxyJump/tunnel/SFTP/monitor/platform matrix |
| 2 | Local terminal | High user value, low protocol risk | Windows/macOS/Linux PTY, shell selection, resize, disconnect, persistence |
| 3 | Elevated access lease | High-value file workflow with a secure FILEX treatment | Timeout/revoke/stale lease, no plaintext/keylogging, confirmed destructive operations |
| 4 | Key/proxy libraries | Completes connection management | Import/validate/attach/delete; proxy preflight and credential references |
| 5 | Command history + optional composer | Improves daily terminal work | Secret exclusion, bounded history, keyboard and stale-target behavior |
| 6 | Encoding and remote-to-remote transfer | Closes file-workflow gaps | Lossless encoding, dual-target confirmation, cancellation, cleanup, identity checks |
| 7 | Activity and remote jobs | Provides safe foundation for automation | Bounded output, cancel, app-exit cleanup, uncertain-outcome state |
| 8 | Read-only CLI/MCP bridge | Adds integration value after the operation model exists | Local-only auth, audit, queue, cancellation, no secret exposure |
| 9 | FTPS/FTP slice | First market-relevant protocol expansion | Explicit/implicit FTPS, plain FTP warning, file-only UI, transfer recovery |
| 10 | Telnet/Serial slices | Depends on validated network-device demand | Secure warnings, device handling, bounded sessions, protocol-specific tests |

Do not start Phase 7 or 8 before Phases 1-6 have stable target identity, cancellation, and error semantics.

## 11. Measurable acceptance checklist

### Product parity

- A user can open a saved SSH host, local terminal, and remote file browser from one persistent workbench.
- The active target is always visible in the terminal, file browser, monitor, transfer, tunnel, and activity context.
- Connection profiles can be imported and exported without leaking credentials or private-key content.
- Command snippets and history cannot send to a stale or different host without revalidation.

### Security

- Unknown and changed host keys are never silently accepted.
- No password, passphrase, API key, private-key block, hidden terminal input, or elevated credential appears in ordinary settings, logs, chat history, transfer history, job output, or diagnostics.
- Elevated access has explicit start, visible state, expiry, revocation, and backend revalidation.
- Automation bridge credentials are local and narrowly scoped; no unrestricted filesystem or shell capability is exposed.

### Reliability

- Every remote mutation has a structured error and a recoverable state.
- Every long operation can be cancelled and has a bounded queue/output/cache.
- App exit cancels or safely settles sessions, jobs, transfers, tunnels, and listeners.
- Stale async results cannot overwrite a newer target or session selection.

### UI and accessibility

- Critical workflows work at 1440 x 900 and the minimum supported window.
- Dark/light themes, keyboard-only operation, focus trap, focus restoration, Escape behavior, enlarged text, and supported locales pass.
- Dense rows retain truncation, hover/focus actions, and accessible labels.
- No status relies on color alone; reduced-motion preferences are respected.

### Verification evidence

- Unit tests for state machines, privilege expiry, job transitions, encoding validation, and redaction.
- Contract tests for local, SSH, FTPS, Telnet, and Serial capability differences.
- Integration tests for credential references, host trust, remote jobs, transfer resume, and tunnel cleanup.
- E2E for the critical SSH/file/transfer/activity workflow, theme/locale switching, error recovery, and minimum layout.
- Live evidence from Windows plus one additional desktop platform for high-risk native features.

## 12. Deliberate non-goals

The review does not recommend adding the following in the same phase:

- A silent or permanently enabled "full access" automation bridge.
- Autonomous background mutation or multi-host broadcasting.
- Passive capture of terminal passwords for `sudo` or `su`.
- Plaintext secret storage or FileTerm-compatible storage internals.
- Remote configuration sync before encrypted portable backup and key-rotation semantics exist.
- SMB, WebDAV, S3, Kubernetes, or database consoles merely to match a competitor checklist.
- Copying FileTerm visuals, labels, icons, transition timing, overview artwork, or release packaging.

## 13. Recommended immediate next decision

Start with:

1. The Phase A acceptance closure.
2. A design-only local-terminal slice.
3. A security design for explicit elevated file access.

These three items improve daily use and close high-risk gaps without committing FILEX to FileTerm's much broader protocol and external-automation surface.
