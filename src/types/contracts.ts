export type EnvironmentKind = 'production' | 'staging' | 'development';
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'degraded' | 'failed';
export type InspectorTab = 'files' | 'monitor' | 'session';
export type TaskTab = 'transfers' | 'tunnels' | 'events';
export type ThemePreference = 'system' | 'dark' | 'light';
export type LocaleCode = 'zh-CN' | 'en-US';

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
}

export interface SafeSettings {
  theme: ThemePreference;
  locale: LocaleCode;
  uiFontFamily: string;
  uiFontSize: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  reduceMotion: boolean;
  inspectorTab: InspectorTab;
  taskTab: TaskTab;
  taskDrawerOpen: boolean;
}

export interface RuntimeInfo {
  kind: 'browser' | 'tauri';
  version: string;
  credentialStore: 'available' | 'locked' | 'unavailable' | 'not_probed';
  sshCapability: 'not_installed' | 'probing' | 'available';
}
