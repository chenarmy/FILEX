import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  OperationResult,
  RemoteFileEntry,
  RemoteTextPreview,
  RemoteTextSaveResult,
} from '@/types/contracts';

export async function listRemoteDirectory(
  sessionId: string,
  path: string,
): Promise<OperationResult<RemoteFileEntry[]>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteFileEntry[]>>('list_remote_directory', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_LIST_FAILED'));
  }
}

export async function previewRemoteText(
  sessionId: string,
  path: string,
): Promise<OperationResult<RemoteTextPreview>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteTextPreview>>('preview_remote_text', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_PREVIEW_FAILED'));
  }
}

export async function openRemoteFileExternally(
  sessionId: string,
  path: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('open_remote_file_externally', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_EXTERNAL_OPEN_FAILED'));
  }
}

export async function saveRemoteText(
  sessionId: string,
  path: string,
  content: string,
  expectedRevision: string,
): Promise<OperationResult<RemoteTextSaveResult>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteTextSaveResult>>('save_remote_text', {
      sessionId,
      path,
      content,
      expectedRevision,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_SAVE_FAILED'));
  }
}

export async function deleteRemoteEntry(
  sessionId: string,
  path: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('delete_remote_entry', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_DELETE_FAILED'));
  }
}

export async function createRemoteDirectory(
  sessionId: string,
  parentPath: string,
  name: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('create_remote_directory', { sessionId, parentPath, name });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_CREATE_DIRECTORY_FAILED'));
  }
}

export async function renameRemoteEntry(
  sessionId: string,
  sourcePath: string,
  targetName: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('rename_remote_entry', { sessionId, sourcePath, targetName });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_RENAME_FAILED'));
  }
}

export async function moveRemoteEntry(
  sessionId: string,
  sourcePath: string,
  targetDirectory: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('move_remote_entry', {
      sessionId,
      sourcePath,
      targetDirectory,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_MOVE_FAILED'));
  }
}

export async function copyRemoteEntry(
  sessionId: string,
  sourcePath: string,
  targetDirectory: string,
  targetName: string,
  operationId: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('copy_remote_entry', {
      sessionId,
      sourcePath,
      targetDirectory,
      targetName,
      operationId,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_COPY_FAILED'));
  }
}
