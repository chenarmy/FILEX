import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { shouldExcludeCommandFromHistory } from '@/domain/commandHistory';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { defaultSafeSettings, readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';
import type { ConnectionProfile, SessionSummary } from '@/types/contracts';

function makeSavedProfile(id = 'prof-1'): ConnectionProfile {
  return {
    id,
    name: 'Prod App',
    group: 'Ops',
    host: '10.0.1.50',
    port: 22,
    username: 'ops',
    environment: 'production',
    tags: [],
    authenticationMethod: 'private_key',
    identityFile: null,
    keyId: 'key-1',
    proxyProfileId: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
    favorite: false,
    credentialRef: null,
    state: 'idle',
    latencyMs: null,
    lastUsedAt: null,
  };
}

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'sess-1',
    generation: 1,
    profileId: 'prof-1',
    sessionKind: 'ssh',
    capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
    state: 'connected',
    host: '10.0.1.50',
    port: 22,
    username: 'ops',
    lastError: null,
    ...overrides,
  };
}

describe('B4 per-profile command history and compact composer settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('keeps compactComposerOpen disabled by default and roundtrips toggle in safe settings', () => {
    expect(defaultSafeSettings.compactComposerOpen).toBe(false);
    expect(readSafeSettings().compactComposerOpen).toBe(false);
    writeSafeSettings({ ...defaultSafeSettings, compactComposerOpen: true });
    expect(readSafeSettings().compactComposerOpen).toBe(true);
  });

  it('excludes secrets, tokens, private keys, and credential flags from history', () => {
    expect(shouldExcludeCommandFromHistory('')).toBe(true);
    expect(shouldExcludeCommandFromHistory('curl -H "Authorization: Bearer tok12345" https://api.test')).toBe(true);
    expect(shouldExcludeCommandFromHistory('export API_TOKEN=secret_val && run.sh')).toBe(true);
    expect(shouldExcludeCommandFromHistory('AWS_SECRET_KEY=abcd terraform plan')).toBe(true);
    expect(shouldExcludeCommandFromHistory('mysql -u root -pSecret123')).toBe(true);
    expect(shouldExcludeCommandFromHistory('https://deploy:pw@git.internal/app.git')).toBe(true);
    expect(shouldExcludeCommandFromHistory('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);

    expect(shouldExcludeCommandFromHistory('systemctl status nginx')).toBe(false);
    expect(shouldExcludeCommandFromHistory('mkdir -p /srv/releases')).toBe(false);
    expect(shouldExcludeCommandFromHistory('docker compose ps')).toBe(false);
  });

  it('allows private_key profiles with central keyId and separates saved profile history from ephemeral local sessions', async () => {
    const connections = useConnectionsStore();
    const sessions = useSessionsStore();
    const profileA = makeSavedProfile('prof-a');
    connections.profiles = [profileA];

    // Verify connecting saved private_key profile with central keyId is NOT blocked client-side.
    const sessA = makeSession({ id: 'sess-a', profileId: 'prof-a', sessionKind: 'ssh' });
    const sessLocal = makeSession({
      id: 'sess-local',
      profileId: 'local:bash',
      sessionKind: 'local',
      capabilities: ['local_shell'],
      host: 'localhost',
      port: 0,
      username: 'user',
    });
    sessions.summaries = [sessA, sessLocal];
    sessions.activeSessionId = 'sess-a';

    expect(sessions.activeHistoryPersisted).toBe(true);
    expect(await sessions.recordCommandHistory('export SECRET=leak')).toBe(false);
    expect(await sessions.recordCommandHistory('uptime')).toBe(true);
    expect(await sessions.recordCommandHistory('df -hP')).toBe(true);
    expect(sessions.commandHistory).toEqual(['uptime', 'df -hP']);

    // Switching to local shell isolates history cleanly as ephemeral session-only.
    sessions.selectSession('sess-local');
    expect(sessions.activeHistoryPersisted).toBe(false);
    expect(sessions.commandHistory).toEqual([]);
    expect(await sessions.recordCommandHistory('pwd')).toBe(true);
    expect(sessions.commandHistory).toEqual(['pwd']);

    // Closing the local session purges its ephemeral history while keeping saved profile history intact.
    await sessions.closeSession('sess-local');
    sessions.selectSession('sess-a');
    expect(sessions.commandHistory).toEqual(['uptime', 'df -hP']);
  });
});
