import type { SafeSettings } from '@/types/contracts';

const storageKey = 'filex.safe-settings.v1';

export const defaultSafeSettings: SafeSettings = {
  theme: 'system',
  locale: 'zh-CN',
  uiFontFamily: 'Inter, system-ui, sans-serif',
  uiFontSize: 12,
  terminalFontFamily: 'JetBrains Mono, Consolas, monospace',
  terminalFontSize: 13,
  reduceMotion: false,
  inspectorTab: 'files',
  taskTab: 'transfers',
  taskDrawerOpen: true,
};

export function readSafeSettings(): SafeSettings {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { ...defaultSafeSettings };

  try {
    const parsed = JSON.parse(raw) as Partial<SafeSettings>;
    return normalizeSettings(parsed);
  } catch {
    localStorage.removeItem(storageKey);
    return { ...defaultSafeSettings };
  }
}

export function writeSafeSettings(settings: SafeSettings): void {
  localStorage.setItem(storageKey, JSON.stringify(normalizeSettings(settings)));
}

function normalizeSettings(input: Partial<SafeSettings>): SafeSettings {
  const themes = ['system', 'dark', 'light'] as const;
  const locales = ['zh-CN', 'en-US'] as const;
  const inspectorTabs = ['files', 'monitor', 'session'] as const;
  const taskTabs = ['transfers', 'tunnels', 'events'] as const;

  return {
    theme: themes.includes(input.theme as typeof themes[number]) ? input.theme as SafeSettings['theme'] : 'system',
    locale: locales.includes(input.locale as typeof locales[number]) ? input.locale as SafeSettings['locale'] : 'zh-CN',
    uiFontFamily: input.uiFontFamily?.slice(0, 160) || defaultSafeSettings.uiFontFamily,
    uiFontSize: clampNumber(input.uiFontSize, 11, 20, defaultSafeSettings.uiFontSize),
    terminalFontFamily: input.terminalFontFamily?.slice(0, 160) || defaultSafeSettings.terminalFontFamily,
    terminalFontSize: clampNumber(input.terminalFontSize, 11, 24, defaultSafeSettings.terminalFontSize),
    reduceMotion: input.reduceMotion === true,
    inspectorTab: inspectorTabs.includes(input.inspectorTab as typeof inspectorTabs[number])
      ? input.inspectorTab as SafeSettings['inspectorTab']
      : 'files',
    taskTab: taskTabs.includes(input.taskTab as typeof taskTabs[number])
      ? input.taskTab as SafeSettings['taskTab']
      : 'transfers',
    taskDrawerOpen: input.taskDrawerOpen !== false,
  };
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
