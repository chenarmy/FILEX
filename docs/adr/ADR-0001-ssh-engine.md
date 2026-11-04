# ADR-0001: SSH engine selection

Status: accepted for the Phase 2 vertical slice  
Date: 2026-11-02

## Context

FILEX needs one engine that can support strict host-key verification, password/key/Agent authentication, interactive PTY channels, SFTP, jump streams and local/remote forwarding on Windows, macOS and Linux. The engine must fit the asynchronous session coordinator and must not force secrets or raw terminal traffic through ordinary configuration.

The spike compared two practical Rust choices:

| Criterion | `russh` 0.65 | `ssh2` / libssh2 |
| --- | --- | --- |
| Runtime model | Tokio-native async handles and channels | Blocking C library API; async use needs a wrapper or dedicated workers |
| Host-key hook | Required `check_server_key`; rejects by default | Known-host API and raw host key access |
| Password auth | Native async method | Native blocking method |
| PTY and resize | Channel PTY, shell/exec, window-change requests | Channel PTY and resize |
| SFTP | `russh-sftp` companion crate | Built-in libssh2 SFTP |
| Forwarding | Direct/forward TCP/IP and stream-local APIs | Direct TCP/IP and listener APIs |
| Native dependency burden | Rust implementation with selectable `ring` or AWS-LC crypto backend | libssh2 plus TLS/crypto native build surface |
| Cancellation/backpressure fit | Async channel/event model fits the coordinator | Requires explicit blocking-worker ownership and interruption strategy |

## Decision

Use `russh` 0.65 with the `ring`, `flate2` and `rsa` features for the first production adapter.

The selection is based on architectural fit, not popularity: the async handle/channel model maps directly to FILEX session generations, cancellation and future PTY/SFTP/tunnel workers; the host-key callback is mandatory and fail-closed by default; and the engine exposes the capabilities required by later phases without adding a local HTTP bridge or a blocking C session owner.

`aws-lc-rs` is not selected for the initial adapter because the `ring` backend gives a smaller cross-platform native build surface for the current package targets. This is not an algorithm-policy relaxation: FILEX keeps `russh` safe defaults and does not enable legacy algorithms in this phase.

## Security shape

- Host-key probing may complete key exchange only to capture algorithm and SHA-256 fingerprint; it disconnects before any credential is requested.
- A real authenticated connection supplies an exact expected algorithm and fingerprint to the handler. Unknown or changed keys are rejected.
- Trust decisions are written through the append-only FILEX trust ledger. The UI cannot provide the previous fingerprint; the core derives it from the ledger.
- Passwords are leased from the OS credential store and passed directly to authentication. They are never returned to Vue, stored in SQLite, emitted as events or included in errors.
- Connect and inactivity timeouts are bounded. Keepalive retry count is bounded.

## Consequences

- FILEX owns a thin `filex-ssh` adapter instead of letting Tauri commands call `russh` directly.
- SFTP will add `russh-sftp` only in Phase 3.
- ProxyJump uses `connect_stream` over an already-authorized upstream channel in a later slice; `ProxyCommand` remains unsupported because arbitrary process execution requires a separate policy.
- The engine choice must be revisited if platform compile checks, PTY/IME throughput, Agent behavior or forwarding fixtures fail the Phase 2 acceptance suite.

## Evidence required before Phase 2 exit

- Disposable server fixtures for unknown key, trusted key, changed key, password accepted/rejected, timeout and remote close.
- Interactive PTY open/input/output/resize plus bounded high-output measurement.
- Windows, macOS and Linux compile checks.
- No secret values in serialized contracts, logs or diagnostic snapshots.
