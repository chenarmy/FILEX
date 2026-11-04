# ADR-0018: Bounded local-file comparison context for the assistant

Status: accepted  
Date: 2026-11-03

## Context

The assistant design calls for comparing explicitly selected text or configuration files and proposing changes without writing them. The current panel supports one local file, so it cannot provide both inputs for a comparison.

## Decision

- Allow the user to attach up to two files through the existing native picker. Each file retains the existing regular-file, extension, UTF-8, control-character, and 12 KiB checks.
- Show each basename, extension, and byte size only in the local panel. The provider receives file text labeled by selection order (`file 1`, `file 2`) and never receives filenames, paths, or reference IDs.
- Keep file content in short-lived zeroizing Rust memory. Attachments are released when removed or when the panel closes, and expire after 15 minutes. Do not persist file content in chat history, events, or diagnostics.
- Share the existing 16,000-character local-context budget across selected files, divide available space evenly, and let unused space from a shorter file flow to the next file. Mark any truncated file content. Other selected FILEX context uses only the remaining budget.
- Keep the existing per-request disclosure, best-effort redaction, persisted provider consent, and 64 KiB Rust request boundary. A comparison reply may produce only the existing inert draft/change-plan cards; it cannot write files, execute commands, or mutate remote state.

## Consequences

- Users can ask the assistant to compare two selected files and draft a change plan while both inputs remain explicit and bounded.
- Large files may be truncated to fit the combined context budget; the provider prompt identifies that truncation and the local disclosure shows the approximate outgoing size.
- Selection order defines the labels shown to the provider, so the user can refer to “file 1” and “file 2” without exposing local names.
