import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  CreateTransferInput,
  DownloadRemoteArchiveInput,
  OperationResult,
  TransferTask,
} from '@/types/contracts';

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
  destinationSessionId?: string | null,
): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('enqueue_transfer', {
      input,
      sessionId,
      destinationSessionId: destinationSessionId ?? null,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_ENQUEUE_FAILED'));
  }
}

export async function downloadRemoteArchive(
  input: DownloadRemoteArchiveInput,
): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('download_remote_archive', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_ARCHIVE_FAILED'));
  }
}

export async function resumeTransfer(
  id: string,
  sessionId: string,
  destinationSessionId?: string | null,
): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('resume_transfer', {
      id,
      sessionId,
      destinationSessionId: destinationSessionId ?? null,
    });
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

export async function resetTransferStaging(
  id: string,
  sessionId: string | null,
  destinationSessionId?: string | null,
): Promise<OperationResult<TransferTask>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask>>('reset_transfer_staging', {
      id,
      sessionId,
      destinationSessionId: destinationSessionId ?? null,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_RESET_FAILED'));
  }
}

export async function clearCompletedTransfers(): Promise<OperationResult<TransferTask[]>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TransferTask[]>>('clear_completed_transfers');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRANSFER_CLEAR_FAILED'));
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
