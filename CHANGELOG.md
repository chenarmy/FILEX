# FILEX changelog

## [Unreleased]

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

