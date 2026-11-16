import { describe, expect, it } from 'vitest';
import { hasCapability, isLocalSession, isSshSession } from '@/domain/sessionCapabilities';
import type { SessionSummary } from '@/types/contracts';

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'session-1',
    generation: 1,
    profileId: 'profile-1',
    sessionKind: 'ssh',
    capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
    state: 'connected',
    host: '10.0.0.10',
    port: 22,
    username: 'ops',
    lastError: null,
    ...overrides,
  };
}

describe('sessionCapabilities', () => {
  it('separates local shell sessions from remote SSH capabilities', () => {
    const localSession = makeSession({
      sessionKind: 'local',
      profileId: 'local:cmd',
      host: 'localhost',
      port: 0,
      capabilities: ['local_shell', 'local_files'],
    });
    expect(isLocalSession(localSession)).toBe(true);
    expect(isSshSession(localSession)).toBe(false);
    expect(hasCapability(localSession, 'local_shell')).toBe(true);
    expect(hasCapability(localSession, 'local_files')).toBe(true);
    expect(hasCapability(localSession, 'sftp')).toBe(false);
    expect(hasCapability(localSession, 'host_monitoring')).toBe(false);
    expect(hasCapability(localSession, 'tunneling')).toBe(false);
    expect(hasCapability(localSession, 'remote_jobs')).toBe(false);
    expect(hasCapability(localSession, 'elevated_file_access')).toBe(false);
  });

  it('recognizes SSH capabilities including optional elevation', () => {
    const sshSession = makeSession({});
    expect(isLocalSession(sshSession)).toBe(false);
    expect(isSshSession(sshSession)).toBe(true);
    expect(hasCapability(sshSession, 'remote_shell')).toBe(true);
    expect(hasCapability(sshSession, 'sftp')).toBe(true);
    expect(hasCapability(sshSession, 'elevated_file_access')).toBe(false);

    const elevatedSsh = makeSession({
      capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs', 'elevated_file_access'],
    });
    expect(hasCapability(elevatedSsh, 'elevated_file_access')).toBe(true);
  });
});
