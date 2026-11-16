import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  ClipboardFileSnapshot,
  ClipboardFileWriteResult,
  OperationResult,
} from '@/types/contracts';

export async function readClipboardFilePaths(): Promise<OperationResult<ClipboardFileSnapshot>> {
  if (!isTauriRuntime()) {
    return success({
      paths: [],
      sequence: null,
      supported: false,
    });
  }
  try {
    return await invoke<OperationResult<ClipboardFileSnapshot>>('read_clipboard_file_paths');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CLIPBOARD_FILES_READ_FAILED'));
  }
}

export async function writeClipboardFilePaths(
  paths: string[],
): Promise<OperationResult<ClipboardFileWriteResult>> {
  if (!isTauriRuntime()) {
    return success({
      written: false,
      sequence: null,
    });
  }
  try {
    return await invoke<OperationResult<ClipboardFileWriteResult>>('write_clipboard_file_paths', {
      paths,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CLIPBOARD_FILES_WRITE_FAILED'));
  }
}
