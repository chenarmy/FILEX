import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NetworkSnapshot,
  OperationResult,
  ProcessSnapshot,
} from '@/types/contracts';

const mocks = vi.hoisted(() => ({
  collectProcessSnapshot: vi.fn(),
  terminateRemoteProcess: vi.fn(),
  collectNetworkSnapshot: vi.fn(),
}));

vi.mock('@/api/domain/processesApi', () => ({
  collectProcessSnapshot: mocks.collectProcessSnapshot,
  terminateRemoteProcess: mocks.terminateRemoteProcess,
}));

vi.mock('@/api/domain/networkApi', () => ({
  collectNetworkSnapshot: mocks.collectNetworkSnapshot,
}));

import { useNetworkStore } from '@/stores/network';
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
});
