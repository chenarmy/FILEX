/**
 * Bounded LRU cache holding per-session store snapshots so switching active
 * sessions restores prior UI/domain state without redundant remote refreshes.
 */
export interface SessionStateCache<T> {
  has(sessionId: string): boolean;
  get(sessionId: string): T | undefined;
  set(sessionId: string, state: T): void;
  delete(sessionId: string): boolean;
  clear(): void;
}

const DEFAULT_MAX_CACHED_SESSIONS = 32;

export function createSessionStateCache<T>(
  maxEntries = DEFAULT_MAX_CACHED_SESSIONS,
): SessionStateCache<T> {
  const entries = new Map<string, T>();

  return {
    has(sessionId: string): boolean {
      return entries.has(sessionId);
    },
    get(sessionId: string): T | undefined {
      const value = entries.get(sessionId);
      if (value === undefined) return undefined;
      entries.delete(sessionId);
      entries.set(sessionId, value);
      return value;
    },
    set(sessionId: string, state: T): void {
      if (entries.has(sessionId)) entries.delete(sessionId);
      entries.set(sessionId, state);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    delete(sessionId: string): boolean {
      return entries.delete(sessionId);
    },
    clear(): void {
      entries.clear();
    },
  };
}
