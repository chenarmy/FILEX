# ADR-0022: Single running FILEX instance

## Context

Launching the executable repeatedly created additional FILEX processes and windows. Local-first desktop applications should reactivate the existing workbench instead of opening duplicate local databases, event listeners and window state.

## Decision

- Register `tauri-plugin-single-instance` before all other Tauri plugins.
- When a second launch occurs, send activation to the existing process.
- Unminimize, show and focus the existing `main` window.
- Allow the second process to exit without constructing a second application shell.

## Consequences

FILEX now has one process and one interactive workbench per desktop user session. A second launch restores a minimized window and focuses it. Opening additional workspaces or hosts must continue through in-app tabs and dialogs rather than separate application processes.
