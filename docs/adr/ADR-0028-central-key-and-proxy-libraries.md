# ADR-0028: Central SSH key library and outbound proxy profiles

Status: accepted
Date: 2026-11-15

## Context

Previously, `ConnectionProfile` stored a direct `privateKeyPath` string and passphrase credential reference per host, without reusable key metadata, SHA-256 fingerprint inspection, or multi-profile key rotation. FILEX also supported SSH jump hosts (`JumpHostSpec`), but lacked reusable outbound `SOCKS5` and `HTTP CONNECT` proxy profiles with secret-backed credentials and connection preflight checks.

## Decision

### Central SSH key library

- Add SQLite Migration v8 introducing `ssh_keys` (`id`, `label`, `key_path`, `algorithm`, `fingerprint_sha256`, `has_passphrase`, `passphrase_ref`, `created_at`, `updated_at`) and nullable `key_id` on `connection_profiles`.
- Inspect key metadata (`russh::keys::load_secret_key` / public key inspection) cleanly on registration or validation to compute algorithm and `SHA256:...` fingerprint without storing or exporting private key material into SQLite, logs, diagnostics, or UI responses.
- Support list, inspect/verify, attach-to-profile, rotate across profiles referencing `key_id`, and confirmed delete (which warns if profiles still reference the key and clears or requires reassignment cleanly).

### Outbound `SOCKS5` and `HTTP CONNECT` proxy library

- Add `proxy_profiles` (`id`, `label`, `kind`, `host`, `port`, `username`, `credential_ref`, `created_at`, `updated_at`) in Migration v8 and nullable `proxy_profile_id` on `connection_profiles`.
- Extend `filex-credentials::CredentialKind` with `ProxyPassword` so proxy passwords live solely in the OS keyring (`keyring`) and follow `SecretLease(Zeroizing<String>)` zeroization rules.
- Validate proxy endpoints safely (supported kind, port range, host length/format, non-empty credentials when auth is configured).
- Implement proxy stream negotiation inside `crates/filex-ssh` (`connect_via_proxy` supporting RFC 1928 `SOCKS5` no-auth and username/password auth, plus HTTP/1.1 `CONNECT` with optional Basic auth, strict timeout and bounded header read), passing the tunneled `TcpStream` into `russh::client::connect_stream` before SSH host-key verification.
- Provide explicit proxy TCP/handshake preflight diagnostics without leaking credentials into logs or error strings.

## Consequences

- Teams and power users manage keys and corporate/bastion proxies once and bind them declaratively from `AddProfileDialog.vue`.
- Host-key trust verification runs end-to-end inside the encrypted SSH channel on top of the proxy transport; a proxy cannot bypass host-key verification.
- Existing profiles referencing legacy `privateKeyPath` remain backward-compatible without breaking existing stored connections.
