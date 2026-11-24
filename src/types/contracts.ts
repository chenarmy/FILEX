export type EnvironmentKind = 'production' | 'staging' | 'development';
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'degraded' | 'failed';
export type InspectorTab = 'files' | 'monitor' | 'session';
export type TaskTab = 'all' | 'transfers' | 'jobs' | 'tunnels' | 'events';
export type ThemePreference = 'system' | 'dark' | 'light';
export type TerminalThemePreference =
  | 'match'
  | 'filex-dark'
  | 'one-dark'
  | 'dracula'
  | 'nord'
  | 'tokyo-night'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'monokai'
  | 'github-dark'
  | 'filex-light'
  | 'solarized-light'
  | 'github-light'
  | 'catppuccin-latte';
export type TerminalEncoding =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'euc-jp'
  | 'euc-kr'
  | 'windows-1252';
export type LocaleCode = 'zh-CN' | 'en-US';
export type CredentialStoreStatus = 'available' | 'locked' | 'unavailable' | 'unsupported';
export type AuthenticationMethod = 'password' | 'private_key' | 'agent';
export type TextEditorPreference = 'internal' | 'external';
export type FileBrowserPosition = 'bottom' | 'right';

export interface AppError {
  code: string;
  messageKey: string;
  retryable: boolean;
  remoteState: 'unchanged' | 'changed' | 'unknown' | 'not_applicable';
  field?: string;
  details?: Record<string, unknown>;
}

export type OperationResult<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; error: AppError; requestId: string };

export interface CommandSnippet {
  id: string;
  name: string;
  folder?: string | null;
  command: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SaveCommandSnippetInput {
  id?: string | null;
  name: string;
  folder?: string | null;
  command: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentKind;
  favorite: boolean;
  tags: string[];
  authenticationMethod: AuthenticationMethod;
  identityFile: string | null;
  keyId?: string | null;
  proxyJump: string | null;
  proxyJumpProfileIds: string[];
  proxyProfileId?: string | null;
  credentialRef: string | null;
  state: ConnectionState;
  latencyMs: number | null;
  lastUsedAt: string | null;
}

export interface CreateConnectionProfileInput {
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentKind;
  tags: string[];
  authenticationMethod: AuthenticationMethod;
  identityFile: string | null;
  keyId?: string | null;
  proxyJump: string | null;
  proxyJumpProfileIds: string[];
  proxyProfileId?: string | null;
}

export interface SshKeyMetadataInspection {
  algorithm: string;
  fingerprintSha256: string;
  encrypted: boolean;
  supported: boolean;
}

export interface SshKeyEntry {
  id: string;
  label: string;
  keyPath: string;
  algorithm: string;
  fingerprintSha256: string;
  hasPassphrase: boolean;
  passphraseRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterSshKeyInput {
  label: string;
  keyPath: string;
  passphrase: string | null;
  savePassphrase: boolean;
}

export interface RotateSshKeyInput {
  keyId: string;
  label: string | null;
  newKeyPath: string;
  passphrase: string | null;
  savePassphrase: boolean;
}

export type ProxyKind = 'socks5' | 'http_connect';

export interface ProxyProfile {
  id: string;
  label: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  credentialRef: string | null;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyProfileInput {
  label: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  savePassword: boolean;
}

export interface UpdateProxyProfileInput {
  id: string;
  label: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  savePassword: boolean;
  clearPassword: boolean;
}

export interface ProxyPreflightResult {
  ok: boolean;
  latencyMs: number;
  detailCode: string;
}

export interface ProfileCommandHistoryEntry {
  id: string;
  profileId: string;
  command: string;
  createdAtMs: number;
}

export type BookmarkSide = 'local' | 'remote';

export interface PathBookmark {
  id: string;
  profileId: string;
  side: BookmarkSide;
  label: string;
  path: string;
  createdAtMs: number;
}

export interface CreatePathBookmarkInput {
  profileId: string;
  side: BookmarkSide;
  label: string;
  path: string;
}

export interface UpdateConnectionProfileInput extends CreateConnectionProfileInput {
  favorite: boolean;
}

export interface SshConfigImportCandidate {
  alias: string;
  host: string;
  port: number;
  username: string;
  identityFile: string | null;
  proxyJump: string | null;
  warnings: string[];
}

export interface SshConfigImportPreview {
  sourcePath: string;
  candidates: SshConfigImportCandidate[];
  warnings: string[];
}

export type HostTrustSource = 'imported_known_hosts' | 'filex_decision';
export type HostTrustEvaluation = 'unknown' | 'trusted' | 'changed';
export interface KnownHostsImportCandidate {
  sourceLine: number;
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  currentFingerprintSha256: string | null;
}
export type KnownHostsImportWarningKind = 'hashed_host' | 'host_pattern' | 'marked_entry' | 'unsupported_key' | 'invalid_entry' | 'conflicting_key';
export interface KnownHostsImportWarning {
  kind: KnownHostsImportWarningKind;
  count: number;
}
export interface KnownHostsImportPreview {
  fileName: string;
  candidates: KnownHostsImportCandidate[];
  warnings: KnownHostsImportWarning[];
}
export interface ImportKnownHostsInput {
  candidates: KnownHostsImportCandidate[];
  observedAt: string;
}
export interface ImportKnownHostsResult {
  importedCount: number;
  changedCount: number;
  unchangedCount: number;
}
export type SessionState =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'verifying_host'
  | 'trust_required'
  | 'ready_to_authenticate'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type SessionKind = 'ssh' | 'local';

export type CapabilityKind =
  | 'remote_shell'
  | 'local_shell'
  | 'sftp'
  | 'local_files'
  | 'remote_edit'
  | 'host_monitoring'
  | 'tunneling'
  | 'remote_jobs'
  | 'elevated_file_access';

export type LocalShellKind =
  | 'power_shell_core'
  | 'windows_power_shell'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'sh';

export interface LocalShellOption {
  kind: LocalShellKind;
  label: string;
  executablePath: string;
  isDefault: boolean;
}

export interface OpenLocalTerminalInput {
  shellKind: LocalShellKind | null;
  workingDirectory: string | null;
  columns: number | null;
  rows: number | null;
}

export interface OpenLocalTerminalResult {
  session: SessionSummary;
  shell: LocalShellOption;
  workingDirectory: string;
}

export type PrivilegeState = 'standard' | 'elevated';

export interface ElevatedAccessLeaseSummary {
  sessionId: string;
  generation: number;
  state: PrivilegeState;
  username: string;
  host: string;
  port: number;
  grantedAtMs: number | null;
  expiresAtMs: number | null;
  ttlSeconds: number | null;
}

export interface AcquireElevatedAccessInput {
  sessionId: string;
  password: string | null;
  ttlSeconds: number;
}

export interface SessionSummary {
  id: string;
  generation: number;
  profileId: string;
  sessionKind: SessionKind;
  capabilities: CapabilityKind[];
  state: SessionState;
  host: string;
  port: number;
  username: string;
  lastError: AppError | null;
}

export type AssistantCommandShell = 'bash' | 'sh' | 'zsh' | 'powershell' | 'cmd';

export interface AssistantProposalTargetSnapshot {
  sessionId: string;
  generation: number;
  host: string;
  port: number;
  state: SessionState;
}

export interface AssistantCommandDraft {
  shell: AssistantCommandShell;
  command: string;
}

export interface AssistantCommandDraftProposalV1 {
  version: 1;
  kind: 'command.draft';
  risk: 'draft';
  commands: AssistantCommandDraft[];
  target: AssistantProposalTargetSnapshot | null;
  stale: boolean;
}

export interface AssistantChangePlanStepV1 {
  title: string;
  commands: AssistantCommandDraft[];
  expectedEffect: string;
  rollback: string;
}

export interface AssistantChangePlanProposalV1 {
  version: 1;
  kind: 'change-plan.draft';
  risk: 'draft';
  title: string;
  summary: string;
  steps: AssistantChangePlanStepV1[];
  target: AssistantProposalTargetSnapshot | null;
  stale: boolean;
}

export type AssistantDraftProposalV1 = AssistantCommandDraftProposalV1 | AssistantChangePlanProposalV1;

export interface HostKeyChallenge {
  session: SessionSummary;
  profileId: string;
  profileName: string;
  host: string;
  port: number;
  hopIndex: number;
  hopCount: number;
  algorithm: string;
  fingerprintSha256: string;
  trust: HostTrustEvaluation;
}

export interface QuickConnectInput {
  host: string;
  port: number;
  username: string;
}

export interface ExternalLaunchRequest {
  launchId: string;
  host: string;
  port: number;
  username: string;
  displayName: string | null;
  authenticationMethod: AuthenticationMethod;
  identityFile: string | null;
  hasPresetPassword: boolean;
  openSftp: boolean;
}

export type ExternalLaunchEvent =
  | { kind: 'launch'; request: ExternalLaunchRequest }
  | { kind: 'error'; error: AppError };

export interface SessionConnectionProgress {
  session: SessionSummary;
  challenge: HostKeyChallenge | null;
  connected: boolean;
}

export interface RecordHostTrustInput {
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  source: HostTrustSource;
  observedAt: string;
}

export interface HostTrustRecord {
  id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  previousFingerprintSha256: string | null;
  source: HostTrustSource;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type TransferDirection = 'upload' | 'download' | 'remote_to_remote';
export type TransferState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';
export type TransferResumeState = 'not_applicable' | 'safe_to_resume' | 'restart_from_beginning' | 'identity_changed';

export interface CreateTransferInput {
  profileId: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  conflictPolicy: ConflictPolicy;
  totalBytes: number | null;
  destinationProfileId?: string | null;
  destinationRemotePath?: string | null;
}

export interface TransferTask {
  id: string;
  profileId: string;
  sessionId: string | null;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  destinationProfileId: string | null;
  destinationSessionId: string | null;
  destinationRemotePath: string | null;
  state: TransferState;
  bytesTransferred: number;
  totalBytes: number | null;
  conflictPolicy: ConflictPolicy;
  remoteSizeBytes: number | null;
  remoteMtimeMs: number | null;
  stagingPath: string | null;
  resumeState: TransferResumeState;
  error: AppError | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number | null;
  modifiedAtMs: number | null;
  permissionsMode: number | null;
  uid?: number | null;
  gid?: number | null;
}

export interface RemoteDirectoryListing {
  path: string;
  entries: RemoteFileEntry[];
}

export type RemotePermissionScope = 'all' | 'files' | 'directories';

export interface UpdateRemotePermissionsInput {
  path: string;
  mode: number;
  recursive: boolean;
  scope: RemotePermissionScope;
}

export interface RemotePermissionUpdateResult {
  updatedCount: number;
  skippedSymlinkCount: number;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number | null;
  modifiedAtMs: number | null;
  permissionsMode: number | null;
}

export interface LocalDirectoryListing {
  path: string;
  parentPath: string | null;
  entries: LocalFileEntry[];
  truncated: boolean;
}

export interface RemoteTextPreview {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  revision: string;
}

export interface RemoteTextSaveResult {
  path: string;
  bytes: number;
  revision: string;
  recoveryCopyPath: string | null;
}

export type ExternalEditorState = 'watching' | 'synced' | 'conflict' | 'failed';

export interface ExternalEditorSession {
  id: string;
  sessionId: string;
  remotePath: string;
  localPath: string;
  localRevision: string;
  remoteRevision: string;
  bytes: number;
  state: ExternalEditorState;
  lastSyncedAtMs: number | null;
  error: AppError | null;
}

export interface ExternalEditorSyncResult {
  session: ExternalEditorSession;
  uploaded: boolean;
}

export interface LocalTextPreview {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  revision: string;
}

export interface LocalTextSaveResult {
  path: string;
  bytes: number;
  revision: string;
}

export type MonitorState = 'live' | 'unsupported' | 'permission_denied' | 'failed';

export interface DiskMount {
  path: string;
  totalKib: number;
  availableKib: number;
}

export interface SystemMonitorSnapshot {
  state: MonitorState;
  collectedAtMs: number;
  hostname: string | null;
  osName: string | null;
  uptimeSeconds: number | null;
  loadOne: number | null;
  loadFive?: number | null;
  loadFifteen?: number | null;
  cpuPercent: number | null;
  memoryTotalKib: number | null;
  memoryAvailableKib: number | null;
  swapTotalKib: number | null;
  swapUsedKib: number | null;
  rootTotalKib: number | null;
  rootAvailableKib: number | null;
  mounts?: DiskMount[];
  networkReceiveBytesPerSecond: number | null;
  networkTransmitBytesPerSecond: number | null;
}

export type ProcessPlatform = 'posix' | 'windows';
export type ProcessSortBy = 'cpu' | 'memory';

export interface ProcessEntry {
  pid: number;
  parentPid?: number | null;
  name: string;
  user?: string | null;
  cpuPercent: number | null;
  cpuTimeSeconds: number | null;
  memoryBytes: number | null;
  virtualMemoryBytes?: number | null;
  threads?: number | null;
  state: string | null;
  startedAtMs?: number | null;
  executablePath?: string | null;
  workingDirectory?: string | null;
  commandLine?: string | null;
  canTerminate: boolean;
}

export interface ProcessSnapshot {
  state: MonitorState;
  platform: ProcessPlatform | null;
  collectedAtMs: number;
  snapshotId: string | null;
  processes: ProcessEntry[];
  truncated: boolean;
}

export type NetworkPlatform = 'linux' | 'windows';

export interface NetworkInterface {
  name: string;
  state: string | null;
  addresses: string[];
  mtu: number | null;
  receivedBytes: number | null;
  transmittedBytes: number | null;
  macAddress?: string | null;
  speedMbps?: number | null;
  rxPackets?: number | null;
  txPackets?: number | null;
  rxErrors?: number | null;
  txErrors?: number | null;
  loopback: boolean;
}

export interface NetworkEndpoint {
  protocol: string;
  localAddress: string;
  localPort: number | null;
  remoteAddress: string | null;
  remotePort: number | null;
  state: string | null;
  pid: number | null;
  processName: string | null;
  recvQ?: number | null;
  sendQ?: number | null;
}

export interface RouteEntry {
  destination: string;
  gateway: string | null;
  interfaceName: string | null;
  metric: number | null;
  protocol: string | null;
  table?: string | null;
  scope?: string | null;
  sourceAddress?: string | null;
  routeType?: string | null;
}

export interface RouteTraceHop {
  hop: number;
  address: string | null;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  lossPercent: number;
  responded: boolean;
}

export interface RouteTraceResult {
  target: string;
  resolvedIp: string | null;
  hops: RouteTraceHop[];
  whoisLines: string[];
  whoisSummary: string | null;
  truncated: boolean;
}

export interface NetworkSnapshot {
  state: MonitorState;
  platform: NetworkPlatform | null;
  collectedAtMs: number;
  interfaces: NetworkInterface[];
  endpoints: NetworkEndpoint[];
  routes: RouteEntry[];
  endpointsTruncated: boolean;
  routesTruncated: boolean;
}

export interface FileChecksumComparison {
  localBytes: number;
  remoteBytes: number;
  localSha256: string;
  remoteSha256: string;
  equal: boolean;
}

export type DirectorySyncEntryKind = 'file' | 'directory' | 'symlink' | 'special';
export type DirectorySyncChangeKind = 'local_only' | 'remote_only' | 'metadata_different' | 'type_conflict' | 'unsupported';

export interface DirectorySyncPreviewEntry {
  relativePath: string;
  changeKind: DirectorySyncChangeKind;
  localKind: DirectorySyncEntryKind | null;
  remoteKind: DirectorySyncEntryKind | null;
  localSize: number | null;
  remoteSize: number | null;
  localModifiedAtMs: number | null;
  remoteModifiedAtMs: number | null;
}

export interface DirectorySyncPreview {
  localEntryCount: number;
  remoteEntryCount: number;
  localOnlyCount: number;
  remoteOnlyCount: number;
  metadataDifferentCount: number;
  typeConflictCount: number;
  unsupportedCount: number;
  unchangedCount: number;
  entries: DirectorySyncPreviewEntry[];
  truncated: boolean;
}

export type TunnelState = 'starting' | 'listening' | 'stopping' | 'failed' | 'stopped';
export type TunnelKind = 'local' | 'dynamic' | 'remote';

export interface CreateTunnelRuleInput {
  profileId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
  autoStart: boolean;
}

export interface TunnelRule extends CreateTunnelRuleInput {
  id: string;
}

export interface UpdateTunnelRuleInput extends CreateTunnelRuleInput {
  id: string;
}

export interface CreateLocalTunnelInput {
  sessionId: string;
  profileId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
  allowNonLoopback: boolean;
}

export interface TunnelSummary extends CreateLocalTunnelInput {
  id: string;
  state: TunnelState;
  lastError: AppError | null;
}

export interface KeyboardShortcuts {
  quickConnect: string;
  newSession: string;
  closeActiveTab: string;
  nextSession: string;
  previousSession: string;
  terminalSearch: string;
  toggleFiles: string;
  toggleFocusMode: string;
  toggleTaskDrawer: string;
  commandPalette: string;
  toggleAssistant: string;
  focusConnections: string;
  focusTerminal: string;
  focusInspector: string;
  openSettings: string;
  showEvents: string;
}

export interface SafeSettings {
  theme: ThemePreference;
  locale: LocaleCode;
  uiFontFamily: string;
  uiFontSize: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalTheme: TerminalThemePreference;
  terminalEncoding: TerminalEncoding;
  terminalScrollback: number;
  pasteProtection: boolean;
  connectionTimeoutSeconds: number;
  keepaliveSeconds: number;
  reconnectAttempts: number;
  monitorIntervalSeconds: number;
  reduceMotion: boolean;
  inspectorTab: InspectorTab;
  dualPaneSftp: boolean;
  taskTab: TaskTab;
  taskDrawerOpen: boolean;
  connectionsPaneWidth: number;
  inspectorPaneWidth: number;
  assistantPaneWidth: number;
  taskDrawerHeight: number;
  hostPanelOpen: boolean;
  fileBrowserOpen: boolean;
  followTerminalCwd: boolean;
  focusMode: boolean;
  detailsPaneOpen: boolean;
  hostPanelWidth: number;
  fileBrowserHeight: number;
  fileBrowserPosition: FileBrowserPosition;
  fileBrowserWidth: number;
  textEditorPreference: TextEditorPreference;
  externalEditorPath: string | null;
  terminalLogging: boolean;
  compactComposerOpen: boolean;
  backupSchedule: 'off' | 'daily' | 'weekly';
  updateChannel: 'stable' | 'beta';
  shortcuts: KeyboardShortcuts;
}

export interface RuntimeInfo {
  kind: 'browser' | 'tauri';
  version: string;
  credentialStore: CredentialStoreStatus | 'not_probed';
  sshCapability: 'not_installed' | 'probing' | 'available';
}

export interface MaintenanceArtifact {
  kind: 'backup' | 'diagnostics' | 'connection_profiles';
  path: string;
  bytes: number;
  createdAtMs: number;
}

export interface UpdateStatus {
  currentVersion: string;
  channel: 'stable' | 'beta';
  configured: boolean;
  availableVersion: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
}

export interface RuntimePaths {
  dataDirectory: string;
  backupDirectory: string;
}

export type TerminalLogState = 'inactive' | 'active' | 'limit_reached' | 'interrupted' | 'failed';

export interface TerminalLogStatus {
  sessionId: string;
  state: TerminalLogState;
  path: string | null;
  bytes: number;
  error?: AppError;
}

export type ProcessSignal = 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGSTOP' | 'SIGCONT';

export type MonitorDetailsView = 'overview' | 'processes' | 'network' | 'routes';

export type DockerAvailability =
  | 'available'
  | 'not_installed'
  | 'permission_denied'
  | 'daemon_stopped'
  | 'unsupported';

export type DockerContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove';

export interface DockerContainerEntry {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  cpuPercent?: string | null;
  memoryUsage?: string | null;
  pids?: string | null;
}

export interface DockerImageEntry {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
}

export interface DockerSnapshot {
  availability: DockerAvailability;
  collectedAtMs: number;
  serverVersion?: string | null;
  containers: DockerContainerEntry[];
  images: DockerImageEntry[];
  truncated: boolean;
  detailNote?: string | null;
}

export interface DockerLogsSnapshot {
  containerId: string;
  lines: string[];
  truncated: boolean;
}

export type OpsCategory = 'overview' | 'ports' | 'services' | 'disks' | 'logs';

export interface OpsCommandSection {
  id: string;
  titleKey: string;
  commandLabel: string;
  lines: string[];
  truncated: boolean;
}

export interface OpsSnapshot {
  state: MonitorState;
  collectedAtMs: number;
  category: OpsCategory;
  hostname?: string | null;
  kernel?: string | null;
  osRelease?: string | null;
  sections: OpsCommandSection[];
}

export type RemoteJobState =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_uncertain';

export type RemoteJobKind =
  | 'tail_system_log'
  | 'inspect_disk_usage'
  | 'check_service_health'
  | 'inspect_listening_ports'
  | 'check_system_health';

export type RemoteJobRiskClass = 'read_only' | 'bounded_diagnostic';

export interface StartRemoteJobInput {
  sessionId: string;
  kind: RemoteJobKind;
  targetPath?: string | null;
  serviceName?: string | null;
  maxLines?: number | null;
}

export interface RemoteJobSummary {
  id: string;
  sessionId: string;
  sessionGeneration: number;
  profileId: string;
  targetHost: string;
  targetPort: number;
  targetUsername: string;
  kind: RemoteJobKind;
  commandLabel: string;
  targetDetail?: string | null;
  riskClass: RemoteJobRiskClass;
  state: RemoteJobState;
  createdAtMs: number;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  exitCode?: number | null;
  exitSignal?: string | null;
  outputStartOffset: number;
  outputEndOffset: number;
  outputRetainedBytes: number;
  outputTruncated: boolean;
  error?: AppError | null;
}

export interface RemoteJobOutputChunk {
  jobId: string;
  startOffset: number;
  endOffset: number;
  retainedStartOffset: number;
  retainedEndOffset: number;
  truncated: boolean;
  content: string;
  state: RemoteJobState;
}

export interface ClipboardFileSnapshot {
  paths: string[];
  sequence?: number | null;
  supported: boolean;
}

export interface ClipboardFileWriteResult {
  written: boolean;
  sequence?: number | null;
}
