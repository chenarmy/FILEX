# FILEX release and updater configuration

The updater is available only in builds compiled with a public key and the selected channel's HTTPS feed. Builds without those variables show the updater as unconfigured and do not register the updater plugin.

Signed artifact generation is enabled only by src-tauri/tauri.release.conf.json in the installer job; local development and ordinary builds do not require signing variables.

Configure these GitHub repository **variables**:

- `FILEX_UPDATER_PUBLIC_KEY`: the public key generated for FILEX's updater signing key.
- `FILEX_UPDATER_STABLE_ENDPOINT`: HTTPS URL returning the stable Tauri update manifest.
- `FILEX_UPDATER_BETA_ENDPOINT`: optional HTTPS URL returning the beta manifest. Leave it unset until a beta feed is maintained.

Configure these GitHub repository **secrets**:

- `TAURI_SIGNING_PRIVATE_KEY`: the private updater signing key. Never commit it or store it as a public variable.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password, if one was set.

The updater verifies the downloaded bundle and requires the manifest version to match the version embedded in its signed comment. Keep `@tauri-apps/cli` at 2.12.0 or newer for versioned updater signatures. Stable and beta feeds are selected independently; FILEX never falls back from one to the other.

The manually dispatched installer job validates the required stable variables and signing secret before invoking Tauri. Tauri Action uploads signed bundles, signatures and a platform-merged latest.json release asset; the installer matrix runs one platform at a time so manifest entries are merged before the next upload, and the Windows entry prefers the NSIS installer. It creates a draft release. Do not dispatch it until the key pair, feeds, GitHub variables and signing secrets are configured. The app's embedded public key and feed URLs are build-time values, so changing them requires a new signed build.

For public GitHub Releases, FILEX_UPDATER_STABLE_ENDPOINT can point to https://github.com/<owner>/<repo>/releases/latest/download/latest.json. The selected manifest and its bundle URLs must be reachable by the app without authentication. The current installer workflow publishes stable releases only; configure and maintain a separate beta manifest before setting FILEX_UPDATER_BETA_ENDPOINT.

See the [Tauri updater guide](https://v2.tauri.app/plugin/updater/) for key generation and manifest format details.
