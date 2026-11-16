# ADR-0031: Clipboard Copy/Paste Upload and Folder Typeahead Navigation

Status: accepted  
Date: 2026-11-16  

## Context

In the FILEX file browser (`FileBrowserPanel` and `InspectorPane`), uploading local files or folders currently requires either drag-and-drop or opening the native file/folder picker dialog. Desktop operators routinely copy files in the OS file manager (`Ctrl+C` / `Cmd+C`) or select an entry in FILEX's local pane and press `Ctrl+V` / `Cmd+V` in the remote folder pane to upload.

Additionally, directories with dozens or hundreds of entries (including virtualized directories over 200 entries) lack letter/prefix typeahead navigation: pressing letters in a focused folder pane does not jump to matching folders or files.

## Decision

### 1. Clipboard copy/paste upload (`Ctrl+C` / `Ctrl+V`)

- **Typed runtime boundary:** Add `ClipboardFileSnapshot` and `ClipboardFileWriteResult` contracts (`crates/filex-contracts`, `src/types/contracts.ts`), desktop Tauri commands `read_clipboard_file_paths` and `write_clipboard_file_paths` (`src-tauri/src/clipboard_files.rs`), and the typed facade `src/api/domain/clipboardFilesApi.ts`. Components never invoke Tauri directly.
- **Native OS file clipboard adapters:**
  - **Windows:** Read `CF_HDROP` via Win32 clipboard APIs (`OpenClipboard` with RAII `CloseClipboard`, `GlobalLock` with RAII `GlobalUnlock`, `DragQueryFileW`) and write `CF_HDROP` (`DROPFILES` UTF-16LE buffer) after validating paths via `canonical_local_entry`. Track `GetClipboardSequenceNumber()` so newer copies made in Windows Explorer or other apps always supersede earlier in-app copies.
  - **macOS:** Read/write `public.file-url` file URLs via `NSPasteboard.generalPasteboard` using `osascript -l JavaScript` with JSON piped via stdin/stdout (no untrusted shell/script string interpolation) and track `changeCount`.
  - **Linux:** Read/write `x-special/gnome-copied-files` and `text/uri-list` via `wl-paste`/`wl-copy` or `xclip` when present, with safe `file://` URI percent-decoding.
- **In-app clipboard & validation parity:** `src/stores/fileClipboard.ts` + `src/composables/useFileUploadQueue.ts` unify upload validation and queueing across drag-and-drop, native picker, local-pane `Ctrl+C`, and remote-pane `Ctrl+V` (as well as context-menu `Copy for upload` / `Paste upload` parity). Every path is capped (256 raw clipboard paths, 64 queued items per batch), re-inspected on disk via `inspectLocalEntry`, checked for safe transfer names, and excludes symlinks and special entries.
- **Focus & input safety:** `Ctrl+C` and `Ctrl+V` are intercepted only inside the `Files` view of the folder browser when focus is not in an editable input/textarea/select, Monaco editor, xterm terminal, popover, context menu, or modal dialog, and when no DOM text selection is active on `Ctrl+C`.

### 2. Folder window typeahead & keyboard traversal

- **Pure matching engine (`src/domain/fileTypeahead.ts`):**
  - Printable non-whitespace characters (with no `Ctrl`/`Meta`/`Alt` modifiers and outside IME composition) trigger case-insensitive prefix matching against the active pane's current entries (folders first, then files, matching listing order).
  - Typing additional characters within 850 ms refines the prefix incrementally.
  - Repeating the same letter cycles forward across matching entries and wraps around.
  - A dead prefix with zero matches clears immediately after showing transient feedback so the next keypress is never blocked.
- **Virtualization and focus continuity:** `VirtualList.vue` exposes `scrollToIndex(index)` so matches beyond the rendered overscan window scroll into view before focusing the `.file-row` button on `nextTick`. Clicking empty space in `.file-list` moves focus into the list (`tabindex="-1"`), and directory reloads restore focus to `.file-list` if focus was dropped to `document.body`.
- **Accessibility & feedback:** Arrow keys (`ArrowDown`, `ArrowUp`, `Home`, `End`) move selection cleanly across normal and virtualized lists. A subtle RTL-safe `pointer-events: none` typeahead badge with `role="status"` shows the active query and match state using semantic tokens.

## Consequences

- Operators can copy files/folders in the OS file manager or FILEX's local pane with `Ctrl+C` / `Cmd+C` and paste with `Ctrl+V` / `Cmd+V` into the remote directory to enqueue durable transfers.
- Operators can locate folders and files in large local or remote listings immediately by typing initial letters or prefixes, without adding external dependencies or bypassing FILEX's path-inspection and transfer boundaries.
