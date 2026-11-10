# FILEX design-to-delivery roadmap

The repository completed the Phase 0 baseline and started Phase 1 foundation implementation on 2026-11-01. Dates for protocol delivery remain intentionally omitted until the SSH engine and terminal-renderer spikes establish realistic effort.

## Phase 0 — design baseline

Deliverables:

- Product scope, users, domain objects, flows, states and explicit exclusions.
- Workbench shell, screen specifications, token system and accessibility model.
- Architecture boundaries, security model, data model and test strategy.
- Version-controlled design skill.

Exit criteria:

- No unresolved contradiction between product, UX and architecture documents.
- P0/P1/later boundaries are explicit.
- Host trust, credentials, logging and destructive operations have written policy.
- First vertical slice and technology spikes are defined.

## Phase 1 — technical spikes and project foundation

Status: **implemented**

Implemented foundation:

- Vue 3/Vite/Pinia workbench shell with semantic dark/light tokens and Chinese/English locale skeleton.
- Typed connection-profile API facade with browser persistence and Tauri command adapter.
- Rust `filex-contracts` and `filex-core` crates with structured errors, profile validation and tests.
- SQLite profile repository with versioned transactional migrations and restart-persistence coverage.
- OS credential-store adapter with a zeroizing, non-serializable secret lease and runtime availability probe.
- Tauri 2 shell with restrictive CSP and a minimum `core:default` capability set.
- Settings persistence for safe appearance/layout preferences; no secret-bearing setting is serialized.
- `russh` SSH engine and xterm.js PTY renderer selected and integrated behind typed application boundaries.

Verification evidence is recorded in `docs/VERIFICATION.md`. The SQLite migration, credential-store probe, SSH engine and terminal renderer spikes are implemented.

Deliverables:

- SSH engine ADR with working PTY, host-key, auth, cancellation and forwarding probes.
- Terminal-renderer ADR with throughput, CJK IME, accessibility and memory evidence.
- Tauri/Vue/Rust workspace, semantic tokens, i18n skeleton and CI gates.
- SQLite migration framework and credential-store capability probe.

Exit criteria:

- Windows, macOS and Linux compile checks.
- No secret crosses a serializable/loggable boundary in tests.
- Production-build shell meets initial startup and layout acceptance.

## Phase 2 — trusted SSH vertical slice

Status: **in progress**

Implemented foundation:

- Durable connection profile create, edit, duplicate and delete flows, with persisted groups, searchable tags, and favorites that can be toggled and filtered from the connection pane.
- Selectable default SSH Config import preview with unsupported-directive warnings.
- Append-only host trust ledger and unknown/trusted/changed evaluation.
- OpenSSH `known_hosts` import with an exact-host preview, visible skipped-entry warnings, candidate/current fingerprint comparison and explicit confirmation. Trust changes remain append-only, and SQLite compares the preview snapshot and commits the batch in one immediate transaction.
- Strict SHA-256 host-key verification, password, private-key and SSH Agent authentication, and bounded SSH connection setup.
- Real PTY input/output/resize, multi-tab buffers, disconnect and generation-safe reconnect. Terminal search covers xterm scrollback with case-insensitive next/previous navigation through Ctrl/Cmd+F. Duplicate sessions open an independent SSH PTY. Vertical and horizontal two-pane layouts bind each pane to its own session and size, retain disconnected scrollback, and can be collapsed without closing the session tab. The shared connection-map lock is released before terminal channel I/O; one terminal's input, resize and close operations remain serialized by its own channel lock.
- The connection editor exposes password, private-key and SSH Agent authentication. Private-key profiles select identity files through the native picker and store passphrases only in the OS credential store. Agent signing is bound to the verified SSH session, capped at six identities, and never forwarded to the remote host. Imported `ProxyJump` aliases map explicitly to an ordered route of saved direct profiles; the runtime now probes and authenticates each hop with that profile's trust and credentials and keeps upstream sessions until destination disconnect.
- Quick connect opens a direct password-authenticated SSH session without creating a durable connection profile. The temporary profile is scoped to its session in runtime memory, the host key still uses the append-only trust ledger, and the one-time password reaches only one authentication operation. Cancellation, failure, disconnect, remote closure, restore and shutdown clear temporary state. Terminal, monitoring and direct SFTP remain available; durable transfer queue, saved tunnel rules and duplicate-session actions require a saved profile. See ADR-0019.
- SSH Config imports use password authentication because the file contains no password. Imported `IdentityFile` remains inert metadata until a user switches the profile to private-key authentication and selects a key file.
- Terminal settings provide 14 built-in palettes: an adaptive FILEX palette, FILEX dark/light, and established dark/light community schemes. The settings browser previews prompt, regular output, normal/bright ANSI colors, cursor and selection without mutating persisted state; Cancel closes with no save, and Apply and save is the only commit action. Selecting a theme updates open xterm panes from one typed palette resolver, including all 16 ANSI colors. Legacy `dark`/`light` settings migrate to `filex-dark`/`filex-light`, while older settings without a terminal palette receive `match`.
- Terminal settings persist UTF-8, GBK, Big5, Shift_JIS or Windows-1252 encoding. Output bytes are decoded incrementally and replayed from the bounded session buffer after an encoding change; keyboard and snippet input are converted before SSH write. Input characters that cannot be represented fail visibly rather than being silently replaced.
- Terminal session logging is off by default and requires both the Settings capability gate and a per-session confirmation that names the endpoint and raw-output risk. Output bytes flow through a bounded asynchronous queue into app-managed `logs/terminal` files with owner-only Unix permissions, a 16 MiB per-log cap, explicit limit/overflow/failure states, and cleanup on stop, disconnect, PTY closure and shutdown. Completed logs are pruned to 24 files and 30 days; logs are excluded from SQLite, backups, diagnostics, exports and AI context.

The terminal palette browser, preview-without-save, explicit commit and restart persistence are verified in browser E2E at dark and light themes. Native Tauri xterm visual verification after a palette change, cross-platform palette rendering and encoding behavior remain pending. A 2026-11-07 live Windows password-authentication flow reached the real Tauri WebView and passed host trust, PTY prompt/echo/output, command-bar submission and terminal search. xterm search now enables the proposed API required by its search addon. Private-key/Agent live flows and cross-platform checks remain open.

Deliverables:

- Profile management, SSH config import preview, and non-secret profile export.
- Host-key verification and trust ledger.
- Password, private-key and SSH Agent authentication are source-wired for direct and mapped jump-profile routes. Route snapshots reject profile changes between host-key verification and authentication, failures tear down upstream sessions in reverse order, and desktop shutdown cancels pending routes. The local SSH fixture covers PTY and remote-forward transport; cross-platform fixtures and live-host route checks remain pending. See ADR-0014 and `docs/VERIFICATION.md`.
- Multi-tab terminal, reconnect and sanitized event timeline.

Exit criteria:

- End-to-end connection path passes DNS, timeout, unknown key, changed key, auth rejection, remote close and reconnect cases.
- Terminal remains responsive under bounded high-output tests.
- Dark/light, Chinese/English, keyboard and minimum-window acceptance passes.

## Phase 3 — SFTP and durable transfers

Status: **in progress**

Implemented slice:

- Session-bound SFTP directory browsing with bounded entry counts. SFTP operations clone their session handle under the connection-map lock, release the lock, and then perform network I/O.
- Persisted dual-pane local/remote browser with independent paths, selections and loading state; upload/download use the durable transfer queue.
- Local and remote file rows display POSIX permission mode bits when supplied by the filesystem or server; symlinks are not followed for metadata, and unsupported local modes remain unavailable instead of being guessed.
- Local folder creation, same-directory rename and confirmed deletion; directory deletion is non-recursive and only succeeds for empty folders.
- Local and remote moves to an existing destination directory, retaining the item name, rejecting existing targets, and preventing a directory from moving into itself.
- Same-side copy for local and remote regular files and directories, with an editable destination name and permission preservation where available. Directory copies reject symlinks and special entries, scan at most 5,000 descendants and 16 levels, and build a sibling staging tree before committing. Remote copies remain capped at 8 GiB and 10 minutes; existing destinations are rejected. Copy can be cancelled during scanning and streaming; the final commit cannot be cancelled, and pause is not available. On application exit, new copies are blocked, active copies receive a cancellation request, and shutdown waits up to five seconds for staging cleanup before closing SSH sessions; after a timeout it proceeds with best-effort cleanup.
- Native file and folder drag-and-drop queues local-to-remote uploads and remote-to-local downloads. A typed backend inspection validates each dropped local path before enqueueing.
- Queued upload/download supports recursive directories, bounded to 5,000 descendants, 16 levels and 4,096-byte composed paths. Progress aggregates file bytes. Pause and cancel operate at stream boundaries; retry after a failed stream starts from byte zero. Overwrite into an existing directory merges descendants and replaces matching regular files; failures can leave completed files in that existing tree. A missing destination directory is staged and renamed after success, with best-effort cleanup after failure.
- Read-only UTF-8 text preview capped at 1 MiB; symlinks, special files, binary data and unsupported encodings are rejected.
- UTF-8 text editor for complete files up to 1 MiB, with content revision conflict detection and recoverable same-directory replacement.
- Confirmed remote file, symbolic-link and empty-directory deletion; recursive deletion is not available.
- Remote empty-directory creation with single-name validation and duplicate protection from the SFTP server.
- Same-directory remote rename with basename validation and no client-side overwrite step.
- External open through the OS default application using a bounded local copy (32 MiB); startup prunes copies older than 30 days.
- Durable upload/download queue with conflict policy, chunk-boundary pause/resume, cancellation, retry and interrupted-task recovery. Active-stream progress writes are throttled to four per second, with pause and completion updates; a paused task resumes on the same live stream and session.
- Tasks whose stream or SSH session ends can be retried through a fresh run; byte-range resume across disconnects or application restarts is not claimed.
- Streaming temporary-file transfer and commit-on-success behavior.

Deliverables:

- Local and remote browser pairing for direct cross-machine transfers (implemented through queued upload/download).
- Upload/download queue, conflict policy, cancellation, retry and interrupted-task recovery.
- Bounded preview, safe text editor and bounded external-open path (implemented).

Exit criteria:

- Large file, directory, symlink, unicode, permission, disconnect and partial-failure fixtures pass.
- Temporary artifacts are cleaned on every failure path.
- UI never claims universal resume or atomic commit when unsupported.

## Phase 4 — monitoring and tunnels

Status: **in progress**

Implemented slice:

- Bounded, read-only Linux, macOS and Windows metric probes with explicit unsupported state when platform metrics are unavailable; the persisted 15/30/60-second refresh interval runs only while the Monitor view is open, its session is connected, and the app is foregrounded. Repeated collection failures exponentially back off to at most five minutes and are surfaced in the panel; unsupported or permission-denied collectors stop automatic polling but remain manually refreshable.
- Source-wired CPU utilization, swap usage and network receive/transmit rates for Linux, macOS and Windows. Probes omit individual values they cannot collect; runtime accuracy and availability still need platform verification.
- Local SSH port-forward instances with deterministic cancellation and non-loopback exposure confirmation.
- Dynamic SOCKS5 CONNECT forwarding through the active SSH session, with IPv4, IPv6 and domain destinations.
- SQLite-backed per-profile tunnel rule create, list, update and delete flows; saved rules can be selected in the start dialog.
- Saved local and dynamic tunnel rules can opt into automatic start after the matching SSH profile connects. The core rejects automatic start for remote forwards and non-loopback binds, and failures are recorded in the event console.
- SSH remote TCP forwarding with bounded forwarded-channel dispatch and local destination bridging.
- Tunnel shutdown now exposes a stopping state, closes active forwarded channels and waits for listener cleanup. Each listener caps concurrent forwarded connections at 64. Remote cancellation is bounded; a denied or unconfirmed cancellation leaves a failed status with guidance to disconnect the SSH session. Session disconnect keeps tunnels in stopping until their workers clean up and confirms remote forwards only after SSH disconnect succeeds. Desktop exit asynchronously disconnects SSH sessions, cancels all tunnels and waits for bounded cleanup before exiting. The UI refreshes live tunnel states while active and continues checking an unconfirmed remote cancellation until disconnect resolves it.
- Server rejection of remote forwarding is classified separately from SSH transport failure, returned as a non-retryable structured error, and localized with the relevant server policy settings.
- Added a loopback SSH fixture covering host-key probe/mismatch rejection, password authentication, PTY input/output, remote-forward channel delivery/cancellation and server shutdown. It runs and passes on Windows since the `request_remote_forward` port-handling fix (a successful `tcpip-forward` reply for a specific port has an empty body, which russh maps to `Ok(0)`).

Still open in this phase: verify tunnel lifecycle and live-host monitoring capability and metric accuracy across Linux, macOS and Windows after the development environment is configured.

Deliverables:

- Capability-probed read-only collectors.
- Live/stale/unsupported/permission-denied metric states.
- Local, remote and dynamic tunnel rules and instances.

Exit criteria:

- Monitoring does not pollute terminal history or overload unsupported hosts.
- Tunnel listeners close deterministically on session/app shutdown.
- Non-loopback exposure and port conflicts have tested warnings and recovery.

## Phase 5 — productivity and hardening

Status: **in progress**

Implemented slice:

- Resizable connection, inspector and task panes with pointer and keyboard controls.
- Borderless Windows shell with delayed first show, draggable context bar, app-owned minimize, maximize/restore and close controls, and a GUI-subsystem release executable so startup does not expose a console window.
- SQLite-authoritative safe settings for appearance, terminal, connection behavior, layout, logging, backup schedule and update channel.
- Shared confirmation dialog, multiline paste confirmation, editable and persistent keyboard shortcuts with per-page reset, a searchable keyboard-accessible command palette, and a bounded sanitized event console.
- Storage settings resolve the read-only application data and backup locations through the platform application-path service instead of displaying a Windows-only placeholder.
- Consistent SQLite backup and a versioned, user-selected diagnostics JSON with SQLite runtime/schema versions, database size, quick integrity/foreign-key state, credential-store state and updater readiness. It excludes paths, profile data, logs, terminal/assistant content and secrets.
- User-selected manual export of a consistent full local SQLite snapshot, with an explicit contents warning; scheduled backups remain in the app-managed directory.
- Validated SQLite backup restore with schema migration, integrity checks, busy-session protection and rollback snapshot.
- Creating a manual backup automatically fills the restore path field; a native single-file picker can select older backups, and manual path entry remains available.
- Daily/weekly automatic backups run from the configured schedule and use SQLite snapshots.
- Automatic backup snapshots rotate to the 30 most recent files; manual backups are retained separately.
- GitHub Actions quality and browser E2E workflows cover Linux and Windows Rust checks. Stable tags produce a signed multi-platform draft release only after version, `Cargo.lock`, Changelog, updater configuration and release-note checks pass.
- Playwright E2E covers profile persistence, keyboard pane resizing, the password default and three authentication options, the ProxyJump preflight error and the browser-to-desktop boundary; it attaches runtime diagnostics and fails on page errors, console errors, and failed requests. Private-key and Agent desktop authentication, platform agent discovery, and cross-platform lifecycle coverage remain pending. The `filex-ssh` local password/PTY/remote-forward lifecycle fixture runs and passes on Windows; packaged WebView PTY output and terminal-search acceptance remain pending.
- Signed update checks and installation are wired through the settings panel and Tauri updater. Checks time out after 30 seconds; downloads expose bounded progress and can be cancelled before the verified installer starts. Release builds use product-specific GitHub and CNB stable feeds in fallback order. FILEX v0.1.0 was built for Windows, Linux and macOS, passed the exact asset, `latest.json`, detached-signature and signed-version gates, and was published through both stable feeds with a product-specific updater key. Packaged update installation on each platform remains pending.
- Command snippets in the connections navigation: up to 200 SQLite-persisted templates, `{{parameter}}` inputs, a bounded preview and confirmed deletion. Sending a selected template writes it to the connected SSH PTY after a second confirmation showing the host and expanded command; the remote shell receives and may execute it.
- Recent connections are recorded after successful authentication and persisted on each connection profile; the Recent view is sorted by last connected time and can reopen or reconnect a host.
- The connections navigation's Tunnels view lists SQLite-persisted rules and live instances, opens rules for editing, confirms deletions with their effect, confirms non-loopback exposure, starts a rule on a connected session, and prevents starting the same active rule twice.
- The Recent, Tunnels and Snippets navigation modes collapse the unused connection search row so each view uses the full sidebar height.
- Security settings expose the full append-only host fingerprint ledger with current-versus-history status, source, previous fingerprint, first/last-seen times, search and explicit refresh.
- Versioned JSON export of connection profiles through a localized native save dialog. It excludes credential references, private-key paths, local runtime state, trust history, events, transfers, snippets, and AI conversations; JSON is streamed through a 16 MiB writer cap, and one export is capped at 10,000 profiles.
- The Monitor inspector includes a bounded process list for POSIX and Windows hosts. It omits command arguments, environment variables and working directories; confirmed termination is limited to one validated PID using SIGTERM or Windows Stop-Process without privilege escalation.
- The dual-pane browser compares one selected local regular file with one selected remote regular file using streaming SHA-256. Each file is capped at 8 GiB, operations time out after 10 minutes, cancellation is available, and no copy or digest history is persisted.
- The dual-pane browser provides a read-only directory difference preview. It scans metadata only, caps each side at 5,000 entries and 16 directory levels, allows cancellation, and never applies changes or creates transfer tasks.

Candidates:

- Encrypted portable export and packaging polish.

Exit criteria:

- Cross-platform installation/update/uninstall checks.
- Threat-model review and dependency audit.
- Performance budgets measured on production builds.
- Accessibility and localization acceptance complete.

## Phase 5.5 — workspace experience alignment

Status: **implemented slice** (added 2026-11-05; verification evidence in `docs/VERIFICATION.md`)

Aligns FILEX with the public feature set of open SSH workbenches (FileTerm as market reference; own implementation) and restyles the shell to the approved FileTerm-style layout. Additive only: no existing capability is removed.

Scope (implemented):

- Shell restyle: top session tab bar, left host panel, terminal, command input bar, bottom dual-pane file browser; connections navigation, session details inspector, assistant panel and task drawer remain as collapsible surfaces. New visual tokens for both themes.
- Floating command input bar with bounded in-memory history (never persisted or logged).
- OSC 7 terminal working-directory tracking with a follow-terminal option in the file browser.
- Remote permission mode editing (chmod) with explicit octal review; numeric uid/gid ownership columns.
- Monitor extension: load averages 1/5/15 and a bounded multi-mount disk list; network rate history chart in the host panel.
- Virtualized scrolling for large directory listings.
- Monaco-based editor panel (lazy-loaded) for bounded remote/local text files with syntax highlighting and find/replace.
- Command snippet folders and focus mode.

Implemented alongside: `update_remote_entry_mode` / `preview_local_text` / `save_local_text` Tauri commands, `RemoteFileEntry.uid/gid`, `SystemMonitorSnapshot.mounts` + `loadFive/loadFifteen`, snippet `folder` field, and the corresponding typed facades, stores and zh-CN/en-US messages. Also fixed latent defects surfaced by verification: the assistant redactor rule order (`[REDACTED_TOKEN]` now survives keyword assignments), a virtual-list start-index clamp, and the session tab strip Teleport (`defer`) reload error.

Exit criteria (remaining):

- Existing Playwright browser E2E scenarios pass unchanged (profile persistence, pane resizing, authentication defaults, ProxyJump preflight, desktop boundary).
- Dark/light, zh/en, keyboard and minimum-window acceptance for the new shell.
- Structured error codes preserved across the new Rust/TS contract additions; secrets remain outside settings, logs and history.

The 2026-11-07 local browser pass confirms dark/light, zh/en, 1440×900 and 960×640 runtime checks with zero page errors or failed requests. The former top-bar wrapping defect at 960×640 with the maximum 20 px UI font is fixed by a non-shrinking, non-wrapping primary action and is covered by Playwright.

FTP/FTPS remains deferred to a separate design slice (see PRODUCT_DESIGN "Later" and Deferred product tracks below).

## Phase 6 — AI assistant

Status: **explain/draft slice, bounded local history and local text-file comparison implemented; hardening remains**

The assistant is an approved product track. Its contracts, redaction boundary and tool policy are designed early, but executable tools are enabled only after their underlying FILEX capabilities pass security and recovery acceptance.

Deliverables:

- Provider-neutral assistant API with OpenAI-compatible and optional local-model adapters.
- OS-credential-backed provider secrets, streaming, cancellation, timeout and rate-limit handling.
- Local chat sessions with explicit context chips and external-provider disclosure preview.
- Explain and summarize flows for sanitized errors, events, metrics, transfers and bounded terminal selections.
- Command/snippet/change-plan drafting without implicit execution.
- Versioned typed tool registry with observe, draft, mutate and destructive risk classes.
- Target-rich confirmation, policy enforcement, stale-proposal invalidation and sanitized assistant audit events.

Implemented first slice:

- Provider configuration now lives in Settings → AI with OpenAI, DeepSeek, Gemini, Kimi, Qwen, Zhipu, MiniMax, OpenRouter, Ollama and custom OpenAI-compatible presets. Presets only prefill a base URL and suggested model IDs; any model ID remains editable. API keys stay behind OS credential references, and keyless requests are accepted only for loopback HTTP endpoints. Model-only switching preserves the credential, resets external-data consent and is revalidated by the Rust boundary.
- The assistant panel has an independent persisted width (default 360 px, 300–520 px), a conversation menu, provider/model selector, bounded Markdown rendering, copy-only code actions, empty-state prompts and a collapsible opt-in context drawer. Provider replies cannot inject HTML or acquire Run, terminal-send or approval actions.
- OpenAI-compatible endpoint and model configuration with provider key stored only in the OS credential store; rate-limit, provider-authentication and timeout responses map to distinct structured errors.
- Provider setup explains that retention and training practices are controlled by the endpoint operator. External-data consent defaults off, is stored with provider configuration, can be revoked, resets when a provider is replaced, and is enforced again at the Rust request boundary.
- Explicit prompt/session/event/monitor/transfer/one-failed-tunnel/terminal-selection/local-file/recent-chat disclosure with approximate outgoing text size, opt-in context chips, path-free transfer summaries, terminal selection capped at 4,000 characters, and user-selected text/configuration files capped at 12 KiB. The user chooses one failed tunnel; only tunnel kind, state, bind endpoint, target port, a target host that passes plain-hostname/IP validation, and structured error code are sent. An unrecognized target host is omitted; tunnel/profile/session IDs, name and credentials are excluded. Rust revalidates the file type, extension, UTF-8 and control characters; the retained text uses a short-lived zeroizing memory reference, is redacted before provider serialization, and is omitted from filenames/paths, transcripts, event logs and diagnostics. A combined 16,000-character context budget prioritizes the file text. Recent-message context, bounded SSE output with fragmented/final-event handling, cancellation and pre-serialization redaction for PEM keys, credential assignments, URL user information and common token formats remain in place.
- Explain and command-draft modes; the assistant has no terminal or mutation tool access.
- Completed Draft replies produce a local `command.draft` v1 card from supported shell fences (up to five commands and 10,000 UTF-8 command bytes). FILEX assigns the fixed `draft` risk; the card only displays commands and never sends them to a PTY. A target is captured in memory only when the user attaches the active session, marked stale after target/state changes, and omitted from provider data and persisted history; restored cards are targetless.
- Multi-step Draft replies can produce a local `change-plan.draft` v1 card from the `filex-change-plan-v1` JSON fence. FILEX enforces the exact schema, 1–5 steps, up to 3 commands per step, 24,000 UTF-8 JSON bytes, 10,000 command bytes and bounded text fields; FILEX assigns draft risk and only displays the ordered plan, expected effects and rollback notes. Target metadata follows the command-draft in-memory/stale rules and is absent from provider data and persisted history; restored plans are targetless. Malformed, oversized, unsafe or mixed-format plans receive a localized notice and are not rendered as structured proposals. No approval or execution action is exposed.
- Draft-mode system instructions define both supported output formats and their limits so model output matches the local parsers; one response cannot mix the command and change-plan formats.
- Up to 10 named local conversations with separate selection, rename, clear and confirmed delete actions. Each keeps up to 24 completed redacted messages with a 32 KB per-message and 128,000-byte total message-content budget; trimmed messages end with an ellipsis. Existing single-transcript data migrates on first access, attached context and partial streaming output are excluded, and only the selected conversation is sent as follow-up history.
- The Rust assistant boundary accepts only explain/draft requests and provider-token credential references, revalidates stored endpoints before exposing or using them, caps attached context at 64 KiB, and acquires a single-request guard before provider configuration or credential access; RAII releases it on every exit path, and cancellation covers setup as well as streaming. Provider redirects are disabled, with 15-second connection and 90-second total request/stream timeouts. Provider configuration events omit the endpoint.
- Stop-generation failures preserve a structured error, appear in the assistant panel and event console, and do not mark an active response as cancelled.
- Users can attach up to two explicitly selected local text/configuration files per request for comparison. Each stays capped at 12 KiB, the provider sees selection-order labels without filenames or paths, and the combined file content shares the 16,000-character context budget. The files remain outside chat history and no file-write or command-execution action is exposed.

Redaction unit-fixture and loopback HTTP transport-fixture sources have been added but are not verified. The transport fixture captures the outgoing body, checks redaction at the provider boundary, and confirms the authorization header is marked sensitive. Still open: run those fixtures after environment setup.

Build, test and UI verification remain pending until the development environment is configured.

Exit criteria:

- Provider credentials, SSH credentials, private keys and hidden terminal input never enter ordinary settings, prompts, logs or chat history.
- Remote content cannot grant permissions, modify policy or bypass confirmation in prompt-injection fixtures.
- Every external request previews or clearly identifies context categories leaving the device.
- Mutating tools call existing application use cases and pass the same authorization, structured-error and cancellation checks as human-triggered actions.
- Streaming, cancellation, provider failure, rate limiting, malformed tool calls and stale session generations pass integration and E2E tests.
- Multi-host broadcasting, unattended autonomous loops and silent destructive execution remain unavailable.

## Deferred product tracks

RDP, cloud sync, team collaboration, batch commands, plugins and acceleration each require a separate product/design/security review. They are not allowed to enter a phase as incidental scope.
