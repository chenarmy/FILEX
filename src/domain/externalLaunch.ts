import type { ExternalLaunchRequest } from '@/types/contracts';

export function shouldPromptExternalLaunchUsername(request: ExternalLaunchRequest): boolean {
  return request.username.trim().length === 0;
}

export function externalLaunchProfileName(
  request: ExternalLaunchRequest,
  fallbackName?: string,
): string {
  const custom = request.displayName?.trim();
  if (custom && custom.length >= 2) return custom;
  const fallback = fallbackName?.trim();
  if (fallback && fallback.length >= 2) return fallback;
  return `${request.username.trim()}@${request.host.trim()}`;
}
