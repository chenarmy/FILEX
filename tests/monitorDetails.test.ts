import { describe, expect, it } from 'vitest';
import {
  ALL_NETWORK_INTERFACES,
  DEFAULT_PROCESS_SORT,
  networkEndpointsForInterface,
  sortProcesses,
} from '@/domain/monitorDetails';
import type { NetworkEndpoint, NetworkInterface, ProcessEntry } from '@/types/contracts';

const eth0: NetworkInterface = {
  name: 'eth0',
  state: 'up',
  addresses: ['10.0.0.2/24', 'fe80::2/64'],
  mtu: 1500,
  receivedBytes: 4_096,
  transmittedBytes: 2_048,
  loopback: false,
};

const endpoints: NetworkEndpoint[] = [
  {
    protocol: 'tcp',
    localAddress: '10.0.0.2',
    localPort: 22,
    remoteAddress: null,
    remotePort: null,
    state: 'LISTEN',
    pid: 42,
    processName: 'sshd',
  },
  {
    protocol: 'tcp',
    localAddress: '127.0.0.1',
    localPort: 25,
    remoteAddress: null,
    remotePort: null,
    state: 'LISTEN',
    pid: 43,
    processName: 'postfix',
  },
  {
    protocol: 'tcp',
    localAddress: '0.0.0.0',
    localPort: 443,
    remoteAddress: null,
    remotePort: null,
    state: 'LISTEN',
    pid: 44,
    processName: 'nginx',
  },
  {
    protocol: 'tcp',
    localAddress: 'fe80::2',
    localPort: 8080,
    remoteAddress: null,
    remotePort: null,
    state: 'LISTEN',
    pid: 45,
    processName: 'node',
  },
];

describe('monitor network interface views', () => {
  it('uses all interfaces as the unfiltered default view', () => {
    expect(ALL_NETWORK_INTERFACES).toBe('');
    expect(networkEndpointsForInterface(endpoints, null)).toEqual(endpoints);
  });

  it('keeps wildcard and matching IPv4/IPv6 endpoints for a selected interface', () => {
    const filtered = networkEndpointsForInterface(endpoints, eth0);
    expect(filtered.map((endpoint) => endpoint.processName)).toEqual(['sshd', 'nginx', 'node']);
  });
});

function makeProcess(overrides: Partial<ProcessEntry> & { pid: number; name: string }): ProcessEntry {
  return {
    parentPid: 1,
    user: 'root',
    cpuPercent: null,
    cpuTimeSeconds: null,
    memoryBytes: null,
    state: 'S',
    startedAtMs: 1_700_000_000_000,
    canTerminate: true,
    ...overrides,
  };
}

describe('monitor process sorting', () => {
  it('defaults to descending CPU sort and does not mutate the input array', () => {
    expect(DEFAULT_PROCESS_SORT).toBe('cpu');
    const source: ProcessEntry[] = [
      makeProcess({ pid: 20, name: 'nginx', cpuPercent: 2.5, cpuTimeSeconds: 10, memoryBytes: 64_000 }),
      makeProcess({ pid: 10, name: 'node', cpuPercent: 18.4, cpuTimeSeconds: 50, memoryBytes: 512_000 }),
      makeProcess({ pid: 30, name: 'postgres', cpuPercent: 0, cpuTimeSeconds: 200, memoryBytes: 2_048_000 }),
    ];
    const snapshotOrder = source.map((entry) => entry.pid);

    const byCpu = sortProcesses(source, 'cpu');
    expect(byCpu.map((entry) => entry.pid)).toEqual([10, 20, 30]);
    expect(source.map((entry) => entry.pid)).toEqual(snapshotOrder);
  });

  it('sorts processes by memory descending with CPU and PID tie-breakers and missing values last', () => {
    const source: ProcessEntry[] = [
      makeProcess({ pid: 50, name: 'missing-mem', cpuPercent: 99, cpuTimeSeconds: 10, memoryBytes: null }),
      makeProcess({ pid: 40, name: 'tie-low-cpu', cpuPercent: 1.0, cpuTimeSeconds: 5, memoryBytes: 1_000_000 }),
      makeProcess({ pid: 12, name: 'tie-same-cpu-higher-pid', cpuPercent: 5.0, cpuTimeSeconds: 5, memoryBytes: 1_000_000 }),
      makeProcess({ pid: 8, name: 'tie-same-cpu-lower-pid', cpuPercent: 5.0, cpuTimeSeconds: 5, memoryBytes: 1_000_000 }),
      makeProcess({ pid: 30, name: 'zero-mem', cpuPercent: 0.5, cpuTimeSeconds: 1, memoryBytes: 0 }),
      makeProcess({ pid: 20, name: 'java', cpuPercent: 0.2, cpuTimeSeconds: 12, memoryBytes: 4_000_000 }),
    ];

    const byMemory = sortProcesses(source, 'memory');
    expect(byMemory.map((entry) => entry.pid)).toEqual([20, 8, 12, 40, 30, 50]);
  });

  it('falls back to CPU time descending for Windows processes without cpuPercent and places missing values last', () => {
    const windowsProcesses: ProcessEntry[] = [
      makeProcess({ pid: 100, name: 'idle-unknown', cpuPercent: null, cpuTimeSeconds: null, memoryBytes: 9_000_000 }),
      makeProcess({ pid: 200, name: 'pwsh', cpuPercent: null, cpuTimeSeconds: 12.4, memoryBytes: 1_000_000 }),
      makeProcess({ pid: 300, name: 'sqlservr', cpuPercent: null, cpuTimeSeconds: 85.2, memoryBytes: 2_000_000 }),
      makeProcess({ pid: 150, name: 'worker-b', cpuPercent: null, cpuTimeSeconds: 12.4, memoryBytes: 3_000_000 }),
    ];

    const byCpu = sortProcesses(windowsProcesses, 'cpu');
    expect(byCpu.map((entry) => entry.pid)).toEqual([300, 150, 200, 100]);

    const byMemory = sortProcesses(windowsProcesses, 'memory');
    expect(byMemory.map((entry) => entry.pid)).toEqual([100, 150, 300, 200]);
  });
});
