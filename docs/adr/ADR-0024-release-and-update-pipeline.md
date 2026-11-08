# ADR-0024: Release and updater delivery pipeline

Status: accepted  
Date: 2026-11-08

## Context

FILEX has signed updater commands and a manual installer-draft workflow, but the delivery path is incomplete:

- The package, Rust workspace and Tauri manifests repeat the application version.
- A tag does not produce a verified public release.
- Release notes are not derived from a versioned changelog.
- The workflow does not prove that the updater manifest, downloaded asset and detached signature belong together.
- GitHub is the only intended update location even though the repository is mirrored to CNB.
- Reusing another product's signing key would make update trust cross product boundaries.

This decision follows the GITBX delivery workflow at the level of gates and recovery behavior. It does not inherit GITBX identifiers, URLs, signing material or release rules.

## Decision

- Every release uses a FILEX-specific Tauri Minisign key pair. The private key and its optional password are GitHub Actions Secrets. The base64-encoded public key is a non-secret GitHub Actions Variable committed into release builds; it is safe to distribute.
- Stable update discovery uses an ordered feed: GitHub Releases first, then the FILEX CNB release mirror. Release builds receive both product-specific URLs. The GitHub feed cannot silently change to another repository.
- Beta remains an explicit, unconfigured channel until a separate beta publication and retention policy exists. A missing beta feed fails closed.
- A pushed stable tag matching `vMAJOR.MINOR.PATCH` is the only automatic release trigger. The tag, package, Cargo workspace and Tauri versions must match, and `CHANGELOG.md` must contain a non-empty section for that version.
- The platform matrix builds Windows NSIS/MSI, Linux AppImage/DEB and macOS DMG/updater bundle into a draft release. Partially uploaded releases remain invisible.
- Before publication, CI downloads the draft assets, checks the exact platform asset set, and verifies `latest.json` with the configured public key. Verification includes:
  - the manifest version and platform set;
  - HTTPS release-download URLs that resolve to checked assets;
  - manifest signatures that match their detached `.sig` files;
  - Minisign signatures over each updater asset;
  - the version recorded inside each signed trusted comment.
- Only a release that passes those checks becomes public and latest. The CNB mirror then publishes the same signed assets and a copy of `latest.json` whose asset URLs point to CNB. Failure to mirror CNB leaves the already verified GitHub release intact and makes the workflow fail visibly.
- A manual CNB mirror workflow can retry an existing verified GitHub release without rebuilding or re-signing it.

## Consequences

- Publishing requires two independent configuration surfaces: FILEX signing material and a CNB token with repository/release permissions.
- A mismatched private key/public key, stale signature, incomplete platform asset set or malformed manifest blocks publication.
- Existing FILEX versions cannot accept a new signing public key. Key rotation therefore requires a separate migration and cannot be performed by replacing the public key in place.
- GitHub remains the release authority. CNB is a delivery mirror and fallback, not a separately generated release.
- Signed in-app installation still requires an installed build whose embedded public key matches the published release.
