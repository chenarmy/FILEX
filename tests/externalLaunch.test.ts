import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  externalLaunchProfileName,
  shouldPromptExternalLaunchUsername,
} from '@/domain/externalLaunch';
import type * as SessionsApi from '@/api/domain/sessionsApi';
import type {
  ExternalLaunchEvent,
  ExternalLaunchRequest,
  HostKeyChallenge,
  OperationResult,
  SessionConnectionProgress,
  SessionSummary,
} from '@/types/contracts';

const mockApi = vi.hoisted(() => ({
  drainExternalLaunchEvents: vi.fn<() => Promise<OperationResult<ExternalLaunchEvent[]>>>(),
  discardExternalLaunch: vi.fn<(launchId: string) => Promise<OperationResult<null>>>(),
  probeExternalLaunchHostKey: vi.fn<(launchId: string) => Promise<OperationResult<HostKeyChallenge>>>(),
  connectExternalLaunchSession: vi.fn<
    (sessionId: string, passphrase?: string) => Promise<OperationResult<SessionConnectionProgress>>
  >(),
  listenExternalLaunchEvents: vi.fn<
    (handler: (event: ExternalLaunchEvent) => void) => Promise<(() => void) | null>
  >(),
  recordHostTrust: vi.fn<() => Promise<OperationResult<unknown>>>(),
  listSessions: vi.fn<() => Promise<OperationResult<SessionSummary[]>>>(),
  cancelSessionAttempt: vi.fn<(sessionId: string) => Promise<OperationResult<null>>>(),
}));

vi.mock('@/api/domain/externalLaunchApi', () => ({
  drainExternalLaunchEvents: mockApi.drainExternalLaunchEvents,
  discardExternalLaunch: mockApi.discardExternalLaunch,
  probeExternalLaunchHostKey: mockApi.probeExternalLaunchHostKey,
  connectExternalLaunchSession: mockApi.connectExternalLaunchSession,
  listenExternalLaunchEvents: mockApi.listenExternalLaunchEvents,
}));

vi.mock('@/api/domain/trustApi', () => ({
  recordHostTrust: mockApi.recordHostTrust,
}));

vi.mock('@/api/domain/sessionsApi', async () => {
  const actual = await vi.importActual<typeof SessionsApi>('@/api/domain/sessionsApi');
  return {
    ...actual,
    listSessions: mockApi.listSessions,
    cancelSessionAttempt: mockApi.cancelSessionAttempt,
  };
});

import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';

function makeRequest(overrides: Partial<ExternalLaunchRequest> = {}): ExternalLaunchRequest {
  return {
    launchId: 'launch-1',
    host: '10.20.30.40',
    port: 5107,
    username: 'ops_user',
    displayName: '天玥网关',
    authenticationMethod: 'password',
    identityFile: null,
    hasPresetPassword: true,
    openSftp: false,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-ext-1',
    generation: 1,
    profileId: 'quick-prof-1',
    sessionKind: 'ssh',
    capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring'],
    state: 'trust_required',
    host: '10.20.30.40',
    port: 5107,
    username: 'ops_user',
    lastError: null,
    ...overrides,
  };
}

function makeChallenge(overrides: Partial<HostKeyChallenge> = {}): HostKeyChallenge {
  return {
    session: makeSummary(),
    profileId: 'quick-prof-1',
    profileName: '天玥网关',
    host: '10.20.30.40',
    port: 5107,
    hopIndex: 0,
    hopCount: 1,
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:fixture',
    trust: 'trusted',
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('external CLI launch helpers and sessions store flow', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockApi.drainExternalLaunchEvents.mockResolvedValue({ ok: true, data: [], requestId: 'r0' });
    mockApi.discardExternalLaunch.mockResolvedValue({ ok: true, data: null, requestId: 'r0' });
    mockApi.listenExternalLaunchEvents.mockResolvedValue(null);
    mockApi.recordHostTrust.mockResolvedValue({ ok: true, data: {}, requestId: 'r0' });
    mockApi.listSessions.mockResolvedValue({ ok: true, data: [], requestId: 'r0' });
    mockApi.cancelSessionAttempt.mockResolvedValue({ ok: true, data: null, requestId: 'r0' });
  });

  it('derives display names and detects missing usernames', () => {
    expect(shouldPromptExternalLaunchUsername(makeRequest({ username: '' }))).toBe(true);
    expect(shouldPromptExternalLaunchUsername(makeRequest({ username: '   ' }))).toBe(true);
    expect(shouldPromptExternalLaunchUsername(makeRequest({ username: 'ops' }))).toBe(false);

    expect(externalLaunchProfileName(makeRequest({ displayName: 'Core Bastion' }))).toBe('Core Bastion');
    expect(externalLaunchProfileName(makeRequest({ displayName: null }), 'Fallback Host')).toBe('Fallback Host');
    expect(externalLaunchProfileName(makeRequest({ displayName: null, username: 'root', host: '10.0.0.1' }))).toBe(
      'root@10.0.0.1',
    );
  });

  it('auto-connects trusted hosts with a server-held preset password and opens SFTP when requested', async () => {
    const request = makeRequest({ openSftp: true });
    const connectedSummary = makeSummary({ state: 'connected' });
    mockApi.probeExternalLaunchHostKey.mockResolvedValue({
      ok: true,
      data: makeChallenge({ trust: 'trusted' }),
      requestId: 'r1',
    });
    mockApi.connectExternalLaunchSession.mockResolvedValue({
      ok: true,
      data: { session: connectedSummary, challenge: null, connected: true },
      requestId: 'r2',
    });

    const sessions = useSessionsStore();
    const settings = useSettingsStore();
    settings.value.fileBrowserOpen = false;
    settings.value.inspectorTab = 'monitor';

    sessions.enqueueExternalLaunch({ kind: 'launch', request });
    await flushMicrotasks();

    expect(mockApi.probeExternalLaunchHostKey).toHaveBeenCalledWith('launch-1');
    expect(mockApi.connectExternalLaunchSession).toHaveBeenCalledWith('sess-ext-1', undefined);
    expect(sessions.passwordProfileId).toBeNull();
    expect(sessions.activeSession?.state).toBe('connected');
    expect(sessions.profileForId('quick-prof-1')?.name).toBe('天玥网关');
    expect(settings.value.fileBrowserOpen).toBe(true);
    expect(settings.value.inspectorTab).toBe('files');
  });

  it('requires host-key approval for unknown hosts before consuming preset credentials and drains queued launches', async () => {
    const first = makeRequest({ launchId: 'launch-1', displayName: 'Bastion 1' });
    const second = makeRequest({ launchId: 'launch-2', host: '10.20.30.41', displayName: 'Bastion 2' });

    mockApi.probeExternalLaunchHostKey
      .mockResolvedValueOnce({
        ok: true,
        data: makeChallenge({
          trust: 'unknown',
          profileId: 'quick-1',
          session: makeSummary({ id: 'sess-1', profileId: 'quick-1' }),
        }),
        requestId: 'r1',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: makeChallenge({
          trust: 'trusted',
          profileId: 'quick-2',
          host: '10.20.30.41',
          session: makeSummary({ id: 'sess-2', profileId: 'quick-2', host: '10.20.30.41' }),
        }),
        requestId: 'r3',
      });

    mockApi.connectExternalLaunchSession
      .mockResolvedValueOnce({
        ok: true,
        data: {
          session: makeSummary({ id: 'sess-1', profileId: 'quick-1', state: 'connected' }),
          challenge: null,
          connected: true,
        },
        requestId: 'r2',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          session: makeSummary({ id: 'sess-2', profileId: 'quick-2', host: '10.20.30.41', state: 'connected' }),
          challenge: null,
          connected: true,
        },
        requestId: 'r4',
      });

    const sessions = useSessionsStore();
    sessions.enqueueExternalLaunch({ kind: 'launch', request: first });
    sessions.enqueueExternalLaunch({ kind: 'launch', request: second });
    await flushMicrotasks();

    // First launch must wait for explicit host-key approval; second stays queued.
    expect(sessions.challenge?.trust).toBe('unknown');
    expect(mockApi.connectExternalLaunchSession).not.toHaveBeenCalled();
    expect(mockApi.probeExternalLaunchHostKey).toHaveBeenCalledTimes(1);

    await sessions.acceptHostKey();
    await flushMicrotasks();

    expect(mockApi.recordHostTrust).toHaveBeenCalledTimes(1);
    expect(mockApi.connectExternalLaunchSession).toHaveBeenNthCalledWith(1, 'sess-1', undefined);
    expect(mockApi.probeExternalLaunchHostKey).toHaveBeenNthCalledWith(2, 'launch-2');
    expect(mockApi.connectExternalLaunchSession).toHaveBeenNthCalledWith(2, 'sess-2', undefined);
    expect(sessions.summaries).toHaveLength(2);
  });

  it('prompts Quick Connect with prefilled host and port when username is omitted', async () => {
    const request = makeRequest({ launchId: 'launch-no-user', username: '', hasPresetPassword: false });
    const sessions = useSessionsStore();
    const ui = useUiStore();

    sessions.enqueueExternalLaunch({ kind: 'launch', request });
    await flushMicrotasks();

    expect(mockApi.discardExternalLaunch).toHaveBeenCalledWith('launch-no-user');
    expect(mockApi.probeExternalLaunchHostKey).not.toHaveBeenCalled();
    expect(ui.quickConnectOpen).toBe(true);
    expect(ui.quickConnectPrefill).toEqual({ host: '10.20.30.40', port: 5107 });
  });

  it('prompts for transient private-key passphrase when key is encrypted', async () => {
    const request = makeRequest({
      launchId: 'launch-key',
      authenticationMethod: 'private_key',
      identityFile: 'C:\\keys\\id_ed25519',
      hasPresetPassword: false,
    });
    mockApi.probeExternalLaunchHostKey.mockResolvedValue({
      ok: true,
      data: makeChallenge({ trust: 'trusted', profileId: 'quick-key', session: makeSummary({ id: 'sess-key', profileId: 'quick-key' }) }),
      requestId: 'r1',
    });
    mockApi.connectExternalLaunchSession
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'SSH_PRIVATE_KEY_PASSPHRASE_REQUIRED',
          messageKey: 'errors.sshPrivateKeyPassphraseRequired',
          retryable: true,
          remoteState: 'not_applicable',
        },
        requestId: 'r2',
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          session: makeSummary({ id: 'sess-key', profileId: 'quick-key', state: 'connected' }),
          challenge: null,
          connected: true,
        },
        requestId: 'r3',
      });

    const sessions = useSessionsStore();
    sessions.enqueueExternalLaunch({ kind: 'launch', request });
    await flushMicrotasks();

    expect(sessions.privateKeyPassphraseProfileId).toBe('quick-key');
    expect(sessions.profileForId('quick-key')?.identityFile).toBe('C:\\keys\\id_ed25519');

    await sessions.savePrivateKeyPassphrase('key-secret');
    expect(mockApi.connectExternalLaunchSession).toHaveBeenNthCalledWith(2, 'sess-key', 'key-secret');
    expect(sessions.privateKeyPassphraseProfileId).toBeNull();
    expect(sessions.activeSession?.state).toBe('connected');
  });

  it('surfaces structured CLI launch errors without crashing', async () => {
    const sessions = useSessionsStore();
    const ui = useUiStore();

    sessions.enqueueExternalLaunch({
      kind: 'error',
      error: {
        code: 'CLI_LAUNCH_UNSUPPORTED_PROTOCOL',
        messageKey: 'errors.cliLaunchUnsupportedProtocol',
        retryable: false,
        remoteState: 'not_applicable',
      },
    });
    await flushMicrotasks();

    expect(sessions.error?.code).toBe('CLI_LAUNCH_UNSUPPORTED_PROTOCOL');
    expect(ui.toast).toBeTruthy();
  });
});
