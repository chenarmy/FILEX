export function isLoopbackAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const parts = normalized.split('.');
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
}
