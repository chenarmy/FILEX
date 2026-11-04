import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError } from '@/api/common';
import type { CommandSnippet, OperationResult, SaveCommandSnippetInput } from '@/types/contracts';

function desktopOnly<T>(): OperationResult<T> {
  return failure({
    code: 'SNIPPET_DESKTOP_ONLY',
    messageKey: 'errors.snippetDesktopOnly',
    retryable: false,
    remoteState: 'not_applicable',
  });
}

export async function listCommandSnippets(): Promise<OperationResult<CommandSnippet[]>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<CommandSnippet[]>>('list_command_snippets');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SNIPPET_LIST_FAILED'));
  }
}

export async function saveCommandSnippet(input: SaveCommandSnippetInput): Promise<OperationResult<CommandSnippet>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<CommandSnippet>>('save_command_snippet', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SNIPPET_SAVE_FAILED'));
  }
}

export async function deleteCommandSnippet(id: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) return desktopOnly();
  try {
    return await invoke<OperationResult<null>>('delete_command_snippet', { id });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'SNIPPET_DELETE_FAILED'));
  }
}
