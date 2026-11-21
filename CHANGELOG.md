# FILEX changelog

## [Unreleased]

## [0.1.12] - 2026-11-21

### Fixed

- Fixed the POSIX process monitoring probe (`ps -e -o pid= -o ppid= -o user= -o pcpu= -o time= -o rss= -o stat=`) where comma-separated `pid=,ppid=...` caused `procps` to treat the remaining columns as a custom header for `pid`, leaving `PPID`, user, CPU, memory, and state blank and preventing server-side CPU/memory sorting from taking effect.
- Preserved kernel thread process names containing `/` (such as `kworker/0:0H` and `ksoftirqd/0`) while still stripping leading filesystem paths on platforms that return full executable paths.
- Switched the process right-click menu in `MonitorDetailsDialog` to the shared vertical `.file-context-menu` surface with proper `z-index` layering, visual action separator, and Up/Down/Home/End keyboard navigation (replacing the unapplied component-scoped `.terminal-context-menu` class that caused items to render horizontally).

## [0.1.11] - 2026-11-21

### Added

- Descending CPU and Memory process sorting inside Host Monitoring Details (`MonitorDetailsDialog`), with a synchronized toolbar mode switch and clickable sortable `CPU` and `Memory` table headers (`aria-sort`, keyboard focusable, and localized in `zh-CN` and `en-US`).
- Deterministic client-side process sorting (`sortProcesses` in `src/domain/monitorDetails.ts`) with Windows `cpuTimeSeconds` fallback when `cpuPercent` is unavailable, missing-value placement, and secondary metric/PID tie-breakers.
- Backend `ProcessSortBy` (`cpu` / `memory`) support for POSIX and Windows process probes (`collect_process_snapshot`) so truncated host process lists (>100 processes) fetch the true top-100 processes for the active sort dimension while keeping snapshot refresh and process termination aligned.

## [0.1.10] - 2026-11-17

### Added

- Connection sidebar context menu (`ConnectionContextMenu`) for profiles (open, edit, duplicate, favorite, move to group, delete with confirmation), group headers (new connection in group, create/rename/delete group, collapse), and empty space (new connection, new group, expand/collapse all).
- Connection group management (`createGroup`, `renameGroup`, `deleteGroup`, `moveToGroup`) with persisted empty groups, persisted collapse state, the reserved `未分组` default group, and a validated `GroupNameDialog`. Deleting a group moves its connections to `未分组` instead of deleting them.
- Group suggestions in the connection profile dialog and pre-filled group when creating a connection from a group context menu.

### Changed

- The terminal tab bar `+` button now always opens Quick Connect, so it no longer duplicates the "Duplicate session" action.

### Fixed

- Added the missing dialog body padding and wider layout for `LocalTerminalDialog`.

## [0.1.9] - 2026-11-17

### Changed

- Aligned the application, desktop bundle, and taskbar icons (`public/filex-mark.svg` and `src-tauri/icons/`) with the FILEX brand mark.

### Fixed

- Fixed vertical body collapse inside `KeyAndProxyLibraryDialog` (`grid-template-rows: 46px auto minmax(0, 1fr) 52px`) caused by the dialog's four-row layout with `.key-proxy-tabs`, aligned inner padding (`16px 20px`), and refined spacing across tab strips, path actions, card actions, form inputs, and dialog footer buttons.

## [0.1.8] - 2026-11-16

### Added

- Local PTY terminal sessions (`filex-local-terminal` / `LocalTerminalDialog`) with allowlisted shell selection, resize/shutdown lifecycle handling, local working-directory follow, and isolation from SSH credentials and remote telemetry.
- Explicit opt-in elevated file access leases (`elevated_access` / `ElevatedAccessDialog`) with zeroized in-memory secret handling, per-operation session-identity verification, amber TTL indicator badges, and manual or disconnect revocation.
- Central SSH key metadata/fingerprint library and validated SOCKS5 / HTTP CONNECT outbound proxy library (`key_proxy_library` / `KeyAndProxyLibraryDialog`) backed by OS credential references.
- Bounded per-profile SQLite command history (200 entries with secret-exclusion filtering) and an optional compact `CommandInputBar` composer.
- `encoding_rs`-backed remote text encoding support (UTF-8, UTF-16LE/BE, GBK/GB18030, Big5, Shift-JIS, EUC-JP, EUC-KR, Windows-1252) with strict unmappable character rejection, confirmed two-endpoint `remote_to_remote` SFTP relay streaming, restart-safe transfer resume checkpoints, and per-profile path bookmarks with active-vs-history transfer filtering.
- Workbench overview modal (`OverviewDialog`), unified activity center (`TaskDrawer` across `all`, `transfers`, `jobs`, `tunnels`, and `events` with inline details), and bounded SSH diagnostic preset remote jobs (`remote_jobs`).
- Native clipboard file copy/paste upload (`Ctrl+C` / `Ctrl+V` via `clipboard_files` / `useFileUploadQueue`) and keyboard folder letter/prefix typeahead navigation (`fileTypeahead` / `useFilePaneKeyboard` with `.file-typeahead-pill` and virtualized scroll-into-view).

### Fixed

- Preserved active `XTerm` terminal instances, search state, composer drafts, SFTP directory paths/selection/expanded tree state, active inspector views, and host monitoring snapshots across duplicated sessions and all tab switches without triggering redundant directory reloads, buffer resets, or spurious PTY resizes, while preserving strict per-session isolation and releasing closed-session caches.

## [0.1.7] - 2026-11-14

### Added

- Normal-buffer semantic log colorization (`TerminalLogColorizer` / `getTerminalLogColorPalette`) in [src/domain/terminalLogColorizer.ts](src/domain/terminalLogColorizer.ts), highlighting timestamps, IP addresses, services, CLI flags, permissions, numbers, and status keywords while skipping alternate-screen TUI buffers and preserving explicit remote ANSI colors.
- Terminal compatibility & rendering adapters (`getTerminalCompatibilityOptions`, `registerTerminalSelectionRenderer`, `registerTerminalForegroundAdapter`, `registerTerminalBufferRenderRecovery`, `pulseTerminalFontMetrics`) in [src/domain/terminalAdapters.ts](src/domain/terminalAdapters.ts), plus localized `连接主机...` / `连接主机成功` connection banner lifecycle messages.

### Fixed

- Cleared opaque inline background colors injected by `@xterm/xterm` DOM row decoration spans (`.xterm-decoration-top`) inside selected cells so `.xterm-selection div` owns selection highlights without hiding adjacent glyphs (such as `:v4` next to selected `.1.0`).
- Removed conflicting `!important` overrides on `.xterm-rows`, added CJK spacing normalization (`text-spacing-trim: space-all; text-autospace: no-autospace;`), triggered font metrics refresh on `document.fonts` `loadingdone`, and migrated the legacy `"JetBrains Mono, Consolas, monospace"` default to `"'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace"` across TypeScript and Rust settings to keep columnar command output (`docker ps`, `top`) strictly aligned.

## [0.1.6] - 2026-11-14

### Fixed

- Removed auto-opening the terminal selection context menu on left mouse button release (`pointerup`) and suppressed `.terminal-click-reticle` when dragging a text selection, keeping right-click as the explicit context menu trigger and adding `Ctrl+Shift+C` / `Ctrl+Shift+V` / selection-aware `Ctrl+C` shortcuts alongside uniform `.xterm` font-kerning and ligature suppression.
- Removed a stale `height: 20px` scoped CSS rule on `.terminal-pane-status` in `TerminalPane.vue` and marked the footer `flex: 0 0 auto;` in `workbench.css` so the quick-operations toolbar rows render completely without vertical clipping.
- Populated and expanded missing ancestor directories in `DirectoryTree` automatically via `missingAncestorDirectories` and `syncTreePath` when a session first connects (e.g., canonicalizing `.` to `/root` now loads `/` children underneath `/`) or opens the file panel after connecting, and reset stale remote tree expansion on session change or disconnect.

## [0.1.5] - 2026-11-14

### Added

- Interactive Docker management modal (`DockerDialog`) accessible from the terminal footer quick-ops strip, showing Docker Engine availability, running/exited containers with resource badges, local images, container log tailing, search filtering, and confirmed container lifecycle actions (`start`, `stop`, `restart`, `pause`, `unpause`, `remove`).
- Curated DevOps diagnostics modal (`OpsDetailsDialog`) with bounded read-only views for Host Overview, Listening Ports, Systemd Services, Disk & Inode Usage, and System/Kernel Logs, plus keyword filtering and one-click output copying.
- Right-click context menu on rows in the Process monitor modal (`MonitorDetailsDialog`) for sending confirmed POSIX signals (`SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGSTOP`, `SIGCONT`), Windows `Stop-Process`, and copying PID or process name, alongside a new Overview & Disk Mounts tab inside `MonitorDetailsDialog`.
- Unselected right-click Paste (`clipboard.readText()` with multiline paste guard) and Select All actions in the terminal context menu, plus live cursor row/column coordinates, clicked-cell visual feedback reticle, and active selection character counter in the footer.

### Changed

- Removed the bottom `CommandInputBar` composer and collapsed the default right-hand host monitoring sidebar (`hostPanelOpen: false`), replacing both with an enlarged (`>= 38 px`) Arco Design footer strip hosting session metadata and one-click monitoring, Docker, and DevOps popup triggers.
- Quoted multi-word default monospace font stacks and raised xterm contrast ratios and cursor/selection palette contrast across dark and light terminal themes.

### Fixed

- Preserved Tauri v2 asset CSP `style-src` compatibility (`dangerousDisableAssetCspModification: ["style-src"]`), added static `.xterm-rows` formatting fallback (`white-space: pre` + monospace metrics), and set `COLORTERM=truecolor` / `LANG=C.UTF-8` (best-effort) on SSH PTY sessions so interactive tools such as `top` render with aligned columns, colors, cursor, and visible selection highlights.
- Prevented `useMonitorPolling` from clearing pre-collected or sibling-tab process snapshots when switching views or mounting `MonitorDetailsDialog` on non-overview tabs.

## [0.1.4] - 2026-11-14

### Added

- Shared theme-aware file-entry iconography across the bottom file browser, directory tree and legacy inspector, distinguishing folders, symlinks, code, structured data, configuration, archives, media, documents, spreadsheets, databases, keys and executables while keeping color secondary to icon shape and labels.

### Changed

- Unified the workbench UI around the Arco Design dark and light visual system, refreshing buttons, icons, tabs, tables, forms, popovers, context menus, toasts and modal dialogs while retaining compact terminal-workbench proportions and `HarmonyOS Sans SC` typography priority.
- Standardized dialog header icons, window/tab close buttons, light-theme hover fills and monitor tab resets, and removed entry `opacity: 0` fade bleed-through on menus/toasts and `transform` drift on modal open animations.
- Follow-terminal directory tracking (`followTerminalCwd`) now defaults to enabled for new installations and legacy settings that never recorded a preference, while keeping explicit opt-outs unchanged.

## [0.1.3] - 2026-11-13

### Added

- Directory-only lazy navigation trees for local and remote file panes, with single-click folder navigation and editable Enter/Escape path fields.
- Explicit active-terminal input status with persistent block/outline cursor states and stronger split-pane focus indication.
- Bounded fallback tracking for simple POSIX `cd` commands when a remote shell does not emit OSC 7 working-directory reports.

### Changed

- Every automatically discovered, unsuppressed update now opens above all other FILEX layers and best-effort restores and focuses the desktop window.
- Closing, cancelling or skipping an update suppresses only that version; a later version automatically clears the old suppression and prompts again.

### Fixed

- Remote file navigation now uses the canonical directory path returned by SFTP instead of retaining aliases such as `.`.

## [0.1.2] - 2026-11-11

### Added

- GITBX-style signed update discovery with a delayed startup check, 30-minute background checks and foreground-return throttling.
- A dismissible update dialog with version context, bounded release notes, download progress, Later, Skip this version and explicit Download and install actions.
- A persistent contextual update button for versions discovered after the startup check, plus non-secret persistence for the last successful check and skipped version.
- A keyboard-accessible file context menu with native file/folder upload, new file/folder, copy path, recursive permissions, quick recursive delete, and internal/system/configured external editing.
- Managed external-editor sessions that upload stable local saves back to the original remote file atomically and stop on remote revision conflicts.

### Fixed

- Successful quick connections now appear as in-memory temporary connections and in Recent while their session exists, instead of leaving the navigation pane empty.
- The bottom file browser can grow beyond its former fixed 480 px height up to the available workspace height.
- Terminal tabs and pane chrome are denser and use fewer nested borders, while native WebView context menus are suppressed so FILEX-owned menus behave consistently.

## [0.1.1] - 2026-11-10

### Added

- Session-scoped Process, Network, and Routes workspaces with dense bounded tables, keyboard row selection, contextual record details, All interfaces plus per-interface switching, and explicit unsupported/error states.
- Read-only Linux and Windows network inspection for interfaces, sockets, byte counters, and operating-system routing tables through typed, bounded SSH collectors.
- Safe process details including owner, parent PID, and start time when available, while continuing to exclude command arguments, environments, and working directories.
- Terminal-local selection and context actions for copy, copy-and-input, search, display clearing, and bounded command-history insert, execute, copy, and delete workflows.

### Fixed

- Full-screen terminal programs now re-fit and synchronize PTY geometry after pane, session, and font changes.
- Proportional or unavailable terminal fonts fall back to a verified monospace stack to preserve column alignment.
- Monitoring detail dialogs retain keyboard focus, close with Escape, restore focus to their opener, and remain contained at the 960 × 640 minimum window size.
- Monitoring data is cleared and discarded across active-session changes, and the details dialog closes instead of retaining one host's records under another host's context.
- POSIX process details now include the process start time when the remote `ps` implementation exposes elapsed time.

## [0.1.0] - 2026-11-08

### First desktop release

- Local-first SSH, PTY, SFTP, monitoring, tunnel, backup, diagnostics and assistant workflows.
- Strict host identity verification, OS credential storage and explicit risk confirmations.
- Dense cross-platform workbench shell with light/dark themes, Simplified Chinese and English UI.
- Signed Tauri updater integration with strict version and HTTPS feed validation.
- Automated quality, browser E2E, cross-platform installer, updater verification and GitHub/CNB delivery workflows.

