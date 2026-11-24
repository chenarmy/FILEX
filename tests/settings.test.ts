import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_TEXT_ENCODINGS } from '@/domain/encodings';
import { saveSafeSettings } from '@/api/domain/settingsApi';
import {
  defaultSafeSettings,
  defaultUiFontFamily,
  normalizeSafeSettings,
  readSafeSettings,
  writeSafeSettings,
} from '@/runtime/safeSettingsRepository';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('safe settings repository', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('returns safe defaults when storage is empty', () => {
    expect(readSafeSettings()).toEqual(defaultSafeSettings);
    expect(defaultSafeSettings.uiFontSize).toBe(14);
    expect(defaultSafeSettings.uiFontFamily).toBe(defaultUiFontFamily);
    expect(defaultSafeSettings.uiFontFamily).toContain('HarmonyOS Sans SC');
    expect(defaultSafeSettings.assistantPaneWidth).toBe(360);
    expect(defaultSafeSettings.followTerminalCwd).toBe(true);
    expect(defaultSafeSettings.fileBrowserPosition).toBe('bottom');
    expect(defaultSafeSettings.fileBrowserWidth).toBe(420);
  });

  it('migrates the legacy default font without overriding custom families', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      uiFontFamily: 'Inter, system-ui, sans-serif',
    }));
    expect(readSafeSettings().uiFontFamily).toBe(defaultUiFontFamily);

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      uiFontFamily: 'Example Sans, sans-serif',
      terminalFontFamily: 'JetBrains Mono, Consolas, monospace',
    }));
    expect(readSafeSettings().uiFontFamily).toBe('Example Sans, sans-serif');
    expect(readSafeSettings().terminalFontFamily).toBe(defaultSafeSettings.terminalFontFamily);
  });

  it('clamps visual settings and ignores unsupported values', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      theme: 'unknown',
      locale: 'unknown',
      uiFontSize: 99,
      terminalFontSize: 2,
      terminalTheme: 'unknown',
    }));

    expect(readSafeSettings()).toMatchObject({
      theme: 'system',
      locale: 'zh-CN',
      uiFontSize: 20,
      terminalFontSize: 11,
      terminalTheme: 'match',
    });
  });

  it('migrates legacy terminal themes and preserves catalog selections', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      terminalTheme: 'dark',
    }));
    expect(readSafeSettings().terminalTheme).toBe('filex-dark');

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      terminalTheme: 'catppuccin-latte',
    }));
    expect(readSafeSettings().terminalTheme).toBe('catppuccin-latte');
  });

  it('clamps the workspace layout settings added with the fileterm-style shell', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      hostPanelWidth: 9_999,
      fileBrowserHeight: 1,
      fileBrowserPosition: 'invalid',
      fileBrowserWidth: 50,
      assistantPaneWidth: 9,
      focusMode: true,
      followTerminalCwd: 'yes',
      detailsPaneOpen: 1,
    }));

    expect(readSafeSettings()).toMatchObject({
      hostPanelWidth: 420,
      fileBrowserHeight: 160,
      fileBrowserPosition: 'bottom',
      fileBrowserWidth: 260,
      assistantPaneWidth: 300,
      focusMode: true,
      followTerminalCwd: true,
      detailsPaneOpen: false,
      hostPanelOpen: false,
      fileBrowserOpen: true,
    });

    writeSafeSettings({
      ...defaultSafeSettings,
      fileBrowserPosition: 'right',
      fileBrowserWidth: 540,
    });
    expect(readSafeSettings()).toMatchObject({
      fileBrowserPosition: 'right',
      fileBrowserWidth: 540,
    });
  });

  it('defaults hostPanelOpen to false while honoring an explicit true setting', () => {
    expect(defaultSafeSettings.hostPanelOpen).toBe(false);
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      hostPanelOpen: true,
    }));
    expect(readSafeSettings().hostPanelOpen).toBe(true);
  });

  it('defaults missing follow-terminal settings on while preserving an explicit opt-out', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      theme: 'dark',
    }));
    expect(readSafeSettings().followTerminalCwd).toBe(true);

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      followTerminalCwd: false,
    }));
    expect(readSafeSettings().followTerminalCwd).toBe(false);
  });

  it('persists only the safe settings structure', () => {
    writeSafeSettings({
      ...defaultSafeSettings,
      theme: 'light',
      uiFontSize: 15,
      terminalTheme: 'nord',
    });
    expect(readSafeSettings()).toMatchObject({
      theme: 'light',
      uiFontSize: 15,
      terminalTheme: 'nord',
    });
  });

  it('preserves tall file browsers and sanitizes external editor settings', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      fileBrowserHeight: 720,
      textEditorPreference: 'external',
      externalEditorPath: '  C:\\Tools\\editor.exe  ',
    }));
    expect(readSafeSettings()).toMatchObject({
      fileBrowserHeight: 720,
      textEditorPreference: 'external',
      externalEditorPath: 'C:\\Tools\\editor.exe',
    });

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      textEditorPreference: 'unsupported',
      externalEditorPath: `bad\u0000path`,
    }));
    expect(readSafeSettings()).toMatchObject({
      textEditorPreference: 'internal',
      externalEditorPath: null,
    });
  });

  it('supports all ten terminal and file text encodings cleanly in settings and TextDecoder', () => {
    expect(SUPPORTED_TEXT_ENCODINGS).toHaveLength(10);
    for (const item of SUPPORTED_TEXT_ENCODINGS) {
      writeSafeSettings({ ...defaultSafeSettings, terminalEncoding: item.value });
      expect(readSafeSettings().terminalEncoding).toBe(item.value);
      expect(() => new TextDecoder(item.value)).not.toThrow();
    }
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      terminalEncoding: 'iso-8859-99',
    }));
    expect(readSafeSettings().terminalEncoding).toBe('utf-8');
  });

  it('normalizes fractional high-DPI pane sizes and whitespace font families before saving to Tauri', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation((_command: string, payload: { input: typeof defaultSafeSettings }) => Promise.resolve({
      ok: true,
      requestId: 'req-settings-1',
      data: payload.input,
    }));

    const result = await saveSafeSettings({
      ...defaultSafeSettings,
      terminalTheme: 'github-dark',
      terminalFontSize: 16,
      terminalFontFamily: '   ',
      connectionsPaneWidth: 244.4,
      inspectorPaneWidth: 286.6,
      assistantPaneWidth: 412.6666564941406,
      taskDrawerHeight: 180.25,
      hostPanelWidth: 260.8,
      fileBrowserHeight: 240.75,
      fileBrowserPosition: 'right',
      fileBrowserWidth: 488.6,
    });

    expect(result.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('save_safe_settings', {
      input: expect.objectContaining({
        terminalTheme: 'github-dark',
        terminalFontSize: 16,
        terminalFontFamily: defaultSafeSettings.terminalFontFamily,
        connectionsPaneWidth: 244,
        inspectorPaneWidth: 287,
        assistantPaneWidth: 413,
        taskDrawerHeight: 180,
        hostPanelWidth: 261,
        fileBrowserHeight: 241,
        fileBrowserPosition: 'right',
        fileBrowserWidth: 489,
      }),
    });
    expect(normalizeSafeSettings({ uiFontFamily: '   ' }).uiFontFamily).toBe(defaultUiFontFamily);
  });

  it('defaults upload conflict to overwrite, auto-open downloads, and clamps MCP settings', () => {
    expect(defaultSafeSettings.uploadConflictPolicy).toBe('overwrite');
    expect(defaultSafeSettings.defaultDownloadDirectory).toBeNull();
    expect(defaultSafeSettings.autoOpenDownloadFolder).toBe(true);
    expect(defaultSafeSettings.mcpEnabled).toBe(false);
    expect(defaultSafeSettings.mcpPort).toBe(19_375);

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      uploadConflictPolicy: 'rename',
      defaultDownloadDirectory: '  C:\\Users\\dev\\Downloads  ',
      autoOpenDownloadFolder: false,
      mcpEnabled: true,
      mcpPort: 80,
    }));
    expect(readSafeSettings()).toMatchObject({
      uploadConflictPolicy: 'rename',
      defaultDownloadDirectory: 'C:\\Users\\dev\\Downloads',
      autoOpenDownloadFolder: false,
      mcpEnabled: true,
      mcpPort: 1024,
    });
  });
});
