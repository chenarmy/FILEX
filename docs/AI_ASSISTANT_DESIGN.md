# FILEX AI assistant design

Status: approved product track, design baseline v0.1  
Delivery phase: Phase 6, with contracts and security boundaries prepared earlier

## Purpose

The FILEX assistant helps operators understand remote-system context and prepare safe next actions. It is not an autonomous administrator and does not bypass FILEX connection, trust, credential, confirmation or authorization boundaries.

Initial outcomes:

- Explain structured connection, authentication, SFTP, transfer, monitoring and tunnel failures.
- Summarize explicitly selected events, monitor samples and bounded terminal output.
- Draft commands, snippets and remediation plans with visible target context.
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
- An explicitly selected text/configuration file with size and type limits.

FILEX does not automatically attach all profiles, full terminal scrollback, credential metadata, private-key files or unrelated local files. Before an external-provider request, the UI identifies the categories and approximate size leaving the device.

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
- Provider data-retention and training disclosures are shown during configuration.
- The core product remains usable with no provider configured and no network access beyond remote operations.

## Security and privacy

- Apply structured redaction before request serialization and again before diagnostic persistence.
- Never include passwords, passphrases, tokens, private-key content, hidden terminal input or credential-bearing URLs.
- Treat remote files, banners, logs and command output as untrusted prompt content. They cannot override system policy or request permissions.
- Keep assistant history local by default. Raw provider traffic is not written to the normal event log.
- Record sanitized proposal, user decision, tool identity, target reference and outcome for executed tools.
- Invalidate pending proposals when the active target, host trust or session generation changes.

## First assistant slice

1. Configure one OpenAI-compatible provider using an OS-keyring credential reference.
2. Attach one structured FILEX error and its sanitized event context.
3. Stream a read-only explanation with cancellation.
4. Draft a command without executing it.
5. Show disclosure, redaction and provider-failure states.
6. Verify through tests that secrets and hidden terminal input never cross the provider boundary.

Executable tools follow only after the underlying SSH, file, transfer, monitoring or tunnel use case has passed its own security and recovery acceptance.

## Explicit exclusions

- Unattended autonomous operation.
- Silent command execution or terminal injection.
- Multi-host command broadcasting.
- Secret recovery or credential display.
- Self-modifying policy, plugin installation or unrestricted shell/filesystem tools.
- Cloud sync of assistant history in the initial track.
