import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { McpServerStatus, OperationResult } from '@/types/contracts';

const browserFallbackStatus: McpServerStatus = {
  enabled: false,
  running: false,
  bindAddress: '127.0.0.1:19375',
  endpointUrl: 'http://127.0.0.1:19375/mcp',
  authToken: null,
  cliCommand: 'filex --mcp',
  error: null,
};

export async function getMcpServerStatus(): Promise<OperationResult<McpServerStatus>> {
  if (!isTauriRuntime()) return success(browserFallbackStatus);
  try {
    return await invoke<OperationResult<McpServerStatus>>('get_mcp_server_status');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'MCP_STATUS_FAILED'));
  }
}

export async function regenerateMcpToken(): Promise<OperationResult<McpServerStatus>> {
  if (!isTauriRuntime()) return success(browserFallbackStatus);
  try {
    return await invoke<OperationResult<McpServerStatus>>('regenerate_mcp_token');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'MCP_TOKEN_REGENERATE_FAILED'));
  }
}
