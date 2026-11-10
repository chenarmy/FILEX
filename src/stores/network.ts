import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectNetworkSnapshot } from '@/api/domain/networkApi';
import type { AppError, NetworkSnapshot } from '@/types/contracts';

export const useNetworkStore = defineStore('network', () => {
  const snapshot = ref<NetworkSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  let snapshotSessionId: string | null = null;
  let generation = 0;

  async function collect(sessionId: string): Promise<void> {
    if (snapshotSessionId !== sessionId) {
      generation += 1;
      snapshotSessionId = sessionId;
      snapshot.value = null;
      loading.value = false;
      error.value = null;
    }
    if (loading.value) return;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectNetworkSnapshot(sessionId);
      if (request !== generation) return;
      if (result.ok) snapshot.value = result.data;
      else {
        snapshot.value = null;
        error.value = result.error;
      }
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  function clear(): void {
    generation += 1;
    snapshotSessionId = null;
    snapshot.value = null;
    loading.value = false;
    error.value = null;
  }

  return { snapshot, loading, error, collect, clear };
});
