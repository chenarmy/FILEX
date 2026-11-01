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

Status: **in progress**

Implemented foundation:

- Vue 3/Vite/Pinia workbench shell with semantic dark/light tokens and Chinese/English locale skeleton.
- Typed connection-profile API facade with browser persistence and Tauri command adapter.
- Rust `filex-contracts` and `filex-core` crates with structured errors, profile validation and tests.
- Tauri 2 shell with restrictive CSP and a minimum `core:default` capability set.
- Settings persistence for safe appearance/layout preferences; no secret-bearing setting is serialized.

Verification evidence is recorded in `docs/VERIFICATION.md`. SSH engine, terminal renderer, SQLite and credential-store spikes remain open and are not represented as complete capabilities in the UI.

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

Deliverables:

- Profile management and SSH config import preview.
- Host-key verification and trust ledger.
- Password or key authentication plus SSH Agent where supported by the selected engine.
- Multi-tab terminal, reconnect and sanitized event timeline.

Exit criteria:

- End-to-end connection path passes DNS, timeout, unknown key, changed key, auth rejection, remote close and reconnect cases.
- Terminal remains responsive under bounded high-output tests.
- Dark/light, Chinese/English, keyboard and minimum-window acceptance passes.

## Phase 3 — SFTP and durable transfers

Deliverables:

- Remote browser and expanded dual-pane mode.
- Upload/download queue, conflict policy, cancellation, retry and interrupted-task recovery.
- Bounded text preview/editor and explicit external-open path.

Exit criteria:

- Large file, directory, symlink, unicode, permission, disconnect and partial-failure fixtures pass.
- Temporary artifacts are cleaned on every failure path.
- UI never claims universal resume or atomic commit when unsupported.

## Phase 4 — monitoring and tunnels

Deliverables:

- Capability-probed read-only collectors.
- Live/stale/unsupported/permission-denied metric states.
- Local, remote and dynamic tunnel rules and instances.

Exit criteria:

- Monitoring does not pollute terminal history or overload unsupported hosts.
- Tunnel listeners close deterministically on session/app shutdown.
- Non-loopback exposure and port conflicts have tested warnings and recovery.

## Phase 5 — productivity and hardening

Candidates:

- Parameterized snippets with preview.
- Process inspection and explicit signal actions.
- Checksums and directory synchronization preview.
- Signed updater, backup/export, diagnostics bundle and packaging polish.

Exit criteria:

- Cross-platform installation/update/uninstall checks.
- Threat-model review and dependency audit.
- Performance budgets measured on production builds.
- Accessibility and localization acceptance complete.

## Phase 6 — AI assistant

The assistant is an approved product track. Its contracts, redaction boundary and tool policy are designed early, but executable tools are enabled only after their underlying FILEX capabilities pass security and recovery acceptance.

Deliverables:

- Provider-neutral assistant API with OpenAI-compatible and optional local-model adapters.
- OS-credential-backed provider secrets, streaming, cancellation, timeout and rate-limit handling.
- Local chat sessions with explicit context chips and external-provider disclosure preview.
- Explain and summarize flows for sanitized errors, events, metrics, transfers and bounded terminal selections.
- Command/snippet/change-plan drafting without implicit execution.
- Versioned typed tool registry with observe, draft, mutate and destructive risk classes.
- Target-rich confirmation, policy enforcement, stale-proposal invalidation and sanitized assistant audit events.

Exit criteria:

- Provider credentials, SSH credentials, private keys and hidden terminal input never enter ordinary settings, prompts, logs or chat history.
- Remote content cannot grant permissions, modify policy or bypass confirmation in prompt-injection fixtures.
- Every external request previews or clearly identifies context categories leaving the device.
- Mutating tools call existing application use cases and pass the same authorization, structured-error and cancellation checks as human-triggered actions.
- Streaming, cancellation, provider failure, rate limiting, malformed tool calls and stale session generations pass integration and E2E tests.
- Multi-host broadcasting, unattended autonomous loops and silent destructive execution remain unavailable.

## Deferred product tracks

RDP, cloud sync, team collaboration, batch commands, plugins and acceleration each require a separate product/design/security review. They are not allowed to enter a phase as incidental scope.
