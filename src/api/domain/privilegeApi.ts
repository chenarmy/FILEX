import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  AcquireElevatedAccessInput,
  ElevatedAccessLeaseSummary,
  OperationResult,
  RemoteDirectoryListing,
  RemoteTextPreview,
  RemoteTextSaveResult,
} from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'ELEVATED_DESKTOP_ONLY',
    messageKey: 'errors.sshDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

async function invokePrivilege<T>(
  command: string,
  args: Record<string, unknown>,
  fallbackCode: string,
): Promise<OperationResult<T>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<T>>(command, args);
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, fallbackCode));
  }
}

export function getElevatedAccessStatus(
  sessionId: string,
): Promise<OperationResult<ElevatedAccessLeaseSummary>> {
  return invokePrivilege('get_elevated_access_status', { sessionId }, 'ELEVATED_OPERATION_FAILED');
}

export function acquireElevatedAccess(
  input: AcquireElevatedAccessInput,
): Promise<OperationResult<ElevatedAccessLeaseSummary>> {
  return invokePrivilege('acquire_elevated_access', { input }, 'ELEVATED_AUTH_FAILED');
}

export function revokeElevatedAccess(
  sessionId: string,
): Promise<OperationResult<ElevatedAccessLeaseSummary>> {
  return invokePrivilege('revoke_elevated_access', { sessionId }, 'ELEVATED_OPERATION_FAILED');
}

export function elevatedListDirectory(
  sessionId: string,
  path: string,
): Promise<OperationResult<RemoteDirectoryListing>> {
  return invokePrivilege('elevated_list_directory', { sessionId, path }, 'ELEVATED_LIST_FAILED');
}

export function elevatedCreateDirectory(
  sessionId: string,
  parentPath: string,
  name: string,
): Promise<OperationResult<void>> {
  return invokePrivilege(
    'elevated_create_directory',
    { sessionId, parentPath, name },
    'REMOTE_CREATE_DIR_FAILED',
  );
}

export function elevatedCreateFile(
  sessionId: string,
  parentPath: string,
  name: string,
): Promise<OperationResult<void>> {
  return invokePrivilege(
    'elevated_create_file',
    { sessionId, parentPath, name },
    'REMOTE_CREATE_FILE_FAILED',
  );
}

export function elevatedRenameEntry(
  sessionId: string,
  sourcePath: string,
  targetName: string,
): Promise<OperationResult<void>> {
  return invokePrivilege(
    'elevated_rename_entry',
    { sessionId, sourcePath, targetName },
    'REMOTE_RENAME_FAILED',
  );
}

export function elevatedDeleteEntry(
  sessionId: string,
  path: string,
  recursive = false,
): Promise<OperationResult<number>> {
  return invokePrivilege(
    'elevated_delete_entry',
    { sessionId, path, recursive },
    'REMOTE_DELETE_FAILED',
  );
}

export function elevatedChmodEntry(
  sessionId: string,
  path: string,
  mode: number,
): Promise<OperationResult<void>> {
  return invokePrivilege(
    'elevated_chmod_entry',
    { sessionId, path, mode },
    'REMOTE_MODE_FAILED',
  );
}

export function elevatedPreviewText(
  sessionId: string,
  path: string,
  encoding?: string | null,
): Promise<OperationResult<RemoteTextPreview>> {
  return invokePrivilege(
    'elevated_preview_text',
    { sessionId, path, encoding: encoding ?? null },
    'SFTP_PREVIEW_FAILED',
  );
}

export function elevatedSaveText(
  sessionId: string,
  path: string,
  content: string,
  expectedRevision: string,
  encoding?: string | null,
): Promise<OperationResult<RemoteTextSaveResult>> {
  return invokePrivilege(
    'elevated_save_text',
    { sessionId, path, content, expectedRevision, encoding: encoding ?? null },
    'REMOTE_SAVE_FAILED',
  );
}
