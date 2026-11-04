# ADR-0007: Portable non-secret connection profile export

Status: accepted  
Date: 2026-11-03

## Context

Operators need to move or share connection definitions between FILEX installations. A full SQLite backup is unsuitable for this purpose because it also contains local settings, trust history, transfer records, and assistant conversations. Profiles can also reference OS credentials and local private-key paths, which must not travel with an export by default.

## Decision

- Export all current connection profiles to a user-selected JSON file from the Connections pane.
- Use the versioned envelope `filex.connection-profiles`, schema version 2, with an export timestamp.
- Include profile name, group, host, port, username, environment, favorite state, tags, authentication method, imported `ProxyJump` source text, and an ordered list of mapped jump endpoints (name, host, port, username).
- Omit profile IDs, OS credential references, private-key paths, live connection state, latency, and last-used timestamps. Never include trust records, event history, settings, transfer data, snippets, or assistant conversations.
- Explain before saving that endpoints and usernames are included while credentials and local key paths are excluded. Cancellation creates no file.
- Open the native save dialog and write from the Rust side; do not accept an arbitrary output path from the webview. Stream JSON through a byte-limited writer into a temporary file in the destination directory, flush it to disk, and atomically persist it. If the cap is exceeded, discard the temporary file and leave any existing destination untouched.
- Limit one export to 10,000 profiles and 16 MiB of JSON. JSON import and overwrite/merge behavior require a separate design decision.

## Consequences

- The export is portable profile metadata, not a complete migration. Users must configure credentials and private-key paths on the destination installation.
- Mapped routes are exported as endpoint snapshots without local profile IDs. Any future JSON importer must ask users to map those hops to destination profiles and must not match them by name or host automatically.
- The user controls where the file is saved because it contains host endpoints and usernames.
- Existing SQLite backup/restore remains the complete local recovery mechanism; it is not used for profile sharing.
