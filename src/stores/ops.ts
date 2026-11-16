import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectOpsSnapshot } from '@/api/domain/opsApi';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import type { AppError, OpsCategory, OpsSnapshot } from '@/types/contracts';

interface OpsSessionCache {
  snapshots: Partial<Record<OpsCategory, OpsSnapshot>>;
  error: AppError | null;
}

export const useOpsStore = defineStore('ops', () => {
  const snapshots = ref<Partial<Record<OpsCategory, OpsSnapshot>>>({});
  const loadingCategory = ref<OpsCategory | null>(null);
  const error = ref<AppError | null>(null);
  const sessionCaches = createSessionStateCache<OpsSessionCache>();
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function persistCurrentSession(): void {
    if (!snapshotSessionId) return;
    if (Object.keys(snapshots.value).length === 0 && error.value === null) return;
    sessionCaches.set(snapshotSessionId, {
      snapshots: { ...snapshots.value },
      error: error.value,
    });
  }

  function resetActive(): void {
    snapshots.value = {};
    error.value = null;
    loadingCategory.value = null;
  }

  function activateSession(nextSessionId: string | null): boolean {
    persistCurrentSession();
    if (
      nextSessionId !== null
      && snapshotSessionId === nextSessionId
      && (Object.keys(snapshots.value).length > 0 || error.value !== null)
    ) {
      return true;
    }
    generation += 1;
    snapshotSessionId = nextSessionId;
    loadingCategory.value = null;
    if (nextSessionId !== null) {
      const cached = sessionCaches.get(nextSessionId);
      if (cached) {
        snapshots.value = { ...cached.snapshots };
        error.value = cached.error;
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

  function syncSession(sessionId: string): void {
    if (snapshotSessionId === sessionId) return;
    activateSession(sessionId);
  }

  async function collect(sessionId: string, category: OpsCategory): Promise<void> {
    syncSession(sessionId);
    if (loadingCategory.value === category) return;
    const request = ++generation;
    loadingCategory.value = category;
    error.value = null;
    try {
      const result = await collectOpsSnapshot(sessionId, category);
      if (request !== generation || snapshotSessionId !== sessionId) return;
      if (result.ok) {
        snapshots.value = { ...snapshots.value, [category]: result.data };
      } else {
        error.value = result.error;
      }
      persistCurrentSession();
    } finally {
      if (request === generation) loadingCategory.value = null;
    }
  }

  function clear(): void {
    generation += 1;
    if (snapshotSessionId) sessionCaches.delete(snapshotSessionId);
    resetActive();
  }

  return {
    snapshots,
    loadingCategory,
    error,
    activateSession,
    dropSession,
    collect,
    clear,
  };
});
