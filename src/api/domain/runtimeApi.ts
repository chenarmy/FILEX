import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { CredentialStoreStatus, OperationResult, RuntimePaths } from '@/types/contracts';

export type ProjectUrlTarget = 'github_repo' | 'github_releases' | 'cnb_repo' | 'cnb_releases';

export const PROJECT_URLS: Record<ProjectUrlTarget, string> = {
  github_repo: 'https://github.com/chenarmy/FILEX',
  github_releases: 'https://github.com/chenarmy/FILEX/releases',
  cnb_repo: 'https://cnb.cool/chenarmy/FILEX',
  cnb_releases: 'https://cnb.cool/chenarmy/FILEX/-/releases',
};

export async function openProjectUrl(target: ProjectUrlTarget): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    window.open(PROJECT_URLS[target], '_blank', 'noopener,noreferrer');
    return success(null);
  }
  try {
    return await invoke<OperationResult<null>>('open_project_url', { target });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'OPEN_URL_FAILED'));
  }
}

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
