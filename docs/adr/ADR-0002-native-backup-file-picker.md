# ADR-0002: Native backup file picker

Status: accepted  
Date: 2026-11-03

## Context

Backup restore currently requires the user to type or paste a full local path. The restore command already validates SQLite integrity and schema before replacing the live database, but path entry is error-prone.

## Decision

Use the Tauri Dialog plugin's native open-file dialog for selecting an existing backup. Enable only `dialog:allow-open`, disallow multiple selection and directories, and filter the picker to SQLite extensions (`sqlite3`, `sqlite`, and `db`). The returned path continues through the existing typed maintenance API and validated restore command.

Pin the Rust and JavaScript plugin packages to 2.7.3. The current stable 2.8.4 requires Rust 1.90, while FILEX declares Rust 1.85; 2.7.3 declares Rust 1.77.2 and preserves the workspace's stated minimum.

The plugin adds only the selected path to its temporary file/asset scope. FILEX does not add the filesystem plugin or general file read commands; only the existing restore use case consumes the path. The file extension filter is a user-interface hint, not a security check; backend SQLite validation remains authoritative.

## Consequences

- Users can select existing backups through the platform-native picker on supported desktop systems.
- Users can still paste paths when the dialog is unavailable.
- The open-dialog capability is added to the main window's minimum permission set.
- The generated Tauri ACL schema must reflect the plugin permission when the normal environment build refreshes generated schemas.
