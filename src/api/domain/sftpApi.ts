import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  OperationResult,
  RemoteDirectoryListing,
  RemoteDirectoryUsage,
  RemotePermissionUpdateResult,
  RemoteTextPreview,
  RemoteTextSaveResult,
  ResolvedLinkTarget,
  TerminalEncoding,
  UpdateRemotePermissionsInput,
} from '@/types/contracts';

export async function listRemoteDirectory(
  sessionId: string,
  path: string,
): Promise<OperationResult<RemoteDirectoryListing>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteDirectoryListing>>('list_remote_directory', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_LIST_FAILED'));
  }
}

export async function resolveRemoteLinkTarget(
  sessionId: string,
  path: string,
): Promise<OperationResult<ResolvedLinkTarget>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<ResolvedLinkTarget>>('resolve_remote_link_target', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SYMLINK_TARGET_UNAVAILABLE'));
  }
}

export async function calculateRemoteDirectoryUsage(
  sessionId: string,
  path: string,
): Promise<OperationResult<RemoteDirectoryUsage>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteDirectoryUsage>>('calculate_remote_directory_usage', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'DIRECTORY_USAGE_FAILED'));
  }
}

export async function previewRemoteText(
  sessionId: string,
  path: string,
  encoding?: TerminalEncoding | null,
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
    return await invoke<OperationResult<RemoteTextPreview>>('preview_remote_text', {
      sessionId,
      path,
      encoding: encoding ?? null,
    });
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
  encoding?: TerminalEncoding | null,
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
      encoding: encoding ?? null,
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

export async function deleteRemoteEntryRecursive(
  sessionId: string,
  path: string,
): Promise<OperationResult<number>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<number>>('delete_remote_entry_recursive', { sessionId, path });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_DELETE_FAILED'));
  }
}

export async function createRemoteFile(
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
    return await invoke<OperationResult<void>>('create_remote_file', { sessionId, parentPath, name });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_CREATE_FILE_FAILED'));
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
  options?: { autoRename?: boolean; copySuffix?: string },
): Promise<OperationResult<string>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<string>>('copy_remote_entry', {
      sessionId,
      sourcePath,
      targetDirectory,
      targetName,
      operationId,
      autoRename: options?.autoRename ?? false,
      copySuffix: options?.copySuffix ?? null,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SFTP_COPY_FAILED'));
  }
}

export async function updateRemoteEntryMode(
  sessionId: string,
  path: string,
  mode: number,
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
    return await invoke<OperationResult<void>>('update_remote_entry_mode', { sessionId, path, mode });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_MODE_UPDATE_FAILED'));
  }
}

export async function updateRemotePermissions(
  sessionId: string,
  input: UpdateRemotePermissionsInput,
): Promise<OperationResult<RemotePermissionUpdateResult>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SFTP_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemotePermissionUpdateResult>>(
      'update_remote_permissions',
      { sessionId, input },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_MODE_UPDATE_FAILED'));
  }
}
