import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  ConnectionProfile,
  HostKeyChallenge,
  OperationResult,
  QuickConnectInput,
  SessionConnectionProgress,
  SessionSummary,
  TerminalEncoding,
} from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'SSH_DESKTOP_ONLY',
    messageKey: 'errors.sshDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function probeSessionHostKey(profileId: string): Promise<OperationResult<HostKeyChallenge>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<HostKeyChallenge>>('probe_session_host_key', { profileId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_PROBE_FAILED'));
  }
}

export async function probeQuickSessionHostKey(
  input: QuickConnectInput,
): Promise<OperationResult<HostKeyChallenge>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<HostKeyChallenge>>('probe_quick_session_host_key', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_PROBE_FAILED'));
  }
}

export async function reprobeSessionHostKey(sessionId: string): Promise<OperationResult<HostKeyChallenge>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<HostKeyChallenge>>('reprobe_session_host_key', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_RECONNECT_PROBE_FAILED'));
  }
}

export async function saveProfilePassword(
  profileId: string,
  password: string,
): Promise<OperationResult<ConnectionProfile>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<ConnectionProfile>>('save_profile_password', { profileId, password });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CREDENTIAL_SAVE_FAILED'));
  }
}

export async function saveProfilePrivateKeyPassphrase(
  profileId: string,
  passphrase: string,
): Promise<OperationResult<ConnectionProfile>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<ConnectionProfile>>(
      'save_profile_private_key_passphrase',
      { profileId, passphrase },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CREDENTIAL_SAVE_FAILED'));
  }
}

export async function connectPasswordSession(sessionId: string): Promise<OperationResult<SessionConnectionProgress>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionConnectionProgress>>('connect_password_session', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function connectQuickPasswordSession(
  sessionId: string,
  password: string,
): Promise<OperationResult<SessionConnectionProgress>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionConnectionProgress>>(
      'connect_quick_password_session',
      { sessionId, password },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function connectPrivateKeySession(sessionId: string): Promise<OperationResult<SessionConnectionProgress>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionConnectionProgress>>('connect_private_key_session', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function connectAgentSession(sessionId: string): Promise<OperationResult<SessionConnectionProgress>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionConnectionProgress>>('connect_agent_session', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function cancelSessionAttempt(sessionId: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<null>>('cancel_session_attempt', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function disconnectSession(sessionId: string): Promise<OperationResult<SessionSummary>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionSummary>>('disconnect_session', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_DISCONNECT_FAILED'));
  }
}

export async function listSessions(): Promise<OperationResult<SessionSummary[]>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionSummary[]>>('list_sessions');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SESSION_LIST_FAILED'));
  }
}

export async function writeTerminal(
  sessionId: string,
  data: number[],
  encoding: TerminalEncoding,
): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<null>>('write_terminal', { sessionId, data, encoding });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TERMINAL_WRITE_FAILED'));
  }
}

export async function resizeTerminal(
  sessionId: string,
  columns: number,
  rows: number,
): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<null>>('resize_terminal', { sessionId, columns, rows });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TERMINAL_RESIZE_FAILED'));
  }
}
