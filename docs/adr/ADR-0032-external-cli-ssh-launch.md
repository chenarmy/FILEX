# ADR-0032: External CLI and Xshell-compatible SSH launch

Status: accepted  
Date: 2026-11-23

## Context

Enterprise bastion hosts and operations security gateways (such as Venustech TianYue Operations Security Gateway V6.0 / 天玥运维安全网关 V6.0 and similar jump-server clients) launch a locally configured terminal executable—typically configured in the Xshell slot—by passing command-line arguments (`-url ssh://...`, `-newtab`, `-i`, direct `ssh://` / `sftp://` URLs, or `.xsh` session files).

Previously, FILEX ignored command-line arguments on both cold startup and `tauri-plugin-single-instance` reactivation (ADR-0022). Pointing a bastion launcher's Xshell path at `filex-desktop.exe` focused the window without opening the requested SSH session.

## Decision

- Implement a pure, runtime-independent CLI parser in `crates/filex-core/src/cli_launch.rs` supporting:
  - Xshell `-url` / `/url` / `--url` syntax (`ssh://`, `sftp://`, or scheme-less `[user[:password]@]host[:port]`).
  - Direct positional `ssh://` and `sftp://` URLs (Xshell 5+ and OS URL handlers).
  - Xshell flags `-newtab [name]`, `-newwin` (handled inside the single-instance tab model), `-i <key_path>`, `-t` / `-title`, and `-f` / `-file` / `-s <session.xsh>` as well as direct `.xsh` session files (UTF-8 / UTF-16LE / UTF-16BE / ANSI lossy INI, bounded to 256 KiB).
  - Real-world bastion `.xsh` templates (such as TianYue V6.0 local loopback proxies on `127.0.0.1:<ephemeral_port>` with `Method=0`, dummy `UserKey=fake_rsa`, boilerplate `Description=Xshell session file`, and empty `Password=`): ignore non-path `UserKey` aliases when `Method=0` (password mode), ignore boilerplate `Xshell session file` descriptions in favor of the `.xsh` filename stem, treat explicit empty `Password=` on loopback hosts as a local SSO proxy credential, keep the unauthenticated probed handle alive across `HostKeyDialog` for one-shot local proxies, and try SSH `none` authentication before empty-password authentication in `filex-ssh`.
- Support transient in-memory file upload and download transfers for quick and external-launch sessions via `HybridTransferRepository` (`src-tauri/src/transient_transfers.rs`): transfers belonging to saved profiles persist in SQLite as before, while transfers belonging to transient quick/bastion profiles remain bounded in memory without violating SQLite foreign keys or writing temporary bastion endpoints to disk.
  - Common OpenSSH/PuTTY/SecureCRT-style overrides (`-ssh`, `-sftp`, `-l` / `/L`, `-p` / `-P` / `/P`, `-pw` / `/PASSWORD`, positional `user@host[:port]`).
  - Tolerant authority parsing that splits userinfo and host at the rightmost valid `@host[:port]` boundary so composite bastion usernames (e.g. `gw@target_user@target_ip`) and raw passwords containing `@`, `:`, `#`, `?`, or `/` are parsed accurately without breaking percent-encoded URLs.
- Keep secrets strictly out of IPC payloads, UI state, SQLite, settings, events, and logs:
  - `ParsedCliLaunch` redacts passwords in `Debug` output and does not implement `Serialize`.
  - `ExternalLaunchRuntime` (in `src-tauri/src/external_launch.rs`) retains optional preset passwords only in bounded in-memory `Zeroizing<String>` entries keyed by a single-use `launchId` with a 5-minute TTL and 16-entry cap.
  - Only non-secret metadata (`ExternalLaunchRequest`) crosses into the WebView via `drain_external_launch_events` (cold start) and the `external-launch` event (warm single-instance relaunch).
  - A `frontend_ready` gate prevents startup race conditions and duplicate event delivery.
- Preserve FILEX security and transient quick-connect invariants (ADR-0019):
  - Every CLI launch probes the remote host key first and evaluates it against the durable `HostTrustService`. Unknown or changed keys always stop at `HostKeyDialog` and are never silently accepted.
  - Once host trust is verified, a held one-time preset password is consumed directly inside Rust (`connect_external_launch_session`) without ever passing through JavaScript.
  - Temporary profiles and held one-time secrets are cleared on consumption, cancellation, failure, expiry, disconnect, remote close, restore reset, or graceful shutdown.
  - If a CLI URL omits the username, FILEX discards the server-side launch token and opens `QuickConnectDialog` prefilled with host and port.
  - Malformed explicit launch arguments or unsupported protocols (such as `telnet://` or `rdp://`) emit structured `CLI_LAUNCH_*` errors without leaking raw secret-bearing arguments.

## Alternatives considered

- **Pass the parsed password to the frontend store and reuse `connect_quick_password_session`.** Rejected because secrets must not cross IPC events or reside in JavaScript state.
- **Auto-accept host keys for CLI-launched bastion sessions.** Rejected because silent host-key acceptance violates FILEX's core trust invariant.
- **Spawn a separate FILEX process per bastion launch.** Rejected because ADR-0022 keeps one SQLite owner and multi-tab workbench per user session.

## Consequences

- Replacing a bastion tool's configured Xshell executable path with `filex-desktop.exe` opens new SSH/SFTP session tabs in FILEX on both cold start and warm single-instance invocation.
- Host-key verification remains auditable: the first connection to a bastion gateway requires explicit host-key approval, and subsequent connections to that trusted gateway authenticate directly into a live terminal tab.
- Xshell proprietary encrypted passwords stored inside `.xsh` files cannot be decrypted outside Xshell; plaintext `.xsh` files and `-url ssh://user:pass@host:port` launches work directly, and rejected credentials fall back cleanly to visible error feedback.
