import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectNetworkSnapshot } from '@/api/domain/networkApi';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import type { AppError, NetworkSnapshot } from '@/types/contracts';

interface NetworkSessionCache {
  snapshot: NetworkSnapshot | null;
  error: AppError | null;
}

export const useNetworkStore = defineStore('network', () => {
  const snapshot = ref<NetworkSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const sessionCaches = createSessionStateCache<NetworkSessionCache>();
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function persistCurrentSession(): void {
    if (!snapshotSessionId) return;
    if (snapshot.value === null && error.value === null) return;
    sessionCaches.set(snapshotSessionId, { snapshot: snapshot.value, error: error.value });
  }

  function resetActive(): void {
    snapshot.value = null;
    loading.value = false;
    error.value = null;
  }

  function activateSession(nextSessionId: string | null): boolean {
    persistCurrentSession();
    if (
      nextSessionId !== null
      && snapshotSessionId === nextSessionId
      && (snapshot.value !== null || error.value !== null)
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
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectNetworkSnapshot(sessionId);
      if (request !== generation || snapshotSessionId !== sessionId) return;
      if (result.ok) snapshot.value = result.data;
      else {
        snapshot.value = null;
        error.value = result.error;
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

  return { snapshot, loading, error, activateSession, dropSession, collect, clear };
});
