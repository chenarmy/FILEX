# ADR-0011: Signed in-app updates

Status: accepted
Date: 2026-11-03
Updated: 2026-11-11

## Context

FILEX now publishes signed releases to GitHub and CNB, and the settings surface can check, download, cancel and install through Rust commands. The remaining gap is update discovery timing: users who do not open Settings receive no indication that a signed release is available.

## Decision

- Use `tauri-plugin-updater` 2.12.0, compatible with the workspace's declared Rust 1.85 baseline, and enable signed-version verification.
- Embed the updater public key and stable/beta HTTPS feed URLs at build time using `FILEX_UPDATER_PUBLIC_KEY`, `FILEX_UPDATER_STABLE_ENDPOINT`, and `FILEX_UPDATER_BETA_ENDPOINT`. The private signing key remains a CI secret and is never included in the app.
- Register updater support only when a public key is present. Report the selected channel as unavailable when its feed is missing or invalid; never fall back to unsigned updates.
- Check and install through Rust Tauri commands. Installation rechecks the selected channel and requires the release version to match the version the user reviewed. Require explicit confirmation in the settings UI.
- Follow the GITBX update cadence while keeping FILEX's typed facade: perform a non-blocking check 3.5 seconds after startup, repeat every 30 minutes, and run a throttled check when the application returns to the foreground. The background check must not block first paint or SSH/terminal work.
- The startup discovery of an available version opens a dismissible update panel. Later background checks update a persistent contextual update button but do not interrupt terminal or file work. The panel and button remain unavailable after the user chooses “skip this version”.
- Persist only the last successful check timestamp and skipped semantic version under a FILEX-specific local preference key. Do not persist release notes, endpoints, errors, source addresses or secrets there.
- Keep background failures silent and retryable; surface failures only for a user-initiated check or install. Do not advance the last-success timestamp after a failed check.
- Require the artifact signature's signed version. Release jobs must use a Tauri CLI that writes the signed version comment and must fail preflight when required signing/feed configuration is absent.
- Keep the beta feed optional until the project configures a beta release process. Stable and beta channels must never silently use each other's feed.
- Use an ordered stable endpoint list with GitHub as the release authority and CNB as the delivery mirror. Connection, HTTP and manifest-parse failures can advance to the mirror; a parsed manifest still has to pass signature and signed-version verification, with no unsigned fallback.
- ADR-0024 defines the release gate, artifact verification, publication and mirror recovery workflow.

## Consequences

- Update discovery and installation remain disabled in builds without the public key and selected feed.
- Automatic discovery never installs an update. Opening the panel, reviewing the target version and choosing download/install remain explicit user actions.
- Installing an update requires a signed release from a trusted HTTPS feed and a fresh server check after confirmation.
- The release workflow requires a maintainer to configure a FILEX-specific signing key, its optional password, the matching public key and CNB credentials before publication.
