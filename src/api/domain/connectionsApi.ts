import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime, normalizeUnknownError, failure } from '@/api/common';
import {
  createBrowserProfile,
  listBrowserProfiles,
} from '@/runtime/browserConnectionsRepository';
import type {
  ConnectionProfile,
  CreateConnectionProfileInput,
  OperationResult,
} from '@/types/contracts';

export async function listConnectionProfiles(): Promise<OperationResult<ConnectionProfile[]>> {
  if (!isTauriRuntime()) return listBrowserProfiles();

  try {
    return await invoke<OperationResult<ConnectionProfile[]>>('list_connection_profiles');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROFILE_LIST_FAILED'));
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
