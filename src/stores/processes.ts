import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { collectProcessSnapshot, terminateRemoteProcess } from '@/api/domain/processesApi';
import type { AppError, ProcessSignal, ProcessSnapshot } from '@/types/contracts';

export const useProcessesStore = defineStore('processes', () => {
  const snapshot = ref<ProcessSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const terminatingPid = ref<number | null>(null);
  const displayState = computed(() => snapshot.value?.state ?? 'unprobed');
  let snapshotSessionId: string | null = null;
  let generation = 0;

  async function collect(sessionId: string): Promise<void> {
    if (snapshotSessionId !== sessionId) {
      generation += 1;
      snapshotSessionId = sessionId;
      snapshot.value = null;
      error.value = null;
      loading.value = false;
      terminatingPid.value = null;
    }
    if (loading.value || terminatingPid.value !== null) return;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectProcessSnapshot(sessionId);
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
      }
    } finally {
      if (request === generation) terminatingPid.value = null;
    }
    if (accepted && request === generation) await collect(sessionId);
    return accepted;
  }

  function clear(): void {
    generation += 1;
    snapshotSessionId = null;
    snapshot.value = null;
    error.value = null;
    loading.value = false;
    terminatingPid.value = null;
  }

  return { snapshot, loading, error, terminatingPid, displayState, collect, terminate, clear };
});
