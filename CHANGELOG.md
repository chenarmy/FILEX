# FILEX changelog

## [0.1.1] - 2026-11-10

### Added

- Session-scoped Process, Network, and Routes workspaces with dense bounded tables, keyboard row selection, contextual record details, interface switching, and explicit unsupported/error states.
- Read-only Linux and Windows network inspection for interfaces, sockets, byte counters, and operating-system routing tables through typed, bounded SSH collectors.
- Safe process details including owner, parent PID, and start time when available, while continuing to exclude command arguments, environments, and working directories.
- Terminal-local selection and context actions for copy, copy-and-input, search, display clearing, and bounded command-history insert, execute, copy, and delete workflows.

### Fixed

- Full-screen terminal programs now re-fit and synchronize PTY geometry after pane, session, and font changes.
- Proportional or unavailable terminal fonts fall back to a verified monospace stack to preserve column alignment.
- Monitoring detail dialogs retain keyboard focus, close with Escape, restore focus to their opener, and remain contained at the 960 × 640 minimum window size.

## [0.1.0] - 2026-11-08

### First desktop release

- Local-first SSH, PTY, SFTP, monitoring, tunnel, backup, diagnostics and assistant workflows.
- Strict host identity verification, OS credential storage and explicit risk confirmations.
- Dense cross-platform workbench shell with light/dark themes, Simplified Chinese and English UI.
- Signed Tauri updater integration with strict version and HTTPS feed validation.
- Automated quality, browser E2E, cross-platform installer, updater verification and GitHub/CNB delivery workflows.

