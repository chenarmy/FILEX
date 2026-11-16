# ADR-0029: Multi-encoding text handling, path bookmarks, transfer history, resume identity, and remote-to-remote relay

Status: accepted
Date: 2026-11-15

## Context

FILEX's remote and local text preview/editing currently hardcodes UTF-8 (`String::from_utf8` and `as_bytes()`), preventing clean inspection and safe saving of legacy GBK/GB18030/Big5/Shift_JIS/EUC-JP/EUC-KR/UTF-16/Windows-1252 files common across production servers. Meanwhile, power users need fast directory bookmarks, an isolated transfer history log separate from live queue tasks, trustworthy crash/restart resume verification, and explicit remote-to-remote file copying between connected sessions.

## Decision

### Character encodings (`encoding_rs`)

- Support explicit encoding selection across local and remote text preview/editor: `utf-8`, `utf-16le`, `utf-16be`, `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-jp`, `euc-kr`, `windows-1252`.
- On read (`preview_local_text`, `preview_remote_text`), decode using `encoding_rs` (`decode_without_bom_handling` or BOM-aware UTF-16/UTF-8 handling) and return `hadReplacementCharacters` / `detectedBom` plus selected encoding metadata.
- On save (`save_local_text`, `save_remote_text`), encode using `encoding_rs::Encoding::encode`; if `had_errors` is true (characters unrepresentable in the chosen legacy encoding), fail closed with `ENCODING_LOSSY_INPUT` so FILEX never silently writes mojibake or `?` substitutions.

### Path bookmarks and transfer history

- Add SQLite Migration v10 (`path_bookmarks`: `id`, `scope` (`local` | `profile`), `profile_id`, `label`, `path`, `created_at`, `updated_at`) with bounded per-scope limits, rename, jump, and confirmed delete.
- Separate active `Transfers` from persistent `Transfer History` views (filtering completed/failed/cancelled records cleanly and offering explicit `Clear finished history` without touching active/resumable queue items).

### Restart-safe transfer resume identity

- Persist structured identity fields on `transfer_tasks` (`remote_size_snapshot`, `remote_mtime_snapshot`, `staging_path`, `conflict_policy`, `resume_state`).
- Classify interrupted/incomplete tasks cleanly on load or pre-resume probe:
  - `safe_to_resume`: partial artifact matches size bounds and remote `size` + `mtime` match snapshot.
  - `restart_from_beginning`: partial artifact missing or unreadable, while identity matches or overwrite restart is chosen.
  - `identity_changed`: remote file `size` or `mtime` changed since interruption; refuse silent append and require explicit user restart/overwrite confirmation.
- Verify final byte count before renaming staging target into final path.

### Remote-to-remote client relay (`RemoteToRemote`)

- Implement chunked stream/buffered relay in FILEX backend reading from source SSH/SFTP session and writing to destination SSH/SFTP session via standard `TransferTask` progress/cancellation/journal tracking.
- Always require explicit two-endpoint confirmation (`sourceHost:sourcePath -> destinationHost:destinationPath`) clearly stating data relays through the local FILEX client (never claiming direct server-to-server transfer).

## Consequences

- Legacy-encoded logs and configs open cleanly and refuse corrupting saves.
- Interrupted transfers resume only when identity holds, preventing silent file corruption.
- Multi-host file movement works uniformly within the bounded transfer engine and survives cancellation/failures cleanly.
