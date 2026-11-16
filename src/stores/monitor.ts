import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { collectSystemMonitor } from '@/api/domain/monitorApi';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import type { AppError, SystemMonitorSnapshot } from '@/types/contracts';

export interface MonitorHistorySample {
  atMs: number;
  receive: number | null;
  transmit: number | null;
}

interface MonitorSessionCache {
  snapshot: SystemMonitorSnapshot | null;
  error: AppError | null;
  stale: boolean;
  consecutiveFailures: number;
  history: MonitorHistorySample[];
}

const MONITOR_HISTORY_LIMIT = 60;

export const useMonitorStore = defineStore('monitor', () => {
  const snapshot = ref<SystemMonitorSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const stale = ref(false);
  const consecutiveFailures = ref(0);
  const history = ref<MonitorHistorySample[]>([]);
  const displayState = computed(() => stale.value && snapshot.value?.state === 'live'
    ? 'stale'
    : (snapshot.value?.state ?? 'unprobed'));
  const sessionCaches = createSessionStateCache<MonitorSessionCache>();
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function persistCurrentSession(): void {
    if (!snapshotSessionId) return;
    if (snapshot.value === null && error.value === null && history.value.length === 0) return;
    sessionCaches.set(snapshotSessionId, {
      snapshot: snapshot.value,
      error: error.value,
      stale: stale.value,
      consecutiveFailures: consecutiveFailures.value,
      history: [...history.value],
    });
  }

  function resetActive(): void {
    snapshot.value = null;
    error.value = null;
    loading.value = false;
    stale.value = false;
    consecutiveFailures.value = 0;
    history.value = [];
  }

  function activateSession(nextSessionId: string | null): boolean {
    persistCurrentSession();
    if (
      nextSessionId !== null
      && snapshotSessionId === nextSessionId
      && (snapshot.value !== null || error.value !== null || history.value.length > 0)
    ) {
      return true;
    }
    generation += 1;
    snapshotSessionId = nextSessionId;
    loading.value = false;
    if (nextSessionId !== null) {
      const cached = sessionCaches.get(nextSessionId);
      if (cached) {
        snapshot.value = cached.snapshot;
        error.value = cached.error;
        stale.value = cached.stale;
        consecutiveFailures.value = cached.consecutiveFailures;
        history.value = [...cached.history];
        return true;
      }
    }
    resetActive();
    return false;
  }

  function dropSession(sessionId: string): void {
    sessionCaches.delete(sessionId);
    if (snapshotSessionId === sessionId) {
      generation += 1;
      snapshotSessionId = null;
      resetActive();
    }
  }

  async function collect(sessionId: string): Promise<void> {
    if (snapshotSessionId !== sessionId) activateSession(sessionId);
    if (loading.value) return;
    stale.value = snapshot.value?.state === 'live'
      && Date.now() - snapshot.value.collectedAtMs > 60_000;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectSystemMonitor(sessionId);
      if (request !== generation || snapshotSessionId !== sessionId) return;
      if (result.ok) {
        snapshot.value = result.data;
        stale.value = false;
        consecutiveFailures.value = result.data.state === 'failed'
          ? Math.min(8, consecutiveFailures.value + 1)
          : 0;
        const nextHistory = [...history.value, {
          atMs: result.data.collectedAtMs,
          receive: result.data.networkReceiveBytesPerSecond,
          transmit: result.data.networkTransmitBytesPerSecond,
        }];
        while (nextHistory.length > MONITOR_HISTORY_LIMIT) nextHistory.shift();
        history.value = nextHistory;
      } else {
        error.value = result.error;
        stale.value = snapshot.value?.state === 'live';
        consecutiveFailures.value = Math.min(8, consecutiveFailures.value + 1);
      }
      persistCurrentSession();
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  function clear(): void {
    generation += 1;
    if (snapshotSessionId) sessionCaches.delete(snapshotSessionId);
    resetActive();
  }

  return {
    snapshot, loading, error, stale, consecutiveFailures, displayState, history,
    activateSession, dropSession, collect, clear,
  };
});
