import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  LocalShellOption,
  OpenLocalTerminalInput,
  OpenLocalTerminalResult,
  OperationResult,
  SessionSummary,
} from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'LOCAL_TERMINAL_DESKTOP_ONLY',
    messageKey: 'localTerminal.desktopOnlyNotice',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function listLocalShellOptions(): Promise<OperationResult<LocalShellOption[]>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<LocalShellOption[]>>('list_local_shell_options');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_TERMINAL_SPAWN_FAILED'));
  }
}

export async function openLocalTerminal(
  input: OpenLocalTerminalInput,
): Promise<OperationResult<OpenLocalTerminalResult>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<OpenLocalTerminalResult>>('open_local_terminal', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_TERMINAL_SPAWN_FAILED'));
  }
}

export async function closeLocalTerminal(sessionId: string): Promise<OperationResult<SessionSummary>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionSummary>>('close_local_terminal', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'LOCAL_TERMINAL_NOT_FOUND'));
  }
}
