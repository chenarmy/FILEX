import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { OperationResult, SystemMonitorSnapshot } from '@/types/contracts';

export async function collectSystemMonitor(sessionId: string): Promise<OperationResult<SystemMonitorSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'MONITOR_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<SystemMonitorSnapshot>>('collect_system_monitor', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'MONITOR_PROBE_FAILED'));
  }
}
