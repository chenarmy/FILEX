import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { CredentialStoreStatus, OperationResult, RuntimePaths } from '@/types/contracts';

export async function getCredentialStoreStatus(): Promise<OperationResult<CredentialStoreStatus>> {
  if (!isTauriRuntime()) return success('unsupported');

  try {
    return await invoke<OperationResult<CredentialStoreStatus>>('credential_store_status');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CREDENTIAL_STORE_PROBE_FAILED'));
  }
}

export async function getRuntimePaths(): Promise<OperationResult<RuntimePaths>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'RUNTIME_PATHS_DESKTOP_ONLY',
      messageKey: 'errors.runtimePathsDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }

  try {
    return await invoke<OperationResult<RuntimePaths>>('runtime_paths');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'RUNTIME_PATHS_UNAVAILABLE'));
  }
}
