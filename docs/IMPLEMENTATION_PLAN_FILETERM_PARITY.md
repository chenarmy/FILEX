# FILEX FileTerm Parity & Hardening Implementation Plan

Status: active (2026-11-15)
Reference: `docs/FILETERM_FEATURE_REVIEW_AND_FILEX_PLAN.md`

## Scope and Sequencing

This plan executes Phases B, C, D, and Workbench Shell consolidation (`Overview` + unified `Activity`) in tested vertical slices while preserving FILEX security invariants, dense workbench UI discipline, and offline testability:

1. **Step 0 — Architecture Decisions (ADRs 0026–0030)**
   - Document contracts, boundaries, SQLite migrations (`v8`–`v10`), and non-goals before implementation.
2. **Step 1 — Phase B1: Local Terminal (`filex-local-terminal`)**
   - Dedicated workspace crate supporting Windows ConPTY (`windows-sys`) and POSIX PTY (`libc::openpty`), allow-listed shell discovery, cwd validation, lifecycle cleanup, capability-aware `SessionSummary`, `LocalTerminalDialog.vue`, `TerminalPane.vue`, `WorkbenchShell.vue`, unit + Playwright tests.
3. **Step 2 — Phase B2: Explicit Elevated File Access (`ElevatedAccessLease`)**
   - Opt-in `Zeroizing<String>` session-scoped lease (`5m`/`15m`/`30m`), non-interactive `sudo -S -k -p '' true` probe, non-shell-interpolated elevated file actions (`list`, `create`, `rename`, `delete`, `chmod`, `preview`, `save`), persistent amber `Elevated` badge + `Revoke` control, disconnect/TTL/host-change revocation.
4. **Step 3 — Phase B3: Central SSH Key Library & Outbound Proxy Library**
   - SQLite Migration `v8` (`ssh_keys`, `proxy_profiles`, profile FK columns), `CredentialKind::ProxyPassword`, SHA-256 fingerprint inspection without private-key exposure, `filex-ssh` `SOCKS5`/`HTTP CONNECT` dialing + preflight + `russh::client::connect_stream`, `KeyAndProxyLibraryDialog.vue`, `AddProfileDialog.vue` selectors, unit + mock-proxy tests.
5. **Step 4 — Phase B4: Per-Profile Command History & Optional Compact Composer**
   - SQLite Migration `v9` (`profile_command_history` bounded at 200/profile with secret-exclusion filter), `SafeSettings.compactComposerOpen: false` default, `CommandInputBar.vue` toggle + history search/copy/insert/execute-with-target-confirmation/clear.
6. **Step 5 — Phase C1–C4: Multi-Encoding, Path Bookmarks, Transfer History, Resume Identity, Remote-to-Remote Relay**
   - `encoding_rs` support (`UTF-8`, `UTF-16LE`, `UTF-16BE`, `GBK`, `GB18030`, `Big5`, `Shift_JIS`, `EUC-JP`, `EUC-KR`, `Windows-1252`) + `had_errors` lossless save guard (`ENCODING_LOSSY_INPUT`).
   - SQLite Migration `v10` (`path_bookmarks`), separate `Transfer History` filter/clear, restart-safe `TransferResumeState` (`safe_to_resume`, `restart_from_beginning`, `identity_changed`), and explicit client-relayed `RemoteToRemote` transfer with two-endpoint confirmation.
7. **Step 6 — Phase D + Shell: `Overview`, Unified `Activity` Center & `RemoteJob` Engine**
   - Bounded session-scoped `RemoteJob` runtime (max 4 concurrent/session, 256 KiB ring-buffered output, `queued | running | stopping | completed | failed | cancelled | outcome_uncertain`), `OverviewDialog.vue` from brand mark & palette, unified `Activity` filter pills (`All`, `Transfers`, `History`, `Tunnels`, `Remote Jobs`, `Diagnostics`).
8. **Step 7 — Completion Audit & Verification**
   - Update `docs/ROADMAP.md` and `docs/VERIFICATION.md`, run full JS/TS/Playwright/Rust verification gates (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Playwright `e2e/workbench.spec.ts`, `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --workspace`), and report honest completion status including deferred items (Phase A live external multi-OS hosts; Phase E read-only CLI/MCP bridge; Phase F FTPS/FTP, Telnet, Serial).
