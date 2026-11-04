import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { OperationResult } from '@/types/contracts';

export async function cancelCopyOperation(operationId: string): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('cancel_copy_operation', { operationId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'FILE_COPY_CANCEL_FAILED'));
  }
}
