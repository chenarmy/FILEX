import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  ExternalEditorSession,
  ExternalEditorSyncResult,
  OperationResult,
} from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'EXTERNAL_EDITOR_DESKTOP_ONLY',
    messageKey: 'errors.externalEditorDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function openRemoteFileInEditor(
  sessionId: string,
  path: string,
  editorPath: string | null,
): Promise<OperationResult<ExternalEditorSession>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<ExternalEditorSession>>(
      'open_remote_file_in_editor',
      { sessionId, path, editorPath },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'EXTERNAL_EDITOR_LAUNCH_FAILED'));
  }
}

export async function syncExternalEditor(
  id: string,
): Promise<OperationResult<ExternalEditorSyncResult>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<ExternalEditorSyncResult>>(
      'sync_external_editor',
      { id },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'EXTERNAL_EDITOR_SYNC_FAILED'));
  }
}

export async function closeExternalEditor(id: string): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<void>>('close_external_editor', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'EXTERNAL_EDITOR_SYNC_FAILED'));
  }
}
