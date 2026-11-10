import { describe, expect, it } from 'vitest';
import {
  ALL_NETWORK_INTERFACES,
  networkEndpointsForInterface,
} from '@/domain/monitorDetails';
import type { NetworkEndpoint, NetworkInterface } from '@/types/contracts';

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
