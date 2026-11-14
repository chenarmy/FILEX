import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSafeSettings, defaultUiFontFamily, readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';

describe('safe settings repository', () => {
  beforeEach(() => localStorage.clear());

  it('returns safe defaults when storage is empty', () => {
    expect(readSafeSettings()).toEqual(defaultSafeSettings);
    expect(defaultSafeSettings.uiFontSize).toBe(14);
    expect(defaultSafeSettings.uiFontFamily).toBe(defaultUiFontFamily);
    expect(defaultSafeSettings.uiFontFamily).toContain('HarmonyOS Sans SC');
    expect(defaultSafeSettings.assistantPaneWidth).toBe(360);
    expect(defaultSafeSettings.followTerminalCwd).toBe(true);
  });

  it('migrates the legacy default font without overriding custom families', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      uiFontFamily: 'Inter, system-ui, sans-serif',
    }));
    expect(readSafeSettings().uiFontFamily).toBe(defaultUiFontFamily);

    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      uiFontFamily: 'Example Sans, sans-serif',
    }));
    expect(readSafeSettings().uiFontFamily).toBe('Example Sans, sans-serif');
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
      assistantPaneWidth: 9,
      focusMode: true,
      followTerminalCwd: 'yes',
      detailsPaneOpen: 1,
    }));

    expect(readSafeSettings()).toMatchObject({
      hostPanelWidth: 420,
      fileBrowserHeight: 160,
      assistantPaneWidth: 300,
      focusMode: true,
      followTerminalCwd: true,
      detailsPaneOpen: false,
      hostPanelOpen: false,
      fileBrowserOpen: true,
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
});
