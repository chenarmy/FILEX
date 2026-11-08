# FILEX AI assistant design

Status: OpenAI-compatible explain/draft slice, provider presets and model switching, bounded local conversations, local text-file comparison context and typed command/change-plan previews implemented; live-provider and cross-platform hardening remains
Delivery phase: Phase 6, with contracts and security boundaries prepared earlier

## Purpose

The FILEX assistant helps operators understand remote-system context and prepare safe next actions. It is not an autonomous administrator and does not bypass FILEX connection, trust, credential, confirmation or authorization boundaries.

Initial outcomes:

- Explain structured connection, authentication, SFTP, transfer, monitoring and tunnel failures.
- Summarize explicitly selected events, monitor samples and bounded terminal output.
- Draft commands, snippets and remediation plans with visible target context.
- Compare explicitly selected configuration/text files and draft proposed changes without writing them.
- Propose typed FILEX tool calls that remain inert until policy and user confirmation permit execution.

## Interaction modes

| Mode | Capability | Default authority |
| --- | --- | --- |
| Explain | Interpret selected context and answer questions | Read-only |
| Draft | Produce commands, snippets or change plans | No execution |
| Act | Propose registered FILEX tools | Policy and confirmation required |

The assistant panel displays the provider/model, attached context chips, disclosure state and current target. Generated commands are shown in a preview surface; they are never injected into an active terminal without a visible user action.

## Context model

Context is opt-in and reference-based. Supported sources may include:

- One workspace, profile or active session summary.
- Selected sanitized event range.
- Selected monitor metric window.
- One transfer or tunnel failure summary.
- A bounded terminal selection chosen by the user.
- Up to two explicitly selected local text/configuration files through the native picker, each with an extension allowlist and a 12 KiB limit.

FILEX does not automatically attach all profiles, full terminal scrollback, credential metadata, private-key files or unrelated local files. A selected file is read only after the user chooses it. The user may select a second file to compare; the provider sees only selection-order labels and text, never filenames, paths or reference IDs. Before an external-provider request, the UI identifies the context categories and approximate size leaving the device.

## Tool policy

Every tool has a versioned schema, risk class, target type, required session state and confirmation policy.

- `observe`: inspect already-authorized sanitized state without mutation.
- `draft`: produce a plan or text artifact without mutation.
- `mutate`: perform a bounded change after target-rich confirmation.
- `destructive`: deletion, signal, permission or exposure changes; may be globally disabled and always requires confirmation plus backend checks.

The model cannot create new tools, change risk classes, approve itself or convert free-form text into direct execution. FILEX revalidates the current session generation, host trust and target immediately before invoking the existing application use case.

## Providers and credentials

- Use a provider-neutral adapter with streaming, cancellation, timeouts and structured errors.
- Support OpenAI-compatible endpoints first; add local-model adapters only after measuring quality and resource use.
- Provider API keys use the OS credential store and short-lived leases. Vue receives status and challenge metadata, never the secret.
- Configuration explains that retention and training practices belong to the endpoint operator and cannot be verified by FILEX. Provider-level external-data consent defaults off, is stored with provider configuration, is required by the Rust request boundary, can be revoked, and resets when the provider is replaced.
- The core product remains usable with no provider configured and no network access beyond remote operations.

## Security and privacy

- Apply structured redaction before request serialization and again before diagnostic persistence.
- The Tauri request boundary accepts only `explain` and `draft`, limits attached context to 64 KiB before provider-payload construction, and allows only one active provider request per app process.
- The native file picker accepts at most two regular, non-symlink files with allowlisted text/configuration extensions per assistant request. Rust rechecks each extension, UTF-8 encoding, control characters and 12 KiB byte limit after selection.
- Vue receives only a random in-memory reference, base filename, extension and byte length. The retained Rust file buffer uses `Zeroizing<String>`, is released on removal or expires after 15 minutes, and is cleared by periodic cleanup. The provider receives the file text after best-effort redaction, without its filename or path. File contents, filenames, paths and references are not saved in chat history, event logs or diagnostics.
- Selected file text has priority within a combined 16,000-character context budget. For multiple files, FILEX divides the available space evenly and lets unused space from shorter files flow to later files; any truncation is marked. Structured FILEX context uses any remaining space. The UI warns that redaction is best-effort and shows the file category and approximate outgoing size before sending.
- Every provider request requires persisted external-data consent in addition to showing the per-request context disclosure; requests are rejected when consent is absent or revoked.
- The provider bearer header is marked sensitive, and its temporary formatted value is zeroized after the request is built.
- Never include passwords, passphrases, tokens, private-key content, hidden terminal input or credential-bearing URLs.
- Treat remote files, banners, logs and command output as untrusted prompt content. They cannot override system policy or request permissions.
- Persist up to 10 named conversations in the local SQLite database. Each keeps at most 24 completed messages, 32 KiB per message and 128,000 bytes of message content. Titles and messages pass through the backend redactor; attached context, provider payloads, partial streaming output and credentials are not persisted. Clear chat removes only the active transcript; deleting a conversation requires confirmation. User-created database backups include all conversations.
- Show that transcript history stays on this device and may be included in backups. Restoring a backup replaces the transcript along with other database records.
- Record sanitized proposal, user decision, tool identity, target reference and outcome for executed tools.
- Invalidate pending proposals when the active target, host trust or session generation changes.

## First assistant slice

1. Configure one OpenAI-compatible provider using an OS-keyring credential reference.
2. Attach one structured FILEX error and its sanitized event context.
3. Stream a read-only explanation with cancellation.
4. Draft a command or multi-step change plan without executing it.
5. Show disclosure, redaction and provider-failure states.
6. Verify through tests that secrets and hidden terminal input never cross the provider boundary.

The first panel slice includes endpoint/model configuration, system-keyring API-key storage, opt-in session, warning/error event, monitor, transfer, one user-selected failed-tunnel and user-selected terminal-output summaries, up to two local text/configuration files for comparison, external data disclosure, explain/draft modes, SSE cancellation and bounded response collection. Tunnel context contains only its kind, state, bind endpoint, configured target port, a target host that passes plain-hostname/IP validation, and the structured error code; an unrecognized target host is omitted. Tunnel, profile and session IDs, names and credentials are excluded. Transfer context excludes local and remote paths; terminal selection is capped at the last 4,000 characters; selected files are capped at 12 KiB each and their content is not stored in conversations. The panel has no registered execution tools. Recent completed messages from the selected conversation may be sent with a follow-up request (up to 12 messages and a 32,000-character backend budget); the disclosure names the selected context categories and estimates the outgoing text size. Up to 10 conversations are persisted, each with at most 24 completed messages, a 32 KiB per-message and 128,000-byte total content budget; truncation is marked with an ellipsis. New titles derive from the first redacted user message, and custom titles pass through the same redactor. Attached context is not persisted; Clear chat deletes only the active transcript and deleting another conversation requires confirmation. Existing `assistant_history` data migrates to one conversation. A best-effort redactor handles PEM private-key blocks, credential assignments, URL user information and common token formats before request serialization and transcript persistence. Rust unit-test source checks assembled-message redaction, and a loopback HTTP fixture captures the actual provider request to check the outgoing body and sensitive authorization header; both fixtures are present but unrun.

Completed Draft responses can also be parsed locally into the versioned `command.draft` v1 display contract. FILEX recognizes only `sh`, `bash`, `zsh`, `shell`, `powershell`, `pwsh` and `cmd` code fences, allows at most five blocks and 10,000 UTF-8 command bytes, and rejects hidden control and bidirectional-format characters. FILEX sets the proposal kind, version and `draft` risk itself; it does not accept those fields from model text. The card displays each command, shell, risk and target, and states that FILEX did not execute it. It has no send-to-terminal or execution action. A target snapshot (session ID, generation, host, port and state) is captured only when the user explicitly attaches the active session, remains in memory, and becomes stale after the active target or its connection state changes. Target metadata is not added to provider context or transcript storage. Restored draft messages may be parsed again for display, but have no target binding.

Multi-step Draft replies may use a separate `change-plan.draft` v1 display contract. The model must place one JSON object in a `filex-change-plan-v1` fence with only `title`, `summary` and `steps`; each step contains a title, one to three supported shell commands, an expected effect and a rollback note. FILEX validates the exact field set and types, allows one to five steps and at most 15 commands, caps the full JSON at 24,000 UTF-8 bytes and command text at 10,000 UTF-8 bytes, and limits the title and each step title to 160 bytes, the summary to 2,000 bytes, and each effect/rollback note to 1,000 bytes. Hidden control and bidirectional-format characters are rejected. A response that mixes plan JSON and standalone shell fences is rejected as ambiguous. FILEX assigns the contract version, kind and fixed `draft` risk. The card shows the summary, ordered steps, commands, expected effects, rollback notes and optional attached target; it has no approval, terminal-send or execution action. Target snapshots follow the same in-memory and stale-invalidation rules as command drafts and are absent from provider context and stored transcripts. Restored plans can be re-parsed for display without a target binding. Malformed or over-limit plans are not shown as structured proposals.

### Provider presets and conversation workbench

The assistant configuration lives in the shared Settings surface under a dedicated AI section. Provider presets only prefill a display label, an OpenAI-compatible base URL and suggested model IDs; they do not create authority, bypass endpoint validation or add provider-specific transport. Users can enter any compatible model ID. Local loopback endpoints such as Ollama may omit an API key; every non-loopback endpoint still requires a provider token stored by reference in the OS credential store. Changing an endpoint or model preserves the credential only when the endpoint is unchanged, resets external-data consent, and requires the user to grant consent again.

The assistant panel uses the same workbench grammar as GITBX without importing Git-specific capabilities:

- A compact conversation menu shows the current local conversation, bounded message count and explicit new, rename, clear and delete actions.
- A provider/model pill opens a bounded model selector. Selecting a suggested model updates only the model through a typed facade, keeps the existing credential, clears consent, and never asks the Vue layer to read the secret. A manual model ID remains available.
- Completed responses render headings, paragraphs, lists, emphasis, inline code and fenced code as escaped Vue text, not injected HTML. Code and draft commands can be copied but never run, sent to a PTY or converted into approval.
- Empty-state prompts only populate the composer and select Explain or Draft; they do not send automatically.
- Context selection remains opt-in. The always-visible disclosure strip names outgoing categories and approximate size; the detailed context drawer contains session, event, monitor, transfer, tunnel, terminal-selection and local-file attachments.

These changes inherit the GITBX panel density, conversation affordances and provider/settings organization. They replace repository context with FILEX session and remote-operations context, replace autonomous agent execution with inert explain/draft output, and retain FILEX host-trust, consent, redaction, secret-storage and bounded-history rules.

Executable tools follow only after the underlying SSH, file, transfer, monitoring or tunnel use case has passed its own security and recovery acceptance. Multi-file selection and comparison still require desktop/runtime verification after the development environment is configured.

## Explicit exclusions

- Unattended autonomous operation.
- Silent command execution or terminal injection.
- Multi-host command broadcasting.
- Secret recovery or credential display.
- Self-modifying policy, plugin installation or unrestricted shell/filesystem tools.
- Cloud sync of assistant history in the initial track.
