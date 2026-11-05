export type EnvironmentKind = 'production' | 'staging' | 'development';
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'degraded' | 'failed';
export type InspectorTab = 'files' | 'monitor' | 'session';
export type TaskTab = 'transfers' | 'tunnels' | 'events';
export type ThemePreference = 'system' | 'dark' | 'light';
export type TerminalThemePreference = 'match' | 'dark' | 'light';
export type TerminalEncoding = 'utf-8' | 'gbk' | 'big5' | 'shift_jis' | 'windows-1252';
export type LocaleCode = 'zh-CN' | 'en-US';
export type CredentialStoreStatus = 'available' | 'locked' | 'unavailable' | 'unsupported';
export type AuthenticationMethod = 'password' | 'private_key' | 'agent';

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
  proxyJump: string | null;
  proxyJumpProfileIds: string[];
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
  proxyJump: string | null;
  proxyJumpProfileIds: string[];
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

export interface SessionSummary {
  id: string;
  generation: number;
  profileId: string;
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

export type TransferDirection = 'upload' | 'download';
export type TransferState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';

export interface CreateTransferInput {
  profileId: string;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  conflictPolicy: ConflictPolicy;
  totalBytes: number | null;
}

export interface TransferTask {
  id: string;
  profileId: string;
  sessionId: string | null;
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  state: TransferState;
  bytesTransferred: number;
  totalBytes: number | null;
  conflictPolicy: ConflictPolicy;
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

export interface ProcessEntry {
  pid: number;
  name: string;
  cpuPercent: number | null;
  cpuTimeSeconds: number | null;
  memoryBytes: number | null;
  state: string | null;
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
  taskDrawerHeight: number;
  hostPanelOpen: boolean;
  fileBrowserOpen: boolean;
  followTerminalCwd: boolean;
  focusMode: boolean;
  detailsPaneOpen: boolean;
  hostPanelWidth: number;
  fileBrowserHeight: number;
  terminalLogging: boolean;
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
