import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { CreateLocalTunnelInput, CreateTunnelRuleInput, OperationResult, TunnelRule, TunnelSummary, UpdateTunnelRuleInput } from '@/types/contracts';

export async function listTunnelRules(): Promise<OperationResult<TunnelRule[]>> {
  if (!isTauriRuntime()) return success([]);
  try { return await invoke<OperationResult<TunnelRule[]>>('list_tunnel_rules'); }
  catch (error: unknown) { return failure(normalizeUnknownError(error, 'TUNNEL_RULE_LIST_FAILED')); }
}

export async function createTunnelRule(input: CreateTunnelRuleInput): Promise<OperationResult<TunnelRule>> {
  if (!isTauriRuntime()) return desktopOnly();
  try { return await invoke<OperationResult<TunnelRule>>('create_tunnel_rule', { input }); }
  catch (error: unknown) { return failure(normalizeUnknownError(error, 'TUNNEL_RULE_CREATE_FAILED')); }
}

export async function updateTunnelRule(input: UpdateTunnelRuleInput): Promise<OperationResult<TunnelRule>> {
  if (!isTauriRuntime()) return desktopOnly();
  try { return await invoke<OperationResult<TunnelRule>>('update_tunnel_rule', { input }); }
  catch (error: unknown) { return failure(normalizeUnknownError(error, 'TUNNEL_RULE_UPDATE_FAILED')); }
}

export async function deleteTunnelRule(id: string): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) return desktopOnly();
  try { return await invoke<OperationResult<void>>('delete_tunnel_rule', { id }); }
  catch (error: unknown) { return failure(normalizeUnknownError(error, 'TUNNEL_RULE_DELETE_FAILED')); }
}

export async function listTunnels(): Promise<OperationResult<TunnelSummary[]>> {
  if (!isTauriRuntime()) return success([]);
  try {
    return await invoke<OperationResult<TunnelSummary[]>>('list_tunnels');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TUNNEL_LIST_FAILED'));
  }
}

export async function startLocalTunnel(input: CreateLocalTunnelInput): Promise<OperationResult<TunnelSummary>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TunnelSummary>>('start_local_tunnel', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TUNNEL_START_FAILED'));
  }
}

export async function stopTunnel(id: string): Promise<OperationResult<TunnelSummary>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TunnelSummary>>('stop_tunnel', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TUNNEL_STOP_FAILED'));
  }
}

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'TUNNEL_DESKTOP_ONLY',
    messageKey: 'errors.sshDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}
