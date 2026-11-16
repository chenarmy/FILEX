import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  acquireElevatedAccess,
  getElevatedAccessStatus,
  revokeElevatedAccess,
} from '@/api/domain/privilegeApi';
import { useSessionsStore } from '@/stores/sessions';
import type {
  AcquireElevatedAccessInput,
  AppError,
  ElevatedAccessLeaseSummary,
  SessionSummary,
} from '@/types/contracts';

export function formatRemainingTtl(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function leaseMatchesSession(
  lease: ElevatedAccessLeaseSummary,
  session: SessionSummary | undefined,
  nowMs = Date.now(),
): boolean {
  if (!session || session.sessionKind !== 'ssh' || session.state !== 'connected') return false;
  if (lease.state !== 'elevated') return false;
  if (
    lease.generation !== session.generation
    || lease.host !== session.host
    || lease.port !== session.port
    || lease.username !== session.username
  ) {
    return false;
  }
  return lease.expiresAtMs !== null && nowMs < lease.expiresAtMs;
}

export const usePrivilegeStore = defineStore('privilege', () => {
  const sessions = useSessionsStore();
  const leases = ref<Record<string, ElevatedAccessLeaseSummary>>({});
  const busy = ref(false);
  const error = ref<AppError | null>(null);
  const nowMs = ref(Date.now());
  let timerId: number | null = null;

  function pruneExpiredOrMismatched(currentNow = Date.now()): void {
    const next: Record<string, ElevatedAccessLeaseSummary> = {};
    let changed = false;
    for (const [sessionId, lease] of Object.entries(leases.value)) {
      const session = sessions.summaries.find((item) => item.id === sessionId);
      if (leaseMatchesSession(lease, session, currentNow)) {
        next[sessionId] = lease;
      } else {
        changed = true;
        sessions.syncElevatedCapability(sessionId, false);
      }
    }
    if (changed) leases.value = next;
    syncTicker(Object.keys(next).length > 0);
  }

  function syncTicker(hasActiveLeases: boolean): void {
    if (hasActiveLeases && timerId === null && typeof window !== 'undefined') {
      timerId = window.setInterval(() => {
        const current = Date.now();
        nowMs.value = current;
        pruneExpiredOrMismatched(current);
      }, 1000);
    } else if (!hasActiveLeases && timerId !== null && typeof window !== 'undefined') {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  watch(
    () => sessions.summaries,
    () => pruneExpiredOrMismatched(Date.now()),
    { deep: true },
  );

  function clearError(): void {
    error.value = null;
  }

  function getLease(sessionId: string | null | undefined): ElevatedAccessLeaseSummary | null {
    if (!sessionId) return null;
    const lease = leases.value[sessionId];
    if (!lease) return null;
    const session = sessions.summaries.find((item) => item.id === sessionId);
    if (!leaseMatchesSession(lease, session, nowMs.value)) return null;
    return lease;
  }

  function isElevated(sessionId: string | null | undefined): boolean {
    return getLease(sessionId) !== null;
  }

  function remainingSeconds(sessionId: string | null | undefined): number {
    const lease = getLease(sessionId);
    if (!lease || lease.expiresAtMs === null) return 0;
    return Math.max(0, Math.ceil((lease.expiresAtMs - nowMs.value) / 1000));
  }

  function clearSession(sessionId: string): void {
    sessions.syncElevatedCapability(sessionId, false);
    if (!(sessionId in leases.value)) return;
    const next = { ...leases.value };
    delete next[sessionId];
    leases.value = next;
    syncTicker(Object.keys(next).length > 0);
  }

  async function refreshStatus(sessionId: string): Promise<ElevatedAccessLeaseSummary | null> {
    const result = await getElevatedAccessStatus(sessionId);
    if (!result.ok) return null;
    nowMs.value = Date.now();
    const session = sessions.summaries.find((item) => item.id === sessionId);
    if (leaseMatchesSession(result.data, session, nowMs.value)) {
      leases.value = { ...leases.value, [sessionId]: result.data };
      sessions.syncElevatedCapability(sessionId, true);
      syncTicker(true);
      return result.data;
    }
    clearSession(sessionId);
    return result.data;
  }

  async function acquire(input: AcquireElevatedAccessInput): Promise<ElevatedAccessLeaseSummary | null> {
    if (busy.value) return null;
    busy.value = true;
    error.value = null;
    try {
      const result = await acquireElevatedAccess(input);
      if (!result.ok) {
        error.value = result.error;
        return null;
      }
      nowMs.value = Date.now();
      if (result.data.state === 'elevated') {
        leases.value = { ...leases.value, [result.data.sessionId]: result.data };
        sessions.syncElevatedCapability(result.data.sessionId, true);
        syncTicker(true);
      } else {
        clearSession(result.data.sessionId);
      }
      await sessions.refreshSummaries();
      return result.data;
    } finally {
      busy.value = false;
    }
  }

  async function revoke(sessionId: string): Promise<boolean> {
    clearSession(sessionId);
    const result = await revokeElevatedAccess(sessionId);
    if (result.ok) {
      await sessions.refreshSummaries();
      return true;
    }
    error.value = result.error;
    return false;
  }

  const activeLeaseCount = computed(() =>
    Object.keys(leases.value).filter((id) => isElevated(id)).length,
  );

  return {
    leases,
    busy,
    error,
    nowMs,
    activeLeaseCount,
    clearError,
    getLease,
    isElevated,
    remainingSeconds,
    clearSession,
    refreshStatus,
    acquire,
    revoke,
  };
});
