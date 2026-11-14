import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { OperationResult, OpsCategory, OpsSnapshot } from '@/types/contracts';

export async function collectOpsSnapshot(
  sessionId: string,
  category: OpsCategory,
): Promise<OperationResult<OpsSnapshot>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'OPS_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<OpsSnapshot>>('collect_ops_snapshot', { sessionId, category });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'OPS_PROBE_FAILED'));
  }
}
