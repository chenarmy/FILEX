import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { OperationResult } from '@/types/contracts';

export interface AssistantProviderStatus {
  endpoint: string;
  model: string;
  configured: boolean;
  externalDataConsent: boolean;
}

export interface AssistantChunk {
  requestId: string;
  text: string;
  done: boolean;
  error: { code: string; messageKey: string } | null;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantContextFileReference {
  id: string;
  fileName: string;
  extension: string;
  byteLength: number;
}

export interface AssistantHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: 'explain' | 'draft';
  content: string;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
}

export interface AssistantConversationIndex {
  activeConversationId: string;
  conversations: AssistantConversationSummary[];
}

export async function getAssistantProvider(): Promise<OperationResult<AssistantProviderStatus>> {
  if (!isTauriRuntime()) return success({ endpoint: '', model: '', configured: false, externalDataConsent: false });
  try {
    return await invoke<OperationResult<AssistantProviderStatus>>('get_assistant_provider');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_CONFIG_LOAD_FAILED'));
  }
}

export async function listAssistantConversations(): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) {
    return success({
      activeConversationId: 'browser-preview',
      conversations: [{ id: 'browser-preview', title: '', createdAtMs: 0, updatedAtMs: 0, messageCount: 0 }],
    });
  }
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('list_assistant_conversations');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function createAssistantConversation(): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('create_assistant_conversation');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function selectAssistantConversation(conversationId: string): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('select_assistant_conversation', { conversationId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function renameAssistantConversation(
  conversationId: string,
  title: string,
): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('rename_assistant_conversation', { conversationId, title });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function deleteAssistantConversation(conversationId: string): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('delete_assistant_conversation', { conversationId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function loadAssistantHistory(conversationId: string): Promise<OperationResult<AssistantHistoryMessage[]>> {
  if (!isTauriRuntime()) return success([]);
  try {
    return await invoke<OperationResult<AssistantHistoryMessage[]>>('load_assistant_history', { conversationId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function saveAssistantHistory(
  conversationId: string,
  messages: AssistantHistoryMessage[],
): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('save_assistant_history', { conversationId, messages });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function clearAssistantHistory(conversationId: string): Promise<OperationResult<AssistantConversationIndex>> {
  if (!isTauriRuntime()) return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  try {
    return await invoke<OperationResult<AssistantConversationIndex>>('clear_assistant_history', { conversationId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_HISTORY_FAILED'));
  }
}

export async function saveAssistantProvider(input: {
  endpoint: string;
  model: string;
  apiKey: string;
}): Promise<OperationResult<AssistantProviderStatus>> {
  if (!isTauriRuntime()) {
    return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  }
  try {
    return await invoke<OperationResult<AssistantProviderStatus>>('save_assistant_provider', input);
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_CONFIG_SAVE_FAILED'));
  }
}

export async function setAssistantProviderConsent(consent: boolean): Promise<OperationResult<AssistantProviderStatus>> {
  if (!isTauriRuntime()) {
    return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  }
  try {
    return await invoke<OperationResult<AssistantProviderStatus>>('set_assistant_provider_consent', { consent });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_CONFIG_SAVE_FAILED'));
  }
}

export async function selectAssistantContextFile(): Promise<OperationResult<AssistantContextFileReference | null>> {
  if (!isTauriRuntime()) {
    return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  }
  try {
    return await invoke<OperationResult<AssistantContextFileReference | null>>('select_assistant_context_file');
  } catch (error: unknown) {
    const normalized = normalizeUnknownError(error, 'ASSISTANT_CONTEXT_FILE_DIALOG_FAILED');
    return failure(normalized.code === 'ASSISTANT_CONTEXT_FILE_DIALOG_FAILED'
      ? { ...normalized, messageKey: 'errors.assistantContextFileFailed' }
      : normalized);
  }
}

export async function releaseAssistantContextFile(id: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  }
  try {
    return await invoke<OperationResult<null>>('release_assistant_context_file', { id });
  } catch (error: unknown) {
    const normalized = normalizeUnknownError(error, 'ASSISTANT_CONTEXT_FILE_FAILED');
    return failure(normalized.code === 'ASSISTANT_CONTEXT_FILE_FAILED'
      ? { ...normalized, messageKey: 'errors.assistantContextFileFailed' }
      : normalized);
  }
}

export async function streamAssistantResponse(request: {
  requestId: string;
  prompt: string;
  mode: 'explain' | 'draft';
  context: string | null;
  contextFileIds: string[];
  history: AssistantTurn[];
}): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return failure({ code: 'DESKTOP_RUNTIME_REQUIRED', messageKey: 'errors.desktopRuntimeRequired', retryable: false, remoteState: 'not_applicable' });
  }
  try {
    return await invoke<OperationResult<null>>('stream_assistant_response', { request: request });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'ASSISTANT_PROVIDER_FAILED'));
  }
}

export async function cancelAssistantResponse(requestId: string): Promise<OperationResult<null>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'DESKTOP_RUNTIME_REQUIRED',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<null>>('cancel_assistant_response', { requestId });
  } catch (error: unknown) {
    const normalized = normalizeUnknownError(error, 'ASSISTANT_CANCEL_FAILED');
    return failure(normalized.code === 'ASSISTANT_CANCEL_FAILED'
      ? { ...normalized, messageKey: 'errors.assistantCancelFailed' }
      : normalized);
  }
}
