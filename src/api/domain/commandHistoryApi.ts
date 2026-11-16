import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime, normalizeUnknownError, failure, success } from '@/api/common';
import type { OperationResult, ProfileCommandHistoryEntry } from '@/types/contracts';

export async function listProfileCommandHistory(
  profileId: string,
): Promise<OperationResult<ProfileCommandHistoryEntry[]>> {
  if (!isTauriRuntime()) {
    return success([]);
  }
  try {
    return await invoke<OperationResult<ProfileCommandHistoryEntry[]>>('list_profile_command_history', {
      profileId,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'COMMAND_HISTORY_QUERY_FAILED'));
  }
}

export async function appendProfileCommandHistory(
  profileId: string,
  command: string,
): Promise<OperationResult<ProfileCommandHistoryEntry | null>> {
  if (!isTauriRuntime()) {
    return success(null);
  }
  try {
    return await invoke<OperationResult<ProfileCommandHistoryEntry | null>>('append_profile_command_history', {
      profileId,
      command,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'COMMAND_HISTORY_WRITE_FAILED'));
  }
}

export async function deleteProfileCommandHistoryEntry(
  profileId: string,
  entryId: string,
): Promise<OperationResult<boolean>> {
  if (!isTauriRuntime()) {
    return success(true);
  }
  try {
    return await invoke<OperationResult<boolean>>('delete_profile_command_history_entry', {
      profileId,
      entryId,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'COMMAND_HISTORY_WRITE_FAILED'));
  }
}

export async function clearProfileCommandHistory(
  profileId: string,
): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return success(null);
  }
  try {
    return await invoke<OperationResult<null>>('clear_profile_command_history', {
      profileId,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'COMMAND_HISTORY_WRITE_FAILED'));
  }
}
