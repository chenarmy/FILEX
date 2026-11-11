# ADR-0025: file context menu and managed external editing

Status: accepted
Date: 2026-11-11

## Context

FILEX already supports a dual-pane local/remote browser, internal Monaco editing, bounded SFTP file operations, recursive transfers and single-entry chmod. Users still need a concise row-level action surface and a practical external-editor workflow. Opening a remote file in an arbitrary desktop application is unsafe or misleading if FILEX launches a detached cache copy without tracking revisions or syncing saves back.

The browser must also avoid treating shell command strings as file operations. A user-controlled path cannot be interpolated into an `rm` command, and recursive permission changes must not follow symlinks or partially mutate an unbounded tree.

## Decision

### Context menu

Use one reusable file context menu with keyboard and pointer navigation. Row actions operate on the exact selected entry; pane-background actions operate on the current directory. The menu is an additional path to existing typed use cases, not a separate implementation.

Native multi-file and folder pickers enqueue normal transfer tasks. New files and folders use typed Tauri commands. The rendered labels may say “quick delete,” but the implementation uses bounded SFTP traversal rather than an interpolated shell command.

### Recursive permissions and delete

Pre-scan at most 5,000 descendants and 16 levels before an operation that mutates a tree. Reject over-limit trees before applying the first mode change. Traverse directories without following symlinks; count and skip unsupported entries. Permission scope applies to the selected root and descendants according to `all`, `files`, or `directories`.

Quick delete removes only files, symlinks and empty directories obtained from the bounded SFTP scan. It rejects root-like targets, does not follow links, and receives an explicit host/path confirmation in the UI.

### Managed external editing

When the user chooses external editing or the OS association, FILEX:

1. Copies a regular remote file of at most 32 MiB into the app-owned `external-open` cache.
2. Computes a SHA-256 revision for the copied bytes and launches either the selected executable directly with the cache path as one argument, or the platform’s default opener. No shell is used.
3. Keeps an in-memory managed-session record containing the SSH session ID, remote path, cache path, expected remote revision and last local revision.
4. Polls the local cache from the typed frontend facade. A local file that changes during a read is retried, not uploaded.
5. Before upload, reads and hashes the remote file without following symlinks. If its revision differs from the expected revision, automatic upload stops with a conflict; FILEX never silently overwrites another writer.
6. Writes a sibling temporary remote file, preserves permissions, rechecks the remote revision, then renames the old file to a recovery name and commits the new file. The recovery file is removed after a successful commit.

The frontend receives only structured session state and bounded metadata. It cannot supply an arbitrary local path to the sync command; synchronization is addressed by the server-side managed-session ID.

The selected executable path and `built-in`/`external` preference are non-secret settings. They are validated for length, NUL bytes, existence and regular-file status at launch.

## Consequences

- External editor saves become visible and recoverable rather than silently discarded.
- Remote concurrent changes and partial local saves fail closed.
- External editing is capped at 32 MiB and is intended for files an external application can reopen through a filesystem path.
- Polling adds a small bounded amount of local I/O per active managed session; active sessions are capped and cleared on app shutdown.
- Recursive operations can fail after the pre-scan if the tree changes or permissions are denied during application. The structured result may then report a partially changed remote state.
- OS association behavior remains platform-specific; the configured executable path is the deterministic cross-platform path.
- Directory packing/archive creation remains a separate feature from ordinary recursive transfer and is not implied by the context menu’s upload/download actions.
