export const TYPEAHEAD_RESET_MS = 850;

export interface TypeaheadState {
  query: string;
  lastTypedAt: number;
  cycling?: boolean;
}

export interface TypeaheadResult<T> {
  entry: T | null;
  index: number;
  nextState: TypeaheadState;
  displayQuery: string;
  matched: boolean;
}

export function createEmptyTypeaheadState(): TypeaheadState {
  return { query: '', lastTypedAt: 0, cycling: false };
}

export function isApplePlatform(platform = typeof navigator !== 'undefined' ? navigator.platform : ''): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function hasPrimaryShortcutModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  apple = isApplePlatform(),
): boolean {
  const hasPrimary = apple ? event.metaKey : event.ctrlKey;
  const hasForeign = apple ? event.ctrlKey : event.metaKey;
  return hasPrimary && !hasForeign && !event.altKey && !event.shiftKey;
}

export function isFileCopyShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  apple = isApplePlatform(),
): boolean {
  if (!hasPrimaryShortcutModifier(event, apple)) return false;
  return event.key.toLowerCase() === 'c' || event.code === 'KeyC';
}

export function isFilePasteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  apple = isApplePlatform(),
): boolean {
  if (!hasPrimaryShortcutModifier(event, apple)) return false;
  return event.key.toLowerCase() === 'v' || event.code === 'KeyV';
}

export function isTypeaheadTriggerKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>,
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  if (event.key === 'Process' || event.key === 'Dead' || event.key.length !== 1) return false;
  return !/\s/u.test(event.key);
}

function findPrefixMatchIndex<T extends { name: string }>(
  entries: readonly T[],
  prefix: string,
  startIndex: number,
): number {
  const count = entries.length;
  if (count === 0 || !prefix) return -1;
  const normalizedStart = ((startIndex % count) + count) % count;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (normalizedStart + offset) % count;
    if (entries[index]?.name.toLocaleLowerCase().startsWith(prefix)) {
      return index;
    }
  }
  return -1;
}

function isRepeatedCharacter(value: string, ch: string): boolean {
  return value.length > 1 && [...value].every((item) => item === ch);
}

export function resolveTypeaheadMatch<T extends { name: string; path: string }>(
  entries: readonly T[],
  selectedPath: string | null,
  rawKey: string,
  state: TypeaheadState,
  now: number,
  timeoutMs = TYPEAHEAD_RESET_MS,
): TypeaheadResult<T> {
  const ch = rawKey.toLocaleLowerCase();
  if (!ch || entries.length === 0) {
    return {
      entry: null,
      index: -1,
      nextState: createEmptyTypeaheadState(),
      displayQuery: ch,
      matched: false,
    };
  }

  const selectedIndex = selectedPath ? entries.findIndex((entry) => entry.path === selectedPath) : -1;
  const expired = !state.query || now - state.lastTypedAt > timeoutMs;

  if (expired) {
    const selectedStartsWith = selectedIndex >= 0
      && Boolean(entries[selectedIndex]?.name.toLocaleLowerCase().startsWith(ch));
    const startIndex = selectedStartsWith ? (selectedIndex + 1) % entries.length : 0;
    const matchIndex = findPrefixMatchIndex(entries, ch, startIndex);
    if (matchIndex < 0) {
      return {
        entry: null,
        index: -1,
        nextState: createEmptyTypeaheadState(),
        displayQuery: ch,
        matched: false,
      };
    }
    return {
      entry: entries[matchIndex] ?? null,
      index: matchIndex,
      nextState: { query: ch, lastTypedAt: now, cycling: false },
      displayQuery: ch,
      matched: true,
    };
  }

  if (state.cycling && state.query === ch) {
    const cycleStart = selectedIndex >= 0 ? (selectedIndex + 1) % entries.length : 0;
    const cycleMatch = findPrefixMatchIndex(entries, ch, cycleStart);
    if (cycleMatch >= 0) {
      return {
        entry: entries[cycleMatch] ?? null,
        index: cycleMatch,
        nextState: { query: ch, lastTypedAt: now, cycling: true },
        displayQuery: ch,
        matched: true,
      };
    }
  }

  const nextQuery = state.query + ch;
  const searchFrom = selectedIndex >= 0 ? selectedIndex : 0;
  const directMatch = findPrefixMatchIndex(entries, nextQuery, searchFrom);
  if (directMatch >= 0 && !(isRepeatedCharacter(nextQuery, ch) && directMatch === selectedIndex)) {
    return {
      entry: entries[directMatch] ?? null,
      index: directMatch,
      nextState: { query: nextQuery, lastTypedAt: now, cycling: false },
      displayQuery: nextQuery,
      matched: true,
    };
  }

  if (isRepeatedCharacter(nextQuery, ch)) {
    const cycleStart = selectedIndex >= 0 ? (selectedIndex + 1) % entries.length : 0;
    const cycleMatch = findPrefixMatchIndex(entries, ch, cycleStart);
    if (cycleMatch >= 0) {
      return {
        entry: entries[cycleMatch] ?? null,
        index: cycleMatch,
        nextState: { query: ch, lastTypedAt: now, cycling: true },
        displayQuery: ch,
        matched: true,
      };
    }
  }

  return {
    entry: null,
    index: -1,
    nextState: createEmptyTypeaheadState(),
    displayQuery: nextQuery,
    matched: false,
  };
}

export function resolveArrowSelectionIndex(
  itemCount: number,
  currentIndex: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number | null {
  if (itemCount <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (currentIndex < 0) return key === 'ArrowDown' ? 0 : itemCount - 1;
  return key === 'ArrowDown'
    ? Math.min(itemCount - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1);
}
