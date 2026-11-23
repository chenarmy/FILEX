import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  ExternalLaunchEvent,
  HostKeyChallenge,
  OperationResult,
  SessionConnectionProgress,
} from '@/types/contracts';

export const EXTERNAL_LAUNCH_EVENT_NAME = 'external-launch';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'SSH_DESKTOP_ONLY',
    messageKey: 'errors.sshDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function drainExternalLaunchEvents(): Promise<OperationResult<ExternalLaunchEvent[]>> {
  if (!isTauriRuntime()) return success([]);
  try {
    return await invoke<OperationResult<ExternalLaunchEvent[]>>('drain_external_launch_events');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CLI_LAUNCH_INVALID_TARGET'));
  }
}

export async function discardExternalLaunch(launchId: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return success(null);
  try {
    return await invoke<OperationResult<null>>('discard_external_launch', { launchId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'CLI_LAUNCH_INVALID_TARGET'));
  }
}

export async function probeExternalLaunchHostKey(
  launchId: string,
): Promise<OperationResult<HostKeyChallenge>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<HostKeyChallenge>>(
      'probe_external_launch_host_key',
      { launchId },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_PROBE_FAILED'));
  }
}

export async function connectExternalLaunchSession(
  sessionId: string,
  passphrase?: string,
): Promise<OperationResult<SessionConnectionProgress>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<SessionConnectionProgress>>(
      'connect_external_launch_session',
      { sessionId, passphrase: passphrase ?? null },
    );
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SSH_CONNECT_FAILED'));
  }
}

export async function listenExternalLaunchEvents(
  handler: (event: ExternalLaunchEvent) => void,
): Promise<UnlistenFn | null> {
  if (!isTauriRuntime()) return null;
  return listen<ExternalLaunchEvent>(EXTERNAL_LAUNCH_EVENT_NAME, ({ payload }) => {
    handler(payload);
  });
}
