# FILEX UI and interaction design

Status: design baseline v0.2

## 1. Experience direction

FILEX is a high-density, dark-first desktop workbench. The interface should feel calm under pressure: critical host and security context is always visible, frequent operations are one or two steps away, and long-running work is observable without modal blockage.

Avoid marketing-style cards, decorative gradients, large empty margins, floating panels everywhere, or playful motion. Workspace surfaces are flat panes divided by 1 px borders. Floating elevation is reserved for dialogs, menus and popovers.

## 2. Application shell

Use native operating-system window chrome for the first implementation. Inside it, use this baseline:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top bar 44: FILEX | session tabs ● + | split/search/log | reconnect ⚙ ⤢    │
├───────────────┬───────────────┬──────────────────────────────┬───────────────┤
│ Navigation    │ Host panel    │ Terminal workspace           │ Details or    │
│ (collapsible) │ (collapsible) │ tabs and optional splits     │ assistant     │
│ 240 px        │ 280 px        │                              │ (collapsible) │
│               │               ├──────────────────────────────┤ 360 px        │
│ Connections   │ connection    │ Command input bar 36         │               │
│ Favorites     │ info, uptime, ├──────────────────────────────┤ Session /     │
│ Recent        │ load 1/5/15,  │ File browser (collapsible)   │ assistant     │
│ Tunnels       │ CPU/memory/   │ Files | Commands             │ context       │
│ Snippets      │ swap gauges,  │ local | remote panes, path   │               │
│               │ process tabs, │ breadcrumb, follow-terminal, │               │
│               │ network rate, │ transfer footer              │               │
│               │ disk mounts   │                              │               │
├───────────────┴───────────────┴──────────────────────────────┴───────────────┤
│ Task drawer 220, optional: Transfers | Tunnels | Events                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Status 24: trust | user@host | latency | encoding | terminal size | tasks   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Focus mode collapses navigation, host panel, file browser and the details/assistant column so the terminal fills the window; it is one action and respects reduced-motion settings.

### Baseline dimensions

| Region | Default | Clamp/behavior |
| --- | ---: | --- |
| Top bar | 44 px | Fixed; brand, session tabs, global actions |
| Navigation | 240 px | 180 px to 40% window width; collapsible |
| Host panel | 280 px | 200 px to 420 px; collapsible; appears with a connected session |
| Command input bar | 36 px | Fixed; hidden without a connected session |
| File browser | 260 px | 160 px to 65% window height; collapsible |
| Details/assistant | 360 px | 280 px to 50% window width; collapsible; assistant replaces details when open |
| Task drawer | 220 px | 96 px to 55% window height; collapsible |
| Status bar | 24 px | Fixed |
| Window | 1280 x 800 | Minimum 960 x 640 |

Separators render as 1 px but expose a 7 px hit target. Hover and drag use the primary color. Every size is persisted per workspace and clamped again after monitor or DPI changes.

## 3. Information architecture

### Global destinations

- **Connections:** tree and search for groups, favorites and profiles.
- **Recent:** recently used sessions with last result, not a duplicate permanent profile list.
- **Tunnels:** saved rules and running instances.
- **Snippets:** user-authored command templates.
- **Tasks:** transfer history and interrupted work; primarily opens the task drawer.
- **Assistant:** opens a collapsible right-side assistant panel. It is contextual and opt-in, not a replacement for Connections or Session navigation.
- **Settings:** appearance, terminal, connections, security, storage, updates and advanced diagnostics.

Credentials are managed inside Settings/Security and profile editors, not exposed as a casual top-level browser.

### Session destinations

- **Terminal:** primary center surface.
- **Command bar:** floating command input bound to the active session, with in-memory history.
- **Files:** bottom dual-pane local/remote browser with follow-terminal option and transfer footer; the right inspector retains the legacy files view.
- **Monitor:** left host panel (connection info, gauges, process tabs, network rate chart, disk mounts); the right inspector retains the legacy monitor view.
- **Editor:** Monaco-based editor panel for bounded remote/local text files.
- **Session:** connection details, negotiated algorithms, channels, jump path and event timeline in the collapsible details column.
- **Notes:** per-profile local notes.
- **Assistant context:** explicit chips for the attached session, event range, metrics, selected file or bounded terminal selection.

## 4. Screen specifications

### 4.1 Empty/first-run workspace

Show three compact actions in the center: Quick Connect, Add Connection, Import SSH Config. Explain local-only storage and host-key verification in one short paragraph. Do not show fake servers or decorative dashboards.

States:

- No profiles.
- Profiles exist but no active session.
- Database unavailable or migration failed.
- OS credential store unavailable.
- Imported profiles need review.

### 4.2 Connection navigation

- Search field remains at the top of the pane.
- Tree rows show environment dot, name, optional host, favorite state and connection status.
- Groups are collapsible and support drag reordering, but destructive moves require explicit drop feedback.
- Row actions appear on hover and focus-within: connect, edit, duplicate and more.
- Right-click menus mirror keyboard-accessible actions; no capability is context-menu-only.
- Production profiles use a visible environment badge or leading stripe, not color alone.

Selected row: primary background at 10-15% opacity plus primary text and a 2 px logical-start marker.

### 4.3 Connection editor

Use a 760-900 px dialog with a compact left section list:

- General: name, group, tags, host, port, user, environment.
- Authentication: Agent, password reference, private key path, passphrase reference.
- Jump/proxy: ordered hop chain and per-hop credential reference.
- Terminal: shell, encoding, startup directory/command, keepalive.
- Files: SFTP behavior, initial path, transfer defaults.
- Monitoring: enabled collectors, interval and command policy.
- Tunnels: saved rules.
- Advanced: algorithm policy, compression, timeouts, Agent forwarding, X11 placeholder only if later supported.

Test Connection performs DNS/connect/host-key/auth/capability stages and renders each result separately. It never silently saves credentials or trust decisions.

### 4.4 Host-key verification

This is a security dialog, not a generic warning.

Show endpoint, resolved address, jump path, key algorithm, SHA-256 fingerprint, source, and whether the key is new or changed. A changed key shows the trusted fingerprint and timestamps beside the presented key.

Actions:

- Cancel.
- Copy fingerprints.
- Trust once, if policy permits.
- Trust and save, only after an explicit checkbox or secondary confirmation for changed keys.

Do not provide “accept all hosts” or a preselected trust action.

The Settings/Security trust ledger shows current and historical fingerprints with provenance and timestamps. OpenSSH `known_hosts` import uses the native file picker and previews exact hosts, candidate fingerprints, current fingerprints and counted skip reasons. Entries that change current trust are highlighted and listed in the confirmation; the old fingerprint remains in history. Hashed names, wildcard/negated patterns, marked entries, malformed keys and conflicting keys are not broadened or silently imported.

### 4.5 Terminal workspace

- Tab label: environment indicator, connection name, optional active command marker, state icon and close button.
- Split layouts: single, vertical, horizontal, and grid only after the base terminal is stable.
- A disconnected pane retains scrollback and shows an inline reconnect strip rather than replacing the terminal.
- Search and command history are overlays that do not steal the entire workspace.
- The command input bar sits directly under the terminal surface. Enter sends the line to the active PTY, Shift+Enter inserts a newline, and the bounded history (in-memory only, capped, clearable) is navigated with ArrowUp/ArrowDown. It is disabled and visibly labelled when no terminal is connected.
- Paste containing multiple lines or shell metacharacters can show a configurable safety preview.
- Password prompts and alternate screen applications must remain compatible with standard terminal behavior.
- Terminal logging is off by default. After the user enables logging capability in Settings → Terminal, the active session toolbar exposes a log action; starting requires a host-specific confirmation that raw output may contain sensitive data. An active log shows a compact written-size indicator, and limit, overflow or write failure changes to an explicit warning state.

The toolbar prioritizes reconnect/disconnect, new split, Files, Monitor and Tunnel. Session logging sits with the secondary session utilities and exposes its state inline; other rare actions belong in More.

### 4.6 Files browser

The primary surface is the bottom dual-pane browser inside the center column: a local pane and a remote pane side by side, with a Files | Commands sub-tab strip, path breadcrumb, refresh, upload/download, new folder, follow-terminal chip and a transfer footer that shows the running task count and opens the task drawer.

List columns: name, size, type, modified, permissions and owner (numeric uid/gid when the server provides it); responsive collapse begins with owner and permissions. Symlinks are visually distinct and display targets in details. Rows expose a permission-mode action that opens an explicit octal review dialog before any chmod mutation.

Header: channel state, path breadcrumb, up, refresh, new folder and upload.

The inspector supports:

- Remote-only compact mode.
- Local/remote dual-pane expanded mode.
- Transfer drop targets with exact destination preview.
- Selection summary and bulk actions.
- Inline rename with validation.
- Bounded text preview/editor with changed-on-server detection.

Never infer a successful upload from bytes sent alone; show verifying or committed state when the protocol/operation needs it.

### 4.7 Host panel and monitor

The primary monitor surface is the left host panel: connection info (name, user@host, port with copy), uptime and load 1/5/15, CPU with a thin progress bar, memory/swap gauges with used/total values, a segmented process sub-view (memory | CPU | commands), a bounded network rate history chart, and a multi-mount disk list card. Use compact sections rather than a card dashboard:

- System and uptime.
- CPU/load sparkline.
- Memory/swap bars.
- Disk mount table.
- Network rate and interface selector.
- Collector status and last sample time.
- A Metrics/Processes sub-view. The process list is manually refreshed and capped at 100 rows; it shows a sanitized process name, PID, CPU information, resident memory and state without command arguments, environment variables or working directories.
- A termination control appears only when the process identity is available and the snapshot is fresh. Confirmation names the host, PID, process and exact action; POSIX sends SIGTERM and Windows uses Stop-Process without Force. The UI reports that the request was sent and does not claim the process has exited.

Each metric may be live, stale, unsupported or permission denied. Missing data renders as “Unavailable,” never `0`.

The user selects a 15-, 30- or 60-second base interval in Settings. Polling runs only while Monitor is open for a connected session and the application window is visible and focused. Repeated collection failures extend the retry interval up to five minutes and show the current delay; unsupported and permission-denied collectors stop automatic polling while keeping manual refresh available.

### 4.8 Tunnel manager

Saved rules appear in the main list; runtime instances appear in the task drawer. A row shows type, listen endpoint, destination, owner session, current connections and status.

Binding to non-loopback addresses triggers an exposure warning. Port conflicts identify the local endpoint and preserve the rule for correction.

### 4.9 Task drawer

Tabs:

- **Transfers:** queue, per-item progress, speed, ETA, conflict, pause/cancel/retry and details.
- **Tunnels:** running instances and diagnostics.
- **Events:** sanitized connection/channel/security events. This is user-facing activity, not a raw developer console.

The drawer does not open for every successful action. It opens for new long-running work, partial failure, or user request.

### 4.10 AI assistant

The assistant uses a collapsible right-side panel that can coexist with the terminal and may temporarily replace the normal inspector at minimum width. It has three explicit modes:

- **Explain:** read-only interpretation of selected errors, events, metrics or text.
- **Draft:** produces commands, snippets or change plans but cannot execute them.
- **Act:** exposes only registered typed tools whose underlying capability and policy permit execution.

The composer shows attached context as removable chips. The user may select one local text/configuration file through the native picker; selection is capped at 12 KiB and rechecked by the Rust boundary for an allowed extension, regular-file type, UTF-8 and control characters. The panel displays its base filename, type and size, explains that redaction is best-effort, and includes its category and approximate size in the provider disclosure. The file text is sent only with an explicit request, without the filename or path, and is not stored in chat history. Provider setup explains that the endpoint operator controls retention and training practices, which FILEX cannot verify. External-provider consent defaults off, is stored with provider configuration, can be revoked, and resets when the endpoint is changed. The assistant boundary rejects sends without consent, and each request displays a compact disclosure of what will leave the device. The panel never silently attaches the full terminal buffer, all profiles, credential metadata or unrelated files.

Every proposed action renders a structured preview with target host, environment, command/tool name, parameters, risk and expected mutation. Read-only tools may use a compact confirmation policy; mutating and destructive tools require explicit confirmation. Model text cannot dismiss or modify that confirmation.

The current command-draft card is a local `command.draft` v1 preview parsed from supported shell fences in completed Draft replies. It shows shell, command, fixed draft risk and the explicitly attached session target, or explains that no target is bound. It also states that FILEX did not execute the command. Changing the selected session, generation, host, port or connection state marks a bound draft stale. Restored transcript drafts have no target binding, and the card offers no execution action.

Multi-step plans use a separate `change-plan.draft` v1 preview parsed from the `filex-change-plan-v1` JSON fence. It shows the title and summary, ordered steps, commands, expected effects and rollback notes with the same fixed draft risk and optional target state. It has no approval, send-to-terminal or execute action. Invalid, oversized or mixed-format plan payloads remain plain assistant text and receive a localized notice; restored plans have no target binding.

After a valid preview is created, FILEX omits its structured fence from the duplicate transcript body and keeps any surrounding explanation visible; the preview card remains the readable representation of the parsed proposal.

Required states:

- Provider unconfigured, credential unavailable and offline.
- Idle, streaming, cancelling, rate-limited and failed.
- No context, context ready, context redacted and context too large.
- Proposal only, awaiting confirmation, executing, succeeded, partially succeeded and rejected by policy.
- Stale proposal when the session generation, host trust or selected target changed.

## 5. Visual tokens

### Dark theme

```css
--background: 240 4% 9%;
--foreground: 0 0% 91%;
--card: 0 0% 12%;
--card-foreground: 0 0% 91%;
--popover: 240 3% 14%;
--popover-foreground: 0 0% 91%;
--primary: 220 84% 56%;
--primary-foreground: 0 0% 100%;
--secondary: 240 4% 16%;
--secondary-foreground: 0 0% 91%;
--muted: 240 4% 15%;
--muted-foreground: 240 4% 58%;
--accent: 240 4% 20%;
--accent-foreground: 0 0% 96%;
--destructive: 0 72% 55%;
--destructive-foreground: 0 0% 98%;
--success: 135 59% 49%;
--border: 240 4% 22%;
--input: 240 4% 25%;
--ring: 220 84% 56%;
--radius: 0.5rem;
--terminal-bg: 0 0% 5%;
```

### Light theme

```css
--background: 240 11% 96%;
--foreground: 240 6% 12%;
--card: 0 0% 100%;
--card-foreground: 240 6% 12%;
--popover: 0 0% 100%;
--primary: 220 83% 52%;
--primary-foreground: 0 0% 100%;
--secondary: 240 16% 93%;
--secondary-foreground: 240 6% 16%;
--muted: 240 16% 94%;
--muted-foreground: 240 4% 42%;
--accent: 240 16% 90%;
--accent-foreground: 240 6% 14%;
--destructive: 0 72% 48%;
--success: 141 60% 38%;
--border: 240 12% 87%;
--input: 240 12% 83%;
--ring: 220 83% 52%;
```

Status roles:

- Primary blue: focus, selection, main action.
- Emerald: connected, completed, healthy.
- Amber: connecting, stale, changed, warning, production attention.
- Rose: failed, rejected, destructive, host-key mismatch.
- Violet/sky/teal: category distinction only.

## 6. Typography and terminal appearance

- UI default: Inter with platform and CJK fallbacks; base 12 px.
- UI sizes: primarily 10, 11 and 12 px; user scale 11-20 px.
- Terminal default: a bundled or system monospace stack chosen for glyph coverage and performance.
- UI and terminal font settings are separate.
- Terminal palette is separate from the application theme, but the default palettes maintain compatible contrast.
- Paths, hosts, ports, fingerprints, algorithms and command text use monospace.

## 7. Common component behavior

- Toolbar button: 26 px high, 11 px label, 12-16 px icon.
- Icon button: 24 x 24 px with tooltip and accessible label.
- Inputs: 3 px radius, 1 px border, primary focus ring.
- Pane header: 28-32 px, muted background, 11 px title.
- Dialog: black/60 overlay, subtle blur, bordered card, 44 px header, scrollable body, 48 px footer.
- Toast: top right; error is assertive, other status polite.
- Loading remains in the initiating control or pane. Full-screen blocking is reserved for unrecoverable bootstrap/migration states.

## 8. Interaction and keyboard model

Initial shortcuts, editable in Settings:

| Action | Default |
| --- | --- |
| Quick Connect | Ctrl/Cmd + K |
| New session | Ctrl/Cmd + N |
| Close active tab | Ctrl/Cmd + W |
| Next/previous tab | Ctrl/Cmd + Tab / Ctrl/Cmd + Shift + Tab |
| Terminal search | Ctrl/Cmd + F |
| Toggle Files | Ctrl/Cmd + Shift + F |
| Toggle focus mode | Ctrl/Cmd + Shift + M |
| Toggle task drawer | Ctrl/Cmd + J |
| Command palette | Ctrl/Cmd + Shift + P |
| Toggle AI assistant | Ctrl/Cmd + Shift + A |
| Focus connections | Ctrl/Cmd + 1 |
| Focus terminal | Ctrl/Cmd + 2 |
| Focus inspector | Ctrl/Cmd + 3 |
| Open settings | Ctrl/Cmd + , |
| Show events | Ctrl/Cmd + Shift + E |

Terminal-reserved shortcuts and platform conventions take precedence. Shortcut conflicts are detected, displayed and remappable.

Settings has a dedicated shortcut page with key recording, conflict and reserved-key feedback, and per-page reset. The command palette is searchable, keyboard navigable, focus-trapped and available from the context bar; it exposes the same session, workspace, pane, settings and console actions as the keyboard model.

Drag/drop is never the only path to move or transfer files. Context menus are never the only path to an action.

## 9. State matrix

| Surface | Required states |
| --- | --- |
| Connection row | idle, connecting, connected, degraded, reconnecting, failed, disabled |
| Session tab | active, background, unread event, auth required, disconnected, closing |
| Terminal | starting, active, read-only, connection lost, reconnecting, closed, renderer failure |
| Files | loading, empty, populated, permission denied, SFTP unavailable, not found, disconnected, partial listing |
| Transfer | scanning, queued, transferring, paused, conflict, verifying, completed, partial, interrupted, failed |
| Monitor | probing, live, stale, unsupported, permission denied, paused, failed |
| Process action | fresh snapshot, expired snapshot, identity changed, awaiting confirmation, request sent, permission denied, failed |
| Tunnel | stopped, starting, listening, degraded, blocked, stopping, failed |
| Forms | pristine, dirty, validating, invalid, saving, saved, failed |
| AI assistant | unconfigured, idle, streaming, cancelled, failed, proposal, awaiting confirmation, executing, policy denied, stale context |

Every error state must answer: what failed, which target was affected, whether remote state may have changed, and what the safe next action is.

## 10. Accessibility, locale and bidirectionality

- First implementation supports Simplified Chinese and English; architecture remains ready for Japanese, German, Spanish, Traditional Chinese, French and Arabic.
- English is the fallback for missing translations, but missing keys are visible in development.
- Use logical CSS properties. When Arabic is added, the application shell follows RTL while hosts, fingerprints, commands, paths, terminal cells and numeric network data remain isolated LTR.
- All icon controls have names; all custom rows support keyboard selection and activation.
- Dialogs trap and restore focus. Menus support arrows, Home/End, Enter, Space and Escape.
- Resizers expose separator semantics and keyboard adjustment.
- Connection, trust, health and error states never depend on color alone.
- Respect reduced motion. Terminal cursor and critical progress indicators remain usable under that preference.

## 11. Visual acceptance

Review at 1440 x 900 and 960 x 640 on Windows, macOS and Linux using:

- Dark and light themes.
- Chinese and English.
- Default and enlarged UI fonts.
- Keyboard-only navigation.
- Long host names, IPv6, long remote paths and mixed CJK/Latin text.
- One, ten and hundreds of profiles.
- One and many simultaneous sessions.
- Inspector and task drawer open/closed/resized.
- Unknown and changed host key, authentication rejection, disconnected SFTP, partial transfer, stale monitor and tunnel port conflict.
- AI provider unavailable, context disclosure, redaction preview, stale proposal, denied tool and destructive-action confirmation.

No acceptance frame may contain GITBX or FinalShell branding, Git terminology, fake security success, or inaccessible hover-only actions.

