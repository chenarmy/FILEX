import type { KeyboardShortcuts } from '@/types/contracts';

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  quickConnect: 'mod+k',
  newSession: 'mod+n',
  closeActiveTab: 'mod+w',
  nextSession: 'mod+tab',
  previousSession: 'mod+shift+tab',
  terminalSearch: 'mod+f',
  toggleFiles: 'mod+shift+f',
  toggleTaskDrawer: 'mod+j',
  commandPalette: 'mod+shift+p',
  toggleAssistant: 'mod+shift+a',
  focusConnections: 'mod+1',
  focusTerminal: 'mod+2',
  focusInspector: 'mod+3',
  openSettings: 'mod+comma',
  showEvents: 'mod+shift+e',
};

export type KeyboardShortcutAction = keyof KeyboardShortcuts;
export type KeyboardShortcutValidationError = 'invalid' | 'reserved' | 'conflict';

const RESERVED_SHORTCUTS = new Set([
  'mod+a',
  'mod+c',
  'mod+v',
  'mod+x',
  'mod+z',
  'mod+q',
  'mod+r',
  'mod+shift+c',
  'mod+shift+q',
  'mod+shift+v',
]);

const NAMED_KEYS = new Set([
  'comma',
  'period',
  'slash',
  'backslash',
  'space',
  'tab',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageup',
  'pagedown',
]);

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  '\\': 'backslash',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  PageDown: 'pagedown',
  PageUp: 'pageup',
};

const CODE_ALIASES: Record<string, string> = {
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Backslash: 'backslash',
  Space: 'space',
  Tab: 'tab',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  PageDown: 'pagedown',
  PageUp: 'pageup',
};

export function isValidKeyboardShortcut(binding: string): boolean {
  if (!binding || binding.length > 32 || !/^[a-z0-9+]+$/.test(binding)) return false;
  const parts = binding.split('+');
  if (parts.length < 2 || parts.length > 4 || parts[0] !== 'mod') return false;

  let previousModifierRank = 0;
  for (const modifier of parts.slice(1, -1)) {
    const rank = modifier === 'alt' ? 1 : modifier === 'shift' ? 2 : 0;
    if (rank <= previousModifierRank) return false;
    previousModifierRank = rank;
  }

  const key = parts.at(-1) ?? '';
  if (!isSupportedShortcutKey(key)) return false;
  return !RESERVED_SHORTCUTS.has(binding);
}

export function getKeyboardShortcutValidationError(
  binding: string,
  shortcuts: KeyboardShortcuts,
  action: KeyboardShortcutAction,
): KeyboardShortcutValidationError | null {
  if (!isValidKeyboardShortcut(binding)) {
    return RESERVED_SHORTCUTS.has(binding) ? 'reserved' : 'invalid';
  }
  if (Object.entries(shortcuts).some(([candidateAction, candidateBinding]) => (
    candidateAction !== action && candidateBinding === binding
  ))) return 'conflict';
  return null;
}

export function normalizeKeyboardShortcuts(input?: Partial<KeyboardShortcuts> | null): KeyboardShortcuts {
  const candidate = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...input };
  const bindings = Object.values(candidate);
  if (bindings.some((binding) => !isValidKeyboardShortcut(binding)) || new Set(bindings).size !== bindings.length) {
    return { ...DEFAULT_KEYBOARD_SHORTCUTS };
  }
  return candidate;
}

export function keyboardShortcutCandidateFromEvent(event: KeyboardEvent): string | null {
  const applePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const hasPrimaryModifier = applePlatform ? event.metaKey : event.ctrlKey;
  const hasForeignPrimaryModifier = applePlatform ? event.ctrlKey : event.metaKey;
  if (!hasPrimaryModifier || hasForeignPrimaryModifier || event.getModifierState('AltGraph')) return null;

  const key = keyFromKeyboardEvent(event);
  if (!/^[a-z0-9]+$/.test(key) && !NAMED_KEYS.has(key) && !/^f(?:[1-9]|1[0-2])$/.test(key)) return null;
  const parts = ['mod'];
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const candidate = keyboardShortcutCandidateFromEvent(event);
  return candidate && isValidKeyboardShortcut(candidate) ? candidate : null;
}

export function matchesKeyboardShortcut(event: KeyboardEvent, binding: string): boolean {
  return shortcutFromKeyboardEvent(event) === binding;
}

export function formatKeyboardShortcut(binding: string): string {
  const applePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const labels: Record<string, string> = {
    mod: applePlatform ? '⌘' : 'Ctrl',
    alt: applePlatform ? '⌥' : 'Alt',
    shift: applePlatform ? '⇧' : 'Shift',
    comma: ',',
    period: '.',
    slash: '/',
    backslash: '\\',
    space: 'Space',
    tab: 'Tab',
    left: '←',
    right: '→',
    up: '↑',
    down: '↓',
    home: 'Home',
    end: 'End',
    pageup: 'Page Up',
    pagedown: 'Page Down',
  };
  return binding.split('+').map((part) => labels[part] ?? part.toUpperCase()).join(' + ');
}

function isSupportedShortcutKey(key: string): boolean {
  return /^[a-z0-9]$/.test(key)
    || NAMED_KEYS.has(key)
    || /^f(?:[1-9]|1[0-2])$/.test(key);
}

function keyFromKeyboardEvent(event: KeyboardEvent): string {
  const keyAlias = KEY_ALIASES[event.key];
  if (keyAlias) return keyAlias;
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toLowerCase();
  const codeAlias = CODE_ALIASES[event.code];
  if (codeAlias) return codeAlias;
  const letterCode = /^Key([A-Z])$/.exec(event.code);
  if (letterCode?.[1]) return letterCode[1].toLowerCase();
  const digitCode = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  if (digitCode?.[1]) return digitCode[1];
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code.toLowerCase();
  return event.key.toLowerCase();
}
