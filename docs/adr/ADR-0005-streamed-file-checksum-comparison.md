# ADR-0005: Streamed local-to-remote checksum comparison

Status: accepted  
Date: 2026-11-03

## Context

Operators need to verify that a selected local file matches a selected remote file before or after a transfer. The comparison must not transfer a copy, modify either file, or load a large file into memory. Remote content and metadata remain untrusted.

## Decision

- Add a read-only checksum comparison action to the dual-pane file browser. It requires one selected regular local file and one selected regular remote file in the active SSH session.
- Compute SHA-256 by streaming each file through a fixed 64 KiB buffer. Support files up to 8 GiB and bound each operation to ten minutes; expose cancellation in the UI and cap concurrent checksum jobs.
- Reject directories, symlinks, special files, files beyond the limit, and files whose size or modification metadata changes during hashing. Compare remote metadata before and after reading and local opened-handle metadata before and after reading.
- Return byte counts, both lowercase SHA-256 digests, and an equality result. Do not expose or persist file contents, absolute local paths, digests in the event console, or assistant context.
- Keep the action available only when the user has explicitly selected both files. Show the target host and both names while hashing and present each digest when complete. A mismatch is informational; it does not start or queue a transfer.

## Consequences

- Operators can confirm file equality without changing the local or remote file or invoking remote shell utilities.
- Memory use stays bounded regardless of file size; operations can be cancelled and have a fixed deadline.
- The initial slice compares files only. It does not recurse directories, create synchronization plans, or modify transfer queues.
- Metadata checks do not detect content replacement that preserves the reported size and modification time; the comparison reflects the bytes actually read from each file.
- Runtime, cancellation, large-file and cross-platform file-type verification remain required before release.
