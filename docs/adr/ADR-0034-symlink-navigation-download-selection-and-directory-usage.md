# ADR-0034: Symlink navigation and download, resilient multi-selection, directory usage statistics, and drag/context-menu move and copy

## Status

Accepted for implementation.

## Context

Operators using the FILEX file browser work with remote Linux hosts containing symbolic links (for example `/var/www/current -> /var/www/releases/2026-11`), nested directory trees with symlinks inside, dense file tables where accidental plain clicks can discard careful multi-selections, and remote directory size inspections where POSIX `lstat` reports only the directory inode block size (typically 4,096 bytes) instead of actual recursive folder usage. In addition, operators expect desktop-class same-pane drag-to-move into folders and right-click copy/cut/paste/duplicate/move actions with automatic conflict-free copy naming.

## Decision

1. **On-demand symlink target resolution and non-destructive listing**:
   - Directory listings (`list_remote_directory`, `elevated_list_directory`, `list_local_directory`) continue to report `lstat` entry types (`isSymlink: true`) so destructive operations (`delete`, `quickDelete`, `chmod`) never follow symlinks implicitly.
   - Remote SFTP directory listings set `size: None` for directories rather than exposing the 4,096-byte directory inode size, and attach `symlinkTarget` when the directory contains at most 64 symlinks.
   - Double-clicking, pressing `Enter`, or choosing `Open` on a symlink invokes a typed resolution command (`resolve_remote_link_target`, `elevated_resolve_link_target`, or `resolve_local_link_target`) using `canonicalize` + `stat`. Directory targets navigate the pane, breadcrumb, and directory tree to the canonical directory; file targets navigate to the canonical parent directory and select/focus the target file; broken symlinks return `SYMLINK_TARGET_UNAVAILABLE`. Opening a file symlink directly in the editor resolves and opens the target file.

2. **Cycle-safe symlink dereferencing for SFTP downloads**:
   - Downloading a symlink directly (or including it in a multi-item or archive download) resolves its canonical target and downloads the target file or directory.
   - `scan_remote_download_tree` (used specifically by `download_directory`, while `scan_remote_transfer_tree` remains strict for same-side copy and relay) tracks canonical directory ancestors per branch in a `BTreeSet<String>` to break symlink cycles cleanly without aborting, dereferences regular-file and directory symlinks within the existing 5,000-entry and 16-level bounds, and skips broken symlinks or special entries (FIFOs, sockets, device nodes) instead of failing the entire folder download.

3. **Resilient multi-selection UX and local-pane parity**:
   - Leading row checkboxes use a full-height `30 px × 26 px` hit target inside the first column (preserving the six-column CSS grid) with `@dblclick.stop` and pointer drag-sweep across rows, paired with a header Select-All/Indeterminate checkbox and a toolbar multi-select toggle chip.
   - Once checkbox selection or multi-item selection is active (`multiSelectMode`, `checkboxSticky`, or `selectedPaths.length > 1`), plain row clicks toggle items instead of discarding the selection; `Escape`, the selection-count clear control, or unchecking Select-All resets selection state. Both remote and local panes support multi-selection.

4. **Bounded, cancellable `du -ah --max-depth=1` directory usage**:
   - Remote directory size calculation runs asynchronously after directory load (and on explicit refresh) via `calculate_remote_directory_usage` (or `elevated_directory_usage` when elevated), preferring NUL-delimited `du -ah -0 --max-depth=1` with POSIX `-d 1` fallback and `--exclude=/proc --exclude=/sys --exclude=/dev` on `/`.
   - Each session tracks a cancellation token so navigating away cancels and kills any prior in-flight `du` process, bounded to 2 MiB output and 30 seconds. Exit status `1` with valid output is marked `partial: true` so unreadable nested subdirectories do not hide known folder sizes, and regular-file byte sizes remain untouched for transfer verification.

5. **Same-pane drag-to-move, context-menu move/copy, and auto-rename copy**:
   - Dragging selected rows onto a subfolder row or `DirectoryTree` node within the same pane moves those entries via `move_remote_entry` / `elevated_move_entry` / `move_local_entry`, rejecting self/descendant targets while preserving cross-pane remote-to-local drag-to-download and OS drag-to-upload.
   - The file context menu exposes `Copy`, `Cut`, `Paste`, `Duplicate`, `Move to…`, and `Copy to…` (while preserving `Copy for upload` and `Paste upload`).
   - `copy_remote_entry` and `copy_local_entry` support `autoRename` and `copySuffix`, returning the final created filename. Both UI defaults and backend commit checks advance through `stem (<suffix>).ext`, `stem (<suffix> 2).ext`, … (preserving `.tar.*` compound extensions and avoiding nested copy suffixes) and enforce non-clobbering creation.

## Consequences

- Operators can follow symlinks to their real paths, download folders containing symlinks safely, maintain multi-selections without accidental resets, view `du -ah --max-depth=1` totals and folder sizes consistent with the shell, and reorganize/duplicate files via drag-and-drop and context menus.
- Same-side copy and remote-to-remote relay continue to reject symlinks per ADR-0015.
