# ADR-0008: User-selected full local backup export

Status: accepted  
Date: 2026-11-03

## Context

The manual SQLite backup currently lands in FILEX's application-data directory. That provides recovery but makes it awkward to move a complete local snapshot to another disk or machine. The database contains connection endpoints and usernames, private-key file paths, host-trust history, transfer paths and queue state, safe settings, assistant provider endpoint/model configuration, command snippets, and local assistant conversation history. Passwords and provider API keys are held by the operating-system credential store, and private-key contents remain in their original files.

## Decision

- Make the manual “Create backup” action open a native save dialog and write the consistent SQLite snapshot to the selected path.
- Before opening the dialog, explain the data categories in the snapshot and the credential/key-file exclusions. The user chooses where to store this sensitive file.
- Use a timestamped `filex-backup-<timestamp>.sqlite3` suggested name and refuse to overwrite an existing destination.
- Cancellation creates no backup and does not change the restore-path field.
- Keep scheduled backups in the application-managed backup directory with the existing retention policy. Restore continues to accept selected or manually entered SQLite files.
- Keep the SQLite export unencrypted and disclose that clearly. Do not add credential export. Portable encrypted backup requires a separate key-management design.

## Consequences

- A user can move the full local SQLite state without locating FILEX's application-data directory.
- The backup may contain sensitive user-authored snippet and assistant text; the confirmation must say so plainly.
- The exported database is not encrypted by FILEX, so users must protect it with their storage location's access controls.
- SSH passwords, provider API keys, and private-key contents must be re-entered or provided separately on another installation.
