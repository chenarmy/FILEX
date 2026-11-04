import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { DirectorySyncPreview, OperationResult } from '@/types/contracts';

export async function previewDirectorySync(
  operationId: string,
  sessionId: string,
  localRoot: string,
  remoteRoot: string,
): Promise<OperationResult<DirectorySyncPreview>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SYNC_PREVIEW_DESKTOP_ONLY',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<DirectorySyncPreview>>('preview_directory_sync', {
      operationId,
      sessionId,
      localRoot,
      remoteRoot,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SYNC_PREVIEW_FAILED'));
  }
}

export async function cancelDirectorySyncPreview(operationId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke('cancel_directory_sync_preview', { operationId });
  } catch {
    // The scan may finish between the UI cancellation request and this call.
  }
}
