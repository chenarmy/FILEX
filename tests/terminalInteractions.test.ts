import { describe, expect, it } from 'vitest';
import {
  ALT_DOUBLE_TAP_WINDOW_MS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  clampTerminalMenuPosition,
  registerAltTap,
  resolveTerminalFontFamily,
} from '@/domain/terminalInteractions';

const plainAlt = { key: 'Alt', repeat: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('terminal interactions', () => {
  it('opens history only for two plain Alt taps inside the bounded interval', () => {
    const first = registerAltTap(null, 100, plainAlt);
    expect(first).toEqual({ lastTapAt: 100, openHistory: false });
    expect(registerAltTap(first.lastTapAt, 100 + ALT_DOUBLE_TAP_WINDOW_MS, plainAlt).openHistory).toBe(true);
    expect(registerAltTap(100, 101, { ...plainAlt, ctrlKey: true })).toEqual({
      lastTapAt: null,
      openHistory: false,
    });
  });

  it('falls back when the effective terminal font is proportional', () => {
    const proportional = (text: string) => text.startsWith('i') ? text.length * 4 : text.length * 9;
    const monospace = (text: string) => text.length * 8;
    expect(resolveTerminalFontFamily('Example Sans', 13, proportional)).toEqual({
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      fellBack: true,
    });
    expect(resolveTerminalFontFamily('Example Mono', 13, monospace)).toEqual({
      fontFamily: 'Example Mono',
      fellBack: false,
    });
  });

  it('keeps the terminal menu inside its surface', () => {
    expect(clampTerminalMenuPosition(
      { x: 490, y: 390 },
      { left: 100, top: 100, width: 400, height: 300 },
      { width: 160, height: 180 },
    )).toEqual({ x: 234, y: 114 });
  });
});
