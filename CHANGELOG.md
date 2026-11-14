# FILEX changelog

## [Unreleased]

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

