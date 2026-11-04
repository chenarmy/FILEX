# FILEX product design

Status: design baseline v0.2  
Product type: local-first cross-platform desktop application  
Target platforms: Windows, macOS, Linux

## 1. Product definition

FILEX is a secure remote operations workbench for developers, individual operators, and small infrastructure teams. It combines terminal sessions, remote files, lightweight server visibility, and SSH tunnels without requiring an always-online account or a permanently installed server agent.

FILEX should feel like a calm desktop IDE for remote systems rather than a collection of disconnected utilities. The product is inspired by the integrated workflow of tools such as FinalShell, but uses its own product identity, architecture, interaction model, and security defaults.

### Product promise

> Connect, inspect, transfer, and troubleshoot from one local workspace without surrendering credential control.

### Primary outcomes

- Reach a known server safely and quickly.
- Keep terminal, remote files, and server context synchronized without losing place.
- See enough resource health to understand whether a problem is local, network, or remote.
- Run and observe transfers or tunnels without blocking terminal work.
- Recover cleanly from disconnects, suspended laptops, changed networks, and interrupted tasks.

## 2. Research basis

The official FinalShell product page describes a cross-platform server-management tool with multi-tab SSH/RDP, terminal and SFTP side by side, resource and network monitoring, process management, command assistance, proxy support, and transfer optimizations. Its FAQ also exposes real failure modes: unsupported remote commands, unavailable SFTP, repeated authentication caused by separate channels, encoding mismatches, missing monitoring tools, and platform differences.

FILEX uses those public market signals to identify user needs. It does not copy FinalShell assets, text, protocols beyond open standards, acceleration service, cloud implementation, or edition model.

References:

- https://www.hostbuf.com/t/988.html
- https://www.hostbuf.com/t/1088.html
- https://www.hostbuf.com/t/1081.html

## 3. Inherit, adapt, replace

| Area | Decision |
| --- | --- |
| Dense workbench, continuous panes, semantic tokens, adjustable layout | Inherit from the GITBX non-functional baseline |
| Dark-first visual posture, light theme, typography controls, keyboard and RTL readiness | Inherit |
| Navigation + session tabs + contextual inspector + task drawer + status bar | Adapt to remote operations |
| Native versus custom window chrome | Use native chrome initially; custom chrome only after cross-platform accessibility validation |
| Typed contracts, portable core, thin adapters, structured errors | Inherit |
| GITBX brand and Git features | Replace completely |
| FinalShell name, copy, artwork, cloud sync, acceleration and paid tiers | Replace completely |
| FILEX domain, workflows, security policy and release model | Define independently |

## 4. Target users

### Independent developer

Maintains a few VPS or cloud instances, frequently switches between terminal and file upload, and wants fast local profiles without an account.

### Operations engineer

Manages dozens or hundreds of hosts organized by project and environment. Needs quick search, trustworthy host identity, jump hosts, tunnels, transfer visibility, and diagnostic context.

### Support or delivery engineer

Needs controlled remote access, reproducible command snippets, safe file exchange, readable logs, and clear evidence of which host and environment is active.

### Explicit non-target for the first release

Large enterprises requiring multi-user RBAC, approval workflows, session recording governance, centralized secrets, or bastion audit compliance. FILEX may integrate with such systems later, but will not pretend to be a PAM platform in v1.

## 5. Product principles

1. **Local first:** core use does not require a FILEX account or cloud service.
2. **Identity before convenience:** host-key trust is explicit; changed keys stop connection until resolved.
3. **Context is always visible:** host, user, environment, trust state, and connection state remain legible around the terminal.
4. **One session, multiple capabilities:** terminal, SFTP, monitoring, and tunnels share a logical session coordinator while retaining separate channels and failure states.
5. **Failure is a state, not a popup:** disconnect, auth challenge, missing SFTP, permission denial, stale metrics, and interrupted transfers have durable recovery paths.
6. **No hidden remote mutation:** monitoring defaults to read-only commands; destructive file/process actions are explicit.
7. **Power without noise:** dense information, compact controls, minimal decoration, and progressive disclosure.

## 6. Core domain objects

### Workspace

A local organization boundary containing connection groups, visual layout, snippets, and non-secret preferences. A user can have multiple workspaces without separate accounts.

### Connection profile

Contains display name, host, port, username, protocol options, group, tags, proxy/jump chain, credential reference, environment classification, startup behavior, and optional monitoring policy. It never embeds plaintext secrets.

### Credential reference

Points to an OS-keyring secret, SSH Agent identity, or private-key path plus a separately stored passphrase reference. The profile remains usable for export only after secret fields are stripped.

### Host trust record

Stores host, port, key algorithm, public fingerprint, first-seen time, last-seen time, source, and explicit user decision. Changed fingerprints never overwrite the trusted record silently.

### Session

The logical lifetime of a connection profile. It coordinates terminal, SFTP, monitoring, and tunnels, but each channel reports its own state and can fail independently.

### Terminal pane

A presentation instance attached to a session and pseudo-terminal channel. Tabs and splits may reference the same profile but do not implicitly share shell state.

### Remote file entry

A path-scoped view model with type, ownership, permission, size, modification time, symlink target, and capability flags. Remote paths use POSIX semantics unless the negotiated server says otherwise.

### Transfer task

A durable upload/download operation with source, destination, overwrite policy, total progress, item results, retry metadata, and cleanup state.

### Tunnel rule and tunnel instance

A saved definition for local, remote, or dynamic forwarding and a runtime instance with listening address, target, connection dependency, status, and diagnostics.

### Monitor sample

A timestamped, capability-tagged sample for load, CPU, memory, swap, disks, and network. Unsupported metrics stay absent rather than becoming zero.

### Command snippet

A user-authored template with name, body, optional parameters, tags, shell hints, and risk classification. It is inserted or previewed by default; automatic execution is an explicit choice.

### AI assistant session

A local conversation record containing provider/model references, explicitly attached FILEX context, redacted messages, proposed actions and user decisions. It never contains recovered credentials, private-key content, hidden terminal input or unrestricted terminal scrollback. Assistant sessions are local by default and are deleted or exported independently from connection profiles.

### Assistant action proposal

A typed, inspectable proposal produced by the assistant. It contains the target workspace/session, capability, parameters, risk classification, required confirmation and expected remote-state impact. A proposal is not executable authority: FILEX revalidates policy and target state when the user chooses to run it.

## 7. Functional scope

### P0 — trusted connection and terminal

- Create, edit, duplicate, group, tag, favorite, search, import, and export non-secret connection profiles.
- Import selected entries from `~/.ssh/config` while preserving unsupported directives as warnings.
- SSH password, private-key, and SSH Agent authentication.
- Explicit unknown-host confirmation and changed-key blocking flow.
- Proxy and jump-host chain with per-hop diagnostics.
- Multiple session tabs, reconnect, duplicate session, terminal search, copy/paste, encoding, theme, font, scrollback, and optional split panes.
- Connection event timeline with sanitized diagnostics.

### P0 — SFTP and transfer queue

- Remote file browser bound to the active session.
- Optional local file pane for deliberate drag/drop and path selection.
- Upload, download, create folder, rename, move, copy, delete, refresh, and permission inspection.
- Transfer queue with pause when technically supported, cancel, retry, conflict policy, partial failure, and restart recovery.
- Inline text preview/editor only for bounded text files; binary and oversized files open through an explicit external action.
- Remote deletion uses clear target context and distinguishes files, directories, and symlinks.

### P0 — basic server visibility

- System identity, uptime, load, CPU, memory, swap, disk usage, and network throughput when supported.
- Capability probe before polling; unsupported commands or insufficient permissions degrade individual metrics.
- Adjustable polling interval with automatic suspension when the application is backgrounded or the session is unstable.
- No server-side agent requirement in v1.

### P0 — tunnels

- Local, remote, and dynamic SOCKS forwarding.
- Saved tunnel rules, ad-hoc instances, auto-start option, port conflict diagnostics, and lifecycle controls.
- Clear linkage to the owning SSH session and stop behavior on disconnect.

### P1 — productivity

- Parameterized command snippets with preview and safe history.
- Quick connect that does not persist credentials unless explicitly saved.
- Session templates and profile duplication.
- Host-level notes and tags.
- File checksum comparison and safe directory synchronization preview.
- Process list with read-only default and explicit signal actions.
- Config backup/export with secrets excluded by default.

### Planned — AI assistant

- Explain sanitized connection, authentication, transfer, monitoring and tunnel errors.
- Summarize selected event ranges, bounded terminal output, monitor samples and transfer failures.
- Draft commands, snippets and remediation plans with the exact target host and environment shown.
- Compare explicitly selected configuration or text files and propose changes without writing them automatically.
- Support OpenAI-compatible and optional local-model providers through a provider-neutral API.
- Keep chat/session history local by default; external-provider requests show which context categories will leave the device.
- Expose typed FILEX tools progressively: observe first, then draft, and only later confirmed actions after the underlying capability has passed its own security acceptance.
- Never enable unattended autonomous operation, multi-host command broadcast or destructive execution as an incidental assistant feature.

### Later, after separate design approval

- RDP and other remote desktop protocols.
- Serial, Telnet, FTP, Kubernetes, container, or database-specific consoles.
- Multi-host command broadcasting and orchestration.
- End-to-end encrypted cross-device sync.
- Team workspaces, enterprise policies, audit export, or shared secrets.
- Plugin marketplace or autonomous operations.
- Commercial network acceleration services.

## 8. Primary workflows

### 8.1 First connection

1. User chooses Quick Connect, Add Connection, or Import SSH Config.
2. FILEX validates host/port/profile fields locally.
3. Session enters resolving and connecting states with step-specific diagnostics.
4. Unknown host key opens a fingerprint decision dialog with algorithm, SHA-256 fingerprint, endpoint and source context.
5. Authentication proceeds through the selected method; challenges remain scoped to the intended host/hop.
6. Terminal becomes usable before optional SFTP and monitoring finish probing.
7. Unsupported optional channels appear degraded without closing the terminal.

### 8.2 Changed host key

1. Connection stops before credential submission.
2. FILEX shows old and presented fingerprints, first/last seen times, endpoint and jump path.
3. User may cancel, inspect known-host sources, or explicitly replace trust after an out-of-band check.
4. Replacement is recorded as a security event; it is never a one-click generic warning.

### 8.3 Terminal and remote files

1. User opens the Files inspector for the active session.
2. Remote directory changes may follow the shell only when reliable path tracking is enabled; otherwise terminal and file paths remain independent and visibly labelled.
3. Dragging to a remote directory creates transfer tasks and never blocks terminal input.
4. Conflicts open a reusable policy dialog: ask, overwrite, skip, rename, or apply to remaining items.
5. Disconnect pauses or interrupts work with resumability determined per task.

### 8.4 Monitoring

1. Session performs a read-only capability probe.
2. Supported collectors begin bounded polling.
3. Each metric indicates live, stale, unsupported, or permission denied.
4. Repeated collector failure backs off and does not flood terminal history or remote load.

### 8.5 Tunnel lifecycle

1. User validates listen address, port, destination and exposure risk.
2. FILEX checks local conflicts before requesting the SSH channel.
3. A running tunnel appears in the task drawer and status bar.
4. Session degradation changes the tunnel to degraded/stopped with an explicit reconnect policy.

### 8.6 AI-assisted diagnosis

1. User opens the assistant and explicitly attaches a session, event range, metric set, file or bounded terminal selection.
2. FILEX previews the context categories, applies structured redaction and identifies whether an external provider will receive data.
3. The assistant explains or drafts an action. Generated shell text remains a proposal and is never written into the terminal input buffer without a visible user action.
4. A requested tool call shows target, parameters, risk, expected mutation and confirmation requirement.
5. FILEX revalidates session generation, trust and policy before execution, then records a sanitized decision/result event.

## 9. State models

### Session

`idle -> resolving -> connecting -> verifying_host -> authenticating -> connected -> reconnecting -> connected`

Terminal states also include `auth_required`, `degraded`, `suspended`, `disconnecting`, `disconnected`, `failed`, and `closed`. A failed optional capability does not imply a failed session.

### Transfer task

`draft -> scanning -> queued -> transferring -> verifying -> completed`

Alternative states: `paused`, `cancel_requested`, `cancelled`, `partial`, `interrupted`, `failed`, `blocked`, `retrying`, `cleaning_up`.

### Tunnel instance

`stopped -> starting -> listening -> degraded -> stopping -> stopped`, plus `failed` and `blocked`.

### Monitoring

`disabled`, `probing`, `live`, `stale`, `unsupported`, `permission_denied`, `paused`, and `failed` are per collector rather than global.

## 10. Security and privacy requirements

- Use the platform credential store for passwords and passphrases. Store only opaque references in the profile database.
- Private key contents are never copied into ordinary app configuration. Import means register a path unless the user explicitly requests a managed secure copy.
- Support OpenSSH `known_hosts` import through a preview and explicit confirmation; skip ambiguous hashed/pattern entries and retain previous fingerprints in the FILEX trust ledger.
- Never offer “always accept any host key.”
- Proxy/jump credentials are isolated per hop and never displayed in the destination profile summary.
- Redact usernames when requested and redact passwords, tokens, passphrases, credential-bearing URLs, and private key content unconditionally.
- Terminal logging is off by default, per-session opt-in, visible while active, and never includes hidden password input.
- Clipboard copy of secrets is avoided; reveal/copy actions are explicit and time-bounded when provided.
- Remote delete, recursive permission changes, process signals, and command broadcast require target-rich confirmation.
- Monitoring uses read-only commands by default and cannot silently escalate privileges.
- Exported profiles exclude secrets, host event logs, and absolute local key paths unless the user deliberately includes them.
- No telemetry or cloud calls in the core product by default. Update checks and crash reporting are separate, visible settings.
- AI providers are opt-in. Provider credentials live in the OS credential store and never enter chat history, ordinary settings, prompts or diagnostics.
- Remote files, terminal output, command output and server banners are untrusted model input. They cannot grant tool permissions or override FILEX policy.
- Sending context to an external model requires a provider-level consent setting and a per-request context preview for sensitive categories.
- Assistant actions default to read-only explanation or drafts. Mutating actions require an explicit user gesture; destructive actions require target-rich confirmation and backend policy checks.
- Assistant requests and tool results use bounded context, cancellation, timeouts and redacted audit events. Raw prompts are not retained unless the user enables local history.

## 11. Non-functional targets

Initial budgets must be measured on production builds and revised with evidence:

- Cold start to usable shell: P95 <= 1 second on a representative modern desktop.
- Open a cached profile list of 5,000 hosts: P95 <= 200 ms.
- Local profile search: P95 <= 100 ms for 10,000 profiles.
- Terminal input-to-render latency introduced by FILEX: P95 <= 16 ms under normal throughput.
- Pane resize, scrolling, terminal rendering and metric animation target 60 fps.
- Idle memory with no sessions: target <= 100 MB; with one terminal session: target <= 160 MB, subject to terminal-renderer spike results.
- No unbounded terminal scrollback, metric history, transfer log, cache, or reconnect loop.
- Application remains usable when update, sync, monitoring, or optional network services are unavailable.

## 12. Product acceptance for the first vertical slice

The first implementation slice is not complete until a user can:

1. Create a profile without storing plaintext credentials.
2. Connect to a test SSH server.
3. Inspect and explicitly trust its host key.
4. Authenticate using one supported method.
5. Use an interactive terminal and see host/session context.
6. Disconnect and reconnect with clear state transitions.
7. Receive structured, localized errors for DNS, timeout, changed key, auth rejection and remote close.
8. Verify through tests that credentials and terminal password input do not enter logs or serialized settings.

## 13. Open decisions before implementation

- Which SSH engine provides the best cross-platform PTY, Agent, jump-host, SFTP, forwarding, cipher-policy and maintenance profile? Resolve with a written spike rather than assumption.
- Whether v1 terminal rendering uses a WebView renderer or a native terminal surface. Measure IME, ligatures, accessibility, throughput and memory.
- Whether transfer resume can be guaranteed for each direction/server capability; UI must not promise resume universally.
- Which Linux secret-service fallback is acceptable when no keyring daemon is available.
- Exact supported operating-system minimums and packaging/signing plan.
- Which external and local AI providers are supported initially, what data-retention disclosures they require, and whether streaming/tool calling behavior is consistent enough for a shared contract.
- Which assistant tools may graduate from observe-only to confirmed execution after the corresponding FILEX capability passes security review.

