import { ref, shallowRef } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { defineStore } from 'pinia';
import { isTauriRuntime } from '@/api/common';
import {
  startTerminalLog,
  stopAllTerminalLogs,
  stopTerminalLog,
} from '@/api/domain/terminalLogsApi';
import { useEventsStore } from '@/stores/events';
import type { AppError, TerminalLogStatus } from '@/types/contracts';

export const useTerminalLogsStore = defineStore('terminalLogs', () => {
  const statuses = shallowRef<Record<string, TerminalLogStatus>>({});
  const busySessionIds = ref<string[]>([]);
  const error = ref<AppError | null>(null);
  const reportedOutcomes = new Map<string, string>();
  let unlistenStatus: UnlistenFn | null = null;

  function upsert(status: TerminalLogStatus): void {
    statuses.value = { ...statuses.value, [status.sessionId]: status };
    if (status.error || ['limit_reached', 'interrupted', 'failed'].includes(status.state)) {
      const outcomeKey = `${status.state}:${status.error?.code ?? ''}`;
      if (reportedOutcomes.get(status.sessionId) !== outcomeKey) {
        reportedOutcomes.set(status.sessionId, outcomeKey);
        useEventsStore().record(
          'session',
          status.error?.code ?? `TERMINAL_LOG_${status.state.toUpperCase()}`,
          status.state === 'failed' ? 'error' : 'warning',
          { sessionId: status.sessionId },
        );
      }
    } else {
      reportedOutcomes.delete(status.sessionId);
    }
  }

  function statusFor(sessionId: string | null | undefined): TerminalLogStatus | null {
    return sessionId ? statuses.value[sessionId] ?? null : null;
  }

  function isBusy(sessionId: string): boolean {
    return busySessionIds.value.includes(sessionId);
  }

  async function start(sessionId: string): Promise<boolean> {
    if (isBusy(sessionId)) return false;
    busySessionIds.value = [...busySessionIds.value, sessionId];
    error.value = null;
    try {
      const result = await startTerminalLog(sessionId);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      upsert(result.data);
      return true;
    } finally {
      busySessionIds.value = busySessionIds.value.filter((id) => id !== sessionId);
    }
  }

  async function stop(sessionId: string): Promise<boolean> {
    if (isBusy(sessionId)) return false;
    busySessionIds.value = [...busySessionIds.value, sessionId];
    error.value = null;
    try {
      const result = await stopTerminalLog(sessionId);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      upsert(result.data);
      return true;
    } finally {
      busySessionIds.value = busySessionIds.value.filter((id) => id !== sessionId);
    }
  }

  async function stopAll(): Promise<boolean> {
    error.value = null;
    const result = await stopAllTerminalLogs();
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    for (const status of result.data) upsert(status);
    return true;
  }

  function clearError(): void {
    error.value = null;
  }

  async function initializeEvents(): Promise<void> {
    if (!isTauriRuntime() || unlistenStatus) return;
    try {
      unlistenStatus = await listen<TerminalLogStatus>('terminal-log-status', ({ payload }) => {
        upsert(payload);
      });
    } catch {
      error.value = {
        code: 'TERMINAL_LOG_EVENT_UNAVAILABLE',
        messageKey: 'errors.terminalLogEventUnavailable',
        retryable: true,
        remoteState: 'not_applicable',
      };
    }
  }

  return {
    statuses,
    busySessionIds,
    error,
    statusFor,
    isBusy,
    start,
    stop,
    stopAll,
    clearError,
    initializeEvents,
  };
});
