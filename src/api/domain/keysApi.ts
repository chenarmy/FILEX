import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  OperationResult,
  RegisterSshKeyInput,
  RotateSshKeyInput,
  SshKeyEntry,
  SshKeyMetadataInspection,
} from '@/types/contracts';

function desktopOnlyFailure<T>(code: string): OperationResult<T> {
  return failure({
    code,
    messageKey: 'errors.desktopRuntimeRequired',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function selectLibraryKeyFile(title: string): Promise<OperationResult<string | null>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('SSH_KEY_PICKER_DESKTOP_ONLY');
  }
  try {
    const selected = await open({ title, multiple: false, directory: false });
    return success(typeof selected === 'string' ? selected : null);
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_KEY_PICKER_FAILED'));
  }
}

export async function listSshKeys(): Promise<OperationResult<SshKeyEntry[]>> {
  if (!isTauriRuntime()) {
    return success([]);
  }
  try {
    return await invoke<OperationResult<SshKeyEntry[]>>('list_ssh_keys');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'KEY_LIBRARY_QUERY_FAILED'));
  }
}

export async function inspectSshKeyFile(
  keyPath: string,
  passphrase: string | null = null,
): Promise<OperationResult<SshKeyMetadataInspection>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('KEY_INSPECT_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<SshKeyMetadataInspection>>('inspect_ssh_key_file', {
      keyPath,
      passphrase,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_KEY_INSPECT_FAILED'));
  }
}

export async function registerSshKey(
  input: RegisterSshKeyInput,
): Promise<OperationResult<SshKeyEntry>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('KEY_REGISTER_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<SshKeyEntry>>('register_ssh_key', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'KEY_LIBRARY_WRITE_FAILED'));
  }
}

export async function rotateSshKey(
  input: RotateSshKeyInput,
): Promise<OperationResult<SshKeyEntry>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('KEY_ROTATE_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<SshKeyEntry>>('rotate_ssh_key', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'KEY_LIBRARY_WRITE_FAILED'));
  }
}

export async function countSshKeyReferences(keyId: string): Promise<OperationResult<number>> {
  if (!isTauriRuntime()) {
    return success(0);
  }
  try {
    return await invoke<OperationResult<number>>('count_ssh_key_references', { keyId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'KEY_LIBRARY_QUERY_FAILED'));
  }
}

export async function deleteSshKey(keyId: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('KEY_DELETE_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<null>>('delete_ssh_key', { keyId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'KEY_LIBRARY_WRITE_FAILED'));
  }
}
