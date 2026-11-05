import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { collectSystemMonitor } from '@/api/domain/monitorApi';
import type { AppError, SystemMonitorSnapshot } from '@/types/contracts';

export interface MonitorHistorySample {
  atMs: number;
  receive: number | null;
  transmit: number | null;
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
  let generation = 0;

  async function collect(sessionId: string): Promise<void> {
    if (loading.value) return;
    stale.value = snapshot.value?.state === 'live'
      && Date.now() - snapshot.value.collectedAtMs > 60_000;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectSystemMonitor(sessionId);
      if (request !== generation) return;
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
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  function clear(): void {
    generation += 1;
    snapshot.value = null;
    error.value = null;
    loading.value = false;
    stale.value = false;
    consecutiveFailures.value = 0;
    history.value = [];
  }

  return {
    snapshot, loading, error, stale, consecutiveFailures, displayState, history, collect, clear,
  };
});
