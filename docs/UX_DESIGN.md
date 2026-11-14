# FILEX UI and interaction design

Status: design baseline v0.2

## 1. Experience direction

FILEX is a high-density, dark-first desktop workbench. The interface should feel calm under pressure: critical host and security context is always visible, frequent operations are one or two steps away, and long-running work is observable without modal blockage.

Avoid marketing-style cards, decorative gradients, large empty margins, floating panels everywhere, or playful motion. Workspace surfaces are flat panes divided by 1 px borders. Floating elevation is reserved for dialogs, menus and popovers.

## 2. Application shell

Use app-owned borderless window chrome on Windows. The 44 px context bar is the drag region and contains accessible minimize, maximize/restore and close controls at the logical end. Tauri hides the window until the first page load completes to avoid a black startup frame. Other platforms retain this structure pending platform-specific acceptance:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Top bar 44: drag region | FILEX/search/actions | minimize □ close          │
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
| Top bar | 40 px | Fixed; brand, global search, global actions, window controls |
| Navigation | 240 px | 180 px to 40% window width; collapsible |
| Host panel | 260 px | 200 px to 420 px; collapsible; appears with a connected session |
| Session tab bar | 32 px | Fixed; scoped above center terminal workspace; tabs + pane actions |
| Command input bar | 32 px | Fixed; hidden without a connected session; compact 12px mono |
| File browser | 240 px | 160 px to 65% window height; collapsible; single-row grouped header |
| File table row | 26 px | Dense virtualized file rows with aligned mono metadata |
| Details/assistant | 360 px | 280 px to 50% window width; collapsible; assistant replaces details when open |
| Task drawer | 180 px | 96 px to 55% window height; collapsible; closed by default until tasks exist |
| Status bar | 24 px | Fixed |
| Window | 1280 x 800 | Minimum 960 x 640 |

Separators render as 1 px but expose a 7 px hit target. Hover and drag use the primary color. Every size is persisted per workspace and clamped again after monitor or DPI changes.

### Spacing and density system

- **Rhythm scale:** 2 px, 4 px, 6 px, 8 px, 12 px, 16 px. Workspace panes use 0 px external margins and 1 px borders.
- **Corner radii:** Standard 3 px for buttons, inputs, segmented controls and tabs; 4 px for floating menus and popovers; 6 px for modal dialogs. Pill (999 px) and card (10 px) radii are excluded from workspace surfaces.
- **Typography hierarchy:** 10 px for micro status/badges, 11 px for dense table headers/pane subtitles, 12 px for default UI and monospace code/paths, 13 px for pane headers and bold titles.
- **Session tab bar alignment:** Session tabs sit directly above the terminal workspace within the center column, maintaining visual continuity with the active remote host instead of spanning across navigation sidebars.
- **File context menu:** 200 px width, 26 px row height, 12 px typography, grouped action segments separated by 1 px dividers, active radio indicators, and restrained destructive highlights.

## 3. Information architecture

### Global destinations

- **Connections:** tree and search for groups, favorites and profiles.
- **Connections:** durable profiles plus an in-memory “Quick connections” group for successful quick sessions that do not have a saved profile.
- **Recent:** recently used durable and current quick sessions with last result, not a duplicate permanent profile list. Quick entries never persist and disappear when their transient session state is cleared.
- **Tunnels:** saved rules and running instances.
- **Snippets:** user-authored command templates.
- **Tasks:** transfer history and interrupted work; primarily opens the task drawer.
- **Assistant:** opens a collapsible right-side assistant panel. It is contextual and opt-in, not a replacement for Connections or Session navigation.
- **Settings:** appearance, terminal, connections, security, storage, updates and advanced diagnostics.

### Signed update discovery

- FILEX checks the configured signed update feed after startup, on a bounded 30-minute interval and when returning to the foreground if the last successful check is older than the interval.
- Every automatic discovery of a version that has not been suppressed opens a compact update dialog above all other in-app layers, showing current and available versions, bounded release notes, download progress and explicit Cancel, Skip this version and Download and install actions. Desktop builds best-effort restore and focus the app window; they do not leave it permanently always-on-top.
- Close, Escape, outside-click, Cancel and Skip this version all suppress only the displayed normalized version. The dialog states that a later release will prompt again. Manual checks can still inspect a suppressed version.
- A skipped version remains hidden for automatic discovery until a different version is published or the user manually checks. Manual checks deliberately ignore the skip preference so the user can revisit a release.
- Background network/configuration failures remain silent and retryable. Manual check and install failures use the existing localized notification and structured-error surfaces.
- Installation requires a reviewed version, a fresh signed-feed check and an explicit install action. Downloads can be cancelled before the installer starts; no code path silently installs or restarts.

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
- The focused pane uses a persistent block cursor, a primary focus outline and a textual "input active" status. An unfocused pane retains an outline cursor and a "click to input" status so split-pane input ownership is never communicated by color alone.
- Search and command history are overlays that do not steal the entire workspace.
- Settings → Terminal exposes a curated terminal palette browser with a live sample of prompt, text, cursor, selection and ANSI colors. Selecting a palette updates only the settings draft and preview; Cancel or closing the dialog discards it. “Apply and save” is the only action that commits the palette to open terminals and local persistence.
- The command input bar sits directly under the terminal surface. Enter sends the line to the active PTY, Shift+Enter inserts a newline, and the bounded history (in-memory only, capped, clearable) is navigated with ArrowUp/ArrowDown. It is disabled and visibly labelled when no terminal is connected.
- Paste containing multiple lines or shell metacharacters can show a configurable safety preview.
- Password prompts and alternate screen applications must remain compatible with standard terminal behavior.
- Terminal logging is off by default. After the user enables logging capability in Settings → Terminal, the active session toolbar exposes a log action; starting requires a host-specific confirmation that raw output may contain sensitive data. An active log shows a compact written-size indicator, and limit, overflow or write failure changes to an explicit warning state.

The toolbar prioritizes reconnect/disconnect, new split, Files, Monitor and Tunnel. Session logging sits with the secondary session utilities and exposes its state inline; other rare actions belong in More.

### 4.6 Files browser

The primary surface is the bottom dual-pane browser inside the center column: a local pane and a remote pane side by side, with a Files | Commands sub-tab strip, editable path field, refresh, upload/download, new folder, follow-terminal chip and a transfer footer that shows the running task count and opens the task drawer. Each pane has a compact directory-only tree beside its file table. Tree nodes lazy-load, omit files and symbolic links, and navigate on a single click. The horizontal separator has a 160 px minimum for the browser but no fixed 480 px ceiling; its effective maximum follows the available center-column height so the browser may occupy the workspace without overflowing the shell.

File-entry visuals inherit the compact Lucide-style outline grammar, adapt it with a restrained category palette, and replace the former one-icon-for-every-file treatment. Folders use amber; source and script files use sky; structured data uses yellow; settings use violet; archives use orange; images use rose; audio/video use pink and purple; documents use blue; spreadsheets use emerald; databases use cyan; keys and certificates use amber; executables use teal; unknown files remain muted. Shape, filename and the Type column carry the meaning when color is unavailable. Expanded tree folders change shape as well as color, and symlinks always use a dedicated link shape. The mapping is shared by the bottom browser and legacy inspector in dark and light themes.

List columns: name, size, type, modified, permissions and owner (numeric uid/gid when the server provides it); responsive collapse begins with owner and permissions. Symlinks are visually distinct and display targets in details. Rows expose a permission-mode action that opens an explicit octal review dialog before any chmod mutation.

Header: channel state, editable path, up, refresh, new folder and upload. Enter navigates to a validated directory; Escape restores the current path. A failed navigation keeps the last successful listing and shows the structured error inline.

The inspector supports:

- Remote-only compact mode.
- Local/remote dual-pane expanded mode.
- Transfer drop targets with exact destination preview.
- Selection summary and bulk actions.
- Inline rename with validation.
- Bounded text preview/editor with changed-on-server detection.

Right-clicking a row selects it and opens one floating menu near the pointer, clamped to the viewport. Right-clicking empty pane space opens the non-row actions. The menu uses arrow/Home/End navigation, nested submenus for Open with, Choose text editor and New, Escape/outside-click dismissal, and restores focus to the row or pane. The menu contains:

- Refresh, Open, Open with (text editor/system association), Choose text editor (built-in/external/set external executable), Copy path.
- Download, Upload file, Upload folder.
- New file and new folder in the current or clicked folder.
- Rename, Delete, Quick recursive delete, and Permissions.

Delete and quick delete use the shared confirmation surface and name the exact host, path and item type. Quick delete is bounded to 5,000 descendants and 16 levels, does not follow symlinks, and is not exposed for root paths. Recursive permission editing pre-scans the same bound before mutation and offers All items, Files only, or Directories only scope.

The permission dialog keeps the owner/group/other matrix and octal review. For directories it adds a recursive checkbox and the three scope choices; recursion is unavailable for files and symlinks. Applying to a directory requires a second host/path/scope confirmation when recursion is enabled.

Settings persist a non-secret text-editor preference (`built-in` or `external`) and an optional external executable path. The executable path is chosen through the native file picker and is never interpreted through a shell. Opening with external editing creates an app-owned cache copy, opens it in the selected tool or OS association, and shows a compact auto-upload state. A stable local save is uploaded atomically over the original; remote revision conflict, local write-in-progress, disconnect and permanent failure are visible states and never reported as a successful overwrite.

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

The assistant uses a collapsible right-side panel that can coexist with the terminal and may temporarily replace the normal inspector at minimum width. Its header combines a conversation menu with compact new, clear, settings and close actions. A second compact bar exposes opt-in context and the active provider/model; the model pill opens a bounded selector with suggested IDs and a manual entry. It has three explicit modes:

- **Explain:** read-only interpretation of selected errors, events, metrics or text.
- **Draft:** produces commands, snippets or change plans but cannot execute them.
- **Act:** exposes only registered typed tools whose underlying capability and policy permit execution.

The composer shows attached context as removable chips inside a collapsible context drawer. The user may select up to two local text/configuration files through the native picker; each selection is capped at 12 KiB and rechecked by the Rust boundary for an allowed extension, regular-file type, UTF-8 and control characters. The panel displays base filenames, types and sizes, explains that redaction is best-effort, and includes categories and approximate size in the provider disclosure. File text is sent only with an explicit request, without filenames or paths, and is not stored in chat history. Provider setup lives in Settings → AI and explains that the endpoint operator controls retention and training practices, which FILEX cannot verify. External-provider consent defaults off, is stored with provider configuration, can be revoked without re-entering the key, and resets when the endpoint or model changes. The assistant boundary rejects sends without consent, and each request displays a compact disclosure of what will leave the device. The panel never silently attaches the full terminal buffer, all profiles, credential metadata or unrelated files.

Assistant messages are separated by role and rendered from a safe, local Markdown subset. The renderer escapes all model text, supports headings, paragraphs, lists, emphasis, inline code and fenced code, and exposes copy-only actions. It does not inject HTML or expose a Run/Execute action. Empty-state suggestions populate the composer; they do not initiate a provider request. Streaming, stop, consent-required, unconfigured, provider-error, malformed-proposal and reduced-motion states remain visible and keyboard reachable.

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

The visual system adapts Arco Design's clean neutral fill ladder, hairline dividers, vivid Arco Blue primary accent (`#165DFF` light / `#3C7EFF` dark), semantic status colors and layered floating elevation onto FILEX's compact multi-pane workbench.

### Dark theme

```css
--background: 240 6% 10%;
--foreground: 240 8% 93%;
--text-secondary: 218 11% 81%;
--card: 240 2% 14%;
--card-foreground: 240 8% 93%;
--popover: 240 3% 17%;
--popover-foreground: 240 8% 93%;
--surface-inset: 240 5% 12%;
--fill-subtle: 240 4% 15%;
--primary: 220 100% 62%;
--primary-hover: 220 100% 67%;
--primary-active: 221 100% 58%;
--primary-foreground: 0 0% 100%;
--secondary: 240 2% 18%;
--secondary-foreground: 240 8% 93%;
--muted: 240 3% 17%;
--muted-foreground: 213 10% 57%;
--accent: 240 3% 22%;
--accent-foreground: 220 23% 98%;
--destructive: 2 90% 67%;
--destructive-hover: 2 92% 72%;
--destructive-foreground: 0 0% 100%;
--danger: var(--destructive);
--warning: 31 100% 59%;
--success: 132 67% 46%;
--border: 240 3% 22%;
--border-subtle: 240 4% 18%;
--input: 240 3% 26%;
--input-hover: 240 3% 34%;
--ring: 220 100% 62%;
--radius: 0.25rem;
--radius-card: 0.375rem;
--radius-popover: 0.375rem;
--radius-dialog: 0.5rem;
--terminal-bg: 0 0% 6%;
```

### Light theme

```css
--background: 220 23% 97%;
--foreground: 220 17% 14%;
--text-secondary: 216 15% 36%;
--card: 0 0% 100%;
--card-foreground: 220 17% 14%;
--popover: 0 0% 100%;
--popover-foreground: 220 17% 14%;
--surface-inset: 220 14% 96%;
--fill-subtle: 220 23% 98%;
--primary: 222 100% 54%;
--primary-hover: 220 100% 63%;
--primary-active: 224 87% 44%;
--primary-foreground: 0 0% 100%;
--secondary: 220 14% 96%;
--secondary-foreground: 220 17% 14%;
--muted: 220 14% 96%;
--muted-foreground: 213 10% 57%;
--accent: 225 14% 91%;
--accent-foreground: 220 17% 14%;
--destructive: 0 90% 60%;
--destructive-hover: 0 93% 68%;
--destructive-foreground: 0 0% 100%;
--danger: var(--destructive);
--warning: 29 100% 50%;
--success: 134 100% 35%;
--border: 225 14% 90%;
--border-subtle: 220 14% 94%;
--input: 218 11% 81%;
--input-hover: 216 12% 72%;
--ring: 222 100% 54%;
```

Status roles:

- Arco primary blue (`--primary`): focus rings, active tab indicators, primary CTAs, toggles.
- Arco green (`--success`): connected, completed, verified signature badges, healthy metrics.
- Arco amber (`--warning`): connecting, stale, changed, warning notices, production attention.
- Arco red (`--destructive` / `--danger`): failed, rejected, destructive actions, host-key mismatch.
- Extended neutral/category accents: file-entry icon semantics only.

## 6. Typography and terminal appearance

- UI default: bundled HarmonyOS Sans SC Regular/Bold followed by system UI/CJK fallbacks (`Inter`, `PingFang SC`, `Microsoft YaHei UI`, `Noto Sans CJK SC`, sans-serif); default 14 px root font size, adjustable 11–20 px.
- The font license is distributed with the application and the bundled fonts are preloaded before the shell.
- Unified optical hierarchy scaled from root `rem`: micro/badge `0.75rem`, caption/metadata `0.7857rem`, dense control/body `0.8571rem`, pane/card section heading `0.9286rem`, modal title `1.0714rem`. Numeric metrics, ports, percentages and timestamps enable `tabular-nums`.
- Terminal default: a bundled or system monospace stack chosen for glyph coverage and performance.
- UI and terminal font settings are separate.
- Terminal palette is separate from the application theme. The default adaptive palette follows the resolved application appearance, while explicit dark and light palettes can be chosen independently.
- The palette browser lists theme name, light/dark classification and a compact ANSI swatch. Its sample preview shows representative normal and bright terminal colors; selection state does not rely on color alone.
- Settings owns palette selection. Terminal panes consume the committed safe setting through a typed palette resolver and never contain per-theme color decisions.
- Paths, hosts, ports, fingerprints, algorithms and command text use monospace.

## 7. Common component behavior

- Buttons: `4 px` radius (`--radius`), crisp `140 ms` `--ease-arco` transitions across hover/active states; primary (`--primary`), default/secondary (`--card`/`--secondary` with hairline border), subtle/ghost (`transparent` fill in menus and headers), and outline danger (`--destructive`) variants. Header bar actions remain single-line (`white-space: nowrap`) at all UI font sizes up to 20 px.
- Icon buttons: `26 × 26 px` (`24 × 24 px` in compact pane toolbars) rounded squares with unified Lucide outline icons (`stroke-width: 1.75`), accessible label and hover fill.
- Inputs, selects and textareas: `4 px` radius, matched height/baseline inside `.form-grid` (`input` and `select` share exact vertical geometry), `--input` hairline border transitioning to `--primary` with a subtle focus halo on focus.
- Switches, segmented controls, checkboxes and radios: pill tracks with elevated active thumb/segment and `--primary` accent state.
- Pane header: `30–34 px` structured header with muted surface fill, `1 px` bottom border and semibold title.
- Dialogs, popovers, context menus and command palette: layered floating surface (`--popover` / `--card`), `6–8 px` radius (`--radius-popover` / `--radius-dialog`), translucent backdrop blur for modals, soft directional shadow, icon + title header with close control, scrollable body and clearly separated secondary/primary footer.
- Toast: top right floating pill/card with semantic left/icon accent and directional shadow; error is assertive, other status polite.
- Loading remains in the initiating control or pane. Full-screen blocking is reserved for unrecoverable bootstrap/migration states.
- Motion: gentle scale/opacity modal & popover entrances use `--duration-micro` / `--duration-modal` and collapse immediately under `[data-reduce-motion="true"]` or `prefers-reduced-motion: reduce`.

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

