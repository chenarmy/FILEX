import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { collectProcessSnapshot, terminateRemoteProcess } from '@/api/domain/processesApi';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import type { AppError, ProcessSignal, ProcessSnapshot, ProcessSortBy } from '@/types/contracts';

interface ProcessSessionCache {
  snapshot: ProcessSnapshot | null;
  error: AppError | null;
}

export const useProcessesStore = defineStore('processes', () => {
  const snapshot = ref<ProcessSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const terminatingPid = ref<number | null>(null);
  const displayState = computed(() => snapshot.value?.state ?? 'unprobed');
  const sessionCaches = createSessionStateCache<ProcessSessionCache>();
  let snapshotSessionId: string | null = null;
  let activeSortBy: ProcessSortBy = 'cpu';
  let generation = 0;

  function persistCurrentSession(): void {
    if (!snapshotSessionId) return;
    if (snapshot.value === null && error.value === null) return;
    sessionCaches.set(snapshotSessionId, { snapshot: snapshot.value, error: error.value });
  }

  function resetActive(): void {
    snapshot.value = null;
    error.value = null;
    loading.value = false;
    terminatingPid.value = null;
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
    terminatingPid.value = null;
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

  async function collect(sessionId: string, sortBy: ProcessSortBy = 'cpu'): Promise<void> {
    if (snapshotSessionId !== sessionId) activateSession(sessionId);
    if (terminatingPid.value !== null) return;
    if (loading.value && activeSortBy === sortBy) return;
    const request = ++generation;
    activeSortBy = sortBy;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectProcessSnapshot(sessionId, sortBy);
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

  async function terminate(sessionId: string, pid: number, signal: ProcessSignal = 'SIGTERM'): Promise<boolean> {
    const snapshotId = snapshot.value?.snapshotId;
    if (snapshotSessionId !== sessionId || !snapshotId || terminatingPid.value !== null || loading.value) return false;
    const request = ++generation;
    terminatingPid.value = pid;
    error.value = null;
    let accepted = false;
    try {
      const result = await terminateRemoteProcess(sessionId, snapshotId, pid, signal);
      if (request !== generation) return false;
      if (result.ok) accepted = true;
      else {
        snapshot.value = null;
        error.value = result.error;
        persistCurrentSession();
      }
    } finally {
      if (request === generation) terminatingPid.value = null;
    }
    if (accepted && request === generation) await collect(sessionId, activeSortBy);
    return accepted;
  }

  function clear(): void {
    generation += 1;
    if (snapshotSessionId) sessionCaches.delete(snapshotSessionId);
    resetActive();
  }

  return {
    snapshot, loading, error, terminatingPid, displayState,
    activateSession, dropSession, collect, terminate, clear,
  };
});
