import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { OperationResult, TerminalLogStatus } from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'TERMINAL_LOG_DESKTOP_ONLY',
    messageKey: 'errors.terminalLogDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function startTerminalLog(sessionId: string): Promise<OperationResult<TerminalLogStatus>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TerminalLogStatus>>('start_terminal_logging', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TERMINAL_LOG_START_FAILED'));
  }
}

export async function stopTerminalLog(sessionId: string): Promise<OperationResult<TerminalLogStatus>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TerminalLogStatus>>('stop_terminal_logging', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TERMINAL_LOG_STOP_FAILED'));
  }
}

export async function stopAllTerminalLogs(): Promise<OperationResult<TerminalLogStatus[]>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<TerminalLogStatus[]>>('stop_all_terminal_logs');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TERMINAL_LOG_STOP_FAILED'));
  }
}
