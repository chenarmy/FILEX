export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
export const INITIAL_UPDATE_CHECK_DELAY_MS = 3_500;

const UPDATE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function normalizeUpdateVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^v/i, '');
  return UPDATE_VERSION.test(normalized) ? normalized : null;
}

export function shouldOfferUpdate(
  currentVersion: string,
  availableVersion: string | null | undefined,
  skippedVersion: string | null | undefined,
): boolean {
  const current = normalizeUpdateVersion(currentVersion);
  const available = normalizeUpdateVersion(availableVersion);
  const skipped = normalizeUpdateVersion(skippedVersion);
  return Boolean(available && available !== current && available !== skipped);
}

export function isUpdateCheckDue(
  lastCheckAt: number | null,
  now: number,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckAt === null || !Number.isFinite(lastCheckAt) || lastCheckAt <= 0) return true;
  return now - lastCheckAt >= intervalMs;
}
