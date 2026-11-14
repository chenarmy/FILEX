import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type {
  DockerContainerAction,
  DockerLogsSnapshot,
  DockerSnapshot,
  OperationResult,
} from '@/types/contracts';

export async function collectDockerSnapshot(sessionId: string): Promise<OperationResult<DockerSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'DOCKER_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<DockerSnapshot>>('collect_docker_snapshot', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'DOCKER_PROBE_FAILED'));
  }
}

export async function collectDockerLogs(
  sessionId: string,
  containerId: string,
  tailLines = 200,
): Promise<OperationResult<DockerLogsSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'DOCKER_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<DockerLogsSnapshot>>('collect_docker_logs', {
      sessionId,
      containerId,
      tailLines,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'DOCKER_PROBE_FAILED'));
  }
}

export async function runDockerContainerAction(
  sessionId: string,
  containerId: string,
  action: DockerContainerAction,
): Promise<OperationResult<void>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'DOCKER_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<void>>('run_docker_container_action', {
      sessionId,
      containerId,
      action,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'DOCKER_ACTION_FAILED'));
  }
}
