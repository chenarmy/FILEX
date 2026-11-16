import type { CapabilityKind, SessionSummary } from '@/types/contracts';

/** Returns true when the summary represents an OS-local terminal session. */
export function isLocalSession(session: SessionSummary | null | undefined): boolean {
  return session?.sessionKind === 'local';
}

/** Returns true when the summary represents a remote SSH session. */
export function isSshSession(session: SessionSummary | null | undefined): boolean {
  return Boolean(session) && !isLocalSession(session);
}

/** Checks whether the session carries a specific capability, falling back safely for mock summaries. */
export function hasCapability(
  session: SessionSummary | null | undefined,
  capability: CapabilityKind,
): boolean {
  if (!session) return false;
  if (Array.isArray(session.capabilities) && session.capabilities.length > 0) {
    return session.capabilities.includes(capability);
  }
  if (session.sessionKind === 'local') {
    return capability === 'local_shell' || capability === 'local_files';
  }
  return capability !== 'local_shell' && capability !== 'local_files' && capability !== 'elevated_file_access';
}
