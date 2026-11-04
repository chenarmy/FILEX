import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { FileChecksumComparison, OperationResult } from '@/types/contracts';

export async function compareFileChecksums(
  operationId: string,
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<OperationResult<FileChecksumComparison>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'CHECKSUM_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<FileChecksumComparison>>('compare_file_checksums', {
      operationId,
      sessionId,
      localPath,
      remotePath,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CHECKSUM_FAILED'));
  }
}

export async function cancelFileChecksum(operationId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke('cancel_file_checksum', { operationId });
  } catch {
    // The comparison may finish between the UI cancellation request and this call.
  }
}
