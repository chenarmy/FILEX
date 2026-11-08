# ADR-0021: Custom window chrome with delayed first show

## Context

The native Windows title bar duplicates FILEX's own top context bar. WebView2 also paints an empty dark surface before the application shell is ready, which can appear as a persistent black startup window on slower launches.

## Decision

- Create the main Tauri window without native decorations.
- Keep the window hidden until Tauri reports `PageLoadEvent::Finished`, then show and focus it.
- Set the native window background to the dark shell background so any pre-paint gap matches the product instead of flashing system white.
- Use the existing 44 px context bar as the drag region.
- Provide custom minimum, maximize/restore, and close controls. Maximize state follows window resize events.
- Keep all window operations behind the typed `windowApi` facade and grant only the required window permissions.
- Support double-click on non-interactive title-bar space to toggle maximize.

## Alternatives

- Keep native decorations: rejected because the user requested removal and it duplicates the application shell.
- Leave a black/loading window visible: rejected because it obscures launch failures and looks like a hung application.
- Make the window transparent: unnecessary complexity and platform-specific failure modes; a matching opaque background is sufficient.

## Consequences

FILEX now owns title-bar layout, keyboard accessibility and all three window controls. Windows startup, drag, minimize, maximize/restore and close were verified against a development and release build. macOS/Linux custom-chrome behavior still requires platform-specific acceptance.
