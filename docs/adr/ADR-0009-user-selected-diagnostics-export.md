# ADR-0009: User-selected privacy-limited diagnostics export

Status: accepted; field whitelist extended by ADR-0017  
Date: 2026-11-03

## Context

FILEX can generate a minimal diagnostics JSON, but it currently writes the file into app data. A user who needs support should be able to save the report somewhere they can attach or inspect it. Diagnostics must not become a side channel for connection endpoints, identities, paths, terminal output, secrets, or assistant content.

## Decision

- Save the existing privacy-limited JSON through a Rust-owned native save dialog.
- Keep generation time, app version, OS, architecture, database schema version, credential-store availability, and the strict host-key policy assertion in the report.
- Keep the explicit `containsSecrets: false` and `containsProfileEndpoints: false` declarations in the report.
- Write through a same-directory temporary file and atomically persist it. Cancellation creates no file.
- Localize the dialog title and filter using the saved locale. Do not add logs, settings, profile counts, paths, or event history to this artifact without a separate privacy review.

## Consequences

- Users can save a support artifact directly to a chosen location.
- The artifact does not include enough user data to reconstruct app state; SQLite backup remains the recovery/export mechanism.
- ADR-0017 extends the field whitelist with fixed SQLite runtime/storage health and updater-readiness values while retaining the exclusions above.
