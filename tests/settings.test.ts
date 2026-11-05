import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSafeSettings, readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';

describe('safe settings repository', () => {
  beforeEach(() => localStorage.clear());

  it('returns safe defaults when storage is empty', () => {
    expect(readSafeSettings()).toEqual(defaultSafeSettings);
  });

  it('clamps visual settings and ignores unsupported values', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      theme: 'unknown',
      locale: 'unknown',
      uiFontSize: 99,
      terminalFontSize: 2,
    }));

    expect(readSafeSettings()).toMatchObject({
      theme: 'system',
      locale: 'zh-CN',
      uiFontSize: 20,
      terminalFontSize: 11,
    });
  });

  it('clamps the workspace layout settings added with the fileterm-style shell', () => {
    localStorage.setItem('filex.safe-settings.v1', JSON.stringify({
      hostPanelWidth: 9_999,
      fileBrowserHeight: 1,
      focusMode: true,
      followTerminalCwd: 'yes',
      detailsPaneOpen: 1,
    }));

    expect(readSafeSettings()).toMatchObject({
      hostPanelWidth: 420,
      fileBrowserHeight: 160,
      focusMode: true,
      followTerminalCwd: false,
      detailsPaneOpen: false,
      hostPanelOpen: true,
      fileBrowserOpen: true,
    });
  });

  it('persists only the safe settings structure', () => {
    writeSafeSettings({ ...defaultSafeSettings, theme: 'light', uiFontSize: 15 });
    expect(readSafeSettings()).toMatchObject({ theme: 'light', uiFontSize: 15 });
  });
});
