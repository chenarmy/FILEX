# FILEX verification evidence

## 2026-11-05 — Windows NSIS package (post Phase 5.5 alignment)

Generated the unsigned Windows x64 NSIS installer with all Phase 5.5 work included (FileTerm-style shell, command input bar, follow-terminal, chmod, disk mounts, Monaco editor, focus mode, seed removal and layout fixes).

| Check | Command | Observed result |
| --- | --- | --- |
| Front-end production build | `pnpm build` (via beforeBuildCommand) | Passed; Vue strict typecheck and Vite build, Monaco split into lazy chunks |
| Release compile | `CARGO_NET_OFFLINE=true pnpm tauri build --bundles nsis` | Passed; release profile optimized build in 4m02s |
| NSIS bundle | makensis | Passed |

Artifact:

- `target/release/bundle/nsis/FILEX_0.1.0_x64-setup.exe`
- Size: 7,595,367 bytes (7.24 MiB)
- SHA-256: `347362ee069fd9fd298e7f7b75f776eb4617d3ce5074d14db8ee03c569c330e5`
- Authenticode: `NotSigned`

Built fully offline (`CARGO_NET_OFFLINE=true`) because the local git proxy (`127.0.0.1:7897`) was down; all crates came from the local cargo cache. Updater signing variables remain unset, so the artifact is for local inspection only — the in-app updater will not install unsigned builds. Installer interaction, live SSH and cross-platform checks were not run.

## 2026-11-05 — Browser preview seed profiles removed

The browser (non-Tauri) runtime no longer injects four demo connection profiles into `filex.connection-profiles.v1` on first load; an empty storage now renders an empty list with the standard empty state. The two Playwright scenarios that relied on the seeds (`dev-sandbox` ProxyJump preflight, `worker-canary` Agent desktop boundary) now install their own localStorage fixtures, so the suite stays self-contained.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (14), `pnpm test:e2e` (5/5) — all green. Verified in the browser that after clearing stored profiles the list is empty with zero page errors.

## 2026-11-05 — Browser functional test pass (non-SSH features)

Scope: manual browser test of every non-SSH feature surface in dev mode (SSH connect/PTY/SFTP/monitoring/tunnel against a live host remain desktop/host-gated): connection profile CRUD + favorites/filter/grouping/navigation modes, all keyboard shortcuts, command palette, focus mode, panel resizing and persistence, bottom file browser (files/commands/editor sub-tabs, dual pane, follow-terminal help, transfer footer), Monaco editor panel, command input bar empty state, task drawer tabs, session details inspector, AI assistant panel, and the full settings dialog (7 sections, theme and locale switching with persistence, shortcuts page).

Result: all scenarios pass with zero page errors in a clean session. Four defects found and fixed in the same pass:

1. **Monaco editor DOM detached in the empty state** — monaco 0.5x removes the entire editor DOM on `setModel(null)`, so the panel rendered a blank host until a file opened. `EditorPanel` now keeps a shared blank model attached instead of null.
2. **Settings → Connections section hardcoded English** ("Connection timeout", "Keepalive interval", "Automatic reconnect", option labels) — now routed through the translation layer (`settings.connectionTimeout`, `settings.keepaliveInterval`, `settings.automaticReconnect(HELP)`, `settings.secondsValue`, `settings.attemptsValue`; `settings.off` already existed).
3. **Task drawer close/resize labels hardcoded English** — now `tasks.closeDrawer` / `tasks.resizeDrawer`.
4. **Shortcuts settings page omitted the focus-mode shortcut** — `toggleFocusMode` added to `shortcutActions` (16 rows render).

Test-tooling notes (not app defects): Playwright `fill("")` on the connections search input did not register in the in-app browser (clearing via input event works and filters reset correctly); injected CUA input stopped reaching the page mid-session while `evaluate` kept working (HMR-period `dimensions` TypeErrors were also HMR-only — a clean reload reproduces none).

Gates re-run after the fixes: `pnpm lint`, `pnpm typecheck`, `pnpm test` (14), `pnpm build`, `pnpm test:e2e` (5/5) — all green.

## 2026-11-05 — Phase 5.5 workspace experience alignment

Scope: FileTerm-style shell restyle (top session tab bar, left host monitor panel, floating command input bar, bottom dual-pane file browser with transfer footer), plus the aligned feature additions — OSC 7 follow-terminal, chmod permission editing with uid/gid columns, multi-mount disk list with load 1/5/15, network rate history chart, virtualized file lists, Monaco editor panel, snippet folders, and focus mode.

| Check | Command | Observed result |
| --- | --- | --- |
| Front-end lint | `pnpm lint` | Passed with zero warnings |
| TypeScript | `pnpm typecheck` | Passed in strict mode |
| Unit tests | `pnpm test` | 4 files, 14 tests passed (permissions, virtual window, settings clamps, connections) |
| Production build | `pnpm build` | Passed; Monaco split into a lazy `monaco-*.js` chunk plus a separate editor worker |
| Rust format | `cargo fmt --all -- --check` | Passed |
| Rust compile | `cargo check --workspace` | Passed |
| Rust tests | `cargo test --workspace` (`CARGO_PROFILE_DEV_DEBUG=0` for disk space) | All crates pass, including the previously unrun `filex-ssh` loopback fixture after fixing `request_remote_forward` (see below) |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | Passed after fixing latent pre-existing lints (redactor ordering, redundant closures, complex types, `&PathBuf`, sort_by_key, cfg-gated `set_readonly`) that also fire on the previous commit with this toolchain |
| Browser E2E | `pnpm test:e2e` | 5/5 passed. Three spec expectations were corrected to match shipped behavior (ambiguous profile-button locators that also matched the favorite toggle, the `Control+1` connections-search shortcut instead of `Control+K`, and the zh-CN desktop-boundary message); all five scenarios failed before this phase on the previous commit |
| Visual inspection | `pnpm dev` + browser | Dark and light themes, empty and populated states, focus-mode collapse and teleported session tab strip inspected at 1440x900 |

Notable fixes surfaced by verification: the assistant redactor now applies the API-token rule before generic key/value assignments so tokens keep `[REDACTED_TOKEN]`; the virtual list clamps its start index when scrolled past the content; the tab-strip Teleport uses `defer` to avoid a Vue `emitsOptions` patch error on reload; and FileBrowserPanel declares its inline-dialog state before its immediate watchers (temporal-dead-zone crash).

`request_remote_forward` port handling: per RFC 4254 a successful `tcpip-forward` reply has an empty body when a specific port was requested, which russh 0.65 maps to `Ok(0)`; the wrapper previously required the echoed port to equal the requested one, so every remote-forward request against a compliant server failed with `RemoteForwardUnavailable`. `Ok(0)` for a non-zero request is now treated as success, and the loopback fixture (host-key rejection, password auth, PTY round-trip, remote forward, forwarded-channel delivery, cancellation, disconnect) runs green on Windows.

Still pending: live-host verification of the new probe fields (`mounts`, `load5/15`), setstat chmod, OSC 7 follow-terminal against a real shell, Monaco save round-trips, and cross-platform acceptance. FTP/FTPS remains deferred per `docs/PRODUCT_DESIGN.md`.

## 2026-11-01 — Phase 1 foundation slice

Scope:

- Vue/Tauri project foundation.
- Workbench shell and settings interaction.
- Non-secret connection profile create/list/search/select slice.
- Typed TypeScript and Rust contracts with structured errors.

Required checks:

| Check | Command | Observed result |
| --- | --- | --- |
| Front-end lint | `pnpm lint` | Passed with zero warnings |
| TypeScript | `pnpm typecheck` | Passed in strict mode |
| Unit tests | `pnpm test` | 2 files, 6 tests passed |
| Production build | `pnpm build` | Passed; generated Vite production assets |
| Rust format | `cargo fmt --all -- --check` | Passed after applying `cargo fmt --all` |
| Rust compile | `cargo --config 'http.proxy=""' check --workspace` | Passed for contracts, core and Tauri shell |
| Rust tests | `cargo --config 'http.proxy=""' test --workspace` | 2 core tests passed; all crate/doc test targets passed |
| Rust lint | `cargo --config 'http.proxy=""' clippy --workspace --all-targets -- -D warnings` | Passed with warnings denied |
| Visual smoke | Edge at 1440 × 900 and 960 × 640 | Shell filled the viewport without overflow |
| Interaction smoke | Settings save; invalid/valid profile create; profile search | Passed; invalid form surfaced an alert and valid profile persisted locally |
| Runtime smoke | Browser console and page errors | Zero severe console or page errors in inspected flows |

Security assertions covered by the slice:

- Connection profiles contain a credential reference only; input contracts have no password or passphrase fields.
- Browser persistence stores only non-secret profile metadata and safe settings.
- UI components use the typed domain API facade instead of importing Tauri `invoke`.
- Tauri capability scope is limited to `core:default`; filesystem, shell and network permissions are not granted.
- Real SSH, host-key trust and credential-store availability are visibly marked as unavailable or unprobed instead of simulated.

The table is updated with observed command output after each validation run.

## 2026-11-01 — SQLite and system credential-store foundation

Scope:

- Replaced the desktop in-memory profile catalog with a SQLite repository in the Tauri app-data directory.
- Added versioned, transactional schema migrations for workspaces, profiles, tags and safe settings.
- Added a platform credential-store adapter and exposed only its classified availability state to Vue.
- Added a zeroizing, non-serializable `SecretLease`; secret values have no Tauri DTO or event contract.

Observed checks:

| Check | Command or observation | Result |
| --- | --- | --- |
| Rust compile | `cargo --config 'http.proxy=""' check --workspace` | Passed for contracts, core, storage, credentials and desktop crates |
| Rust tests | `cargo --config 'http.proxy=""' test --workspace` | 6 tests passed, including migration version, database reopen persistence and secret debug redaction |
| Rust lint | `cargo --config 'http.proxy=""' clippy --workspace --all-targets -- -D warnings` | Passed with warnings denied |
| Rust format | `cargo fmt --all -- --check` | Passed |
| Front-end gates | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Passed; 2 files / 6 tests and production bundle generated |
| Desktop startup | `pnpm tauri dev --no-watch` | Tauri application started without runtime errors |
| Durable database | `%APPDATA%\\dev.filex.workbench\\filex.sqlite3` after desktop startup | Database created by the native bootstrap path |

Security assertions:

- SQLite stores `credential_ref` only and has no password, passphrase or provider-token column.
- Invalid credential references are rejected before reaching the OS API.
- Credential backend failures are reduced to safe status/error classes; platform error text and secrets are not returned through IPC.
- Browser preview reports the OS credential store as unsupported instead of simulating secure storage.

## 2026-11-02 — profile CRUD, SSH Config import and trust ledger

Scope:

- Added durable create, edit, duplicate and delete operations through Vue store, typed API, Tauri commands, core use cases and SQLite.
- Added default `~/.ssh/config` parsing, warnings, selectable preview and import.
- Added SQLite migration v2 for authentication metadata and an append-only host trust ledger.
- Added unknown, trusted and changed-fingerprint evaluation with previous-fingerprint history generated by the core rather than accepted from the UI.

Observed checks:

| Check | Command or observation | Result |
| --- | --- | --- |
| Front-end gates | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Passed; 2 files / 6 tests and production bundle generated |
| Rust tests | `cargo --config 'http.proxy=""' test --workspace` | 9 tests passed, including SSH Config parsing, durable CRUD/duplicate, restart persistence and changed-fingerprint history |
| Rust lint | `cargo --config 'http.proxy=""' clippy --workspace --all-targets -- -D warnings` | Passed with warnings denied |
| Rust format | `cargo fmt --all -- --check` | Passed |
| Existing-data migration | `pnpm tauri dev --no-watch` against the existing app-data database | Desktop started successfully and SQLite wrote the v2 migration WAL |
| Browser interaction smoke | Edit `prod-api-01`, duplicate it, open SSH Config import and inspect Security settings | Edited and duplicated rows appeared immediately; browser preview showed the expected desktop-only import error; credential and trust states remained explicit |

The native window capture helper located the FILEX window but timed out twice while capturing it. Native execution is therefore evidenced by the live Tauri process, migration output and Rust integration suite; visual interaction evidence for this slice comes from the same Vue build in a controlled browser preview.

## 2026-11-02 — trusted SSH, PTY, SFTP, monitoring and local tunnels

Scope:

- Added `russh` host-key probing, strict trust checks, password authentication, typed session state and reconnect.
- Added xterm.js PTY tabs with binary input/output, resize, bounded buffers and remote-close handling.
- Added `russh-sftp` browsing and a SQLite-backed upload/download queue with cancellation, retry and startup recovery.
- Added bounded read-only monitoring and cancellable local SSH port forwards with non-loopback exposure confirmation.

Observed checks:

| Check | Command or observation | Result |
| --- | --- | --- |
| Front-end lint | `pnpm lint` | Passed with zero warnings |
| TypeScript | `pnpm typecheck` | Passed in strict mode |
| Front-end tests | `pnpm test -- --run` | 2 files, 6 tests passed |
| Production build | `pnpm build` | Passed; 1,632 modules transformed |
| Rust compile | `cargo --config 'http.proxy=""' check --workspace --target-dir C:\\Users\\Administrator\\.cache\\filex-target` | Passed for all six crates |
| Rust tests | `cargo --config 'http.proxy=""' test --workspace --target-dir C:\\Users\\Administrator\\.cache\\filex-target` | 13 tests passed, including session state, bounded monitoring and durable transfer recovery |
| Rust lint | `cargo --config 'http.proxy=""' clippy --workspace --all-targets --target-dir C:\\Users\\Administrator\\.cache\\filex-target -- -D warnings` | Passed with warnings denied |
| Rust format | `cargo --config 'http.proxy=""' fmt --all --check` | Passed |

Security and recovery assertions:

- Authentication secrets are leased from the OS credential store, zeroized and never placed in profile DTOs or events.
- Unknown or changed host keys cannot proceed without an explicit trust action; reconnect repeats host-key verification.
- Terminal and monitor output are bounded, and user-controlled values are not interpolated into the monitor probe.
- Transfer content is streamed through temporary files and published only after a successful flush/close; interrupted running tasks become paused on startup.
- Local listeners are cancelled on stop or session disconnect, and the UI requires explicit acknowledgement before binding outside loopback.

Remaining acceptance work is fixture-backed remote E2E: DNS/timeout/auth/remote-close cases, high-output PTY, large and partial SFTP transfers, and tunnel lifecycle on disposable SSH servers.

## 2026-11-02 — workbench controls, maintenance and assistant implementation

Implemented:

- Pointer and keyboard resizing for the connections pane, inspector and task drawer.
- SQLite-backed safe settings contract, validation and browser-preview fallback.
- Shared confirmation dialog, global shortcuts, multiline paste confirmation and bounded in-memory event console with sensitive-key filtering.
- Consistent SQLite backup using `VACUUM INTO` and a minimal diagnostics JSON that excludes profile endpoints and secrets.
- Daily/weekly background backup scheduler reads the persisted schedule and records its last successful snapshot time in SQLite.
- GitHub Actions quality/E2E workflow and a manually gated cross-platform installer workflow definition. No installer or release workflow was executed.
- AI assistant panel for OpenAI-compatible providers, OS-keyring API-key storage, per-request external disclosure, opt-in session summary, explain/draft modes, SSE cancellation and bounded response collection.

The workbench controls passed the front-end gates and two Chromium E2E cases before maintenance and assistant code were added. No verification command was run after the assistant implementation. At that point, the signing key, updater public key and release endpoint were not configured, so signed in-app updates remained unavailable; the settings panel reported that state. The later updater implementation is recorded below.

## 2026-11-02 — dynamic SOCKS forwarding

Implemented a local dynamic tunnel mode using SOCKS5 no-auth CONNECT over the selected SSH session. Destination parsing supports IPv4, IPv6 and domain-name addresses; unsupported commands and address types are rejected. Non-loopback listeners require an explicit backend acknowledgement. No build, test, or release command was run for this change, per the user's instruction to defer verification and publication until environment variables are configured.

Added schema migration 4 and a `TunnelRuleService`/SQLite repository slice for per-profile rule CRUD, exposed through typed Tauri commands and the tunnel dialog. Saved rules contain listener and target configuration only; they do not grant non-loopback exposure, which must be acknowledged again when starting. No test, build, or release command was run for this continuation.

Added SSH remote TCP forwarding for pinned ports. The russh client handler dispatches incoming forwarded channels through a bounded per-listener queue; the runtime bridges each accepted channel to the configured local target and cancels the SSH listener when the tunnel stops or its session disconnects. Schema migration 5 extends the tunnel-rule kind constraint while preserving migration 4 data. This implementation has not been built or exercised against an SSH server.

Added backup restore through SQLite's online backup API. The selected database is opened read-only, schema version/integrity/foreign keys are checked, and the current database is snapshotted for rollback before restore. Active SSH sessions and running transfers block restoration; successful restore clears ephemeral session state and reloads the webview. No build or test was run for this work.

Added read-only SFTP text preview with a 1 MiB response bound. The backend rejects symlinks and non-regular files, and returns a structured error for binary/control data or invalid UTF-8. Directory double-click opens a preview dialog with an explicit download action. No build, test, typecheck or release command was run for this change.

Added confirmed remote-item deletion through the SFTP API. The backend classifies the target with `lstat`, removes symbolic links as links, deletes regular files, and permits only non-recursive empty-directory removal; parent traversal and dot targets are rejected. Updated the roadmap to keep the preview/editor note under SFTP. No build, test, typecheck or release command was run for this change.

Added remote directory creation from the active SFTP browser. The backend canonicalizes the selected parent, accepts only a single bounded name, and delegates collision handling to the remote `mkdir` operation. No build, test, typecheck or release command was run for this change.

Added same-directory SFTP rename for selected files, directories and symbolic links. The backend canonicalizes the parent, validates the target basename, and uses the SFTP rename request without deleting an existing destination first. No build, test, typecheck or release command was run for this change.

Added an editable view for complete UTF-8 remote files up to 1 MiB. The editor uses a SHA-256 content revision for stale-write detection, writes through an exclusive sibling temporary file, preserves advertised permission bits, moves the previous file to a recovery name before replacement, rechecks the moved copy, refuses to replace a newly appeared target, attempts rollback if commit fails, and reports a retained recovery path. No build, test, typecheck or release command was run for this change.

Added an external-open action for remote regular files. FILEX streams a copy to an app-owned temporary directory, enforces a 32 MiB limit even if remote size metadata is missing or stale, launches the platform default application without shell command parsing, and prunes regular cached copies older than 30 days on startup. No build, test, typecheck or release command was run for this change.

Added a persisted local/remote dual-pane browser setting. The local side lists up to 1,000 entries per directory, navigates folders, and hands selected files to the durable upload queue; the remote side continues to use SFTP and routes downloads to the selected local directory. The SQLite safe-settings contract defaults this option off when loading older settings. No build, test, typecheck or release command was run for this change.

Added local folder creation, same-directory rename, and confirmed local-item deletion in the dual-pane browser. Operations validate a single basename, refuse an existing rename target, treat symbolic links as links, and use non-recursive directory removal so only empty folders can be deleted. No build, test, typecheck or release command was run for this change.

Extended assistant follow-ups to include only recent completed chat messages, bounded to 12 entries and a 32,000-character backend budget. The disclosure shows that recent chat may be sent and estimates the outgoing text size; the in-memory transcript can be cleared and is not persisted. Expanded pre-serialization redaction to cover PEM private-key blocks, credential assignments, URL user information and common token formats. Redaction fixtures and provider-boundary inspection remain unverified. No build, test, typecheck or release command was run for this change.

Added macOS and Windows branches to the read-only SSH monitor probe for uptime, memory and root filesystem metrics; Linux and macOS also report one-minute load. The parser now reports `unsupported` when a probe returns only host or OS identity without any metrics. Live-host capability checks remain open.

Added a Windows SSH monitor path that launches a bounded, non-interactive PowerShell CIM query and reports uptime, physical memory and the system-drive capacity. It is selected only when the probe identifies Windows; other hosts continue through the POSIX probe. No build, test or Windows-host probe was run for this change.

Added automatic 30-second monitor refresh while the monitor tab is active, stale indication when a live sample is older than 60 seconds or its refresh fails, and localized monitor state labels. Session/tab changes invalidate in-flight samples and clear the timer. No typecheck, UI interaction or SSH-session verification was run for this change.

Added separately opt-in assistant context chips for the active session, up to 8 recent warning/error events, the latest monitor summary, and up to 5 transfer summaries. Transfer context omits local and remote paths; the disclosure lists the selected categories and includes their text in the size estimate. No typecheck, UI interaction or provider-boundary verification was run for this change.

Added an explicit terminal-toolbar action that sends the current xterm selection to the assistant panel. The user can remove the attached selection, and only its last 4,000 characters are included; hidden input is not read. No typecheck, keyboard, UI or provider-boundary verification was run for this change.

Mapped provider HTTP 429, 401/403 and request/stream timeouts to distinct assistant error codes and localized messages. Authentication/configuration errors are not marked retryable; rate limits and timeouts are. Provider response fixtures were not run.

Reworked assistant SSE framing to accumulate `data:` lines until event boundaries, tolerate CRLF and UTF-8 BOM framing, process a final event without a trailing newline, stop on `[DONE]`, and surface malformed or provider-error events instead of completing with an empty answer. No provider fixture or stream test was run.

Added automatic backup retention: startup and successful scheduled snapshots prune only regular files matching FILEX's timestamped auto-backup naming scheme, keeping the 30 newest. Manual backup names and symlinks are excluded. No filesystem retention exercise was run.

Added SQLite-persisted command snippets with bounded parameter-template validation, parameter preview, and confirmed deletion. A selected template can be written to the connected SSH PTY only after a second confirmation shows the target host and expanded command; stale or disconnected sessions are rejected. The remote shell receives the command and may execute it. Added a Recent connections view backed by the profile `last_used_at` field, updated after successful authentication, with reconnect/open actions. No build, test, typecheck, or UI verification was run, per the user's instruction to defer verification and publication.

Connected the left-side Tunnels navigation to saved rules and live instances. Rules can be started on a matching connected SSH session, edited through the existing rule dialog, stopped, or deleted after confirmation that names the rule and clarifies that deletion does not stop an existing instance; non-loopback starts show the bound endpoint and target before acknowledgement, and duplicate starts for an active rule are disabled. No build, test, typecheck, or UI verification was run.

Expanded the security settings host trust display from a five-record preview to the full searchable append-only ledger, including current/history status, source, previous fingerprint and first/last-seen timestamps, with refresh and surfaced read errors. No build, test, typecheck, or UI verification was run.

Manual backup creation fills the restore path field with the returned SQLite snapshot path. The storage settings also provide a native single-file picker for older SQLite backups, filter to SQLite extensions, and retain manual path entry; cancellation leaves the current path unchanged. Only `dialog:allow-open` is granted, and the selected path still goes through the existing SQLite integrity/schema validation and restore flow. Cargo dependency metadata resolution updated the root lockfile without compiling. Generated Tauri ACL schemas and UI/runtime verification remain pending. No test, build, typecheck, or release command was run, per the user's instruction.

Added bounded local AI conversation history in SQLite, retaining up to 24 completed messages per conversation with a 32 KB per-message and 128,000-byte per-conversation message-content budget. The Rust boundary redacts messages and titles; attached context and partial responses are not persisted. Clearing affects only the active transcript; deleting a conversation requires confirmation, and at least one conversation remains. Existing `assistant_history` data migrates into one conversation after the new record is saved. Up to 10 conversations are supported, and only the selected transcript is used for follow-up requests. Redaction fixtures and runtime persistence checks remain pending. No test, build, typecheck, or release command was run, per the user's instruction.

## 2026-11-03 — bounded process inspection and confirmed termination

Implemented a Monitor sub-view with capped POSIX and Windows process probes, sanitized process names, CPU/memory details, explicit unsupported handling, and a single-process termination action. The backend caches only the latest snapshot per session for up to 60 seconds, rejects stale snapshot IDs and protected PIDs, rechecks process start identity and name immediately before signaling, and uses fixed commands with no user-supplied shell text or privilege escalation. Process arguments, environment variables and working directories are not collected. The UI confirmation names the host, PID, process and action and reports that a termination request was sent.

No tests, typecheck, build, live-host probe, or release command was run, per the user's instruction to defer verification and publication. POSIX PID identity checking has a narrow non-atomic race documented in ADR-0004; cross-platform runtime verification remains pending.

## 2026-11-03 — streamed local/remote SHA-256 comparison

Added a dual-pane action to compare a selected local regular file and remote regular file. Hashing uses a fixed 64 KiB buffer, an 8 GiB per-file limit, a 10-minute deadline, cancellation, and a maximum of two concurrent jobs. The result dialog identifies the host and both names, shows byte sizes and digests, and reports whether they match. Directories, symbolic links and special files are rejected; file size and modification metadata are checked around hashing. Paths and digests are not stored in comparison history.

No tests, typecheck, build, local-file exercise, SSH/SFTP host verification, or release command was run, per the user's instruction to defer verification and publication until environment variables are configured. Metadata checks cannot detect a replacement that preserves the reported size and modification time; runtime verification remains pending.

## 2026-11-03 — bounded directory difference preview

Added a dual-pane read-only directory preview that compares relative paths and metadata without reading file contents, creating transfer tasks, or modifying either tree. It reports local-only, remote-only, metadata-different, type-conflict, unsupported, and unchanged counts; sorts paths; returns at most 1,000 changed entries; and marks truncated results. Each side is capped at 5,000 entries and 16 directory levels, with a three-minute deadline, cancellation, and one active scan. Symlinks are not followed; special files, unsafe cross-platform names, and files missing required comparison metadata are surfaced as unsupported or rejected. The preview does not persist root paths or results.

No tests, typecheck, build, large-tree scan, Unicode/path fixture, cancellation exercise, SSH/SFTP host verification, or release command was run, per the user's instruction to defer verification and publication until environment variables are configured. The scan is a non-atomic metadata snapshot, and matching size plus modification time does not prove equal file contents.

Follow-up code review tightened cancellation cleanup: cancellation and the three-minute timeout now propagate through local filesystem and SFTP reads, and wait for the scan to close its remote directory handle and SFTP sessions before returning. The SFTP reader excludes `.` and `..` from the entry budget. No tests, typecheck, build, or live-host verification were run for this change.

## 2026-11-03 — non-secret connection profile export

Added a versioned `filex.connection-profiles` JSON export from the Connections pane. Schema version 2 includes ordered jump endpoint snapshots while omitting local profile IDs, credential references, private-key paths, live state, latency, and last-used data. Trust history, events, settings, transfers, snippets, and assistant conversations are not included. The native save dialog is opened by the backend, and the selected file is written through a same-directory temporary file with a 10,000-profile and 16 MiB cap. The UI explains the included endpoint/user fields and excluded data before opening the dialog.

No tests, typecheck, build, save-dialog interaction, cross-platform file-write verification, or release command was run for this change, per the user's instruction to defer verification until the environment is configured.

Follow-up review replaced whole-document JSON buffering with a streaming writer that enforces the 16 MiB cap before writing beyond it; over-limit exports discard the same-directory temporary file and do not persist the chosen destination. The native dialog title and filter label follow the saved Chinese or English locale. No build, test, typecheck, or desktop interaction was run for this follow-up.

## 2026-11-03 — user-selected full local backup export

Changed manual backup creation to open a localized native save dialog and write the SQLite snapshot to the selected path. The confirmation lists included profile metadata, private-key paths, trust history, transfer paths, snippets and assistant conversation text, and explains that OS credential secrets and private-key contents are excluded. Existing files are refused; cancellation creates no artifact. Scheduled backups remain under the app data directory, and successful manual backup paths continue to populate the restore field.

No tests, typecheck, build, backup/restore exercise, save-dialog interaction, or release command was run for this change, per the user's instruction to defer verification until the environment is configured.

## 2026-11-03 — user-selected diagnostics export

Changed the privacy-limited diagnostics JSON to use a localized native save dialog and a same-directory temporary file. The report remains limited to timestamp, app version, OS, architecture, schema version, credential-store availability, and the strict host-key-policy assertion; it excludes endpoints and user data. Cancellation creates no artifact, and serialized output is capped at 64 KiB.

No tests, typecheck, build, save-dialog interaction, privacy-boundary inspection, or release command was run for this change, per the user's instruction to defer verification until the environment is configured.

## 2026-11-03 — assistant request-boundary hardening

The Rust command now rejects unknown assistant modes, caps incoming context at 64 KiB before constructing a provider request, and admits only one active provider request per app process. Context over the cap receives a specific localized error. Existing prompt, history, provider response, timeout, cancellation, and redaction bounds remain in place.

No tests, typecheck, build, provider-boundary exercise, or release command was run for this change, per the user's instruction to defer verification until the environment is configured.

## 2026-11-03 — signed in-app updater integration (not verified)

Connected the settings update controls to signed Tauri updater commands. Each channel uses its own compile-time HTTPS feed and public key; checks return bounded release notes, and installation rechecks the feed and requires the reviewed version to match before downloading. Settings require an explicit install confirmation. Builds without the required key or feed report the channel as unconfigured; malformed updater configuration prevents checks and installation.

Enabled updater artifact generation in the Tauri bundle and configured the manually dispatched installer workflow to validate signing/feed configuration, upload signatures, and publish the platform-merged latest.json manifest.

No tests, typecheck, build, signed artifact generation, live manifest/signature check, installation, or release command was run for this change. The signing private key, updater public key and stable feed endpoint remain unconfigured; the current build cannot check or install updates.

Follow-up review now surfaces failed stop-generation requests as a localized assistant error and sanitized event, while leaving the response running until the backend reports completion or cancellation. No tests, typecheck, build, or UI interaction were run for this change.

## 2026-11-03 — SSH Config and runtime capability alignment

The profile editor now offers password authentication and identifies legacy key/Agent methods as unsupported. SSH Config imports assign password authentication because the file contains no password; an imported `IdentityFile` remains inert profile metadata and is called out in the import and inspector UI. A non-empty `ProxyJump` is retained for editing, shown with a warning, and rejected before host probing, reconnection, password storage, or authentication in both the session store and Rust runtime.

Source review only. Added Playwright coverage for password-only profile creation and visible Agent/ProxyJump preflight failures. Each E2E attaches browser diagnostics and asserts that uncaught page errors, console errors and failed requests are absent. The suite was not run. No tests, typecheck, build, live SSH connection, or desktop UI verification was run, per the user's instruction to defer testing until the environment is configured.

## 2026-11-03 — assistant provider-payload redaction fixture

Extracted provider-message assembly into a pure Rust function and added a unit-test fixture that checks prompt, selected context, and recent history for credential assignments, URL credentials, PEM private-key blocks, and a GitHub token pattern before serialization. The fixture source is present but was not executed. A transport-level mock-provider test is still open.

No tests, typecheck, build, or provider request was run, per the user's instruction to defer testing until the environment is configured.

## 2026-11-03 — remote forwarding policy denial classification

Mapped the SSH library's rejected `tcpip_forward` response to a dedicated `SSH_REMOTE_FORWARD_DENIED` application error. The error is non-retryable and localized with the relevant server forwarding policy settings; other SSH failures remain transport errors. Source review confirmed that the pinned `russh` implementation returns `RequestDenied` when the server rejects the TCP/IP forwarding request. Added a unit-test fixture for the classification, but did not execute it.

Source review only. No tests, typecheck, build, live SSH forwarding request, or release command was run, per the user's instruction to defer testing and publication until the environment is configured.

## 2026-11-03 — assistant provider transport boundary hardening

Extracted OpenAI-compatible request construction so the transport path can be inspected independently. The bearer authorization value is marked sensitive, and its temporary formatted copy is zeroized after the HTTP request is built. Added a loopback HTTP fixture that captures the request actually sent by `reqwest` and checks that prompt, context, private-key, and token secrets are absent from the body while redaction markers remain present.

Source review only. The transport fixture was not run. No tests, typecheck, build, provider request, or release command was run, per the user's instruction to defer verification and publication until the environment is configured.

## 2026-11-03 — assistant cancellation ingress and provider metadata hygiene

Moved the assistant's single-request guard ahead of provider-setting and keyring access so cancellation is available throughout setup and concurrent requests are rejected before credential retrieval or provider-message assembly. An RAII guard releases the active slot for all success and error exits, and biased cancellation selection avoids polling the HTTP send when a stop is already pending. Added a 15-second connection timeout while retaining the 90-second total request/stream timeout; redirects remain disabled. Persisted provider settings are validated before endpoint/model details are returned to the UI or used for a request. Assistant configuration now accepts only `provider-token` credential references, and replacement deletes only references of that type. Removed the provider endpoint from the provider-configured event details.

Source review only. No tests, typecheck, build, provider request, or release command was run, per the user's instruction to defer verification until the environment is configured.

## 2026-11-03 — assistant provider data-sharing consent

Added provider setup copy explaining that retention and training are controlled by the endpoint operator and are not verified by FILEX. External-data consent defaults off, is persisted with provider configuration, resets when a provider is replaced, and can be revoked without re-entering the API key. The Rust command rejects sends without current consent and serializes provider updates with consent changes; consent cannot be revoked while a request is active. Each request continues to show the selected context categories and estimated text size.

Source review only. No tests, typecheck, build, UI interaction or provider request was run, per the user's instruction to defer verification until the environment is configured.

## 2026-11-03 — loopback SSH lifecycle fixture source

Added a local russh server fixture with an ephemeral Ed25519 host key. The fixture source exercises host-key probing and mismatch rejection, password authentication, PTY greeting/input/echo, remote TCP-forward channel delivery, forwarding cancellation, disconnect and server shutdown. The fixture binds only to an ephemeral loopback port; `rand` is a test-only dependency for the ephemeral host key.

Source review only. The fixture was not run. No tests, typecheck, build, live SSH host connection, or release command was run, per the user's instruction to defer testing and publication until the environment is configured.

## 2026-11-03 — remote tunnel stop-state and cancellation reporting

Added a visible `stopping` state and made the stop command wait for listener cleanup before returning a terminal state. Remote SSH cancellation now has a five-second deadline; the local forwarded-channel route is closed after the attempt, and a denied or unconfirmed server cancellation produces a failed tunnel with a localized warning that the remote port may remain open until the SSH session is disconnected. Local listener state changes to stopped only after the socket is dropped. The tunnel views show stopping and surface the cancellation error.

Source review only. No test, typecheck, build, live SSH server cancellation-denial exercise, or release command was run, per the user's instruction to defer verification and publication until the environment is configured.

Follow-up source review found that session disconnect marked every tunnel stopped before the SSH session had closed, and that live backend state changes were not refreshed after start. Session teardown now marks active tunnels stopping, leaves local tunnel completion to the listener cleanup task, and marks a remote forward stopped only after the SSH disconnect succeeds. Tunnel workers own and abort their active bridge tasks before reporting completion, and each listener caps concurrent bridges at 64. The desktop close path now schedules bounded asynchronous session and tunnel cleanup before allowing process exit; the macOS window close button keeps its normal window-only behavior, while an application quit request uses the cleanup path. The tunnel store polls live instances every two seconds while they are starting, listening or stopping, and checks unconfirmed remote cancellation at a lower rate until disconnect resolves it. Stale snapshots cannot move a tunnel back to an earlier lifecycle state, and a stopping row keeps an idempotent stop action available after the current request returns. The polling timer is scoped to the store lifecycle. No tests, typecheck, build, or live-host verification were run.

## 2026-11-03 — assistant typed command draft preview

Added a local `command.draft` v1 display contract for completed Draft replies. Only supported shell fences are parsed; proposals are bounded to five blocks and 10,000 UTF-8 bytes, with hidden control and bidirectional-format characters rejected. FILEX assigns the draft-only risk class. An explicitly attached active-session snapshot stays in memory, is invalidated on target or connection-state changes, and is omitted from provider payloads and persisted transcripts. Restored draft text can be parsed into a targetless card. No terminal-send or execution action was added.

Source review only. No tests, typecheck, build, provider request, UI interaction, live SSH session, or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

Follow-up source review aligned the draft-mode system prompt with the local parser by requesting supported shell-fence labels and at most five command blocks. No tests, typecheck, provider request, build, or release command was run.

## 2026-11-03 — configurable foreground monitoring

Added a persisted monitor polling interval (15, 30 or 60 seconds) to safe settings, with matching browser normalization and backward-compatible Rust deserialization defaulting old settings to 30 seconds. Monitoring polls only while a connected session's Monitor view is open and the app window is visible and focused. Hiding or unfocusing the window stops the polling timer; returning to the foreground triggers a fresh sample. Changing the interval restarts the timer without discarding the current sample. Repeated failures use exponential backoff capped at five minutes, unsupported and permission-denied results stop automatic polling, and the panel explains the retry delay while preserving manual refresh.

Source review only. No tests, typecheck, build, UI interaction, cross-platform live-host verification, or release command was run, per the user's instruction to defer testing and publication.

## 2026-11-03 — assistant structured change-plan preview

Added the local `change-plan.draft` v1 display contract for completed Draft replies. The `filex-change-plan-v1` fence is parsed as strict JSON with exact field sets, bounded to five steps, three commands per step, 24,000 JSON bytes, 10,000 command bytes and bounded text fields. Unsupported shells, malformed fields, mixed-format responses, hidden controls and bidirectional-format characters do not produce a structured plan. FILEX sets the contract identity and draft-only risk; the card shows steps, commands, expected effects, rollback notes and the optional in-memory target, with no approval or execution action. Restored plans are parsed without a target. The Draft system prompt now requests this format for multi-step plans and the existing shell-fence format for single-command drafts.

Source review only. No tests, typecheck, build, provider request, UI interaction, live SSH session or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — SSH private-key authentication slice

Recorded ADR-0012 and wired `russh` public-key authentication through the strict host-key trust check, session coordinator, typed Tauri API, profile editor, native key-file picker, and passphrase dialog. Key files are read with a 1 MiB bound; the source buffer and passphrase leases are zeroized on drop. Passphrases use the existing `key-passphrase:<uuid>` OS-credential reference, and password/passphrase references are type-checked. Changing authentication method or private-key path clears the stored reference; successful profile deletion also removes its FILEX credential item on a best-effort basis. SSH Agent and `ProxyJump` remain blocked. SSH Config imports continue to keep `IdentityFile` inert until the user explicitly selects private-key authentication.

The existing `SessionRuntime` authentication-support fixture now reflects password and private-key support while keeping SSH Agent unsupported. Private-key file selection and public-key authentication have no loopback fixture or E2E assertion yet; those checks remain pending. Source review only. No test, typecheck, build, desktop dialog interaction, live-host connection, cross-platform check, or release command was run, per the user's instruction to defer verification and publication until the environment is configured.

## 2026-11-03 — user-selected local AI context files

Added a localized native file picker for an allowlist of text/configuration extensions. Rust revalidates regular-file type, extension, UTF-8, control characters and a 12 KiB read cap. The frontend receives only an in-memory reference ID, base filename, extension and byte length; Rust keeps the retained text buffer in a zeroizing memory entry with explicit release, a 15-minute expiry and periodic cleanup. When a file is attached, provider context includes its text after the existing best-effort redactor, prioritizes it within a combined 16,000-character context budget, and omits filename/path. File text, filename, path and reference are not written to conversation history, events or diagnostics. The UI previews the category and approximate outgoing size and warns that redaction is best-effort.

Source review only. No tests, typecheck, build, native picker interaction, provider request, UI interaction, or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — SSH Agent authentication slice

Recorded ADR-0013 and wired `russh` Agent signing through strict host-key verification, the session coordinator, Tauri command, typed API and connection editor. Unix reads the endpoint from `SSH_AUTH_SOCK`; Windows uses an explicit named pipe or the standard OpenSSH Agent pipe. FILEX binds the Agent to the verified SSH session before listing identities, disables forwarding, supports public keys and OpenSSH certificates, and attempts at most six identities. Agent operations use the configured connection timeout and close failed SSH handles with a one-second cleanup bound. Profiles store no Agent secret or identity comment. Structured errors distinguish unavailable Agent, timeout, failed binding, empty identity list, excess identities, signing failure and server rejection. ProxyJump remains blocked pending per-hop trust and credential design. Existing E2E source now expects three authentication options and the desktop-only boundary for browser SSH.

Source review only. No tests, typecheck, build, live Agent/SSH connection, cross-platform check, UI interaction or release command was run, per the user's instruction to defer verification and publication until the environment is configured.

## 2026-11-03 — ProxyJump route runtime source review

Recorded ADR-0014 and implemented the ordered saved-profile route in the SQLite-backed profile model and editor. Imported `ProxyJump` aliases remain inert until explicitly mapped; unresolved routes fail closed. Routes allow up to four direct hop profiles and reject duplicate, self, missing and nested references. The SSH runtime probes each hop through its authenticated upstream channel, checks that hop's host key, and then uses that profile's password, private key or local SSH Agent. The final PTY connection retains the upstream sessions and tears them down in reverse order.

Authentication commands resolve the current hop from the session route and verify the full ordered route plus a snapshot of each hop's endpoint, username, authentication method, key path and route references. Saving a credential after host-key confirmation remains allowed. A changed connection target or no-longer-trusted host aborts the route and closes its upstream sessions. Challenge and credential dialogs use the challenged hop's profile. The route lock is not held while opening network channels, pending routes are canceled during desktop shutdown, and canceled pre-authentication challenges release their route.

Source review only. No tests, typecheck, build, UI interaction, SSH connection, cross-platform check or release command was run, per the user's instruction to defer verification and publication until the development environment is configured.

## 2026-11-03 — terminal search, duplicate sessions and two-pane layouts (source review only)

Added the @xterm/addon-search package at version 0.15.0 for xterm scrollback search, case-insensitive matching, match decorations, result count, next/previous navigation, and the Ctrl/Cmd+F shortcut. Added duplicate-session, vertical split and horizontal split controls. Each split pane owns a separate SSH session, PTY, xterm renderer, input binding and resize path; removing a pane leaves its session tab available, while closing the tab disconnects and removes that session. Disconnected panes retain their local scrollback and expose a reconnect action. Search, split, pane, session and reconnect labels are localized in English and Simplified Chinese. Removed obsolete copy that said the SSH runtime was not yet connected.

No tests, typecheck, build, UI interaction, live SSH connection, cross-platform verification or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — file permission inspection (source review only)

Extended local and remote file-entry contracts with optional POSIX permission mode bits. Remote SFTP rows expose the server-provided mode; local Unix listings expose filesystem mode bits. Symlink metadata is not followed, and platforms or servers that do not provide mode bits display an unavailable marker. Both file panes show the mode in octal with a localized label and title.

No tests, typecheck, build, UI interaction, cross-platform filesystem verification, live SFTP connection or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — file moves and same-side regular-file copy (source review only)

Local and remote file operations now capture the active listing generation and refresh only when the same session and directory are still active. Move operations preserve the source name, check for an existing target, and reject moving a directory into itself. Remote deletion confirmation is bound to the host, SSH session generation, and directory; stale confirmation returns without deleting. Same-side local and remote copy supports regular files with an editable destination name; it preserves advertised permission bits, streams through a temporary sibling, checks remote target existence before work and immediately before commit, and attempts cleanup after failures. Remote copies are bounded to 8 GiB and ten minutes. Directory and symlink copy are explicitly unsupported in this slice.

Source review only. No tests, typecheck, build, local filesystem operation, live SFTP operation, UI interaction, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — static P0 gap review (not verified)

At the time of this review, remaining P0 scope included terminal character-encoding selection and a persisted terminal palette, along with drag-and-drop and recursive directory copy/transfer, system CPU/swap/network-throughput metrics, and tunnel-rule auto-start. The terminal preferences and constrained tunnel auto-start were added in subsequent source slices below. The current queue still has cancellation, retry and interrupted-task recovery, but no interactive pause control.

This was a source review only. No tests, typecheck, build, UI interaction, live host operation, platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — terminal encoding and palette preferences (source review only)

Added persisted terminal theme selection (match the application, dark or light) and terminal encodings (UTF-8, GBK, Big5, Shift_JIS and Windows-1252). Raw session output is decoded incrementally in the terminal pane and retained bytes are replayed when the encoding changes. UTF-8 keyboard and snippet input is converted with `encoding_rs` before it is written to SSH; invalid input and characters not representable by the selected encoding return structured localized errors. The bounded output buffer now tracks an absolute chunk offset so trimming old output does not cause a pane to skip new chunks. Older SQLite settings default to match-app and UTF-8, and frontend settings normalization applies the same defaults.

Source review only. No tests, typecheck, build, UI interaction, live SSH session, encoding round-trip fixture, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — tunnel rule auto-start (source review only)

Added SQLite migration 7 for a persisted auto-start flag on tunnel rules. Authenticated SSH sessions trigger opted-in local or SOCKS rules after connection. The core accepts auto-start only for loopback binds and rejects remote-forward auto-start; the runtime store repeats the restriction before starting, skips already-active matching rules, and records rule-loading or startup failures in the event console. The rule editor disables auto-start for unsupported binds and displays the setting in the saved-rules list. Existing rules migrate with auto-start disabled.

Source review only. No tests, typecheck, build, UI interaction, SSH connection, tunnel start, migration run, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — transfer pause, resume and progress controls (source review only)

Added queue pause and resume actions for queued and running uploads/downloads. Active stream copies use a bounded 64 KiB buffer, suspend between read/write chunks without discarding their temporary file or open SFTP stream, and continue on the same live session after resume. Stream byte-count writes are throttled to four per second, with pause and completion updates. Final commit is a short non-pausable state; cancellation is refused after that state begins. Disconnect, cancellation or application shutdown ends the current stream and cleans staging files on a best-effort basis; retry after the stream ends begins again from byte zero. Existing paused records recovered after process restart also restart from byte zero after the user reconnects.

Source review only. No tests, typecheck, build, UI interaction, live transfer, disconnect/reconnect exercise, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — CPU, swap and network monitoring metrics (source review only)

Extended the typed monitor snapshot, defensive output parser, inspector panel and opt-in assistant summary with CPU utilization, swap usage and network receive/transmit rates. The Linux collector samples aggregate `/proc/stat` and `/proc/net/dev` counters around a one-second interval, reads swap values from `/proc/meminfo`, and excludes loopback traffic. macOS collects CPU from `top`, swap from `sysctl vm.swapusage`, and interface counters from `netstat`, excluding `lo0`. Windows reports processor load from CIM, page-file usage from `Win32_PageFileUsage`, and samples `Get-NetAdapterStatistics` for one second while excluding adapters named loopback, Teredo or ISATAP. Unavailable individual metrics remain null. Runtime accuracy, collector capability and adapter filtering remain unverified.

Source review only. No tests, typecheck, build, UI interaction, remote probe, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — recursive directory copy, transfer and drag-and-drop (source review only)

Added native local-file/folder drop-to-upload and remote-entry drop-to-download. Dropped local paths are inspected individually by a typed Rust command before they become durable transfer tasks, so the bounded local browser listing does not limit drop discovery. Upload and download workers scan directory trees with 5,000-entry, 16-level and composed-path limits, reject symbolic links and special entries, and report aggregate byte progress. Missing destination roots are written to random sibling staging directories and renamed after success; overwrite into an existing directory uses merge semantics. Failed transfers attempt bounded best-effort staging cleanup, while failures in an existing merge may leave already completed files. Same-side local and remote directory copy also stages before commit and refuses an existing destination. Remote copy retains the 8 GiB and ten-minute limits. Cleanup uses bounded directory enumeration, closes the dedicated SFTP reader on success and error, and attempts to restore owner access to staged directories before deletion. Static review also added final remote target-path checks and source-path bounds to local tree copy.

Added a cancel action for same-side local and remote copies. Cancellation is honored during local traversal and chunked file copies, remote SFTP directory scans and stream copies. Final rename/commit is guarded as a non-cancellable state; local and remote staging is cleaned on cancellation on a best-effort basis. The local blocking worker retains its registry lease through cleanup, and the dialog only clears cancellation state when it still belongs to that operation. During application shutdown, the registry blocks new copies, requests cancellation of active copies and waits up to five seconds for their operation leases to finish before shutting down SSH sessions. If the wait expires, shutdown proceeds and staging cleanup remains best-effort.

Source review only. No tests, typecheck, build, UI interaction, local filesystem copy, live SFTP transfer, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — release shared session-map locks before channel I/O (source review only)

Terminal writes and resizes now clone a per-terminal handle before awaiting channel operations, and disconnect closes that handle after removing the connection from the shared map. SFTP browse, preview, external-open, save, delete, create-directory, rename, move and copy paths obtain an owned session handle before opening or using SFTP. This prevents one slow channel operation from holding the registry lock for every session.

Source review only. No tests, typecheck, build, live SSH/SFTP operation or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — AI assistant failed-tunnel context (source review only)

Added an opt-in assistant context chip for one user-selected failed tunnel. The local selector shows the tunnel name and listener endpoint; provider context includes tunnel kind/state, the bind endpoint, target port, a target host only when it passes plain-hostname/IP validation, and the structured error code. Unsupported target host strings are omitted. Tunnel, profile and session IDs, names and credential fields are excluded. The disclosure lists the selected tunnel-failure category and includes it in the estimated outgoing size. If the selected tunnel is no longer in a failed state, the context selection clears. No execution tool or remote action was added.

Source review only. No tests, typecheck, build, provider request, UI interaction, tunnel operation, SSH connection or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — persisted profile favorites (source review only)

Added an accessible favorite toggle beside each connection profile and a favorites-only filter in the connection pane. Favorite changes use the existing typed profile update path and persist with the profile; the store reorders profiles with favorites first and keeps group/name ordering stable. The favorites filter respects the existing search query and has its own empty state. Groups and tags remain editable/searchable through the profile form and filter.

Source review only. No tests, typecheck, build, UI interaction, SQLite/browser persistence check, SSH connection or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — OpenSSH known_hosts import (source review only)

Added native file selection and a bounded preview for OpenSSH `known_hosts` files (2 MiB and 5,000 candidates). Exact hostnames/IP addresses and `[host]:port` entries are parsed; SSH public-key blobs are decoded and fingerprinted with SHA-256, with declared and blob key algorithms required to match. Hashed names, host patterns, marked entries, unsupported key types, malformed entries and conflicting keys are counted and skipped. The security settings preview displays candidate and current fingerprints, highlights trust changes, and requires confirmation before import. Commit rechecks every current fingerprint under an SQLite immediate transaction before atomically appending the batch; stale previews abort without writes. Added localized messages and the decision record in ADR-0016.

Source review only. No tests, typecheck, build, UI interaction, SQLite import, live SSH connection, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — editable keyboard shortcuts and command palette (source review only)

Added a persisted shortcut contract, settings recorder with conflict/reserved-key feedback, per-section default reset, and centralized shortcut dispatch. Added a searchable, keyboard-navigable command palette for session, pane, settings and console actions. Updated the UX model and roadmap.

No tests, typecheck, build, keyboard interaction, settings migration exercise, or desktop UI verification was run, per the user's instruction to defer verification and publication until the environment is configured.

## 2026-11-03 — enhanced privacy-limited diagnostics snapshot (source review only)

Added the versioned `filex.diagnostics` v2 report with SQLite runtime/schema versions, database file size, quick integrity and foreign-key check states, credential-store state, and updater readiness for the selected channel. SQLite inspection runs in a blocking worker with a nonblocking repository lock; busy/poisoned lock and query failures are represented as `unavailable` without exporting raw errors. The report has no database path, connection/profile content, counts, event history, terminal or assistant data, or secrets. The localized Settings description lists the included and excluded categories. Output remains user-selected, atomically written and capped at 64 KiB.

Source review only. No tests, typecheck, build, desktop interaction, database integrity exercise, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — bounded AI local-file comparison context (source review only)

Extended assistant context selection from one local text/configuration file to two. The typed Rust ingress caps each request at two unique short-lived references; each file retains the native-picker extension, UTF-8, control-character, regular-file and 12 KiB checks. The provider receives only ordered `file 1`/`file 2` labels and redacted text, never filenames, paths or reference IDs. The combined local-file text shares the existing 16,000-character context budget, marks truncation, remains outside transcript/event/diagnostics persistence, and cannot trigger a write or execution action. Added local selection chips, add/remove flow, disclosure sizing and Chinese/English copy. Recorded the design in ADR-0018.

Source review only. No tests, typecheck, build, provider request, UI interaction, runtime or cross-platform verification was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — transient quick-connect sessions (source review only)

Added a dedicated Quick connect dialog reachable from the workspace, terminal empty state and `mod+k`. The typed input is validated at both the UI and Tauri boundaries; Rust builds a temporary password profile and binds it to the session ID only in `SessionRuntime`. Host-key evaluation still uses the existing durable trust ledger and explicit unknown/changed-key dialogs. After verification, the existing password dialog uses one-time copy and calls a command that wraps the supplied password in `Zeroizing` before the existing direct-route authenticator.

The runtime clears the temporary profile on route cancellation, authentication or transport failure, disconnect, remote PTY closure, backup restore reset and shutdown; the front-end clears its matching session map on the same lifecycle events. Terminal/tab naming, session status, Inspector profile context and assistant session labels resolve temporary profiles. Durable transfer queue actions, saved tunnel actions and duplicate-session actions are disabled for these sessions so an ephemeral profile ID cannot leak into persisted records. The decision and tradeoffs are recorded in ADR-0019.

Source review only. No tests, typecheck, build, UI interaction, live SSH connection, host-key challenge, credential/memory inspection, transfer guard, cross-platform check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — platform-resolved settings data directory (source review only)

Replaced the Windows-only `%APPDATA%\FILEX` placeholder in Storage settings with a typed read-only runtime path result. The Tauri adapter resolves the application data directory through the platform path service and derives the managed backup location from it. Browser mode and path-resolution failure display a localized unavailable state.

Source review only. No tests, typecheck, build, UI interaction, native path-resolution exercise, Windows/macOS/Linux check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — bounded opt-in terminal session logs (source review only)

Connected the previously inert terminal-logging setting to a real output sink. Settings now acts as a capability gate, while each connected session requires a host-specific confirmation that discloses raw terminal-output sensitivity and the 16 MiB cap. Only `TerminalOutputEvent::Data` bytes enter the sink; terminal input, password dialogs, selections, SFTP/AI content and event-console fields do not.

Rust owns up to eight session-scoped background writers, each with a nonblocking queue capped at 64 messages of 64 KiB, unique app-data filenames without host/profile metadata, Unix `0700` directory and `0600` file permissions where supported, per-file size enforcement and structured `active`, `inactive`, `limit_reached`, `interrupted` and `failed` states. Queue overflow or write failure stops the active log without delaying PTY delivery. Explicit stop, disabling the global Settings gate, disconnect, PTY closure and application shutdown cancel writers and wait up to two seconds for flush. Startup initialization removes FILEX terminal logs older than 30 days and prunes completed logs beyond the newest 24 while preserving active paths. Paths remain outside SQLite, backup, diagnostics, profile export and assistant context. The decision is recorded in ADR-0020.

Source review only. No tests, typecheck, build, UI interaction, live SSH output, file-permission check, size-limit exercise, backpressure exercise, shutdown flush, retention check, Windows/macOS/Linux check or release command was run, per the user's instruction to defer verification and publication until environment variables are configured.

## 2026-11-03 — Windows NSIS package

Generated the unsigned Windows x64 NSIS installer after the user requested local packaging.

| Check | Command | Observed result |
| --- | --- | --- |
| Front-end production build | `pnpm build` | Passed; Vue type checking and Vite production build completed |
| Desktop compile check | `cargo check -p filex-desktop --offline` | Passed after resolving pre-existing TypeScript and Rust compile blockers |
| NSIS package | `pnpm tauri build --bundles nsis` with Cargo offline mode | Passed; release binary and installer generated |

Artifact:

- `target/release/bundle/nsis/FILEX_0.1.0_x64-setup.exe`
- Size: 6,831,897 bytes
- SHA-256: `4267C37EC99178F6AE3842FCC118FCC6BB5D70097AD011BAB863724978EB6CFE`
- Authenticode: `NotSigned`

The local shell proxy pointed to an unavailable `127.0.0.1` endpoint. Cargo dependencies and the NSIS toolchain were fetched through verified direct/mirror downloads, then the package command was run with `CARGO_NET_OFFLINE=true`. Updater signing variables and feed endpoints remain unset, so this artifact is for local inspection only. No unit, integration, E2E, live-host, installer interaction or GitHub release/publish step was run.

