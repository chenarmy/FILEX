use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    Production,
    Staging,
    Development,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Idle,
    Connecting,
    Connected,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethod {
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteState {
    Unchanged,
    Changed,
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStoreStatus {
    Available,
    Locked,
    Unavailable,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message_key: String,
    pub retryable: bool,
    pub remote_state: RemoteState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyboardShortcuts {
    pub quick_connect: String,
    pub new_session: String,
    pub close_active_tab: String,
    pub next_session: String,
    pub previous_session: String,
    pub terminal_search: String,
    pub toggle_files: String,
    #[serde(default = "default_toggle_focus_mode")]
    pub toggle_focus_mode: String,
    pub toggle_task_drawer: String,
    pub command_palette: String,
    pub toggle_assistant: String,
    pub focus_connections: String,
    pub focus_terminal: String,
    pub focus_inspector: String,
    pub open_settings: String,
    pub show_events: String,
}

fn default_toggle_focus_mode() -> String {
    "mod+shift+m".to_owned()
}

impl Default for KeyboardShortcuts {
    fn default() -> Self {
        Self {
            quick_connect: "mod+k".to_owned(),
            new_session: "mod+n".to_owned(),
            close_active_tab: "mod+w".to_owned(),
            next_session: "mod+tab".to_owned(),
            previous_session: "mod+shift+tab".to_owned(),
            terminal_search: "mod+f".to_owned(),
            toggle_files: "mod+shift+f".to_owned(),
            toggle_focus_mode: "mod+shift+m".to_owned(),
            toggle_task_drawer: "mod+j".to_owned(),
            command_palette: "mod+shift+p".to_owned(),
            toggle_assistant: "mod+shift+a".to_owned(),
            focus_connections: "mod+1".to_owned(),
            focus_terminal: "mod+2".to_owned(),
            focus_inspector: "mod+3".to_owned(),
            open_settings: "mod+comma".to_owned(),
            show_events: "mod+shift+e".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeSettings {
    pub theme: String,
    pub locale: String,
    pub ui_font_family: String,
    pub ui_font_size: u8,
    pub terminal_font_family: String,
    pub terminal_font_size: u8,
    #[serde(default = "default_terminal_theme")]
    pub terminal_theme: String,
    #[serde(default = "default_terminal_encoding")]
    pub terminal_encoding: String,
    pub terminal_scrollback: u32,
    pub paste_protection: bool,
    pub connection_timeout_seconds: u16,
    pub keepalive_seconds: u16,
    pub reconnect_attempts: u8,
    #[serde(default = "default_monitor_interval_seconds")]
    pub monitor_interval_seconds: u16,
    pub reduce_motion: bool,
    pub inspector_tab: String,
    #[serde(default)]
    pub dual_pane_sftp: bool,
    pub task_tab: String,
    pub task_drawer_open: bool,
    pub connections_pane_width: u16,
    pub inspector_pane_width: u16,
    #[serde(default = "default_assistant_pane_width")]
    pub assistant_pane_width: u16,
    pub task_drawer_height: u16,
    #[serde(default = "default_host_panel_open")]
    pub host_panel_open: bool,
    #[serde(default = "default_file_browser_open")]
    pub file_browser_open: bool,
    #[serde(default = "default_follow_terminal_cwd")]
    pub follow_terminal_cwd: bool,
    #[serde(default)]
    pub focus_mode: bool,
    #[serde(default)]
    pub details_pane_open: bool,
    #[serde(default = "default_host_panel_width")]
    pub host_panel_width: u16,
    #[serde(default = "default_file_browser_height")]
    pub file_browser_height: u16,
    #[serde(default = "default_text_editor_preference")]
    pub text_editor_preference: String,
    #[serde(default)]
    pub external_editor_path: Option<String>,
    pub terminal_logging: bool,
    #[serde(default)]
    pub compact_composer_open: bool,
    pub backup_schedule: String,
    pub update_channel: String,
    #[serde(default)]
    pub shortcuts: KeyboardShortcuts,
}

fn default_monitor_interval_seconds() -> u16 {
    30
}

fn default_host_panel_open() -> bool {
    false
}

fn default_file_browser_open() -> bool {
    true
}

fn default_follow_terminal_cwd() -> bool {
    true
}

fn default_host_panel_width() -> u16 {
    280
}

fn default_assistant_pane_width() -> u16 {
    360
}

fn default_file_browser_height() -> u16 {
    260
}

fn default_text_editor_preference() -> String {
    "internal".to_owned()
}

fn default_terminal_theme() -> String {
    "match".to_owned()
}

fn default_terminal_encoding() -> String {
    "utf-8".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceArtifact {
    pub kind: String,
    pub path: String,
    pub bytes: u64,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub channel: String,
    pub configured: bool,
    pub available_version: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePaths {
    pub data_directory: String,
    pub backup_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalLogState {
    Inactive,
    Active,
    LimitReached,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLogStatus {
    pub session_id: String,
    pub state: TerminalLogState,
    pub path: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandSnippet {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub command: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommandSnippetInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub command: String,
}

impl<T> OperationResult<T> {
    pub fn success(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
            request_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn failure(error: AppError) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(error),
            request_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: EnvironmentKind,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub authentication_method: AuthenticationMethod,
    pub identity_file: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
    #[serde(default)]
    pub proxy_profile_id: Option<String>,
    pub credential_ref: Option<String>,
    pub state: ConnectionState,
    pub latency_ms: Option<u32>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableConnectionRouteHop {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableConnectionProfile {
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: EnvironmentKind,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub authentication_method: AuthenticationMethod,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_route: Vec<PortableConnectionRouteHop>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfilesExport {
    pub format: String,
    pub schema_version: u16,
    pub exported_at_ms: u64,
    pub profiles: Vec<PortableConnectionProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionProfileInput {
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: EnvironmentKind,
    pub tags: Vec<String>,
    pub authentication_method: AuthenticationMethod,
    pub identity_file: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
    #[serde(default)]
    pub proxy_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickConnectInput {
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLaunchRequest {
    pub launch_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub display_name: Option<String>,
    pub authentication_method: AuthenticationMethod,
    pub identity_file: Option<String>,
    pub has_preset_password: bool,
    pub open_sftp: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExternalLaunchEvent {
    #[serde(rename_all = "camelCase")]
    Launch { request: ExternalLaunchRequest },
    #[serde(rename_all = "camelCase")]
    Error { error: AppError },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionProfileInput {
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub environment: EnvironmentKind,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub authentication_method: AuthenticationMethod,
    pub identity_file: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
    #[serde(default)]
    pub proxy_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyMetadataInspection {
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub encrypted: bool,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyEntry {
    pub id: String,
    pub label: String,
    pub key_path: String,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub has_passphrase: bool,
    pub passphrase_ref: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisterSshKeyInput {
    pub label: String,
    pub key_path: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub save_passphrase: bool,
}

impl fmt::Debug for RegisterSshKeyInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisterSshKeyInput")
            .field("label", &self.label)
            .field("key_path", &self.key_path)
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "[REDACTED]"),
            )
            .field("save_passphrase", &self.save_passphrase)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RotateSshKeyInput {
    pub key_id: String,
    pub label: Option<String>,
    pub new_key_path: String,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub save_passphrase: bool,
}

impl fmt::Debug for RotateSshKeyInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RotateSshKeyInput")
            .field("key_id", &self.key_id)
            .field("label", &self.label)
            .field("new_key_path", &self.new_key_path)
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "[REDACTED]"),
            )
            .field("save_passphrase", &self.save_passphrase)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProxyKind {
    Socks5,
    HttpConnect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProfile {
    pub id: String,
    pub label: String,
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub credential_ref: Option<String>,
    pub has_password: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateProxyProfileInput {
    pub label: String,
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub save_password: bool,
}

impl fmt::Debug for CreateProxyProfileInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CreateProxyProfileInput")
            .field("label", &self.label)
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("save_password", &self.save_password)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProxyProfileInput {
    pub id: String,
    pub label: String,
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub clear_password: bool,
}

impl fmt::Debug for UpdateProxyProfileInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpdateProxyProfileInput")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("save_password", &self.save_password)
            .field("clear_password", &self.clear_password)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPreflightResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub detail_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCommandHistoryEntry {
    pub id: String,
    pub profile_id: String,
    pub command: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathBookmark {
    pub id: String,
    pub profile_id: String,
    pub side: String,
    pub label: String,
    pub path: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePathBookmarkInput {
    pub profile_id: String,
    pub side: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportCandidate {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImportPreview {
    pub source_path: String,
    pub candidates: Vec<SshConfigImportCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostTrustSource {
    ImportedKnownHosts,
    FilexDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostTrustRecord {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub previous_fingerprint_sha256: Option<String>,
    pub source: HostTrustSource,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordHostTrustInput {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub source: HostTrustSource,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsImportCandidate {
    pub source_line: u32,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub current_fingerprint_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum KnownHostsImportWarningKind {
    HashedHost,
    HostPattern,
    MarkedEntry,
    UnsupportedKey,
    InvalidEntry,
    ConflictingKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsImportWarning {
    pub kind: KnownHostsImportWarningKind,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsImportPreview {
    pub file_name: String,
    pub candidates: Vec<KnownHostsImportCandidate>,
    pub warnings: Vec<KnownHostsImportWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportKnownHostsInput {
    pub candidates: Vec<KnownHostsImportCandidate>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportKnownHostsResult {
    pub imported_count: u32,
    pub changed_count: u32,
    pub unchanged_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostTrustEvaluation {
    Unknown,
    Trusted,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Resolving,
    Connecting,
    VerifyingHost,
    TrustRequired,
    ReadyToAuthenticate,
    Authenticating,
    Connected,
    Reconnecting,
    Disconnecting,
    Disconnected,
    Failed,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Ssh,
    Local,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    RemoteShell,
    LocalShell,
    Sftp,
    LocalFiles,
    RemoteEdit,
    HostMonitoring,
    Tunneling,
    RemoteJobs,
    ElevatedFileAccess,
}

pub fn capabilities_for_ssh(elevated: bool) -> Vec<CapabilityKind> {
    let mut capabilities = vec![
        CapabilityKind::RemoteShell,
        CapabilityKind::Sftp,
        CapabilityKind::RemoteEdit,
        CapabilityKind::HostMonitoring,
        CapabilityKind::Tunneling,
        CapabilityKind::RemoteJobs,
    ];
    if elevated {
        capabilities.push(CapabilityKind::ElevatedFileAccess);
    }
    capabilities
}

pub fn capabilities_for_local() -> Vec<CapabilityKind> {
    vec![CapabilityKind::LocalShell, CapabilityKind::LocalFiles]
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalShellKind {
    PowerShellCore,
    WindowsPowerShell,
    Cmd,
    Bash,
    Zsh,
    Fish,
    Sh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellOption {
    pub kind: LocalShellKind,
    pub label: String,
    pub executable_path: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenLocalTerminalInput {
    pub shell_kind: Option<LocalShellKind>,
    pub working_directory: Option<String>,
    pub columns: Option<u32>,
    pub rows: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenLocalTerminalResult {
    pub session: SessionSummary,
    pub shell: LocalShellOption,
    pub working_directory: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivilegeState {
    Standard,
    Elevated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ElevatedAccessLeaseSummary {
    pub session_id: String,
    pub generation: u64,
    pub state: PrivilegeState,
    pub username: String,
    pub host: String,
    pub port: u16,
    pub granted_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub ttl_seconds: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcquireElevatedAccessInput {
    pub session_id: String,
    pub password: Option<String>,
    pub ttl_seconds: u32,
}

impl std::fmt::Debug for AcquireElevatedAccessInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcquireElevatedAccessInput")
            .field("session_id", &self.session_id)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("ttl_seconds", &self.ttl_seconds)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub generation: u64,
    pub profile_id: String,
    #[serde(default)]
    pub session_kind: SessionKind,
    #[serde(default)]
    pub capabilities: Vec<CapabilityKind>,
    pub state: SessionState,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub last_error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub session: SessionSummary,
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub hop_index: u8,
    pub hop_count: u8,
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub trust: HostTrustEvaluation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionConnectionProgress {
    pub session: SessionSummary,
    pub challenge: Option<HostKeyChallenge>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
    RemoteToRemote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransferResumeState {
    #[default]
    NotApplicable,
    SafeToResume,
    RestartFromBeginning,
    IdentityChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTransferInput {
    pub profile_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub conflict_policy: ConflictPolicy,
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub destination_profile_id: Option<String>,
    #[serde(default)]
    pub destination_remote_path: Option<String>,
}

/// Persistent transfer journal entry.
/// For downloads, `remote_size_bytes` and `remote_mtime_ms` store the source remote file identity;
/// for uploads, they store the local source file identity;
/// for `remote_to_remote` relays, `profile_id`/`remote_path` identify the source host and path,
/// while `destination_profile_id`/`destination_remote_path` identify the target host and path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub profile_id: String,
    pub session_id: Option<String>,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default)]
    pub destination_profile_id: Option<String>,
    #[serde(default)]
    pub destination_session_id: Option<String>,
    #[serde(default)]
    pub destination_remote_path: Option<String>,
    pub state: TransferState,
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub conflict_policy: ConflictPolicy,
    pub remote_size_bytes: Option<u64>,
    pub remote_mtime_ms: Option<u64>,
    pub staging_path: Option<String>,
    #[serde(default)]
    pub resume_state: TransferResumeState,
    pub error: Option<AppError>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub permissions_mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryListing {
    pub path: String,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemotePermissionScope {
    All,
    Files,
    Directories,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRemotePermissionsInput {
    pub path: String,
    pub mode: u32,
    pub recursive: bool,
    pub scope: RemotePermissionScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePermissionUpdateResult {
    pub updated_count: u32,
    pub skipped_symlink_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub permissions_mode: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<LocalFileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextPreview {
    pub path: String,
    pub content: String,
    pub bytes: u32,
    pub truncated: bool,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextSaveResult {
    pub path: String,
    pub bytes: u32,
    pub revision: String,
    pub recovery_copy_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalEditorState {
    Watching,
    Synced,
    Conflict,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditorSession {
    pub id: String,
    pub session_id: String,
    pub remote_path: String,
    pub local_path: String,
    pub local_revision: String,
    pub remote_revision: String,
    pub bytes: u64,
    pub state: ExternalEditorState,
    pub last_synced_at_ms: Option<u64>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditorSyncResult {
    pub session: ExternalEditorSession,
    pub uploaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextPreview {
    pub path: String,
    pub content: String,
    pub bytes: u32,
    pub truncated: bool,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextSaveResult {
    pub path: String,
    pub bytes: u32,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MonitorState {
    Live,
    Unsupported,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitorSnapshot {
    pub state: MonitorState,
    pub collected_at_ms: u64,
    pub hostname: Option<String>,
    pub os_name: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub load_one: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_five: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_fifteen: Option<f64>,
    pub cpu_percent: Option<f64>,
    pub memory_total_kib: Option<u64>,
    pub memory_available_kib: Option<u64>,
    pub swap_total_kib: Option<u64>,
    pub swap_used_kib: Option<u64>,
    pub root_total_kib: Option<u64>,
    pub root_available_kib: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mounts: Vec<DiskMount>,
    pub network_receive_bytes_per_second: Option<f64>,
    pub network_transmit_bytes_per_second: Option<f64>,
}

/// A bounded per-mount disk usage sample reported alongside the root aggregate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskMount {
    pub path: String,
    pub total_kib: u64,
    pub available_kib: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessPlatform {
    Posix,
    Windows,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessSortBy {
    #[default]
    Cpu,
    Memory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_pid: Option<u32>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub cpu_percent: Option<f64>,
    pub cpu_time_seconds: Option<f64>,
    pub memory_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub virtual_memory_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threads: Option<u32>,
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
    pub can_terminate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub state: MonitorState,
    pub platform: Option<ProcessPlatform>,
    pub collected_at_ms: u64,
    pub snapshot_id: Option<String>,
    pub processes: Vec<ProcessEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPlatform {
    Linux,
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub state: Option<String>,
    pub addresses: Vec<String>,
    pub mtu: Option<u64>,
    pub received_bytes: Option<u64>,
    pub transmitted_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_mbps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rx_packets: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_packets: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rx_errors: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_errors: Option<u64>,
    pub loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEndpoint {
    pub protocol: String,
    pub local_address: String,
    pub local_port: Option<u16>,
    pub remote_address: Option<String>,
    pub remote_port: Option<u16>,
    pub state: Option<String>,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recv_q: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_q: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntry {
    pub destination: String,
    pub gateway: Option<String>,
    pub interface_name: Option<String>,
    pub metric: Option<u32>,
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraceHop {
    pub hop: u32,
    pub address: Option<String>,
    pub avg_latency_ms: Option<f64>,
    pub min_latency_ms: Option<f64>,
    pub max_latency_ms: Option<f64>,
    pub loss_percent: f64,
    pub responded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraceResult {
    pub target: String,
    pub resolved_ip: Option<String>,
    pub hops: Vec<RouteTraceHop>,
    pub whois_lines: Vec<String>,
    pub whois_summary: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    pub state: MonitorState,
    pub platform: Option<NetworkPlatform>,
    pub collected_at_ms: u64,
    pub interfaces: Vec<NetworkInterface>,
    pub endpoints: Vec<NetworkEndpoint>,
    pub routes: Vec<RouteEntry>,
    pub endpoints_truncated: bool,
    pub routes_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChecksumComparison {
    pub local_bytes: u64,
    pub remote_bytes: u64,
    pub local_sha256: String,
    pub remote_sha256: String,
    pub equal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DirectorySyncEntryKind {
    File,
    Directory,
    Symlink,
    Special,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DirectorySyncChangeKind {
    LocalOnly,
    RemoteOnly,
    MetadataDifferent,
    TypeConflict,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySyncPreviewEntry {
    pub relative_path: String,
    pub change_kind: DirectorySyncChangeKind,
    pub local_kind: Option<DirectorySyncEntryKind>,
    pub remote_kind: Option<DirectorySyncEntryKind>,
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
    pub local_modified_at_ms: Option<u64>,
    pub remote_modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySyncPreview {
    pub local_entry_count: usize,
    pub remote_entry_count: usize,
    pub local_only_count: usize,
    pub remote_only_count: usize,
    pub metadata_different_count: usize,
    pub type_conflict_count: usize,
    pub unsupported_count: usize,
    pub unchanged_count: usize,
    pub entries: Vec<DirectorySyncPreviewEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelState {
    Starting,
    Listening,
    Stopping,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    Local,
    Dynamic,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTunnelRuleInput {
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTunnelRuleInput {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRule {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalTunnelInput {
    pub session_id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub allow_non_loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSummary {
    pub id: String,
    pub session_id: String,
    pub profile_id: String,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub state: TunnelState,
    pub last_error: Option<AppError>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum ProcessSignal {
    #[default]
    Sigterm,
    Sigkill,
    Sighup,
    Sigstop,
    Sigcont,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerAvailability {
    Available,
    NotInstalled,
    PermissionDenied,
    DaemonStopped,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerContainerAction {
    Start,
    Stop,
    Restart,
    Pause,
    Unpause,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerEntry {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_usage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pids: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageEntry {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_since: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerSnapshot {
    pub availability: DockerAvailability,
    pub collected_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    pub containers: Vec<DockerContainerEntry>,
    pub images: Vec<DockerImageEntry>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogsSnapshot {
    pub container_id: String,
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsCategory {
    Overview,
    Ports,
    Services,
    Disks,
    Logs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpsCommandSection {
    pub id: String,
    pub title_key: String,
    pub command_label: String,
    pub lines: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpsSnapshot {
    pub state: MonitorState,
    pub collected_at_ms: u64,
    pub category: OpsCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_release: Option<String>,
    pub sections: Vec<OpsCommandSection>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteJobState {
    Queued,
    Running,
    Stopping,
    Completed,
    Failed,
    Cancelled,
    OutcomeUncertain,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteJobKind {
    TailSystemLog,
    InspectDiskUsage,
    CheckServiceHealth,
    InspectListeningPorts,
    CheckSystemHealth,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteJobRiskClass {
    ReadOnly,
    BoundedDiagnostic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartRemoteJobInput {
    pub session_id: String,
    pub kind: RemoteJobKind,
    #[serde(default)]
    pub target_path: Option<String>,
    #[serde(default)]
    pub service_name: Option<String>,
    #[serde(default)]
    pub max_lines: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJobSummary {
    pub id: String,
    pub session_id: String,
    pub session_generation: u64,
    pub profile_id: String,
    pub target_host: String,
    pub target_port: u16,
    pub target_username: String,
    pub kind: RemoteJobKind,
    pub command_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_detail: Option<String>,
    pub risk_class: RemoteJobRiskClass,
    pub state: RemoteJobState,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<String>,
    pub output_start_offset: u64,
    pub output_end_offset: u64,
    pub output_retained_bytes: usize,
    pub output_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJobOutputChunk {
    pub job_id: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub retained_start_offset: u64,
    pub retained_end_offset: u64,
    pub truncated: bool,
    pub content: String,
    pub state: RemoteJobState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileSnapshot {
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileWriteResult {
    pub written: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}
