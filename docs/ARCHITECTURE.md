# FILEX application architecture

Status: architecture baseline v0.2  
Decision posture: desktop-first, local-first, portable core, thin adapters

## 1. Recommended baseline

Use the following as the initial architecture decision, subject to the protocol and terminal-renderer spikes defined in the product design:

- Vue 3 with `<script setup lang="ts">` for the workbench presentation.
- Strict TypeScript, Pinia, Vite, semantic Tailwind utilities and Lucide icons.
- Tauri 2 as the cross-platform desktop shell.
- Rust for connection/session coordination, SSH/SFTP/tunnel protocols, monitoring, persistence and security-sensitive services.
- SQLite for local structured data.
- OS credential services for passwords and passphrases.

FILEX does not need an Axum/Web runtime for v1. A local HTTP server must not be introduced merely to connect the WebView to the Rust core; use typed Tauri IPC. Remote/cloud services require a separate design and threat model.

## 2. Layering

The arrow means “the left layer may depend on the right layer”:

```text
Vue presentation / Tauri adapters
              -> application use cases and capability coordinators
              -> domain/core
              -> contracts and value types
```

Runtime call flow travels from the UI through a typed facade and Tauri command into an application use case, then returns a structured result. Inner layers never import Vue, Tauri, window APIs or concrete persistence/credential implementations.

## 3. Proposed workspace

```text
src/
  api/
    common.ts
    domain/
      connectionsApi.ts
      sessionsApi.ts
      filesApi.ts
      transfersApi.ts
      monitoringApi.ts
      tunnelsApi.ts
      settingsApi.ts
      assistantApi.ts
  components/
    layout/
    ui/
    dialogs/
    connections/
    terminal/
    files/
    monitoring/
    tunnels/
    tasks/
    assistant/
  composables/
  i18n/locales/
  services/
  stores/
  types/
  utils/
crates/
  filex-contracts/
  filex-core/
  filex-storage/
  filex-credentials/
  filex-ssh/
  filex-terminal/
  filex-sftp/
  filex-monitoring/
  filex-tunnels/
  filex-ai/           # create only when the assistant phase starts
src-tauri/
tests/
  fixtures/
  integration/
  e2e/
```

Do not create every crate before the first vertical slice. Begin with contracts, core, desktop adapter, storage and the smallest SSH/terminal capability boundary; split only when responsibilities and tests justify it.

## 4. Core boundaries

### Contracts

Own serializable request/response types, IDs, progress events and structured errors. Contracts do not own framework objects, sockets, database handles or secret values.

Every operation returns either typed data or an error containing:

- Stable code.
- Safe localized-message key or safe fallback message.
- Retryable flag.
- Operation/session/task ID.
- Optional field and structured details.
- Remote-state certainty: unchanged, changed, unknown or not applicable.

Example codes:

`DNS_FAILED`, `CONNECT_TIMEOUT`, `HOST_KEY_UNKNOWN`, `HOST_KEY_CHANGED`, `AUTH_REJECTED`, `CREDENTIAL_UNAVAILABLE`, `CHANNEL_UNAVAILABLE`, `SFTP_UNSUPPORTED`, `REMOTE_PERMISSION_DENIED`, `TRANSFER_CONFLICT`, `TRANSFER_INTERRUPTED`, `TUNNEL_BIND_FAILED`, `MONITOR_UNSUPPORTED`.

### Domain/core

Own connection profiles without secrets, trust decisions, session state transitions, transfer/tunnel state machines, validation and policy decisions. Domain types use credential references, never password strings.

### Application/capability layer

Own use-case orchestration: connect, verify trust, authenticate, open channel, browse, transfer, start tunnel, collect metrics, reconnect and recover tasks. It depends on interfaces for storage, credentials, SSH transport, clock and events.

### Runtime adapters

Own Tauri commands/events, SQLite repositories, OS keyring, native filesystem dialogs, network transport, terminal renderer bridge and platform packaging. They map and forward rather than duplicating policy.

### Presentation

Own view state, focus, panes, dialogs and localized feedback. Vue components use domain API facades and stores; they never call raw `invoke`, sockets, SSH or filesystems directly.

## 5. Session architecture

Use one logical `SessionCoordinator` per active connection profile. It owns cancellation, reconnect policy, trust/auth challenges and capability channels.

```text
SessionCoordinator
  ├─ Transport / jump chain
  ├─ TerminalChannel(s)
  ├─ SftpChannel / transfer workers
  ├─ MonitorCollectorGroup
  ├─ TunnelInstance(s)
  └─ Sanitized event stream
```

Optional channel failure does not close a healthy terminal. A transport failure moves dependent channels to degraded/interrupted states and gives each capability a deterministic recovery decision.

The coordinator emits immutable typed events with monotonic sequence numbers. UI stores discard events from obsolete session generations.

## 6. SSH engine selection spike

Do not commit to a library based only on popularity. Build a bounded spike and score candidates against:

- Windows, macOS and Linux support.
- Interactive PTY resize and Unicode/IME behavior.
- Password, public-key, encrypted-key and SSH Agent authentication.
- Known-host verification hooks and algorithm/fingerprint access.
- Proxy/jump chains and Agent forwarding policy.
- SFTP behavior and large-transfer throughput.
- Local, remote and dynamic forwarding.
- Keepalive, rekey, reconnect and cancellation.
- Modern algorithm policy and maintenance cadence.
- Rust safety surface, native dependency burden, license and auditability.

The spike result becomes an ADR before the first real session implementation.

## 7. Terminal boundary

The terminal emulator/renderer is a presentation capability, while PTY bytes and resize control are session capabilities.

- Rust exposes byte streams, resize, channel state and sanitized diagnostics.
- The renderer owns cell layout, selection, search, scrollback and visual themes.
- Backpressure is mandatory. High output cannot create an unbounded UI or IPC queue.
- Scrollback is capped by lines and memory estimate.
- Resize events are debounced but the final size is always delivered.
- Terminal password input is opaque to application logging.
- Alternate screen, bracketed paste, mouse reporting and Unicode width behavior require compatibility tests.

Evaluate WebView and native renderer options with real throughput, CJK IME, accessibility and memory tests before final selection.

## 8. SFTP and transfers

Separate directory browsing from transfer execution. A listing channel should not be blocked by a long file transfer.

The runtime session-map lock protects lookup and insertion only. Clone the session or terminal handle while holding it, then release it before awaiting SSH or SFTP I/O. Serialize operations on one terminal through its per-session channel lock so unrelated sessions remain available.

- `FileBrowserService` handles list/stat/canonicalize and capability flags.
- `TransferPlanner` expands directories, validates targets, computes conflict plans and records a durable manifest.
- `TransferExecutor` uses bounded workers and per-host concurrency limits.
- `TransferRecovery` marks in-progress work interrupted on restart and determines which items may resume or retry.

Write downloads to a local temporary sibling and atomically rename when possible. Uploads use a remote temporary name and rename when the server/filesystem supports the required semantics. When atomic commit is unavailable, surface that limitation in the operation plan.

Do not promise universal resume. Record server support, remote file identity, offsets and validation evidence per task.

## 9. Monitoring

Monitoring is a capability-probed read-only collector system, not a hard-coded stream of shell commands.

- Probe OS family and available commands once per session generation.
- Enable collectors independently for system, CPU/load, memory, disks and network.
- Parse locale-independent output or force a safe locale for collector commands when permitted.
- Bound polling, execution time and retained history.
- Back off on repeated failure and pause when the app is backgrounded or the connection is unstable.
- Never represent unsupported or failed data as zero.
- Monitoring commands use a dedicated exec channel when available so terminal history and prompt state are not polluted.

## 10. Tunnels

Tunnel rules are persistent non-secret configuration. Tunnel instances are ephemeral and tied to a session generation.

- Validate listen addresses and privileged/non-loopback exposure before start.
- Detect local port conflicts before requesting the remote channel.
- Track active connection count without retaining payloads.
- Close listeners deterministically on session end or application shutdown.
- Reconnect only when the rule explicitly permits it and the owning profile re-establishes trust/auth successfully.

## 11. Storage

SQLite stores:

- Workspaces, groups, profiles, tags and favorites.
- Credential references, never secret material.
- Host trust records and security-event metadata.
- Snippets and non-secret history.
- Transfer manifests and safe task history.
- Tunnel rules.
- Layout, appearance and locale preferences.
- Bounded monitoring summaries if the user enables history.

Use versioned migrations, transactions and backup-before-migration for destructive schema changes. Config files that remain outside SQLite use atomic temp-file-plus-rename writes.

Export has a typed redaction pipeline and excludes secrets by construction rather than by post-processing a full database dump.

## 12. Credential architecture

Define an interface such as:

```text
CredentialStore
  put(kind, secret) -> CredentialRef
  get(ref, purpose, sessionContext) -> SecretLease
  delete(ref)
  status() -> Available | Locked | Unavailable | Unsupported
```

`SecretLease` is short-lived, zeroized where supported, never serializable, never printable and never emitted through Tauri events. The UI receives challenge metadata, not recovered secrets.

When no secure credential service is available, FILEX offers session-only input or a clearly explained unsupported state; it does not silently fall back to plaintext storage.

## 13. Host trust

- Normalize host and port, but preserve the exact requested endpoint and jump path for display.
- Calculate and store modern fingerprints from the presented public key.
- Distinguish imported known-host records, FILEX decisions and one-time trust.
- Changed keys stop before credential use.
- Trust replacement records both fingerprints and a user decision timestamp.
- Hashed known-host formats and multiple algorithms require explicit test fixtures.

## 14. Async and concurrency

- Every session, channel and long task has a cancellation token and generation ID.
- Late events from an obsolete generation are discarded.
- Per-host and global concurrency limits protect remote hosts and local resources.
- Reconnect uses bounded exponential backoff with jitter and an explicit maximum.
- UI actions settle loading state in `finally` and cannot leave dialogs or menus stuck.
- Temporary files, listeners, channels, subscriptions and child processes use scope guards/RAII cleanup.
- Progress events are throttled to avoid saturating Tauri IPC.

## 15. Front-end state

Use separate stores for:

- `connections`: profile summaries, tree and active filter.
- `sessions`: logical session summaries and tab mapping.
- `terminal`: presentation instances and renderer preferences, not byte history in Pinia.
- `files`: current path, listing, selection and capability flags.
- `transfers`: durable task summaries and progress.
- `monitoring`: latest samples and collector states.
- `tunnels`: rules and runtime instances.
- `ui`: pane sizes, dialogs, transient targets and command palette.
- `settings`: theme, locale, fonts and safe preferences.
- `notifications` and `confirmation`: global feedback primitives.

Do not create a single `serverStore` that owns profiles, sockets, terminal bytes, files, dialogs and monitoring.

## 16. Bootstrap

1. Load safe appearance preferences and apply theme/font before mounting.
2. Open/migrate the local database.
3. Check credential-store status.
4. Restore workspaces, layout and interrupted task summaries.
5. Mount the shell and report degraded services.
6. Reconnect sessions only when the user explicitly enabled restore and security prerequisites remain satisfied.

## 17. Security boundary

- Tauri capabilities grant only required dialogs, filesystem scopes and process/network functions.
- Use a strict CSP; no arbitrary remote scripts or remote HTML inside privileged app surfaces.
- Online update metadata is isolated from SSH traffic and signed. Release builds use product-specific GitHub and CNB feeds in a fixed order; the updater accepts only HTTPS metadata whose artifact signature, signed version and configured public key verify.
- External links open through a controlled adapter.
- Remote file preview treats content as untrusted; HTML never executes in the privileged WebView.
- Command snippets are text, not trusted code. Parameter substitution is displayed before execution.
- Logs and crash reports pass through structured redaction before persistence or upload.
- The renderer cannot request credentials directly.

## 18. Test architecture

### Unit

- Profile validation and normalization.
- Trust transitions and changed-key policy.
- Session, transfer and tunnel state machines.
- Redaction and structured error mapping.
- Path/conflict rules, backoff and layout clamps.

### Protocol fixtures

- Disposable SSH servers with password, key, Agent, jump, changed key, unavailable SFTP, slow stream and forced disconnect cases.
- Filesystems with symlinks, permissions, unicode names, huge directories, partial reads and conflict behavior.
- Monitoring fixtures across representative Linux distributions and unsupported outputs.

### Integration

- SQLite migrations and interrupted task recovery.
- Credential-store availability/lock/failure.
- Multi-channel disconnect and cancellation cleanup.
- Transfer temporary-file commit/cleanup.
- Tunnel port conflict and shutdown.

### E2E

- Add profile -> verify key -> authenticate -> terminal -> disconnect/reconnect.
- Terminal + files -> transfer -> interrupt -> recover.
- Start tunnel -> connect through it -> disconnect owner session -> observe cleanup.
- Dark/light, Chinese/English, keyboard-only, minimum window and enlarged font.

CI must fail on TypeScript errors, Rust formatting/lints/tests, uncaught UI errors, leaked fixture secrets and platform-specific compilation failures.

## 19. First vertical slice

Implement in this order after design approval:

1. Workbench shell and semantic token system.
2. SQLite profile repository with credential references.
3. Connection editor and typed profile API.
4. SSH transport spike converted into a production adapter.
5. Host-key decision flow.
6. One authentication method and interactive terminal.
7. Structured error and event timeline.
8. Integration/E2E verification and security review.

SFTP, monitoring and tunnels follow only after the session foundation proves cancellation, host trust, secret handling and recovery.

## 20. AI assistant architecture

The assistant is a consumer of FILEX capabilities, not a privileged alternate control plane. It uses the same application use cases, policy checks, cancellation, structured errors and audit events as human-triggered actions. Model output cannot call SSH transports, credential stores or raw filesystems. Frontend code uses typed Tauri APIs; a narrow Rust command handles only the native picker and bounded read after explicit local-file selection.

### 20.1 Boundaries

```text
Assistant UI
  -> assistantApi / assistant store
  -> AssistantOrchestrator
       ├─ ContextAssembler + Redactor
       ├─ ProviderAdapter
       ├─ ToolRegistry + PolicyEvaluator
       └─ existing FILEX application use cases
```

- `ContextAssembler` accepts explicit context references and produces a bounded, typed snapshot. It does not scrape global stores or whole terminal histories.
- A local-file context reference is created only after the native picker returns a user-selected path. Rust validates and reads bounded text into a short-lived `Zeroizing<String>` and returns only an in-memory ID plus display metadata to Vue. Provider serialization includes redacted file text but excludes the filename, path and reference; these values are not persisted in the transcript, event log or diagnostics.
- `Redactor` removes credentials, tokens, private-key material, credential-bearing URLs, hidden input and user-configured sensitive patterns before provider serialization.
- `ProviderAdapter` owns streaming, timeouts, cancellation, retry policy and provider-specific request/response mapping. Provider API keys are obtained as short-lived credential leases in the Rust adapter and are never returned to Vue.
- `ToolRegistry` exposes stable schemas for registered FILEX use cases. Tools are classified as `observe`, `draft`, `mutate` or `destructive`.
- `PolicyEvaluator` validates provider permission, workspace/session scope, host trust, current session generation, risk class and required confirmation immediately before execution.

### 20.2 Execution contract

Model output is untrusted data. Free-form text cannot invoke capabilities. A tool proposal must deserialize into a known versioned contract and remains inert until FILEX validates it.

The initial `command.draft` v1 preview is built locally from supported shell code fences in a completed Draft response. FILEX supplies the version, kind and fixed `draft` risk; the model cannot assign authority. The renderer caps proposals at five blocks and 10,000 UTF-8 command bytes, rejects hidden control and bidirectional-format characters, and has no terminal-send or execution action. An active session target snapshot is kept in memory only when the user explicitly attaches that session, and the preview becomes stale when its target or connection state changes. Target metadata is omitted from provider requests and transcript storage; restored command drafts have no target binding.

- Observe tools are read-only and return bounded sanitized data.
- Draft tools create text or plans without remote mutation.
- Mutating tools require an explicit user action and show target-rich preview.
- Destructive tools require shared confirmation and backend authorization; policy may disable them completely.
- Multi-host broadcast and unattended loops remain outside the approved scope.
- Any session, trust or target change invalidates outstanding proposals through generation IDs.

### 20.3 Storage and privacy

SQLite may store assistant session titles, provider/model references, redacted messages, context reference metadata, proposals and sanitized outcomes. It does not store provider credentials, recovered secrets, private-key content or hidden terminal input.

Selected local-file text is held only in process memory, limited to 12 KiB per file, at most four temporary references, and a 15-minute lifetime. The retained file buffer is zeroized when released or expired and is never included in assistant history or database backups.

External-provider requests are opt-in and identify the categories leaving the device. Local-model adapters follow the same contracts and policy even when data does not leave the machine. Prompt/response retention is disabled by default and is independent from the operational event timeline.

Remote file content, selected local file text, command output, server banners and copied text are marked as untrusted context so prompt-injection text cannot alter tool policy, confirmation requirements or system instructions.

### 20.5 Phase 5.6 Remote Ops & Docker Facade Contract

```
TerminalQuickOpsBar / Dialogs (MonitorDetailsDialog, DockerDialog, OpsDetailsDialog)
  -> Pinia stores (monitor, processes, network, docker, ops)
  -> Domain API facades (processesApi, dockerApi, opsApi)
  -> Tauri commands (terminate_remote_process with ProcessSignal, collect_docker_snapshot, run_docker_container_action, collect_docker_logs, collect_ops_snapshot)
  -> SessionRuntime bounded SSH execution + strict input/ID validation (filex-contracts DTOs + structured AppError codes)
```

- `terminate_remote_process` accepts an optional strictly-typed `ProcessSignal` (`SIGTERM` default, `SIGKILL`, `SIGHUP`, `SIGSTOP`, `SIGCONT`), validated in Rust and re-verified against the cached `ProcessSnapshot` `(lstart, comm)` / Windows start ticks before signaling.
- `DockerSnapshot` and `run_docker_container_action` strictly allowlist container IDs/names (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`), image IDs, and bounded action verbs (`start`, `stop`, `restart`, `pause`, `unpause`, `remove`) and cap log/probe output sizes and SSH execution timeouts cleanly without shell-interpolating user input.
- `OpsDetailsDialog` executes curated, read-only bounded probes (`ports`, `services`, `disks`, `logs`) via `collect_ops_snapshot` and returns structured availability/permission states (`live`, `unsupported`, `permission_denied`).

### 20.4 Tests

- Redaction fixtures for passwords, keys, tokens, URLs, multiline output and hidden-input markers.
- Provider contract tests for streaming, cancellation, malformed tool calls, rate limits and timeouts.
- Policy tests for observe/draft/mutate/destructive tools, stale generations and changed host trust.
- Prompt-injection fixtures proving remote content cannot grant tools or bypass confirmation.
- E2E flow: attach selected error -> preview disclosure -> receive explanation -> draft command -> reject or confirm -> observe sanitized event.

