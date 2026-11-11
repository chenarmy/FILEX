import { open } from '@tauri-apps/plugin-dialog';
import { failure, isTauriRuntime, success } from '@/api/common';
import type { OperationResult } from '@/types/contracts';

export async function selectUploadPaths(
  kind: 'files' | 'folders',
  title: string,
): Promise<OperationResult<string[]>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'FILE_PICKER_DESKTOP_ONLY',
      messageKey: 'errors.filePickerDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    const selected = await open({
      title,
      multiple: true,
      directory: kind === 'folders',
    });
    return success(Array.isArray(selected) ? selected : selected ? [selected] : []);
  } catch {
    return failure({
      code: 'FILE_PICKER_FAILED',
      messageKey: 'errors.filePickerFailed',
      retryable: true,
      remoteState: 'not_applicable',
    });
  }
}

export async function selectExternalEditorExecutable(
  title: string,
): Promise<OperationResult<string | null>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'FILE_PICKER_DESKTOP_ONLY',
      messageKey: 'errors.filePickerDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    const selected = await open({
      title,
      multiple: false,
      directory: false,
    });
    return success(typeof selected === 'string' ? selected : null);
  } catch {
    return failure({
      code: 'FILE_PICKER_FAILED',
      messageKey: 'errors.filePickerFailed',
      retryable: true,
      remoteState: 'not_applicable',
    });
  }
}
