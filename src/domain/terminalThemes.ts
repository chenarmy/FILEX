import type { TerminalThemePreference, ThemePreference } from '@/types/contracts';

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalThemeDefinition {
  id: TerminalThemePreference;
  name: string;
  appearance: 'adaptive' | 'dark' | 'light';
  palette: TerminalPalette;
}

export const terminalThemes: readonly TerminalThemeDefinition[] = [
  {
    id: 'match',
    name: 'FILEX Adaptive',
    appearance: 'adaptive',
    palette: {
      background: '#0b0f14',
      foreground: '#d8e1ec',
      cursor: '#62a8ff',
      cursorAccent: '#0b0f14',
      selectionBackground: '#274c77aa',
      selectionForeground: '#f8fbff',
      black: '#111820',
      red: '#f07178',
      green: '#7bd88f',
      yellow: '#e5c07b',
      blue: '#67a9ff',
      magenta: '#c792ea',
      cyan: '#56d4c2',
      white: '#cbd5e1',
      brightBlack: '#5c6773',
      brightRed: '#ff8b92',
      brightGreen: '#98e5a7',
      brightYellow: '#f3d298',
      brightBlue: '#8bc1ff',
      brightMagenta: '#d9a9ff',
      brightCyan: '#7ee8d8',
      brightWhite: '#f8fafc',
    },
  },
  {
    id: 'filex-dark',
    name: 'FILEX Dark',
    appearance: 'dark',
    palette: {
      background: '#0b0f14',
      foreground: '#d8e1ec',
      cursor: '#62a8ff',
      cursorAccent: '#0b0f14',
      selectionBackground: '#274c77aa',
      selectionForeground: '#f8fbff',
      black: '#111820',
      red: '#f07178',
      green: '#7bd88f',
      yellow: '#e5c07b',
      blue: '#67a9ff',
      magenta: '#c792ea',
      cyan: '#56d4c2',
      white: '#cbd5e1',
      brightBlack: '#5c6773',
      brightRed: '#ff8b92',
      brightGreen: '#98e5a7',
      brightYellow: '#f3d298',
      brightBlue: '#8bc1ff',
      brightMagenta: '#d9a9ff',
      brightCyan: '#7ee8d8',
      brightWhite: '#f8fafc',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    appearance: 'dark',
    palette: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#56b6c2',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451cc',
      selectionForeground: '#ffffff',
      black: '#1e2127',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    palette: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475acc',
      selectionForeground: '#ffffff',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    palette: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5ecc',
      selectionForeground: '#eceff4',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    palette: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#283457cc',
      selectionForeground: '#ffffff',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    appearance: 'dark',
    palette: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#fabd2f',
      cursorAccent: '#282828',
      selectionBackground: '#504945cc',
      selectionForeground: '#fbf1c7',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    appearance: 'dark',
    palette: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#b58900',
      cursorAccent: '#002b36',
      selectionBackground: '#073642cc',
      selectionForeground: '#fdf6e3',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    appearance: 'dark',
    palette: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: '#49483ecc',
      selectionForeground: '#ffffff',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    appearance: 'dark',
    palette: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78cc',
      selectionForeground: '#ffffff',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'filex-light',
    name: 'FILEX Light',
    appearance: 'light',
    palette: {
      background: '#fbfcfe',
      foreground: '#243044',
      cursor: '#2563eb',
      cursorAccent: '#fbfcfe',
      selectionBackground: '#bfdbfe99',
      selectionForeground: '#102a56',
      black: '#1f2937',
      red: '#c2414f',
      green: '#22824f',
      yellow: '#9a6700',
      blue: '#1d4ed8',
      magenta: '#8b3fb3',
      cyan: '#087b78',
      white: '#d8dee8',
      brightBlack: '#394456',
      brightRed: '#dc5b66',
      brightGreen: '#2f9e62',
      brightYellow: '#b77900',
      brightBlue: '#2f64e8',
      brightMagenta: '#a855c9',
      brightCyan: '#0e9d99',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    appearance: 'light',
    palette: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#2aa198',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5cc',
      selectionForeground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    appearance: 'light',
    palette: {
      background: '#ffffff',
      foreground: '#24292f',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      selectionBackground: '#add6ffcc',
      selectionForeground: '#0a3069',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#4d2d00',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#6e7781',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#8c959f',
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'light',
    palette: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#ccd0dacc',
      selectionForeground: '#4c4f69',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc',
    },
  },
];

const terminalThemeIds = new Set<TerminalThemePreference>(terminalThemes.map((theme) => theme.id));
const terminalThemeById = new Map(terminalThemes.map((theme) => [theme.id, theme]));
const legacyTerminalThemes: Readonly<Record<string, TerminalThemePreference>> = {
  dark: 'filex-dark',
  light: 'filex-light',
};

export function normalizeTerminalTheme(value: unknown): TerminalThemePreference {
  if (typeof value !== 'string') return 'match';
  const legacy = legacyTerminalThemes[value as TerminalThemePreference];
  if (legacy) return legacy;
  return terminalThemeIds.has(value as TerminalThemePreference)
    ? value as TerminalThemePreference
    : 'match';
}

export function resolveTerminalPalette(
  preference: TerminalThemePreference,
  applicationTheme: ThemePreference,
  systemAppearance: 'dark' | 'light',
): TerminalPalette {
  const normalized = normalizeTerminalTheme(preference);
  if (normalized === 'match') {
    const appearance = resolveTerminalThemeAppearance(preference, applicationTheme, systemAppearance);
    return terminalThemeById.get(appearance === 'light' ? 'filex-light' : 'filex-dark')!.palette;
  }
  return (terminalThemeById.get(normalized) ?? terminalThemeById.get('filex-dark')!).palette;
}

export function resolveTerminalThemeAppearance(
  preference: TerminalThemePreference,
  applicationTheme: ThemePreference,
  systemAppearance: 'dark' | 'light',
): 'dark' | 'light' {
  const normalized = normalizeTerminalTheme(preference);
  if (normalized === 'match') {
    return applicationTheme === 'system' ? systemAppearance : applicationTheme;
  }
  return terminalThemeById.get(normalized)?.appearance === 'light' ? 'light' : 'dark';
}
