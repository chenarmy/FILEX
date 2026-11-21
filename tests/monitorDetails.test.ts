import { describe, expect, it } from 'vitest';
import {
  ALL_NETWORK_INTERFACES,
  ALL_ROUTE_TABLES,
  DEFAULT_PROCESS_SORT,
  aggregateNetworkServices,
  filterNetworkEndpoints,
  filterNetworkServices,
  filterProcesses,
  filterRoutes,
  networkEndpointsForInterface,
  routeTableNames,
  sortProcesses,
  summarizeEndpointStates,
} from '@/domain/monitorDetails';
import type { NetworkEndpoint, NetworkInterface, ProcessEntry, RouteEntry } from '@/types/contracts';

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

  it('filters processes by PID, path, working directory, or command line', () => {
    const entries: ProcessEntry[] = [
      makeProcess({
        pid: 26126,
        name: 'java',
        executablePath: '/usr/local/jdk1.8.0_251/bin/java',
        workingDirectory: '/opt/kkFileView-4.1.0',
        commandLine: 'java -jar /opt/kkFileView-4.1.0/bin/kkFileView-4.1.0.jar',
      }),
      makeProcess({
        pid: 1601,
        name: 'mysqld',
        user: 'polkitd',
        executablePath: '/usr/sbin/mysqld',
        commandLine: 'mysqld --mysql-native-password=on',
      }),
    ];

    expect(filterProcesses(entries, '/jdk1.8').map((e) => e.pid)).toEqual([26126]);
    expect(filterProcesses(entries, 'kkfileview').map((e) => e.pid)).toEqual([26126]);
    expect(filterProcesses(entries, 'polkitd').map((e) => e.pid)).toEqual([1601]);
    expect(filterProcesses(entries, '1601').map((e) => e.pid)).toEqual([1601]);
  });
});

describe('monitor network service aggregation and route filtering', () => {
  it('aggregates listening services with unique remote IP and connection counts plus outbound connections', () => {
    const sampleEndpoints: NetworkEndpoint[] = [
      {
        protocol: 'tcp',
        localAddress: '0.0.0.0',
        localPort: 22,
        remoteAddress: null,
        remotePort: null,
        state: 'LISTEN',
        pid: 1069,
        processName: 'sshd',
      },
      {
        protocol: 'tcp',
        localAddress: '0.0.0.0',
        localPort: 80,
        remoteAddress: null,
        remotePort: null,
        state: 'LISTEN',
        pid: 1623,
        processName: 'nginx',
      },
      {
        protocol: 'tcp',
        localAddress: '10.0.0.2',
        localPort: 22,
        remoteAddress: '27.8.49.219',
        remotePort: 9799,
        state: 'ESTAB',
        recvQ: 0,
        sendQ: 128,
        pid: 1069,
        processName: 'sshd',
      },
      {
        protocol: 'tcp',
        localAddress: '10.0.0.2',
        localPort: 22,
        remoteAddress: '27.8.49.219',
        remotePort: 9127,
        state: 'ESTAB',
        pid: 1069,
        processName: 'sshd',
      },
      {
        protocol: 'tcp',
        localAddress: '10.0.0.2',
        localPort: 54321,
        remoteAddress: '100.100.30.25',
        remotePort: 80,
        state: 'ESTAB',
        pid: 1698,
        processName: 'AliYunDun',
      },
    ];

    const services = aggregateNetworkServices(sampleEndpoints);
    expect(services).toHaveLength(3);
    expect(services[0]?.processName).toBe('sshd');
    expect(services[0]?.uniqueRemoteIps).toBe(1);
    expect(services[0]?.connectionCount).toBe(2);
    expect(services[0]?.establishedCount).toBe(2);

    expect(services[1]?.processName).toBe('AliYunDun');
    expect(services[1]?.isListener).toBe(false);
    expect(services[1]?.connectionCount).toBe(1);

    expect(services[2]?.processName).toBe('nginx');
    expect(services[2]?.connectionCount).toBe(0);

    expect(filterNetworkServices(services, '27.8.49.219').map((s) => s.processName)).toEqual(['sshd']);

    const stateSummary = summarizeEndpointStates(sampleEndpoints);
    expect(stateSummary).toEqual({
      all: 5,
      listen: 2,
      established: 3,
      time_wait: 0,
      other: 0,
    });
    expect(filterNetworkEndpoints(sampleEndpoints, null, 'established', '9799')).toHaveLength(1);
  });

  it('lists route tables with main first and filters by table and search query', () => {
    const routes: RouteEntry[] = [
      {
        destination: '10.0.0.2',
        gateway: null,
        interfaceName: 'eth0',
        metric: null,
        protocol: 'kernel',
        table: 'local',
        scope: 'host',
        sourceAddress: '10.0.0.2',
        routeType: 'local',
      },
      {
        destination: 'default',
        gateway: '10.0.0.1',
        interfaceName: 'eth0',
        metric: 100,
        protocol: 'dhcp',
        table: 'main',
        scope: null,
        sourceAddress: null,
        routeType: 'unicast',
      },
    ];

    expect(routeTableNames(routes)).toEqual(['main', 'local']);
    expect(filterRoutes(routes, ALL_ROUTE_TABLES, '10.0.0.1')).toHaveLength(1);
    expect(filterRoutes(routes, 'local', '')).toHaveLength(1);
  });
});
