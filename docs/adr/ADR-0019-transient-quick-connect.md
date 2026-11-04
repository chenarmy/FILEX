# ADR-0019: Transient quick-connect sessions

Status: accepted  
Date: 2026-11-03

## Context

FILEX has durable connection profiles and explicit credential handling, but the first workspace still lacks a low-friction path for a one-off host. Routing that path through the profile editor writes metadata the user did not ask to retain and makes the first connection slower than the established FinalShell-class workflow.

A quick session also crosses two different persistence scopes. Host trust is security evidence and must remain durable. Connection metadata and authentication secrets are user data that should exist only for the active session.

## Decision

- Add a password-authenticated quick-connect flow for one direct SSH host. Collect host, port and username in a dedicated dialog; do not create a durable profile.
- Construct a temporary `ConnectionProfile` in Rust after validating the exact boundary input. Bind it to the session ID in `SessionRuntime` memory only. It is never inserted through `ProfileService`, SQLite, settings, events, diagnostics or export.
- Run the existing strict host-key probe and trust evaluation. Unknown or changed keys still require the existing explicit confirmation, and confirmed fingerprints are appended to the durable trust ledger.
- Prompt for the password after host verification. Accept it in a dedicated command that wraps it in `Zeroizing`, bounds its encoded size and passes it directly to one route authentication operation. Do not write it to the OS credential store, session state, command results or logs.
- Keep the temporary profile while the session is active so terminal naming and session-scoped inspections can resolve the same endpoint. Remove it on cancellation, authentication or transport failure, disconnect, remote closure, restore reset or application shutdown; a later connection starts from a fresh quick-connect decision.
- Support terminal, PTY, monitoring, direct SFTP and direct remote file operations. Disable durable transfer queue, saved tunnel rules and duplicate-session actions because those features persist or reuse a profile ID. Users who need them create a saved connection profile.
- If a temporary profile is absent during reconnection, fail closed with the existing profile/session error instead of reconstructing endpoint data from UI state.

## Alternatives considered

- **Save a hidden profile automatically.** Rejected because silent retention violates the quick-connect intent and makes credentials/trust behavior harder to explain.
- **Keep only a UI-side profile.** Rejected because host verification, reconnect and authentication checks must be enforced by the trusted runtime boundary.
- **Reuse the normal credential-store command.** Rejected because it stores a password the user expected to use once.
- **Store a temporary profile in SQLite.** Rejected because failed attempts and cleanup would leave user data behind and complicate backup/export exclusion.

## Consequences

- A one-off host can be opened without changing the connection library.
- Temporary sessions remain multi-tab safe because each mapping is scoped by session/profile ID.
- Host trust remains auditable across quick and saved connections.
- Quick sessions intentionally expose fewer workspace actions than saved profiles; the UI must explain the limitation instead of creating orphaned persistent records.
- Runtime lifecycle cleanup needs source fixtures for unknown-key cancellation, authentication failure, disconnect and remote closure. Those fixtures remain pending while verification is deferred.
