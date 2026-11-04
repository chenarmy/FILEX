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
    pub toggle_task_drawer: String,
    pub command_palette: String,
    pub toggle_assistant: String,
    pub focus_connections: String,
    pub focus_terminal: String,
    pub focus_inspector: String,
    pub open_settings: String,
    pub show_events: String,
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
    pub task_drawer_height: u16,
    pub terminal_logging: bool,
    pub backup_schedule: String,
    pub update_channel: String,
    #[serde(default)]
    pub shortcuts: KeyboardShortcuts,
}

fn default_monitor_interval_seconds() -> u16 {
    30
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
    pub command: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommandSnippetInput {
    pub id: Option<String>,
    pub name: String,
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
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
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
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
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
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_jump_profile_ids: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub generation: u64,
    pub profile_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTransferInput {
    pub profile_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub conflict_policy: ConflictPolicy,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub profile_id: String,
    pub session_id: Option<String>,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub state: TransferState,
    pub bytes_transferred: u64,
    pub total_bytes: Option<u64>,
    pub conflict_policy: ConflictPolicy,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub cpu_percent: Option<f64>,
    pub memory_total_kib: Option<u64>,
    pub memory_available_kib: Option<u64>,
    pub swap_total_kib: Option<u64>,
    pub swap_used_kib: Option<u64>,
    pub root_total_kib: Option<u64>,
    pub root_available_kib: Option<u64>,
    pub network_receive_bytes_per_second: Option<f64>,
    pub network_transmit_bytes_per_second: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessPlatform {
    Posix,
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: Option<f64>,
    pub cpu_time_seconds: Option<f64>,
    pub memory_bytes: Option<u64>,
    pub state: Option<String>,
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
