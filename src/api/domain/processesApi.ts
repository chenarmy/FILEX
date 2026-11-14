import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { OperationResult, ProcessSignal, ProcessSnapshot } from '@/types/contracts';

export async function collectProcessSnapshot(sessionId: string): Promise<OperationResult<ProcessSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'PROCESS_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<ProcessSnapshot>>('collect_process_snapshot', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROCESS_PROBE_FAILED'));
  }
}

export async function terminateRemoteProcess(
  sessionId: string,
  snapshotId: string,
  pid: number,
  signal: ProcessSignal = 'SIGTERM',
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'PROCESS_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('terminate_remote_process', { sessionId, snapshotId, pid, signal });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROCESS_TERMINATION_FAILED'));
  }
}
