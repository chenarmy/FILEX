import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  cancelTransfer,
  clearCompletedTransfers,
  downloadRemoteArchive,
  enqueueTransfer,
  listTransfers,
  pauseTransfer,
  resetTransferStaging,
  resumeTransfer,
  retryTransfer,
} from '@/api/domain/transfersApi';
import { openLocalDirectory } from '@/api/domain/localFilesApi';
import { isTauriRuntime } from '@/api/common';
import { updateSpeedSample, type SpeedSample } from '@/domain/transferSpeed';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useEventsStore } from '@/stores/events';
import type {
  AppError,
  CreateTransferInput,
  DownloadRemoteArchiveInput,
  TransferTask,
} from '@/types/contracts';

interface DownloadOpenBatch {
  folderPath: string;
  pendingIds: Set<string>;
  completedCount: number;
}

export const useTransfersStore = defineStore('transfers', () => {
  const tasks = ref<TransferTask[]>([]);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const speedSamples = ref<Record<string, SpeedSample>>({});
  const downloadBatches: DownloadOpenBatch[] = [];
  let unlistenTransfer: UnlistenFn | null = null;

  const activeTasks = computed(() =>
    tasks.value.filter((task) => task.state === 'queued' || task.state === 'running' || task.state === 'paused'),
  );
  const historyTasks = computed(() =>
    tasks.value.filter((task) => task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled'),
  );
  const aggregateSpeedBytesPerSecond = computed(() => {
    let total = 0;
    for (const task of tasks.value) {
      if (task.state !== 'running') continue;
      const rate = speedSamples.value[task.id]?.bytesPerSecond ?? 0;
      if (rate > 0) total += rate;
    }
    return total;
  });

  function speedForTask(task: TransferTask): number | null {
    if (task.state === 'running') {
      const sample = speedSamples.value[task.id];
      if (sample && sample.bytesPerSecond > 0) return sample.bytesPerSecond;
      const elapsedMs = Math.max(0, task.updatedAtMs - task.createdAtMs);
      if (elapsedMs >= 100 && task.bytesTransferred > 0) {
        return (task.bytesTransferred * 1000) / elapsedMs;
      }
      return 0;
    }
    if (task.state === 'completed' && task.bytesTransferred > 0) {
      const elapsedMs = Math.max(0, task.updatedAtMs - task.createdAtMs);
      if (elapsedMs >= 50) return (task.bytesTransferred * 1000) / elapsedMs;
    }
    return null;
  }

  function trackDownloadBatch(folderPath: string, taskIds: readonly string[]): void {
    const cleanFolder = folderPath.trim();
    const ids = taskIds.filter(Boolean);
    if (!cleanFolder || ids.length === 0) return;
    const batch: DownloadOpenBatch = {
      folderPath: cleanFolder,
      pendingIds: new Set(ids),
      completedCount: 0,
    };
    downloadBatches.push(batch);
    // Check if any tracked task already completed synchronously.
    for (const id of ids) {
      const existing = tasks.value.find((task) => task.id === id);
      if (existing && ['completed', 'failed', 'cancelled'].includes(existing.state)) {
        settleDownloadBatch(existing);
      }
    }
  }

  function settleDownloadBatch(task: TransferTask): void {
    if (!['completed', 'failed', 'cancelled'].includes(task.state)) return;
    for (let index = downloadBatches.length - 1; index >= 0; index -= 1) {
      const batch = downloadBatches[index];
      if (!batch || !batch.pendingIds.has(task.id)) continue;
      batch.pendingIds.delete(task.id);
      if (task.state === 'completed') batch.completedCount += 1;
      if (batch.pendingIds.size === 0) {
        downloadBatches.splice(index, 1);
        if (batch.completedCount > 0 && useSettingsStore().value.autoOpenDownloadFolder) {
          void openLocalDirectory(batch.folderPath);
        }
      }
    }
  }

  function upsert(task: TransferTask): void {
    const index = tasks.value.findIndex((item) => item.id === task.id);
    const previousState = index >= 0 ? tasks.value[index]?.state : null;
    if (index >= 0) tasks.value[index] = task;
    else tasks.value.unshift(task);

    if (task.state === 'running') {
      const sampleTime = task.updatedAtMs || Date.now();
      const updatedSample = updateSpeedSample(speedSamples.value[task.id], task.bytesTransferred, sampleTime);
      speedSamples.value = { ...speedSamples.value, [task.id]: updatedSample };
    } else if (speedSamples.value[task.id]) {
      const next = { ...speedSamples.value };
      delete next[task.id];
      speedSamples.value = next;
    }

    if (previousState !== task.state) {
      useEventsStore().record('transfer', `TRANSFER_${task.state.toUpperCase()}`, task.state === 'failed' ? 'error' : task.state === 'completed' ? 'success' : 'info', { transferId: task.id, bytes: task.bytesTransferred });
      settleDownloadBatch(task);
    }
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listTransfers();
      if (result.ok) tasks.value = result.data;
      else error.value = result.error;
    } finally {
      loading.value = false;
    }
  }

  function resolveConnectedSession(profileId: string | null | undefined) {
    if (!profileId) return null;
    const sessions = useSessionsStore();
    if (sessions.activeSession?.profileId === profileId && sessions.activeSession.state === 'connected') {
      return sessions.activeSession;
    }
    return sessions.summaries.find((item) => item.profileId === profileId && item.state === 'connected') ?? null;
  }

  async function enqueueTask(
    input: CreateTransferInput,
    sessionIdOverride?: string | null,
    destinationSessionIdOverride?: string | null,
  ): Promise<TransferTask | null> {
    const sessionId = sessionIdOverride === undefined
      ? (resolveConnectedSession(input.profileId)?.id ?? null)
      : sessionIdOverride;
    const result = input.direction === 'remote_to_remote'
      ? await enqueueTransfer(
        input,
        sessionId,
        destinationSessionIdOverride === undefined
          ? (resolveConnectedSession(input.destinationProfileId)?.id ?? null)
          : destinationSessionIdOverride,
      )
      : await enqueueTransfer(input, sessionId);
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    upsert(result.data);
    return result.data;
  }

  async function enqueue(
    input: CreateTransferInput,
    sessionIdOverride?: string | null,
    destinationSessionIdOverride?: string | null,
  ): Promise<boolean> {
    return (await enqueueTask(input, sessionIdOverride, destinationSessionIdOverride)) !== null;
  }

  async function downloadArchive(input: DownloadRemoteArchiveInput): Promise<TransferTask | null> {
    error.value = null;
    const result = await downloadRemoteArchive(input);
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    upsert(result.data);
    trackDownloadBatch(input.localDirectory, [result.data.id]);
    return result.data;
  }

  async function cancel(id: string): Promise<void> {
    error.value = null;
    const result = await cancelTransfer(id);
    if (result.ok) upsert(result.data);
    else error.value = result.error;
  }

  async function pause(id: string): Promise<void> {
    error.value = null;
    const result = await pauseTransfer(id);
    if (result.ok) upsert(result.data);
    else error.value = result.error;
  }

  async function retry(id: string): Promise<void> {
    const task = tasks.value.find((item) => item.id === id);
    const sourceSession = task ? resolveConnectedSession(task.profileId) : null;
    const destinationSession = task?.direction === 'remote_to_remote'
      ? resolveConnectedSession(task.destinationProfileId)
      : null;
    error.value = null;
    if (task?.resumeState === 'identity_changed') {
      error.value = {
        code: 'TRANSFER_IDENTITY_CHANGED',
        messageKey: 'errors.transferIdentityChanged',
        retryable: false,
        remoteState: 'unchanged',
      };
      return;
    }
    const checkpointedResume = task?.state === 'paused' || (task?.state === 'failed' && Boolean(task.stagingPath) && task.error?.retryable !== false);
    if (checkpointedResume && task) {
      if (!sourceSession || (task.direction === 'remote_to_remote' && !destinationSession)) {
        error.value = {
          code: 'TRANSFER_SESSION_UNAVAILABLE',
          messageKey: 'errors.transferSessionUnavailable',
          retryable: true,
          remoteState: 'unknown',
        };
        return;
      }
      const result = task.direction === 'remote_to_remote'
        ? await resumeTransfer(id, sourceSession.id, destinationSession!.id)
        : await resumeTransfer(id, sourceSession.id);
      if (result.ok) upsert(result.data);
      else error.value = result.error;
      return;
    }
    let result;
    if (task?.direction === 'remote_to_remote') {
      result = sourceSession && destinationSession
        ? await resumeTransfer(id, sourceSession.id, destinationSession.id)
        : await retryTransfer(id);
    } else {
      result = task && sourceSession
        ? await resumeTransfer(id, sourceSession.id)
        : await retryTransfer(id);
    }
    if (result.ok) upsert(result.data);
    else error.value = result.error;
  }

  async function resetStaging(id: string): Promise<boolean> {
    error.value = null;
    const task = tasks.value.find((item) => item.id === id);
    const sessionId = task ? (resolveConnectedSession(task.profileId)?.id ?? null) : null;
    const result = task?.direction === 'remote_to_remote'
      ? await resetTransferStaging(id, sessionId, resolveConnectedSession(task.destinationProfileId)?.id ?? null)
      : await resetTransferStaging(id, sessionId);
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    upsert(result.data);
    return true;
  }

  async function clearCompleted(): Promise<boolean> {
    error.value = null;
    const result = await clearCompletedTransfers();
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    tasks.value = result.data;
    return true;
  }

  async function initializeEvents(): Promise<void> {
    if (!isTauriRuntime() || unlistenTransfer) return;
    unlistenTransfer = await listen<TransferTask>('transfer-updated', ({ payload }) => upsert(payload));
  }

  return {
    tasks,
    activeTasks,
    historyTasks,
    aggregateSpeedBytesPerSecond,
    speedForTask,
    trackDownloadBatch,
    loading,
    error,
    load,
    enqueue,
    enqueueTask,
    downloadArchive,
    pause,
    cancel,
    retry,
    resetStaging,
    clearCompleted,
    initializeEvents,
  };
});
