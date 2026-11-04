# ADR-0017: Enhanced privacy-limited diagnostics snapshot

Status: accepted  
Date: 2026-11-03

## Context

The existing diagnostics artifact contains the app version, platform, schema version, credential-store status, and host-key policy assertion. That is insufficient to distinguish a storage/runtime problem from an application configuration problem, while exporting the database, event history, or connection data would disclose user content.

## Decision

- Upgrade the JSON artifact to a versioned `filex.diagnostics` schema.
- Add the SQLite runtime version, database file size, schema version when readable, a `quick_check(1)` status, a foreign-key-check status, and whether the updater is configured for the currently selected channel.
- Keep the checks inside the local process. The diagnostic command must not contact update, SSH, or assistant providers.
- Use fixed status values (`ok`, `issue_detected`, `unavailable`) for database checks. Never include database paths, SQL errors, or raw exception text.
- Keep the existing app/platform/credential-store fields and explicit security assertions. The artifact contains no secrets, profile endpoints, user content, record counts, event history, terminal data, assistant data, or filenames.
- Keep the user-selected native save dialog, same-directory atomic write, cancellation behavior, and 64 KiB serialized-size limit.
- Run the SQLite inspection in a blocking worker and use a nonblocking repository lock. A busy/poisoned lock or query failure is represented as unavailable and does not prevent exporting the rest of the report.

## Consequences

- Support can distinguish database integrity, foreign-key, updater-configuration, and credential-store states without receiving the user's connection data.
- The database health scan is user-initiated and may take time for a large database. If another repository operation owns the connection, the health fields are marked unavailable immediately.
- The report remains a diagnostic snapshot, not a backup or a full recovery artifact.
