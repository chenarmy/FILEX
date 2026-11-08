import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import { readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';
import type { OperationResult, SafeSettings } from '@/types/contracts';

export async function loadSafeSettings(): Promise<OperationResult<SafeSettings>> {
  if (!isTauriRuntime()) return success(readSafeSettings());
  try {
    return await invoke<OperationResult<SafeSettings>>('load_safe_settings');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SETTINGS_LOAD_FAILED'));
  }
}

export async function saveSafeSettings(input: SafeSettings): Promise<OperationResult<SafeSettings>> {
  if (!isTauriRuntime()) {
    writeSafeSettings(input);
    return success(readSafeSettings());
  }
  try {
    const result = await invoke<OperationResult<SafeSettings>>('save_safe_settings', { input });
    if (result.ok) writeSafeSettings(result.data);
    return result;
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SETTINGS_SAVE_FAILED'));
  }
}
