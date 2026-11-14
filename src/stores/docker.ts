import { ref } from 'vue';
import { defineStore } from 'pinia';
import { collectDockerLogs, collectDockerSnapshot, runDockerContainerAction } from '@/api/domain/dockerApi';
import type {
  AppError,
  DockerContainerAction,
  DockerLogsSnapshot,
  DockerSnapshot,
} from '@/types/contracts';

export const useDockerStore = defineStore('docker', () => {
  const snapshot = ref<DockerSnapshot | null>(null);
  const logs = ref<DockerLogsSnapshot | null>(null);
  const loading = ref(false);
  const logsLoading = ref(false);
  const actingContainerId = ref<string | null>(null);
  const error = ref<AppError | null>(null);
  let snapshotSessionId: string | null = null;
  let generation = 0;

  function syncSession(sessionId: string): void {
    if (snapshotSessionId === sessionId) return;
    generation += 1;
    snapshotSessionId = sessionId;
    snapshot.value = null;
    logs.value = null;
    error.value = null;
    loading.value = false;
    logsLoading.value = false;
    actingContainerId.value = null;
  }

  async function collect(sessionId: string): Promise<void> {
    syncSession(sessionId);
    if (loading.value) return;
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await collectDockerSnapshot(sessionId);
      if (request !== generation) return;
      if (result.ok) snapshot.value = result.data;
      else error.value = result.error;
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function fetchLogs(sessionId: string, containerId: string, tailLines = 200): Promise<void> {
    syncSession(sessionId);
    if (logsLoading.value) return;
    const request = ++generation;
    logsLoading.value = true;
    error.value = null;
    try {
      const result = await collectDockerLogs(sessionId, containerId, tailLines);
      if (request !== generation) return;
      if (result.ok) logs.value = result.data;
      else error.value = result.error;
    } finally {
      if (request === generation) logsLoading.value = false;
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
      else error.value = result.error;
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
    snapshotSessionId = null;
    snapshot.value = null;
    logs.value = null;
    error.value = null;
    loading.value = false;
    logsLoading.value = false;
    actingContainerId.value = null;
  }

  return {
    snapshot,
    logs,
    loading,
    logsLoading,
    actingContainerId,
    error,
    collect,
    fetchLogs,
    performAction,
    clear,
  };
});
