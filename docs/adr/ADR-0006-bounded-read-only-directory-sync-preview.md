# ADR-0006: Bounded read-only directory synchronization preview

Status: accepted  
Date: 2026-11-03

## Context

Operators need to inspect what differs between a local folder and a remote folder before deciding what to transfer. A preview must not silently copy, replace, or delete files, and must remain bounded on large or hostile directory trees.

## Decision

- Compare the current local and remote roots from the dual-pane browser. The remote root must belong to the active connected SSH session.
- Traverse at most 5,000 entries per side and 16 directory levels, with a three-minute deadline and explicit cancellation. Permit one active directory scan at a time.
- Read metadata only. Do not read file content or modify files, create transfer tasks, persist absolute roots, or save preview results.
- Normalize displayed paths to UTF-8 relative paths with `/` separators. Refuse non-UTF-8 names and path components that cannot be represented safely on both platforms.
- Do not follow symbolic links. Report symbolic links, special files, and regular files without size or modification metadata as unsupported entries; never treat them as ordinary missing files. Report regular-file metadata differences using size and second-resolution modification time. Directory modification times do not determine equality.
- Return counts for local-only, remote-only, metadata-different, type-conflict, unsupported, and unchanged entries. Return at most 1,000 changed paths and disclose when the result list is truncated. Sort paths deterministically.
- Label the output as a non-atomic metadata snapshot. Matching size and modification time does not prove file contents are equal; the separate checksum action can verify individual files.
- The preview has no apply, delete, overwrite, or queue action. A future synchronization operation requires a separate design decision and explicit review of transfer and conflict semantics.

## Consequences

- Users can review bounded path and metadata differences without changing either tree.
- Symlinks, special files, very deep trees, and trees over the entry limit are visible as unsupported or rejected rather than silently traversed.
- A scan can span concurrent filesystem changes. It is informational and must be refreshed before any later transfer decision.
- Runtime, cancellation, large-tree, Unicode, and cross-platform path verification remain required before release.
