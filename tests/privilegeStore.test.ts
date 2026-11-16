import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatRemainingTtl, leaseMatchesSession, usePrivilegeStore } from '@/stores/privilege';
import { useSessionsStore } from '@/stores/sessions';
import type { ElevatedAccessLeaseSummary, SessionSummary } from '@/types/contracts';

function makeSshSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    generation: 2,
    profileId: 'prof-1',
    sessionKind: 'ssh',
    capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
    state: 'connected',
    host: '10.1.2.3',
    port: 22,
    username: 'ops',
    lastError: null,
    ...overrides,
  };
}

function makeLease(overrides: Partial<ElevatedAccessLeaseSummary> = {}): ElevatedAccessLeaseSummary {
  return {
    sessionId: 'sess-1',
    generation: 2,
    state: 'elevated',
    username: 'ops',
    host: '10.1.2.3',
    port: 22,
    grantedAtMs: 1_000,
    expiresAtMs: 301_000,
    ttlSeconds: 300,
    ...overrides,
  };
}

describe('privilege store and elevated lease validation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('formats remaining TTL countdown as MM:SS', () => {
    expect(formatRemainingTtl(0)).toBe('00:00');
    expect(formatRemainingTtl(65)).toBe('01:05');
    expect(formatRemainingTtl(1800)).toBe('30:00');
  });

  it('validates lease identity against generation, host, port, username, state, and expiry', () => {
    const session = makeSshSession();
    const lease = makeLease();

    expect(leaseMatchesSession(lease, session, 100_000)).toBe(true);
    expect(leaseMatchesSession(lease, session, 301_000)).toBe(false);
    expect(leaseMatchesSession(lease, { ...session, generation: 3 }, 100_000)).toBe(false);
    expect(leaseMatchesSession(lease, { ...session, host: '10.1.2.99' }, 100_000)).toBe(false);
    expect(leaseMatchesSession(lease, { ...session, state: 'disconnected' }, 100_000)).toBe(false);
    expect(leaseMatchesSession(lease, { ...session, sessionKind: 'local' }, 100_000)).toBe(false);
  });

  it('automatically drops active leases when session disconnects or bumps generation', async () => {
    const sessions = useSessionsStore();
    const privilege = usePrivilegeStore();
    const now = Date.now();

    sessions.summaries = [makeSshSession()];
    privilege.leases = {
      'sess-1': makeLease({ grantedAtMs: now, expiresAtMs: now + 300_000 }),
    };

    expect(privilege.isElevated('sess-1')).toBe(true);
    expect(privilege.remainingSeconds('sess-1')).toBeGreaterThan(295);

    sessions.summaries = [makeSshSession({ generation: 3 })];
    await Promise.resolve();
    expect(privilege.isElevated('sess-1')).toBe(false);
    expect(privilege.getLease('sess-1')).toBeNull();
  });
});
