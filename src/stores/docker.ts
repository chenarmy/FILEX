import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectDockerLogs, collectDockerSnapshot, runDockerContainerAction } from '@/api/domain/dockerApi';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import type {
  AppError,
  DockerContainerAction,
  DockerLogsSnapshot,
  DockerSnapshot,
} from '@/types/contracts';

interface DockerSessionCache {
  snapshot: DockerSnapshot | null;
  logs: DockerLogsSnapshot | null;
  error: AppError | null;
}

export const useDockerStore = defineStore('docker', () => {
  const snapshot = ref<DockerSnapshot | null>(null);
  const logs = ref<DockerLogsSnapshot | null>(null);
  const loading = ref(false);
  const logsLoading = ref(false);
  const actingContainerId = ref<string | null>(null);
  const error = ref<AppError | null>(null);
  const sessionCaches = createSessionStateCache<DockerSessionCache>();
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function persistCurrentSession(): void {
    if (!snapshotSessionId) return;
    if (snapshot.value === null && logs.value === null && error.value === null) return;
    sessionCaches.set(snapshotSessionId, {
      snapshot: snapshot.value,
      logs: logs.value,
      error: error.value,
    });
  }

  function resetActive(): void {
    snapshot.value = null;
    logs.value = null;
    error.value = null;
    loading.value = false;
    logsLoading.value = false;
    actingContainerId.value = null;
  }

  function activateSession(nextSessionId: string | null): boolean {
    persistCurrentSession();
    if (
      nextSessionId !== null
      && snapshotSessionId === nextSessionId
      && (snapshot.value !== null || logs.value !== null || error.value !== null)
    ) {
      return true;
    }
    generation += 1;
    snapshotSessionId = nextSessionId;
    loading.value = false;
    logsLoading.value = false;
    actingContainerId.value = null;
    if (nextSessionId !== null) {
      const cached = sessionCaches.get(nextSessionId);
      if (cached) {
        snapshot.value = cached.snapshot;
        logs.value = cached.logs;
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

  async function collect(sessionId: string): Promise<void> {
    syncSession(sessionId);
    if (loading.value) return;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectDockerSnapshot(sessionId);
      if (request !== generation || snapshotSessionId !== sessionId) return;
      if (result.ok) snapshot.value = result.data;
      else error.value = result.error;
      persistCurrentSession();
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function fetchLogs(
    sessionId: string,
    containerId: string,
    tailLines = 100,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    syncSession(sessionId);
    if (logsLoading.value) return;
    const request = ++generation;
    if (!options.silent) logsLoading.value = true;
    error.value = null;
    try {
      const result = await collectDockerLogs(sessionId, containerId, tailLines);
      if (request !== generation || snapshotSessionId !== sessionId) return;
      if (result.ok) logs.value = result.data;
      else if (!options.silent) error.value = result.error;
      persistCurrentSession();
    } finally {
      if (request === generation && !options.silent) logsLoading.value = false;
    }
  }

  async function performAction(
    sessionId: string,
    containerId: string,
    action: DockerContainerAction,
  ): Promise<boolean> {
    syncSession(sessionId);
    if (actingContainerId.value !== null || loading.value) return false;
    const request = ++generation;
    actingContainerId.value = containerId;
    error.value = null;
    let succeeded = false;
    try {
      const result = await runDockerContainerAction(sessionId, containerId, action);
      if (request !== generation) return false;
      if (result.ok) succeeded = true;
      else {
        error.value = result.error;
        persistCurrentSession();
      }
    } finally {
      if (request === generation) actingContainerId.value = null;
    }
    if (succeeded && request === generation) {
      await collect(sessionId);
    }
    return succeeded;
  }

  function clear(): void {
    generation += 1;
    if (snapshotSessionId) sessionCaches.delete(snapshotSessionId);
    resetActive();
  }

  return {
    snapshot,
    logs,
    loading,
    logsLoading,
    actingContainerId,
    error,
    activateSession,
    dropSession,
    collect,
    fetchLogs,
    performAction,
    clear,
  };
});
