import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionsApi from '@/api/domain/sessionsApi';
import type {
  HostKeyChallenge,
  OperationResult,
  SessionConnectionProgress,
  SessionSummary,
  TunnelRule,
  TunnelSummary,
} from '@/types/contracts';

const mockApi = vi.hoisted(() => ({
  probeSessionHostKey: vi.fn<() => Promise<OperationResult<HostKeyChallenge>>>(),
  connectPasswordSession: vi.fn<(sessionId: string) => Promise<OperationResult<SessionConnectionProgress>>>(),
  probeQuickSessionHostKey: vi.fn<() => Promise<OperationResult<HostKeyChallenge>>>(),
  connectQuickPasswordSession: vi.fn<() => Promise<OperationResult<SessionConnectionProgress>>>(),
  duplicateConnectedSession: vi.fn<(sessionId: string) => Promise<OperationResult<SessionSummary>>>(),
  disconnectSession: vi.fn<(sessionId: string) => Promise<OperationResult<SessionSummary>>>(),
  reprobeSessionHostKey: vi.fn<(sessionId: string) => Promise<OperationResult<HostKeyChallenge>>>(),
  cancelSessionAttempt: vi.fn<(sessionId: string) => Promise<OperationResult<null>>>(),
  listSessions: vi.fn<() => Promise<OperationResult<SessionSummary[]>>>(),
  listTunnels: vi.fn<() => Promise<OperationResult<TunnelSummary[]>>>(),
  listTunnelRules: vi.fn<() => Promise<OperationResult<TunnelRule[]>>>(),
  startLocalTunnel: vi.fn<() => Promise<OperationResult<TunnelSummary>>>(),
  createTunnelRule: vi.fn<() => Promise<OperationResult<TunnelRule>>>(),
}));

vi.mock('@/api/domain/sessionsApi', async () => {
  const actual = await vi.importActual<typeof SessionsApi>('@/api/domain/sessionsApi');
  return {
    ...actual,
    probeSessionHostKey: mockApi.probeSessionHostKey,
    connectPasswordSession: mockApi.connectPasswordSession,
    probeQuickSessionHostKey: mockApi.probeQuickSessionHostKey,
    connectQuickPasswordSession: mockApi.connectQuickPasswordSession,
    duplicateConnectedSession: mockApi.duplicateConnectedSession,
    disconnectSession: mockApi.disconnectSession,
    reprobeSessionHostKey: mockApi.reprobeSessionHostKey,
    cancelSessionAttempt: mockApi.cancelSessionAttempt,
    listSessions: mockApi.listSessions,
  };
});

vi.mock('@/api/domain/tunnelsApi', () => ({
  listTunnels: mockApi.listTunnels,
  listTunnelRules: mockApi.listTunnelRules,
  startLocalTunnel: mockApi.startLocalTunnel,
  stopTunnel: vi.fn(),
  createTunnelRule: mockApi.createTunnelRule,
  updateTunnelRule: vi.fn(),
  deleteTunnelRule: vi.fn(),
}));

import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useTunnelsStore } from '@/stores/tunnels';

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-quick-1',
    generation: 1,
    profileId: 'quick-prof-1',
    sessionKind: 'ssh',
    capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
    state: 'connected',
    host: '192.0.2.50',
    port: 22,
    username: 'ops',
    lastError: null,
    ...overrides,
  };
}

function makeChallenge(overrides: Partial<HostKeyChallenge> = {}): HostKeyChallenge {
  return {
    session: makeSummary({ state: 'ready_to_authenticate' }),
    profileId: 'quick-prof-1',
    profileName: 'ops@192.0.2.50',
    host: '192.0.2.50',
    port: 22,
    hopIndex: 0,
    hopCount: 1,
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:quickfixture',
    trust: 'trusted',
    ...overrides,
  };
}

describe('temporary quick-connect session parity', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockApi.listSessions.mockResolvedValue({ ok: true, data: [], requestId: 'r0' });
    mockApi.listTunnels.mockResolvedValue({ ok: true, data: [], requestId: 'r0' });
    mockApi.listTunnelRules.mockResolvedValue({ ok: true, data: [], requestId: 'r0' });
    mockApi.cancelSessionAttempt.mockResolvedValue({ ok: true, data: null, requestId: 'r0' });
  });

  it('duplicates a connected quick session on the live SSH transport and retains quick profile until the last tab closes', async () => {
    mockApi.probeQuickSessionHostKey.mockResolvedValue({
      ok: true,
      data: makeChallenge(),
      requestId: 'r1',
    });
    mockApi.connectQuickPasswordSession.mockResolvedValue({
      ok: true,
      data: { session: makeSummary(), challenge: null, connected: true },
      requestId: 'r2',
    });
    mockApi.duplicateConnectedSession.mockResolvedValue({
      ok: true,
      data: makeSummary({ id: 'sess-quick-2' }),
      requestId: 'r3',
    });
    mockApi.disconnectSession.mockImplementation((sessionId) => Promise.resolve({
      ok: true,
      data: makeSummary({ id: sessionId, state: 'disconnected' }),
      requestId: 'r4',
    }));

    const sessions = useSessionsStore();
    expect(await sessions.beginQuick({ host: '192.0.2.50', port: 22, username: 'ops' })).toBe(true);
    await sessions.savePassword('one-time-pass');

    expect(sessions.activeSession?.id).toBe('sess-quick-1');
    expect(sessions.isQuickProfile('quick-prof-1')).toBe(true);

    // Duplicate creates a second independent tab without prompting for password again.
    expect(await sessions.duplicateSession('sess-quick-1')).toBe(true);
    expect(mockApi.duplicateConnectedSession).toHaveBeenCalledWith('sess-quick-1');
    expect(sessions.summaries.map((item) => item.id)).toEqual(['sess-quick-1', 'sess-quick-2']);
    expect(sessions.activeSession?.id).toBe('sess-quick-2');

    // Closing the first tab keeps the shared quick profile alive for the remaining tab.
    await sessions.closeSession('sess-quick-1');
    expect(sessions.isQuickProfile('quick-prof-1')).toBe(true);
    expect(sessions.profileForId('quick-prof-1')?.host).toBe('192.0.2.50');

    // Closing the last tab clears the temporary profile cleanly.
    await sessions.closeSession('sess-quick-2');
    expect(sessions.isQuickProfile('quick-prof-1')).toBe(false);
    expect(sessions.profileForId('quick-prof-1')).toBeNull();
  });

  it('automatically removes the temporary session and profile when disconnected', async () => {
    mockApi.probeQuickSessionHostKey.mockResolvedValue({
      ok: true,
      data: makeChallenge(),
      requestId: 'r1',
    });
    mockApi.connectQuickPasswordSession.mockResolvedValueOnce({
      ok: true,
      data: { session: makeSummary({ generation: 1 }), challenge: null, connected: true },
      requestId: 'r2',
    });
    mockApi.disconnectSession.mockResolvedValue({
      ok: true,
      data: makeSummary({ state: 'disconnected' }),
      requestId: 'r3',
    });

    const sessions = useSessionsStore();
    await sessions.beginQuick({ host: '192.0.2.50', port: 22, username: 'ops' });
    await sessions.savePassword('first-pass');

    await sessions.disconnectActive();
    expect(sessions.summaries).toHaveLength(0);
    expect(sessions.activeSession).toBeNull();
    expect(sessions.isQuickProfile('quick-prof-1')).toBe(false);
    expect(sessions.profileForId('quick-prof-1')).toBeNull();
  });

  it('supports starting tunnels and saving transient tunnel rules for quick profiles', async () => {
    const quickRule: TunnelRule = {
      id: 'rule-quick-1',
      profileId: 'quick-prof-1',
      name: 'Quick Web',
      kind: 'local',
      bindHost: '127.0.0.1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
      autoStart: true,
    };
    const quickTunnel: TunnelSummary = {
      id: 'tunnel-quick-1',
      sessionId: 'sess-quick-1',
      profileId: 'quick-prof-1',
      name: 'Quick Web',
      kind: 'local',
      bindHost: '127.0.0.1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
      allowNonLoopback: false,
      state: 'listening',
      lastError: null,
    };

    mockApi.createTunnelRule.mockResolvedValue({ ok: true, data: quickRule, requestId: 'r1' });
    mockApi.startLocalTunnel.mockResolvedValue({ ok: true, data: quickTunnel, requestId: 'r2' });

    const tunnels = useTunnelsStore();
    expect(await tunnels.saveRule({
      profileId: 'quick-prof-1',
      name: 'Quick Web',
      kind: 'local',
      bindHost: '127.0.0.1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
      autoStart: true,
    })).toBe(true);
    expect(tunnels.rules).toHaveLength(1);
    expect(tunnels.rules[0]?.profileId).toBe('quick-prof-1');

    expect(await tunnels.start({
      sessionId: 'sess-quick-1',
      profileId: 'quick-prof-1',
      name: 'Quick Web',
      kind: 'local',
      bindHost: '127.0.0.1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
      allowNonLoopback: false,
    })).toBe(true);
    expect(tunnels.tunnels[0]?.state).toBe('listening');
  });

  it('reconnects a connected saved session in-place without creating duplicate tabs', async () => {
    const connections = useConnectionsStore();
    connections.profiles = [{
      id: 'saved-prof-1',
      name: 'prod-box',
      group: '',
      host: '192.0.2.60',
      port: 22,
      username: 'ops',
      environment: 'production',
      favorite: false,
      tags: [],
      authenticationMethod: 'password',
      identityFile: null,
      proxyJump: null,
      proxyJumpProfileIds: [],
      credentialRef: 'password:saved-prof-1',
      state: 'idle',
      latencyMs: null,
      lastUsedAt: null,
    }];

    const sessions = useSessionsStore();
    sessions.summaries = [makeSummary({
      id: 'sess-saved-1',
      profileId: 'saved-prof-1',
      generation: 1,
      host: '192.0.2.60',
    })];
    sessions.activeSessionId = 'sess-saved-1';

    mockApi.disconnectSession.mockResolvedValueOnce({
      ok: true,
      data: makeSummary({
        id: 'sess-saved-1',
        profileId: 'saved-prof-1',
        generation: 1,
        host: '192.0.2.60',
        state: 'disconnected',
      }),
      requestId: 'r-disc',
    });
    mockApi.reprobeSessionHostKey.mockResolvedValueOnce({
      ok: true,
      data: makeChallenge({
        session: makeSummary({
          id: 'sess-saved-1',
          profileId: 'saved-prof-1',
          generation: 2,
          host: '192.0.2.60',
          state: 'ready_to_authenticate',
        }),
        profileId: 'saved-prof-1',
        profileName: 'prod-box',
        host: '192.0.2.60',
      }),
      requestId: 'r-reprobe',
    });
    mockApi.connectPasswordSession.mockResolvedValueOnce({
      ok: true,
      data: {
        session: makeSummary({
          id: 'sess-saved-1',
          profileId: 'saved-prof-1',
          generation: 2,
          host: '192.0.2.60',
          state: 'connected',
        }),
        challenge: null,
        connected: true,
      },
      requestId: 'r-conn',
    });

    await sessions.reconnectActive();

    expect(mockApi.disconnectSession).toHaveBeenCalledWith('sess-saved-1');
    expect(mockApi.reprobeSessionHostKey).toHaveBeenCalledWith('sess-saved-1');
    expect(mockApi.connectPasswordSession).toHaveBeenCalledWith('sess-saved-1');
    expect(sessions.summaries).toHaveLength(1);
    expect(sessions.activeSession?.id).toBe('sess-saved-1');
    expect(sessions.activeSession?.generation).toBe(2);
    expect(sessions.activeSession?.state).toBe('connected');
  });

  it('replaces a connected quick session on reconnect when probe succeeds and preserves it on probe failure', async () => {
    mockApi.probeQuickSessionHostKey.mockResolvedValueOnce({
      ok: true,
      data: makeChallenge(),
      requestId: 'r1',
    });
    mockApi.connectQuickPasswordSession.mockResolvedValueOnce({
      ok: true,
      data: { session: makeSummary(), challenge: null, connected: true },
      requestId: 'r2',
    });

    const sessions = useSessionsStore();
    await sessions.beginQuick({ host: '192.0.2.50', port: 22, username: 'ops' });
    await sessions.savePassword('first-pass');
    expect(sessions.activeSession?.id).toBe('sess-quick-1');

    mockApi.probeQuickSessionHostKey.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'SSH_CONNECT_FAILED',
        messageKey: 'errors.sshConnectFailed',
        retryable: true,
        remoteState: 'unknown',
      },
      requestId: 'r3',
    });

    await sessions.reconnectActive();
    expect(mockApi.disconnectSession).not.toHaveBeenCalled();
    expect(sessions.summaries.map((item) => item.id)).toEqual(['sess-quick-1']);
    expect(sessions.activeSession?.state).toBe('connected');

    mockApi.probeQuickSessionHostKey.mockResolvedValueOnce({
      ok: true,
      data: makeChallenge({
        session: makeSummary({ id: 'sess-quick-2', profileId: 'quick-prof-2', state: 'ready_to_authenticate' }),
        profileId: 'quick-prof-2',
      }),
      requestId: 'r4',
    });
    mockApi.disconnectSession.mockResolvedValueOnce({
      ok: true,
      data: makeSummary({ id: 'sess-quick-1', state: 'disconnected' }),
      requestId: 'r5',
    });

    await sessions.reconnectActive();
    expect(mockApi.disconnectSession).toHaveBeenCalledWith('sess-quick-1');
    expect(sessions.summaries.map((item) => item.id)).toEqual(['sess-quick-2']);
    expect(sessions.isQuickProfile('quick-prof-1')).toBe(false);
    expect(sessions.activeSession?.id).toBe('sess-quick-2');
  });
});
