import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  CreateProxyProfileInput,
  OperationResult,
  ProxyPreflightResult,
  ProxyProfile,
  UpdateProxyProfileInput,
} from '@/types/contracts';

function desktopOnlyFailure<T>(code: string): OperationResult<T> {
  return failure({
    code,
    messageKey: 'errors.desktopRuntimeRequired',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function listProxyProfiles(): Promise<OperationResult<ProxyProfile[]>> {
  if (!isTauriRuntime()) {
    return success([]);
  }
  try {
    return await invoke<OperationResult<ProxyProfile[]>>('list_proxy_profiles');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_LIBRARY_QUERY_FAILED'));
  }
}

export async function createProxyProfile(
  input: CreateProxyProfileInput,
): Promise<OperationResult<ProxyProfile>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('PROXY_CREATE_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<ProxyProfile>>('create_proxy_profile', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_LIBRARY_WRITE_FAILED'));
  }
}

export async function updateProxyProfile(
  input: UpdateProxyProfileInput,
): Promise<OperationResult<ProxyProfile>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('PROXY_UPDATE_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<ProxyProfile>>('update_proxy_profile', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_LIBRARY_WRITE_FAILED'));
  }
}

export async function countProxyReferences(proxyId: string): Promise<OperationResult<number>> {
  if (!isTauriRuntime()) {
    return success(0);
  }
  try {
    return await invoke<OperationResult<number>>('count_proxy_references', { proxyId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_LIBRARY_QUERY_FAILED'));
  }
}

export async function deleteProxyProfile(proxyId: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('PROXY_DELETE_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<null>>('delete_proxy_profile', { proxyId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_LIBRARY_WRITE_FAILED'));
  }
}

export async function testProxyProfile(proxyId: string): Promise<OperationResult<ProxyPreflightResult>> {
  if (!isTauriRuntime()) {
    return desktopOnlyFailure('PROXY_TEST_DESKTOP_ONLY');
  }
  try {
    return await invoke<OperationResult<ProxyPreflightResult>>('test_proxy_profile', { proxyId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'PROXY_CONNECT_FAILED'));
  }
}
