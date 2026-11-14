import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectOpsSnapshot } from '@/api/domain/opsApi';
import type { AppError, OpsCategory, OpsSnapshot } from '@/types/contracts';

export const useOpsStore = defineStore('ops', () => {
  const snapshots = ref<Partial<Record<OpsCategory, OpsSnapshot>>>({});
  const loadingCategory = ref<OpsCategory | null>(null);
  const error = ref<AppError | null>(null);
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function syncSession(sessionId: string): void {
    if (snapshotSessionId === sessionId) return;
    generation += 1;
    snapshotSessionId = sessionId;
    snapshots.value = {};
    error.value = null;
    loadingCategory.value = null;
  }

  async function collect(sessionId: string, category: OpsCategory): Promise<void> {
    syncSession(sessionId);
    if (loadingCategory.value === category) return;
    const request = ++generation;
    loadingCategory.value = category;
    error.value = null;
    try {
      const result = await collectOpsSnapshot(sessionId, category);
      if (request !== generation) return;
      if (result.ok) {
        snapshots.value = { ...snapshots.value, [category]: result.data };
      } else {
        error.value = result.error;
      }
    } finally {
      if (request === generation) loadingCategory.value = null;
    }
  }

  function clear(): void {
    generation += 1;
    snapshotSessionId = null;
    snapshots.value = {};
    error.value = null;
    loadingCategory.value = null;
  }

  return {
    snapshots,
    loadingCategory,
    error,
    collect,
    clear,
  };
});
