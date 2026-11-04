import { ref } from 'vue';
import { defineStore } from 'pinia';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  cancelTransfer,
  enqueueTransfer,
  listTransfers,
  pauseTransfer,
  resumeTransfer,
  retryTransfer,
} from '@/api/domain/transfersApi';
import { isTauriRuntime } from '@/api/common';
import { useSessionsStore } from '@/stores/sessions';
import { useEventsStore } from '@/stores/events';
import type { AppError, CreateTransferInput, TransferTask } from '@/types/contracts';

export const useTransfersStore = defineStore('transfers', () => {
  const tasks = ref<TransferTask[]>([]);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  let unlistenTransfer: UnlistenFn | null = null;

  function upsert(task: TransferTask): void {
    const index = tasks.value.findIndex((item) => item.id === task.id);
    const previousState = index >= 0 ? tasks.value[index]?.state : null;
    if (index >= 0) tasks.value[index] = task;
    else tasks.value.unshift(task);
    if (previousState !== task.state) {
      useEventsStore().record('transfer', `TRANSFER_${task.state.toUpperCase()}`, task.state === 'failed' ? 'error' : task.state === 'completed' ? 'success' : 'info', { transferId: task.id, bytes: task.bytesTransferred });
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

  async function enqueue(input: CreateTransferInput, sessionIdOverride?: string | null): Promise<boolean> {
    const sessions = useSessionsStore();
    const sessionId = sessionIdOverride === undefined
      ? sessions.activeSession?.profileId === input.profileId && sessions.activeSession.state === 'connected'
        ? sessions.activeSession.id
        : null
      : sessionIdOverride;
    const result = await enqueueTransfer(input, sessionId);
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    upsert(result.data);
    return true;
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
    const session = useSessionsStore().activeSession;
    error.value = null;
    if (task?.state === 'paused') {
      if (!session || session.state !== 'connected' || session.profileId !== task.profileId) {
        error.value = {
          code: 'TRANSFER_SESSION_UNAVAILABLE',
          messageKey: 'errors.transferSessionUnavailable',
          retryable: true,
          remoteState: 'unknown',
        };
        return;
      }
      const result = await resumeTransfer(id, session.id);
      if (result.ok) upsert(result.data);
      else error.value = result.error;
      return;
    }
    const result = task && session?.state === 'connected' && session.profileId === task.profileId
      ? await resumeTransfer(id, session.id)
      : await retryTransfer(id);
    if (result.ok) upsert(result.data);
    else error.value = result.error;
  }

  async function initializeEvents(): Promise<void> {
    if (!isTauriRuntime() || unlistenTransfer) return;
    unlistenTransfer = await listen<TransferTask>('transfer-updated', ({ payload }) => upsert(payload));
  }

  return { tasks, loading, error, load, enqueue, pause, cancel, retry, initializeEvents };
});
