import type { NetworkEndpoint, NetworkInterface } from '@/types/contracts';

export const ALL_NETWORK_INTERFACES = '';

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
