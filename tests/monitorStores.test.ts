import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DockerLogsSnapshot,
  DockerSnapshot,
  NetworkSnapshot,
  OperationResult,
  OpsSnapshot,
  ProcessSnapshot,
} from '@/types/contracts';

const mocks = vi.hoisted(() => ({
  collectProcessSnapshot: vi.fn(),
  terminateRemoteProcess: vi.fn(),
  collectNetworkSnapshot: vi.fn(),
  collectDockerSnapshot: vi.fn(),
  collectDockerLogs: vi.fn(),
  runDockerContainerAction: vi.fn(),
  collectOpsSnapshot: vi.fn(),
}));

vi.mock('@/api/domain/processesApi', () => ({
  collectProcessSnapshot: mocks.collectProcessSnapshot,
  terminateRemoteProcess: mocks.terminateRemoteProcess,
}));

vi.mock('@/api/domain/networkApi', () => ({
  collectNetworkSnapshot: mocks.collectNetworkSnapshot,
}));

vi.mock('@/api/domain/dockerApi', () => ({
  collectDockerSnapshot: mocks.collectDockerSnapshot,
  collectDockerLogs: mocks.collectDockerLogs,
  runDockerContainerAction: mocks.runDockerContainerAction,
}));

vi.mock('@/api/domain/opsApi', () => ({
  collectOpsSnapshot: mocks.collectOpsSnapshot,
}));

import { useDockerStore } from '@/stores/docker';
import { useNetworkStore } from '@/stores/network';
import { useOpsStore } from '@/stores/ops';
import { useProcessesStore } from '@/stores/processes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function processResult(name: string): OperationResult<ProcessSnapshot> {
  return {
    ok: true,
    requestId: `process-${name}`,
    data: {
      state: 'live',
      platform: 'posix',
      collectedAtMs: 1,
      snapshotId: `snapshot-${name}`,
      processes: [{
        pid: 42,
        name,
        user: 'root',
        cpuPercent: 1,
        cpuTimeSeconds: 2,
        memoryBytes: 3_072,
        state: 'S',
        startedAtMs: 1,
        canTerminate: true,
      }],
      truncated: false,
    },
  };
}

function networkResult(name: string): OperationResult<NetworkSnapshot> {
  return {
    ok: true,
    requestId: `network-${name}`,
    data: {
      state: 'live',
      platform: 'linux',
      collectedAtMs: 1,
      interfaces: [{
        name,
        state: 'up',
        addresses: ['10.0.0.2/24'],
        mtu: 1500,
        receivedBytes: 1,
        transmittedBytes: 1,
        loopback: false,
      }],
      endpoints: [],
      routes: [],
      endpointsTruncated: false,
      routesTruncated: false,
    },
  };
}

describe('monitoring store session isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('clears process data on session change and discards the previous session response', async () => {
    const first = deferred<OperationResult<ProcessSnapshot>>();
    const second = deferred<OperationResult<ProcessSnapshot>>();
    mocks.collectProcessSnapshot
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const store = useProcessesStore();
    const firstRequest = store.collect('session-a');
    expect(store.loading).toBe(true);

    const secondRequest = store.collect('session-b');
    expect(store.snapshot).toBeNull();
    second.resolve(processResult('session-b-process'));
    await secondRequest;
    expect(store.snapshot?.snapshotId).toBe('snapshot-session-b-process');

    first.resolve(processResult('session-a-process'));
    await firstRequest;
    expect(store.snapshot?.snapshotId).toBe('snapshot-session-b-process');
  });

  it('clears network data on session change and discards the previous session response', async () => {
    const first = deferred<OperationResult<NetworkSnapshot>>();
    const second = deferred<OperationResult<NetworkSnapshot>>();
    mocks.collectNetworkSnapshot
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const store = useNetworkStore();
    const firstRequest = store.collect('session-a');
    expect(store.loading).toBe(true);

    const secondRequest = store.collect('session-b');
    expect(store.snapshot).toBeNull();
    second.resolve(networkResult('session-b-interface'));
    await secondRequest;
    expect(store.snapshot?.interfaces[0]?.name).toBe('session-b-interface');

    first.resolve(networkResult('session-a-interface'));
    await firstRequest;
    expect(store.snapshot?.interfaces[0]?.name).toBe('session-b-interface');
  });

  it('forwards explicit process signals such as SIGKILL through processesStore.terminate', async () => {
    mocks.collectProcessSnapshot
      .mockResolvedValueOnce(processResult('before-kill'))
      .mockResolvedValueOnce(processResult('after-kill'));
    mocks.terminateRemoteProcess.mockResolvedValueOnce({
      ok: true,
      requestId: 'term-1',
      data: { pid: 42, terminated: true, detailNote: null },
    });

    const store = useProcessesStore();
    await store.collect('session-a');
    const ok = await store.terminate('session-a', 42, 'SIGKILL');

    expect(ok).toBe(true);
    expect(mocks.terminateRemoteProcess).toHaveBeenCalledWith('session-a', 'snapshot-before-kill', 42, 'SIGKILL');
    expect(mocks.collectProcessSnapshot).toHaveBeenCalledTimes(2);
  });

  it('collects Docker snapshots, fetches logs, and refreshes after container actions', async () => {
    const dockerSnapshot: DockerSnapshot = {
      availability: 'available',
      collectedAtMs: 10,
      serverVersion: '26.1.0',
      containers: [{
        id: 'c1234567890ab',
        name: 'api-gateway',
        image: 'nginx:1.27',
        state: 'running',
        status: 'Up 2 hours',
        ports: '0.0.0.0:80->80/tcp',
        createdAt: '2026-11-14 01:00:00',
        cpuPercent: '0.50%',
        memoryUsage: '24MiB / 2GiB',
        pids: '4',
      }],
      images: [{
        id: 'sha256:abcd',
        repository: 'nginx',
        tag: '1.27',
        size: '188MB',
        createdSince: '2 weeks ago',
      }],
      truncated: false,
    };
    const dockerLogs: DockerLogsSnapshot = {
      containerId: 'c1234567890ab',
      lines: ['ready on :80'],
      truncated: false,
    };
    mocks.collectDockerSnapshot
      .mockResolvedValue({ ok: true, requestId: 'd-1', data: dockerSnapshot } satisfies OperationResult<DockerSnapshot>);
    mocks.collectDockerLogs
      .mockResolvedValueOnce({ ok: true, requestId: 'dl-1', data: dockerLogs } satisfies OperationResult<DockerLogsSnapshot>);
    mocks.runDockerContainerAction
      .mockResolvedValueOnce({ ok: true, requestId: 'da-1', data: undefined });

    const store = useDockerStore();
    await store.collect('session-a');
    expect(store.snapshot?.containers).toHaveLength(1);

    await store.fetchLogs('session-a', 'c1234567890ab', 200);
    expect(store.logs?.lines).toEqual(['ready on :80']);

    const acted = await store.performAction('session-a', 'c1234567890ab', 'restart');
    expect(acted).toBe(true);
    expect(mocks.runDockerContainerAction).toHaveBeenCalledWith('session-a', 'c1234567890ab', 'restart');
    expect(mocks.collectDockerSnapshot).toHaveBeenCalledTimes(2);
  });

  it('caches ops diagnostic snapshots per category and clears on session change', async () => {
    const portsSnapshot: OpsSnapshot = {
      state: 'live',
      collectedAtMs: 20,
      category: 'ports',
      hostname: 'prod-1',
      osRelease: 'Ubuntu 24.04',
      sections: [{
        id: 'listening',
        titleKey: 'opsDialog.sectionListeningPorts',
        commandLabel: 'ss -tulpen',
        lines: ['LISTEN 0 128 *:22 *:*'],
        truncated: false,
      }],
    };
    mocks.collectOpsSnapshot.mockResolvedValueOnce({
      ok: true,
      requestId: 'ops-1',
      data: portsSnapshot,
    } satisfies OperationResult<OpsSnapshot>);

    const store = useOpsStore();
    await store.collect('session-a', 'ports');
    expect(store.snapshots.ports?.sections[0]?.lines[0]).toContain('*:22');

    store.clear();
    expect(store.snapshots.ports).toBeUndefined();
  });
});
