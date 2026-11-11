import { normalizeUpdateVersion } from '@/domain/updatePolicy';

const UPDATE_PREFERENCES_KEY = 'filex.update-preferences.v1';

export interface UpdatePreferences {
  lastCheckAt: number | null;
  skippedVersion: string | null;
}

export const defaultUpdatePreferences: UpdatePreferences = {
  lastCheckAt: null,
  skippedVersion: null,
};

export function normalizeUpdatePreferences(input: unknown): UpdatePreferences {
  if (!input || typeof input !== 'object') return { ...defaultUpdatePreferences };
  const candidate = input as Record<string, unknown>;
  const lastCheckAt = typeof candidate.lastCheckAt === 'number'
    && Number.isFinite(candidate.lastCheckAt)
    && candidate.lastCheckAt > 0
    ? Math.floor(candidate.lastCheckAt)
    : null;
  return {
    lastCheckAt,
    skippedVersion: normalizeUpdateVersion(candidate.skippedVersion),
  };
}

export function readUpdatePreferences(): UpdatePreferences {
  try {
    const raw = localStorage.getItem(UPDATE_PREFERENCES_KEY);
    return raw ? normalizeUpdatePreferences(JSON.parse(raw) as unknown) : { ...defaultUpdatePreferences };
  } catch {
    return { ...defaultUpdatePreferences };
  }
}

export function writeUpdatePreferences(value: UpdatePreferences): void {
  try {
    localStorage.setItem(UPDATE_PREFERENCES_KEY, JSON.stringify(normalizeUpdatePreferences(value)));
  } catch {
    // Update scheduling still works in-memory when local storage is unavailable.
  }
}
