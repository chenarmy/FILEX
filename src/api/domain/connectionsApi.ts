import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import {
  createBrowserProfile,
  deleteBrowserProfile,
  duplicateBrowserProfile,
  listBrowserProfiles,
  updateBrowserProfile,
} from '@/runtime/browserConnectionsRepository';
import type {
  ConnectionProfile,
  CreateConnectionProfileInput,
  MaintenanceArtifact,
  OperationResult,
  SshConfigImportPreview,
  UpdateConnectionProfileInput,
} from '@/types/contracts';

export async function exportConnectionProfiles(): Promise<OperationResult<MaintenanceArtifact | null>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'PROFILE_EXPORT_DESKTOP_ONLY',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<MaintenanceArtifact | null>>('export_connection_profiles');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_EXPORT_FAILED'));
  }
}

export async function listConnectionProfiles(): Promise<OperationResult<ConnectionProfile[]>> {
  if (!isTauriRuntime()) return listBrowserProfiles();

  try {
    return await invoke<OperationResult<ConnectionProfile[]>>('list_connection_profiles');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_LIST_FAILED'));
  }
}

export async function updateConnectionProfile(
  id: string,
  input: UpdateConnectionProfileInput,
): Promise<OperationResult<ConnectionProfile>> {
  if (!isTauriRuntime()) return updateBrowserProfile(id, input);
  try {
    return await invoke<OperationResult<ConnectionProfile>>('update_connection_profile', { id, input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_UPDATE_FAILED'));
  }
}

export async function duplicateConnectionProfile(id: string): Promise<OperationResult<ConnectionProfile>> {
  if (!isTauriRuntime()) return duplicateBrowserProfile(id);
  try {
    return await invoke<OperationResult<ConnectionProfile>>('duplicate_connection_profile', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_DUPLICATE_FAILED'));
  }
}

export async function deleteConnectionProfile(id: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return deleteBrowserProfile(id);
  try {
    const result = await invoke<OperationResult<null>>('delete_connection_profile', { id });
    return result;
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_DELETE_FAILED'));
  }
}

export async function previewDefaultSshConfig(): Promise<OperationResult<SshConfigImportPreview>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SSH_CONFIG_DESKTOP_ONLY',
      messageKey: 'errors.sshConfigUnavailable',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<SshConfigImportPreview>>('preview_default_ssh_config');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONFIG_PREVIEW_FAILED'));
  }
}

export async function importDefaultSshConfig(
  aliases: string[],
): Promise<OperationResult<ConnectionProfile[]>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SSH_CONFIG_DESKTOP_ONLY',
      messageKey: 'errors.sshConfigUnavailable',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<ConnectionProfile[]>>('import_default_ssh_config', { aliases });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONFIG_IMPORT_FAILED'));
  }
}

export async function createConnectionProfile(
  input: CreateConnectionProfileInput,
): Promise<OperationResult<ConnectionProfile>> {
  if (!isTauriRuntime()) return createBrowserProfile(input);

  try {
    return await invoke<OperationResult<ConnectionProfile>>('create_connection_profile', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_CREATE_FAILED'));
  }
}

export async function selectPrivateKeyFile(
  title: string,
): Promise<OperationResult<string | null>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'SSH_PRIVATE_KEY_PICKER_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    const selectedPath = await open({ title, multiple: false, directory: false });
    return success(typeof selectedPath === 'string' ? selectedPath : null);
  } catch {
    return failure({
      code: 'SSH_PRIVATE_KEY_PICKER_FAILED',
      messageKey: 'errors.privateKeyPickerFailed',
      retryable: true,
      remoteState: 'not_applicable',
    });
  }
}
