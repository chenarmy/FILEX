# ADR-0012: Private-key SSH authentication

Status: accepted for the Phase 2 SSH vertical slice  
Date: 2026-11-03

## Context

The connection profile already carries an optional private-key path and the credential store already defines a separate `key-passphrase:<uuid>` reference. The SSH engine and session flow currently reject private-key profiles, so the profile editor cannot safely use those fields.

Private keys are user-owned files. FILEX needs to authenticate with a selected key without copying its contents into SQLite, profile exports, assistant context, diagnostics, events, or UI state. Host identity must still be checked before authentication, and an encrypted key must produce an explicit passphrase request.

## Decision

- Keep the private-key path in the local connection profile. Read the selected file only during authentication, with a 1 MiB read bound. Do not log the path or include it in structured errors.
- Decode the key in the `filex-ssh` capability using the selected `russh` parser. Zeroize the bounded source buffer on drop; keep the decoded key scoped to the authentication attempt.
- Support public-key authentication through `russh` after the exact host algorithm and SHA-256 fingerprint have been verified against the trust ledger. Choose the best RSA signature hash advertised by the server and do not enable legacy algorithms as a fallback.
- Store a supplied private-key passphrase only in the OS credential store under a `key-passphrase:<uuid>` reference. Reject credential references of the wrong kind before retrieval. Passphrase bytes never enter SQLite, exported profiles, events, assistant context, or errors.
- An unencrypted key connects without a passphrase. An encrypted key without a saved passphrase leaves the session ready for authentication and opens the passphrase dialog. A passphrase submitted there is stored in the OS credential store before retrying.
- Changing a profile's authentication method or private-key path clears its credential reference. The desktop adapter deletes the previous FILEX password/passphrase item after the profile update succeeds.
- SSH Config imports continue to use password authentication. An imported `IdentityFile` remains inert metadata until the user explicitly chooses private-key authentication and selects the key file in the profile editor.
- SSH Agent authentication and `ProxyJump` remain unsupported in this slice and must fail before authentication.

## Consequences

- The desktop capability adds bounded asynchronous local-file reading and public-key authentication; no key bytes are exposed to Vue or serialized contracts.
- The UI needs a native file picker, a private-key passphrase dialog, and distinct localized errors for missing files, oversized files, required passphrases, and invalid keys or passphrases.
- The parsed key object is owned by the selected SSH dependency during the authentication attempt. FILEX zeroizes its source buffer and credential lease; the dependency does not expose an explicit zeroization contract for its parsed key type.
- Test fixtures and platform checks remain pending until the user configures the development environment.

## Acceptance evidence

- Private-key authentication is source-wired through the trust check, credential type check, SSH engine, typed API, session store, and profile editor.
- Key-file read size and passphrase handling are bounded, and errors reveal neither key content nor local path.
- Unknown and changed host keys still block authentication.
- Rust, TypeScript, desktop UI, and cross-platform verification are recorded separately; a source review alone does not count as a passed gate.
