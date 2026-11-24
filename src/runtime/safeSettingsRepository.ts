import type { SafeSettings } from '@/types/contracts';
import { normalizeTextEncoding } from '@/domain/encodings';
import { normalizeTerminalTheme } from '@/domain/terminalThemes';
import { DEFAULT_TERMINAL_FONT_FAMILY, LEGACY_TERMINAL_FONT_FAMILY } from '@/domain/terminalInteractions';
import { DEFAULT_KEYBOARD_SHORTCUTS, normalizeKeyboardShortcuts } from '@/utils/keyboardShortcuts';

const storageKey = 'filex.safe-settings.v1';
const legacyUiFontFamily = 'Inter, system-ui, sans-serif';
export const defaultUiFontFamily = '"HarmonyOS Sans SC", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif';

export const defaultSafeSettings: SafeSettings = {
  theme: 'system',
  locale: 'zh-CN',
  uiFontFamily: defaultUiFontFamily,
  uiFontSize: 14,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 13,
  terminalTheme: 'match',
  terminalEncoding: 'utf-8',
  terminalScrollback: 10_000,
  pasteProtection: true,
  connectionTimeoutSeconds: 15,
  keepaliveSeconds: 30,
  reconnectAttempts: 3,
  monitorIntervalSeconds: 30,
  reduceMotion: false,
  inspectorTab: 'files',
  dualPaneSftp: false,
  taskTab: 'transfers',
  taskDrawerOpen: false,
  connectionsPaneWidth: 244,
  inspectorPaneWidth: 286,
  assistantPaneWidth: 360,
  taskDrawerHeight: 180,
  hostPanelOpen: false,
  fileBrowserOpen: true,
  followTerminalCwd: true,
  focusMode: false,
  detailsPaneOpen: false,
  hostPanelWidth: 260,
  fileBrowserHeight: 240,
  fileBrowserPosition: 'bottom',
  fileBrowserWidth: 420,
  textEditorPreference: 'internal',
  externalEditorPath: null,
  uploadConflictPolicy: 'overwrite',
  defaultDownloadDirectory: null,
  autoOpenDownloadFolder: true,
  mcpEnabled: false,
  mcpPort: 19_375,
  terminalLogging: false,
  compactComposerOpen: false,
  backupSchedule: 'daily',
  updateChannel: 'stable',
  shortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
};

export function readSafeSettings(): SafeSettings {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { ...defaultSafeSettings, shortcuts: { ...defaultSafeSettings.shortcuts } };

  try {
    const parsed = JSON.parse(raw) as Partial<SafeSettings>;
    return normalizeSafeSettings(parsed);
  } catch {
    localStorage.removeItem(storageKey);
    return { ...defaultSafeSettings, shortcuts: { ...defaultSafeSettings.shortcuts } };
  }
}

export function writeSafeSettings(settings: SafeSettings): void {
  localStorage.setItem(storageKey, JSON.stringify(normalizeSafeSettings(settings)));
}

export function normalizeSafeSettings(input: Partial<SafeSettings>): SafeSettings {
  const themes = ['system', 'dark', 'light'] as const;
  const locales = ['zh-CN', 'en-US'] as const;
  const inspectorTabs = ['files', 'monitor', 'session'] as const;
  const taskTabs = ['all', 'transfers', 'jobs', 'tunnels', 'events'] as const;

  return {
    theme: themes.includes(input.theme as typeof themes[number]) ? input.theme as SafeSettings['theme'] : 'system',
    locale: locales.includes(input.locale as typeof locales[number]) ? input.locale as SafeSettings['locale'] : 'zh-CN',
    uiFontFamily: normalizeFontFamily(input.uiFontFamily, legacyUiFontFamily, defaultSafeSettings.uiFontFamily),
    uiFontSize: clampNumber(input.uiFontSize, 11, 20, defaultSafeSettings.uiFontSize),
    terminalFontFamily: normalizeFontFamily(
      input.terminalFontFamily,
      LEGACY_TERMINAL_FONT_FAMILY,
      defaultSafeSettings.terminalFontFamily,
    ),
    terminalFontSize: clampNumber(input.terminalFontSize, 11, 24, defaultSafeSettings.terminalFontSize),
    terminalTheme: normalizeTerminalTheme(input.terminalTheme),
    terminalEncoding: normalizeTextEncoding(input.terminalEncoding, defaultSafeSettings.terminalEncoding),
    terminalScrollback: [5_000, 10_000, 25_000].includes(input.terminalScrollback ?? 0)
      ? input.terminalScrollback!
      : defaultSafeSettings.terminalScrollback,
    pasteProtection: input.pasteProtection !== false,
    connectionTimeoutSeconds: [10, 15, 30, 60].includes(input.connectionTimeoutSeconds ?? 0)
      ? input.connectionTimeoutSeconds!
      : defaultSafeSettings.connectionTimeoutSeconds,
    keepaliveSeconds: [0, 15, 30, 60].includes(input.keepaliveSeconds ?? -1)
      ? input.keepaliveSeconds!
      : defaultSafeSettings.keepaliveSeconds,
    reconnectAttempts: clampNumber(input.reconnectAttempts, 0, 5, defaultSafeSettings.reconnectAttempts),
    monitorIntervalSeconds: [15, 30, 60].includes(input.monitorIntervalSeconds ?? 0)
      ? input.monitorIntervalSeconds!
      : defaultSafeSettings.monitorIntervalSeconds,
    reduceMotion: input.reduceMotion === true,
    inspectorTab: inspectorTabs.includes(input.inspectorTab as typeof inspectorTabs[number])
      ? input.inspectorTab as SafeSettings['inspectorTab']
      : 'files',
    dualPaneSftp: input.dualPaneSftp === true,
    taskTab: taskTabs.includes(input.taskTab as typeof taskTabs[number])
      ? input.taskTab as SafeSettings['taskTab']
      : 'transfers',
    taskDrawerOpen: input.taskDrawerOpen === true,
    connectionsPaneWidth: clampNumber(input.connectionsPaneWidth, 180, 420, defaultSafeSettings.connectionsPaneWidth),
    inspectorPaneWidth: clampNumber(input.inspectorPaneWidth, 220, 760, defaultSafeSettings.inspectorPaneWidth),
    assistantPaneWidth: clampNumber(input.assistantPaneWidth, 300, 520, defaultSafeSettings.assistantPaneWidth),
    taskDrawerHeight: clampNumber(input.taskDrawerHeight, 96, 360, defaultSafeSettings.taskDrawerHeight),
    hostPanelOpen: input.hostPanelOpen === true,
    fileBrowserOpen: input.fileBrowserOpen !== false,
    followTerminalCwd: input.followTerminalCwd !== false,
    focusMode: input.focusMode === true,
    detailsPaneOpen: input.detailsPaneOpen === true,
    hostPanelWidth: clampNumber(input.hostPanelWidth, 200, 420, defaultSafeSettings.hostPanelWidth),
    fileBrowserHeight: clampNumber(input.fileBrowserHeight, 160, 65_535, defaultSafeSettings.fileBrowserHeight),
    fileBrowserPosition: input.fileBrowserPosition === 'right' ? 'right' : 'bottom',
    fileBrowserWidth: clampNumber(input.fileBrowserWidth, 260, 1_200, defaultSafeSettings.fileBrowserWidth),
    textEditorPreference: input.textEditorPreference === 'external' ? 'external' : 'internal',
    externalEditorPath: normalizeExternalEditorPath(input.externalEditorPath),
    uploadConflictPolicy: ['ask', 'overwrite', 'skip', 'rename'].includes(input.uploadConflictPolicy ?? '')
      ? input.uploadConflictPolicy as SafeSettings['uploadConflictPolicy']
      : defaultSafeSettings.uploadConflictPolicy,
    defaultDownloadDirectory: normalizeOptionalLocalPath(input.defaultDownloadDirectory),
    autoOpenDownloadFolder: input.autoOpenDownloadFolder !== false,
    mcpEnabled: input.mcpEnabled === true,
    mcpPort: clampNumber(input.mcpPort, 1024, 65_535, defaultSafeSettings.mcpPort),
    terminalLogging: input.terminalLogging === true,
    compactComposerOpen: input.compactComposerOpen === true,
    backupSchedule: ['off', 'daily', 'weekly'].includes(input.backupSchedule ?? '')
      ? input.backupSchedule as SafeSettings['backupSchedule']
      : defaultSafeSettings.backupSchedule,
    updateChannel: ['stable', 'beta'].includes(input.updateChannel ?? '')
      ? input.updateChannel as SafeSettings['updateChannel']
      : defaultSafeSettings.updateChannel,
    shortcuts: normalizeKeyboardShortcuts(input.shortcuts),
  };
}

function normalizeFontFamily(
  value: string | undefined,
  legacy: string,
  fallback: string,
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === legacy) return fallback;
  return trimmed.slice(0, 160);
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeExternalEditorPath(value: string | null | undefined): string | null {
  return normalizeOptionalLocalPath(value);
}

function normalizeOptionalLocalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return path && path.length <= 4_096 && !path.includes('\0') ? path : null;
}
