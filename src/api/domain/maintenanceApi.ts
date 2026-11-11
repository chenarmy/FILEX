import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import packageJson from '../../../package.json';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { MaintenanceArtifact, OperationResult, UpdateStatus } from '@/types/contracts';

export type UpdateInstallEvent =
  | {
    event: 'progress';
    data: {
      downloadedBytes: number;
      contentLength: number | null;
    };
  }
  | { event: 'installing' };

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'DESKTOP_RUNTIME_REQUIRED',
    messageKey: 'errors.desktopRuntimeRequired',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function createBackup(): Promise<OperationResult<MaintenanceArtifact | null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<MaintenanceArtifact | null>>('create_backup');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'BACKUP_CREATE_FAILED'));
  }
}

export async function restoreBackup(backupPath: string): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<void>>('restore_backup', { backupPath });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'BACKUP_RESTORE_FAILED'));
  }
}

export async function selectBackupFile(
  title: string,
  filterName: string,
): Promise<OperationResult<string | null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    const selectedPath = await open({
      title,
      multiple: false,
      directory: false,
      filters: [{ name: filterName, extensions: ['sqlite3', 'sqlite', 'db'] }],
    });
    return success(typeof selectedPath === 'string' ? selectedPath : null);
  } catch {
    return failure({
      code: 'BACKUP_PICKER_FAILED',
      messageKey: 'errors.backupPickerFailed',
      retryable: true,
      remoteState: 'not_applicable',
    });
  }
}

export async function createDiagnostics(): Promise<OperationResult<MaintenanceArtifact | null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<MaintenanceArtifact | null>>('create_diagnostics');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'DIAGNOSTICS_CREATE_FAILED'));
  }
}

export async function getUpdateStatus(): Promise<OperationResult<UpdateStatus>> {
  if (!isTauriRuntime()) return success({
    currentVersion: packageJson.version,
    channel: 'stable',
    configured: false,
    availableVersion: null,
    releaseNotes: null,
    publishedAt: null,
  });
  try {
    return await invoke<OperationResult<UpdateStatus>>('get_update_status');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'UPDATE_STATUS_FAILED'));
  }
}

export async function checkForUpdates(): Promise<OperationResult<UpdateStatus>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<UpdateStatus>>('check_for_updates');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'UPDATE_CHECK_FAILED'));
  }
}

export async function installUpdate(
  expectedVersion: string,
  onEvent?: (event: UpdateInstallEvent) => void,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    const events = new Channel<UpdateInstallEvent>();
    if (onEvent) events.onmessage = onEvent;
    return await invoke<OperationResult<void>>('install_update', { expectedVersion, onEvent: events });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'UPDATE_INSTALL_FAILED'));
  }
}

export async function cancelUpdateDownload(): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<void>>('cancel_update_download');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'UPDATE_CANCEL_FAILED'));
  }
}
