# FILEX verification evidence

## 2026-11-01 — Phase 1 foundation slice

Scope:

- Vue/Tauri project foundation.
- Workbench shell and settings interaction.
- Non-secret connection profile create/list/search/select slice.
- Typed TypeScript and Rust contracts with structured errors.

Required checks:

| Check | Command | Observed result |
| --- | --- | --- |
| Front-end lint | `pnpm lint` | Passed with zero warnings |
| TypeScript | `pnpm typecheck` | Passed in strict mode |
| Unit tests | `pnpm test` | 2 files, 6 tests passed |
| Production build | `pnpm build` | Passed; generated Vite production assets |
| Rust format | `cargo fmt --all -- --check` | Passed after applying `cargo fmt --all` |
| Rust compile | `cargo --config 'http.proxy=""' check --workspace` | Passed for contracts, core and Tauri shell |
| Rust tests | `cargo --config 'http.proxy=""' test --workspace` | 2 core tests passed; all crate/doc test targets passed |
| Rust lint | `cargo --config 'http.proxy=""' clippy --workspace --all-targets -- -D warnings` | Passed with warnings denied |
| Visual smoke | Edge at 1440 × 900 and 960 × 640 | Shell filled the viewport without overflow |
| Interaction smoke | Settings save; invalid/valid profile create; profile search | Passed; invalid form surfaced an alert and valid profile persisted locally |
| Runtime smoke | Browser console and page errors | Zero severe console or page errors in inspected flows |

Security assertions covered by the slice:

- Connection profiles contain a credential reference only; input contracts have no password or passphrase fields.
- Browser persistence stores only non-secret profile metadata and safe settings.
- UI components use the typed domain API facade instead of importing Tauri `invoke`.
- Tauri capability scope is limited to `core:default`; filesystem, shell and network permissions are not granted.
- Real SSH, host-key trust and credential-store availability are visibly marked as unavailable or unprobed instead of simulated.

The table is updated with observed command output after each validation run.
