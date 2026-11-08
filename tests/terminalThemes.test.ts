import { describe, expect, it } from 'vitest';
import {
  normalizeTerminalTheme,
  resolveTerminalPalette,
  terminalThemes,
} from '@/domain/terminalThemes';

describe('terminal theme catalog', () => {
  it('exposes unique, fully specified color palettes', () => {
    expect(new Set(terminalThemes.map((theme) => theme.id)).size).toBe(terminalThemes.length);
    expect(terminalThemes.length).toBeGreaterThan(10);

    for (const theme of terminalThemes) {
      const colors = Object.values(theme.palette);
      expect(colors.length).toBe(22);
      for (const color of colors) {
        expect(color).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
      }
    }
  });

  it('normalizes legacy and unsupported theme identifiers', () => {
    expect(normalizeTerminalTheme('dark')).toBe('filex-dark');
    expect(normalizeTerminalTheme('light')).toBe('filex-light');
    expect(normalizeTerminalTheme('dracula')).toBe('dracula');
    expect(normalizeTerminalTheme('not-a-theme')).toBe('match');
    expect(normalizeTerminalTheme(null)).toBe('match');
  });

  it('resolves adaptive palettes from the current application appearance', () => {
    const dark = resolveTerminalPalette('match', 'system', 'dark');
    const light = resolveTerminalPalette('match', 'system', 'light');
    const explicitLight = resolveTerminalPalette('filex-light', 'dark', 'dark');
    const nord = terminalThemes.find((theme) => theme.id === 'nord')?.palette;

    expect(dark.background).toBe('#0b0f14');
    expect(light.background).toBe('#fbfcfe');
    expect(explicitLight.background).toBe('#fbfcfe');
    expect(resolveTerminalPalette('nord', 'light', 'light')).toEqual(nord);
  });
});
