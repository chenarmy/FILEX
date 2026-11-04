# ADR-0013: SSH Agent authentication

Status: accepted for the Phase 2 SSH vertical slice  
Date: 2026-11-03

## Context

Connection profiles already include `AuthenticationMethod::Agent`, but the SSH runtime rejects that method. FILEX needs to use the user's local SSH agent without copying private key material into the application, profile database, Tauri payloads, logs, or UI state. Authentication must remain behind the existing host-key trust boundary.

The selected `russh` 0.65 engine includes an SSH agent client and signer, plus OpenSSH session binding. Its agent API supports Unix-domain sockets, Windows named pipes, Pageant streams, public keys, and OpenSSH certificates. OpenSSH destination-constrained identities require session binding before identity enumeration or signing.

## Decision

- Use `russh::keys::agent::client::AgentClient` as the local signer. FILEX never reads or receives an agent-held private key.
- On Unix, connect only to the endpoint named by `SSH_AUTH_SOCK`. On Windows, use an explicit `SSH_AUTH_SOCK` named pipe when present; otherwise try the standard OpenSSH Agent pipe (`\\.\pipe\openssh-ssh-agent`). Do not log or return the endpoint path.
- Authenticate the SSH transport first. The engine's host-key callback must match the expected algorithm and SHA-256 fingerprint before FILEX contacts the agent.
- Require `handle.agent_session_binding()` and successfully call `bind_session(binding, false)` before requesting identities. An agent that cannot bind this session is rejected; FILEX never falls back to unbound signing. `false` explicitly disables agent forwarding.
- Support agent public keys and OpenSSH certificates. Do not retain identity comments or include them in errors, events, or diagnostics.
- Limit one connection to six identity authentication attempts, matching the common SSH server default and bounding agent prompts and server failures. If more identities are loaded and the attempted subset is rejected, return a specific limit error instead of silently treating it as a bad password.
- Bound Agent discovery, binding, identity enumeration and signing by the configured SSH connection timeout. Cancelled attempts close the SSH handle with a one-second cleanup bound.
- Map agent discovery, binding, identity-list, signing, and server-rejection failures to structured localized errors without exposing socket paths, public-key blobs, comments, signatures, or local agent diagnostics.
- Agent profiles do not create or retrieve an OS credential-store entry. The profile stores only the selected authentication method.

## Consequences

- Unix requires a reachable `SSH_AUTH_SOCK`; Windows supports a configured named pipe or the Windows OpenSSH Agent service. Agent providers that lack OpenSSH session-binding support are intentionally unsupported by this slice.
- Agent identity selection is automatic in agent order and capped at six attempts. Users with many loaded identities may need to remove unrelated keys before connecting.
- `ProxyJump` remains a separate follow-up. Each jump requires an independent trust decision and credential mapping; the Agent slice does not change that boundary.
- The UI can enable the Agent option and explain that a compatible local agent must be running. Missing agent, empty identities, unsupported binding, signing failure, and remote rejection remain distinct user-visible errors.

## Acceptance evidence

- Source review confirms trust is checked both against the FILEX ledger and against the exact SSH handshake key before agent use.
- Agent session binding precedes identity enumeration; unbound fallback and agent forwarding are absent.
- Agent socket paths, identity comments, key material, and signatures do not cross serializable or diagnostic boundaries.
- Local-agent success, unavailable-agent, empty-agent, binding failure, server rejection, host-key rejection, and bounded-attempt cases require runtime fixtures and cross-platform checks. These remain pending until the user configures the development environment.
