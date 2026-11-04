# ADR-0011: Signed in-app updates

Status: accepted  
Date: 2026-11-03

## Context

The updates settings currently reports configuration status but cannot check or install a release. Tauri's updater verifies signed bundles, but the app must carry the verification key and a release feed at compile time. FILEX's signing material and feed variables are not configured yet.

## Decision

- Use `tauri-plugin-updater` 2.12.0, compatible with the workspace's declared Rust 1.85 baseline, and enable signed-version verification.
- Embed the updater public key and stable/beta HTTPS feed URLs at build time using `FILEX_UPDATER_PUBLIC_KEY`, `FILEX_UPDATER_STABLE_ENDPOINT`, and `FILEX_UPDATER_BETA_ENDPOINT`. The private signing key remains a CI secret and is never included in the app.
- Register updater support only when a public key is present. Report the selected channel as unavailable when its feed is missing or invalid; never fall back to unsigned updates.
- Check and install through Rust Tauri commands. Installation rechecks the selected channel and requires the release version to match the version the user reviewed. Require explicit confirmation in the settings UI.
- Require the artifact signature's signed version. Release jobs must use a Tauri CLI that writes the signed version comment and must fail preflight when required signing/feed configuration is absent.
- Keep the beta feed optional until the project configures a beta release process. Stable and beta channels must never silently use each other's feed.

## Consequences

- Update discovery and installation remain disabled in builds without the public key and selected feed.
- Installing an update requires a signed release from a trusted HTTPS feed and a fresh server check after confirmation.
- The release workflow requires a maintainer to configure the public key, feed URLs, and signing secrets before creating a release draft.
