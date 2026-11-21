import type {
  NetworkEndpoint,
  NetworkInterface,
  ProcessEntry,
  ProcessSortBy,
} from '@/types/contracts';

export const ALL_NETWORK_INTERFACES = '';
export const DEFAULT_PROCESS_SORT: ProcessSortBy = 'cpu';

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

export function networkEndpointsForInterface(
  endpoints: NetworkEndpoint[],
  selectedInterface: NetworkInterface | null,
): NetworkEndpoint[] {
  if (!selectedInterface) return endpoints;

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
