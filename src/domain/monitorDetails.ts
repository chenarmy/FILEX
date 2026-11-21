import type {
  NetworkEndpoint,
  NetworkInterface,
  ProcessEntry,
  ProcessSortBy,
  RouteEntry,
} from '@/types/contracts';

export const ALL_NETWORK_INTERFACES = '';
export const ALL_ROUTE_TABLES = '';
export const DEFAULT_PROCESS_SORT: ProcessSortBy = 'cpu';

export type NetworkStateFilter = 'all' | 'listen' | 'established' | 'time_wait' | 'other';

export interface NetworkServiceSummary {
  key: string;
  isListener: boolean;
  protocol: string;
  pid: number | null;
  processName: string | null;
  localAddress: string | null;
  localPort: number | null;
  uniqueRemoteIps: number;
  connectionCount: number;
  establishedCount: number;
  connections: NetworkEndpoint[];
}

function compareOptionalNumberDescending(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  const leftValid = typeof left === 'number' && Number.isFinite(left);
  const rightValid = typeof right === 'number' && Number.isFinite(right);
  if (leftValid && rightValid) return right - left;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}

function compareCpuDescending(left: ProcessEntry, right: ProcessEntry): number {
  const percentDiff = compareOptionalNumberDescending(left.cpuPercent, right.cpuPercent);
  if (percentDiff !== 0) return percentDiff;
  return compareOptionalNumberDescending(left.cpuTimeSeconds, right.cpuTimeSeconds);
}

function compareMemoryDescending(left: ProcessEntry, right: ProcessEntry): number {
  return compareOptionalNumberDescending(left.memoryBytes, right.memoryBytes);
}

export function sortProcesses(
  entries: readonly ProcessEntry[],
  sortBy: ProcessSortBy,
): ProcessEntry[] {
  return [...entries].sort((left, right) => {
    const primary = sortBy === 'memory'
      ? compareMemoryDescending(left, right)
      : compareCpuDescending(left, right);
    if (primary !== 0) return primary;

    const secondary = sortBy === 'memory'
      ? compareCpuDescending(left, right)
      : compareMemoryDescending(left, right);
    if (secondary !== 0) return secondary;

    return left.pid - right.pid;
  });
}

export function filterProcesses(
  entries: readonly ProcessEntry[],
  query: string,
): ProcessEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...entries];
  return entries.filter((entry) => (
    String(entry.pid).includes(normalized)
    || entry.name.toLowerCase().includes(normalized)
    || (entry.user?.toLowerCase().includes(normalized) ?? false)
    || (entry.executablePath?.toLowerCase().includes(normalized) ?? false)
    || (entry.workingDirectory?.toLowerCase().includes(normalized) ?? false)
    || (entry.commandLine?.toLowerCase().includes(normalized) ?? false)
    || (entry.state?.toLowerCase().includes(normalized) ?? false)
  ));
}

export function networkEndpointsForInterface(
  endpoints: readonly NetworkEndpoint[],
  selectedInterface: NetworkInterface | null,
): NetworkEndpoint[] {
  if (!selectedInterface) return [...endpoints];

  const interfaceAddresses = new Set(
    selectedInterface.addresses.map((address) => address.replace(/\/\d+$/, '')),
  );
  return endpoints.filter((endpoint) => (
    isWildcardAddress(endpoint.localAddress) || interfaceAddresses.has(endpoint.localAddress)
  ));
}

export function isWildcardAddress(address: string): boolean {
  return address === '*' || address === '0.0.0.0' || address === '::' || address === '[::]';
}

export function classifyEndpointState(state: string | null): Exclude<NetworkStateFilter, 'all'> {
  const normalized = (state ?? '').trim().toUpperCase();
  if (normalized === 'LISTEN' || normalized === 'LISTENING') return 'listen';
  if (normalized === 'ESTAB' || normalized === 'ESTABLISHED') return 'established';
  if (normalized === 'TIME-WAIT' || normalized === 'TIME_WAIT' || normalized === 'TIMEWAIT') {
    return 'time_wait';
  }
  return 'other';
}

export function summarizeEndpointStates(
  endpoints: readonly NetworkEndpoint[],
): Record<NetworkStateFilter, number> {
  const counts: Record<NetworkStateFilter, number> = {
    all: endpoints.length,
    listen: 0,
    established: 0,
    time_wait: 0,
    other: 0,
  };
  for (const endpoint of endpoints) {
    counts[classifyEndpointState(endpoint.state)] += 1;
  }
  return counts;
}

export function filterNetworkEndpoints(
  endpoints: readonly NetworkEndpoint[],
  selectedInterface: NetworkInterface | null,
  stateFilter: NetworkStateFilter,
  query: string,
): NetworkEndpoint[] {
  const byInterface = networkEndpointsForInterface(endpoints, selectedInterface);
  const byState = stateFilter === 'all'
    ? byInterface
    : byInterface.filter((endpoint) => classifyEndpointState(endpoint.state) === stateFilter);
  const normalized = query.trim().toLowerCase();
  if (!normalized) return byState;
  return byState.filter((endpoint) => (
    endpoint.protocol.toLowerCase().includes(normalized)
    || endpoint.localAddress.toLowerCase().includes(normalized)
    || (endpoint.localPort !== null && String(endpoint.localPort).includes(normalized))
    || (endpoint.remoteAddress?.toLowerCase().includes(normalized) ?? false)
    || (endpoint.remotePort !== null && String(endpoint.remotePort).includes(normalized))
    || (endpoint.state?.toLowerCase().includes(normalized) ?? false)
    || (endpoint.pid !== null && String(endpoint.pid).includes(normalized))
    || (endpoint.processName?.toLowerCase().includes(normalized) ?? false)
  ));
}

function isListeningEndpoint(endpoint: NetworkEndpoint): boolean {
  const normalized = (endpoint.state ?? '').trim().toUpperCase();
  if (normalized === 'LISTEN' || normalized === 'LISTENING') return true;
  if (normalized === 'UNCONN' && endpoint.remoteAddress === null) return true;
  return false;
}

function normalizeAddressFamily(address: string): 'ipv4' | 'ipv6' | 'any' {
  if (address === '*') return 'any';
  if (address.includes(':')) return 'ipv6';
  return 'ipv4';
}

function listenerMatchesConnection(
  listenerAddress: string,
  connectionAddress: string,
): 'exact' | 'wildcard' | null {
  if (listenerAddress === connectionAddress) return 'exact';
  if (listenerAddress === '*') return 'wildcard';
  if (listenerAddress === '0.0.0.0' && normalizeAddressFamily(connectionAddress) === 'ipv4') {
    return 'wildcard';
  }
  if ((listenerAddress === '::' || listenerAddress === '[::]')
    && (normalizeAddressFamily(connectionAddress) === 'ipv6' || connectionAddress.startsWith('::ffff:'))) {
    return 'wildcard';
  }
  return null;
}

export function aggregateNetworkServices(
  endpoints: readonly NetworkEndpoint[],
): NetworkServiceSummary[] {
  const listeners = new Map<string, NetworkServiceSummary>();
  const activeConnections: NetworkEndpoint[] = [];

  for (const endpoint of endpoints) {
    if (isListeningEndpoint(endpoint)) {
      const protocol = endpoint.protocol.toLowerCase();
      const key = `listen|${protocol}|${endpoint.localAddress}|${endpoint.localPort ?? ''}|${endpoint.pid ?? ''}`;
      if (!listeners.has(key)) {
        listeners.set(key, {
          key,
          isListener: true,
          protocol,
          pid: endpoint.pid,
          processName: endpoint.processName,
          localAddress: endpoint.localAddress,
          localPort: endpoint.localPort,
          uniqueRemoteIps: 0,
          connectionCount: 0,
          establishedCount: 0,
          connections: [],
        });
      }
    } else if (endpoint.remoteAddress !== null) {
      activeConnections.push(endpoint);
    }
  }

  const listenerList = [...listeners.values()];
  const outboundGroups = new Map<string, NetworkServiceSummary>();

  for (const connection of activeConnections) {
    const protocol = connection.protocol.toLowerCase();
    let bestMatch: NetworkServiceSummary | null = null;
    let bestQuality: 'exact' | 'wildcard' | null = null;

    if (connection.localPort !== null) {
      for (const listener of listenerList) {
        if (listener.protocol !== protocol || listener.localPort !== connection.localPort) continue;
        if (listener.localAddress === null) continue;
        const quality = listenerMatchesConnection(listener.localAddress, connection.localAddress);
        if (!quality) continue;
        if (quality === 'exact') {
          bestMatch = listener;
          bestQuality = 'exact';
          break;
        }
        if (bestQuality === null) {
          bestMatch = listener;
          bestQuality = 'wildcard';
        }
      }
    }

    if (bestMatch) {
      bestMatch.connections.push(connection);
      continue;
    }

    const outboundKey = `outbound|${protocol}|${connection.pid ?? ''}|${connection.processName ?? ''}`;
    let group = outboundGroups.get(outboundKey);
    if (!group) {
      group = {
        key: outboundKey,
        isListener: false,
        protocol,
        pid: connection.pid,
        processName: connection.processName,
        localAddress: null,
        localPort: null,
        uniqueRemoteIps: 0,
        connectionCount: 0,
        establishedCount: 0,
        connections: [],
      };
      outboundGroups.set(outboundKey, group);
    }
    group.connections.push(connection);
  }

  const allServices = [...listenerList, ...outboundGroups.values()];
  for (const service of allServices) {
    const remoteIps = new Set<string>();
    let established = 0;
    for (const connection of service.connections) {
      if (connection.remoteAddress) remoteIps.add(connection.remoteAddress);
      if (classifyEndpointState(connection.state) === 'established') established += 1;
    }
    service.uniqueRemoteIps = remoteIps.size;
    service.connectionCount = service.connections.length;
    service.establishedCount = established;
  }

  return allServices.sort((left, right) => {
    if (left.connectionCount !== right.connectionCount) {
      return right.connectionCount - left.connectionCount;
    }
    if (left.isListener !== right.isListener) {
      return left.isListener ? -1 : 1;
    }
    const leftPort = left.localPort ?? Number.MAX_SAFE_INTEGER;
    const rightPort = right.localPort ?? Number.MAX_SAFE_INTEGER;
    if (leftPort !== rightPort) return leftPort - rightPort;
    return (left.pid ?? Number.MAX_SAFE_INTEGER) - (right.pid ?? Number.MAX_SAFE_INTEGER);
  });
}

export function filterNetworkServices(
  services: readonly NetworkServiceSummary[],
  query: string,
): NetworkServiceSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...services];
  return services.filter((service) => (
    service.protocol.toLowerCase().includes(normalized)
    || (service.pid !== null && String(service.pid).includes(normalized))
    || (service.processName?.toLowerCase().includes(normalized) ?? false)
    || (service.localAddress?.toLowerCase().includes(normalized) ?? false)
    || (service.localPort !== null && String(service.localPort).includes(normalized))
    || service.connections.some((conn) => (
      (conn.remoteAddress?.toLowerCase().includes(normalized) ?? false)
      || (conn.remotePort !== null && String(conn.remotePort).includes(normalized))
    ))
  ));
}

export function routeTableNames(routes: readonly RouteEntry[]): string[] {
  const names = new Set<string>();
  for (const route of routes) {
    if (route.table) names.add(route.table);
  }
  return [...names].sort((left, right) => {
    if (left === 'main') return -1;
    if (right === 'main') return 1;
    return left.localeCompare(right);
  });
}

export function filterRoutes(
  routes: readonly RouteEntry[],
  tableFilter: string,
  query: string,
): RouteEntry[] {
  const byTable = tableFilter === ALL_ROUTE_TABLES
    ? [...routes]
    : routes.filter((route) => (route.table ?? '') === tableFilter);
  const normalized = query.trim().toLowerCase();
  if (!normalized) return byTable;
  return byTable.filter((route) => (
    route.destination.toLowerCase().includes(normalized)
    || (route.gateway?.toLowerCase().includes(normalized) ?? false)
    || (route.interfaceName?.toLowerCase().includes(normalized) ?? false)
    || (route.protocol?.toLowerCase().includes(normalized) ?? false)
    || (route.table?.toLowerCase().includes(normalized) ?? false)
    || (route.scope?.toLowerCase().includes(normalized) ?? false)
    || (route.sourceAddress?.toLowerCase().includes(normalized) ?? false)
    || (route.routeType?.toLowerCase().includes(normalized) ?? false)
  ));
}
