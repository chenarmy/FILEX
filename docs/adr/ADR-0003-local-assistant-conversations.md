# ADR-0003: Local AI assistant conversations

Status: accepted  
Date: 2026-11-03

## Context

The assistant currently persists one transcript. Operators need separate local conversations for unrelated hosts and maintenance tasks without sending old context into a new request.

## Decision

- Store conversation metadata and redacted transcript messages together in one SQLite app-setting value. This keeps create, rename, delete and transcript updates atomic without a schema migration.
- Keep at most 10 conversations. Each conversation keeps at most 24 completed messages, a 32 KiB per-message content limit and a 128,000-byte aggregate content limit. The resulting transcript content ceiling is 1.28 MB, excluding bounded metadata.
- Load conversation summaries separately and load only the selected conversation's transcript. Follow-up requests include history from the selected conversation only.
- Derive the initial title from the first redacted user message. User-edited titles receive the same redaction and a 240-byte limit. Context attachments and partial streaming output are never persisted.
- Migrate the existing `assistant_history` array into one conversation on first access. Delete the legacy key only after the new value is saved successfully.
- Keep one conversation at all times. Deleting other conversations requires confirmation; clearing a conversation removes only its messages.

## Consequences

- Users can start, switch, rename, clear and delete local conversations without adding cloud sync.
- New provider requests receive only the active conversation's bounded recent history.
- Database backups continue to include assistant conversations. Restoring a backup replaces them with the backed-up set.
- All transcript and title writes remain behind Rust normalization and redaction.
