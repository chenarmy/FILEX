import { describe, expect, it } from 'vitest';
import {
  isUpdateCheckDue,
  normalizeUpdateVersion,
  shouldOfferUpdate,
} from '@/domain/updatePolicy';
import {
  normalizeUpdatePreferences,
} from '@/runtime/updatePreferencesRepository';

describe('update scheduling policy', () => {
  it('normalizes stable release versions and rejects malformed values', () => {
    expect(normalizeUpdateVersion(' v0.1.2 ')).toBe('0.1.2');
    expect(normalizeUpdateVersion('0.2.0-beta.1')).toBe('0.2.0-beta.1');
    expect(normalizeUpdateVersion('../unsafe')).toBeNull();
    expect(normalizeUpdateVersion(42)).toBeNull();
  });

  it('suppresses only the explicitly skipped version', () => {
    expect(shouldOfferUpdate('0.1.1', '0.1.2', null)).toBe(true);
    expect(shouldOfferUpdate('0.1.1', '0.1.2', '0.1.2')).toBe(false);
    expect(shouldOfferUpdate('0.1.1', '0.1.3', '0.1.2')).toBe(true);
    expect(shouldOfferUpdate('0.1.1', '0.1.1', null)).toBe(false);
  });

  it('makes foreground checks due after the bounded interval', () => {
    const interval = 30 * 60 * 1_000;
    expect(isUpdateCheckDue(null, 1_000, interval)).toBe(true);
    expect(isUpdateCheckDue(1_000, 1_000 + interval - 1, interval)).toBe(false);
    expect(isUpdateCheckDue(1_000, 1_000 + interval, interval)).toBe(true);
  });

  it('normalizes persisted non-secret update preferences', () => {
    expect(normalizeUpdatePreferences({
      lastCheckAt: 1_700_000_000_123.9,
      skippedVersion: 'v0.1.2',
    })).toEqual({
      lastCheckAt: 1_700_000_000_123,
      skippedVersion: '0.1.2',
    });
    expect(normalizeUpdatePreferences({
      lastCheckAt: -1,
      skippedVersion: '../bad',
    })).toEqual({
      lastCheckAt: null,
      skippedVersion: null,
    });
  });
});
