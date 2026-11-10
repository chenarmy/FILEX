import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { NetworkSnapshot, OperationResult } from '@/types/contracts';

export async function collectNetworkSnapshot(sessionId: string): Promise<OperationResult<NetworkSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'NETWORK_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<NetworkSnapshot>>('collect_network_snapshot', { sessionId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'NETWORK_PROBE_FAILED'));
  }
}
