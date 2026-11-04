import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { CreateTransferInput, OperationResult, TransferTask } from '@/types/contracts';

export async function listTransfers(): Promise<OperationResult<TransferTask[]>> {
  if (!isTauriRuntime()) return success([]);
  try {
    return await invoke<OperationResult<TransferTask[]>>('list_transfers');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_LIST_FAILED'));
  }
}

export async function enqueueTransfer(
  input: CreateTransferInput,
  sessionId: string | null,
): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('enqueue_transfer', { input, sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_ENQUEUE_FAILED'));
  }
}

export async function resumeTransfer(id: string, sessionId: string): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('resume_transfer', { id, sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_RESUME_FAILED'));
  }
}

export async function pauseTransfer(id: string): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('pause_transfer', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_PAUSE_FAILED'));
  }
}

export async function cancelTransfer(id: string): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('cancel_transfer', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_CANCEL_FAILED'));
  }
}

export async function retryTransfer(id: string): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('retry_transfer', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_RETRY_FAILED'));
  }
}

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'TRANSFER_DESKTOP_ONLY',
    messageKey: 'errors.transferDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}
