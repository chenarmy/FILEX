# ADR-0015: bounded recursive file operations

## Status

Accepted for implementation.

## Context

The dual-pane browser and durable transfer queue currently handle regular files. Directory drag-and-drop, queued directory transfer, and directory copy are part of the P0 workbench scope. Recursive filesystem work must not follow links, escape the selected root, or allocate an unbounded manifest.

## Decision

- A queued transfer infers whether its source is a regular file or directory when execution begins. The existing persisted task contract remains compatible.
- Directory transfers preserve the selected root name at the destination. Uploading local/project to /remote/project writes its descendants under that remote root; downloading /remote/project to C:/downloads/project mirrors that shape.
- Directory traversal is bounded to 5,000 descendants and 16 levels. Names must be valid portable path segments and composed paths may not exceed 4,096 bytes. Symbolic links and special filesystem entries are rejected and never followed.
- ask fails before mutation when the root already exists; skip skips an existing root; rename chooses a new root name; and overwrite merges into an existing directory, replacing regular files while preserving unrelated descendants. File-versus-directory conflicts and symbolic-link targets fail closed.
- Directory transfer progress reports aggregate bytes across files. Pause takes effect at stream boundaries. Cancellation and failure may leave completed files and created directories; retry starts at byte zero and applies the selected conflict policy again.
- Same-side directory copy builds a bounded sibling staging tree, refuses an existing destination, then renames the completed tree into place. Copy rejects links and special entries. Remote copy retains its existing 8 GiB and ten-minute bounds.
- Same-side copy can be cancelled during traversal and streaming. The commit step is short and non-cancellable; canceled staging trees receive best-effort cleanup.
- Application shutdown closes the copy registry to new operations, requests cancellation of active copies, and waits up to five seconds for their cleanup before shutting down SSH sessions. If that bound expires, shutdown continues and cleanup remains best-effort.
- Native file drops are treated as untrusted paths. A typed backend inspection resolves the parent and reports metadata for the single dropped entry before it is queued.

## Consequences

The browser and queue can move ordinary directory trees without shelling out or following symlinks. Large or unusual trees receive a structured limit/unsupported error instead of unbounded work. A failed queued directory transfer can leave a partial tree, while same-side directory copy exposes the destination only after staging completes.
