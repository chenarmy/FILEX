import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  LocalTextPreview,
  LocalTextSaveResult,
  OperationResult,
} from '@/types/contracts';

export async function listLocalDirectory(path?: string): Promise<OperationResult<LocalDirectoryListing>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<LocalDirectoryListing>>('list_local_directory', { path: path ?? null });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_DIRECTORY_FAILED'));
  }
}

export async function inspectLocalEntry(path: string): Promise<OperationResult<LocalFileEntry>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<LocalFileEntry>>('inspect_local_entry', { path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_FILE_OPERATION_FAILED'));
  }
}

export function createLocalDirectory(parentPath: string, name: string): Promise<OperationResult<void>> {
  return runLocalOperation('create_local_directory', { parentPath, name }, 'LOCAL_FILE_OPERATION_FAILED');
}

export function createLocalFile(parentPath: string, name: string): Promise<OperationResult<void>> {
  return runLocalOperation('create_local_file', { parentPath, name }, 'LOCAL_FILE_OPERATION_FAILED');
}

export function openLocalFileExternally(
  path: string,
  editorPath: string | null,
): Promise<OperationResult<void>> {
  return runLocalOperation(
    'open_local_file_externally',
    { path, editorPath },
    'SFTP_EXTERNAL_OPEN_LAUNCH_FAILED',
  );
}

export function renameLocalEntry(path: string, targetName: string): Promise<OperationResult<void>> {
  return runLocalOperation('rename_local_entry', { path, targetName }, 'LOCAL_FILE_OPERATION_FAILED');
}

export function moveLocalEntry(path: string, targetDirectory: string): Promise<OperationResult<void>> {
  return runLocalOperation('move_local_entry', { path, targetDirectory }, 'LOCAL_FILE_OPERATION_FAILED');
}

export function copyLocalEntry(
  path: string,
  targetDirectory: string,
  targetName: string,
  operationId: string,
): Promise<OperationResult<void>> {
  return runLocalOperation(
    'copy_local_entry',
    { operationId, path, targetDirectory, targetName },
    'LOCAL_FILE_OPERATION_FAILED',
  );
}

export function deleteLocalEntry(path: string): Promise<OperationResult<void>> {
  return runLocalOperation('delete_local_entry', { path }, 'LOCAL_FILE_OPERATION_FAILED');
}

export async function previewLocalText(
  path: string,
): Promise<OperationResult<LocalTextPreview>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<LocalTextPreview>>('preview_local_text', { path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_TEXT_PREVIEW_FAILED'));
  }
}

export async function saveLocalText(
  path: string,
  content: string,
  expectedRevision: string,
): Promise<OperationResult<LocalTextSaveResult>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<LocalTextSaveResult>>('save_local_text', {
      path,
      content,
      expectedRevision,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_TEXT_SAVE_FAILED'));
  }
}

async function runLocalOperation(
  command: string,
  args: Record<string, unknown>,
  fallbackCode: string,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'LOCAL_FILES_DESKTOP_ONLY',
      messageKey: 'errors.localFilesDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>(command, args);
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, fallbackCode));
  }
}
