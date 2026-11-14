import { describe, expect, it } from 'vitest';
import type { IBufferLine, Terminal } from '@xterm/xterm';
import { getTerminalLogColorPalette, TerminalLogColorizer } from '@/domain/terminalLogColorizer';
import { resolveTerminalPalette } from '@/domain/terminalThemes';

interface MockBufferLine {
  length: number;
  _data: Uint32Array;
  translateToString: () => string;
  getCell: (column: number, target: Record<string, unknown>) => Record<string, unknown>;
}

function createMockLine(text: string, initialForegrounds: number[] = []): MockBufferLine {
  const length = text.length;
  const _data = new Uint32Array(length * 3);
  for (let i = 0; i < length; i += 1) {
    _data[i * 3] = text.charCodeAt(i);
    _data[i * 3 + 1] = initialForegrounds[i] ?? 0;
  }
  return {
    length,
    _data,
    translateToString: () => text,
    getCell(column: number, target: Record<string, unknown>) {
      target.getWidth = () => 1;
      target.getChars = () => String.fromCharCode(_data[column * 3] ?? 32);
      return target;
    },
  };
}

function createMockTerminal(lines: MockBufferLine[], bufferType: 'normal' | 'alternate' = 'normal') {
  const cell = {};
  let refreshes = 0;
  const buffer = {
    type: bufferType,
    baseY: 0,
    cursorY: 0,
    viewportY: 0,
    length: lines.length,
    getNullCell: () => cell,
    getLine: (index: number) => lines[index] as unknown as IBufferLine,
  };
  const terminal = {
    rows: lines.length || 1,
    cols: 120,
    buffer: {
      normal: buffer,
      active: buffer,
    },
    write: (_data: string, callback?: () => void) => callback?.(),
    reset: () => undefined,
    clear: () => undefined,
    resize: () => undefined,
    refresh: () => {
      refreshes += 1;
    },
    registerMarker: () => ({ line: 0, isDisposed: false, dispose: () => undefined }),
  };
  return {
    terminal: terminal as unknown as Terminal,
    getRefreshes: () => refreshes,
  };
}

describe('TerminalLogColorizer', () => {
  it('applies semantic colors to SSH login banners without false positives on hostnames or tags', () => {
    const loginText = 'Last login: Sat Nov 14 19:19:42 2026 from 27.8.49.120';
    const dockerText = 'ea23eaf54d65   keking/kkfileview:v4.1.0   Up 2 days';
    const promptText = '[root@iZ2zeiwvlu7t0gzfwkugs0Z ~]# docker ps';
    const lines = [
      createMockLine(loginText),
      createMockLine(dockerText),
      createMockLine(promptText),
    ];
    const { terminal, getRefreshes } = createMockTerminal(lines);
    const theme = resolveTerminalPalette('filex-light', 'light', 'light');
    const palette = getTerminalLogColorPalette(theme);
    const colorizer = new TerminalLogColorizer(terminal, palette);

    (terminal.buffer.active as unknown as { cursorY: number }).cursorY = 2;
    terminal.write(loginText);

    const loginData = lines[0]!._data;
    const loginStart = loginText.indexOf('login');
    const tsStart = loginText.indexOf('Nov 14 19:19:42');
    const yearStart = loginText.indexOf('2026');
    const ipStart = loginText.indexOf('27.8.49.120');

    expect(loginData[loginStart * 3 + 1]! & 0x03000000).toBe(0x03000000);
    expect(loginData[tsStart * 3 + 1]! & 0x03000000).toBe(0x03000000);
    expect(loginData[yearStart * 3 + 1]! & 0x03000000).toBe(0x03000000);
    expect(loginData[ipStart * 3 + 1]! & 0x03000000).toBe(0x03000000);
    expect(getRefreshes()).toBe(1);

    // Image tag `v4.1.0` and hostname `iZ2...0Z` must stay default foreground.
    const v4Start = dockerText.indexOf('v4.1.0');
    expect(lines[1]!._data[v4Start * 3 + 1]).toBe(0);
    const hostStart = promptText.indexOf('iZ2zeiwvlu7t0gzfwkugs0Z');
    for (let i = 0; i < 'iZ2zeiwvlu7t0gzfwkugs0Z'.length; i += 1) {
      expect(lines[2]!._data[(hostStart + i) * 3 + 1]).toBe(0);
    }

    colorizer.dispose();
    expect(loginData[ipStart * 3 + 1]).toBe(0);
  });

  it('preserves explicit ANSI foreground colors and ignores the alternate buffer', () => {
    const ansiColorWord = 0x01000002; // palette green (CM_P16 + color 2)
    const errorText = 'error ok';
    const ansiForegrounds = Array.from({ length: errorText.length }, (_, index) => (index < 5 ? ansiColorWord : 0));
    const line = createMockLine(errorText, ansiForegrounds);
    const { terminal } = createMockTerminal([line]);
    const palette = getTerminalLogColorPalette(resolveTerminalPalette('filex-dark', 'dark', 'dark'));
    const colorizer = new TerminalLogColorizer(terminal, palette);

    terminal.write(errorText);
    // `error` keeps explicit ANSI foreground; plain `ok` receives semantic color.
    expect(line._data[1]).toBe(ansiColorWord);
    expect(line._data[6 * 3 + 1]! & 0x03000000).toBe(0x03000000);

    const altLine = createMockLine('error 2026');
    const alt = createMockTerminal([altLine], 'alternate');
    const altColorizer = new TerminalLogColorizer(alt.terminal, palette);
    alt.terminal.write('error 2026');
    expect(altLine._data[1]).toBe(0);
    expect(alt.getRefreshes()).toBe(0);

    altColorizer.dispose();
    colorizer.dispose();
  });
});
