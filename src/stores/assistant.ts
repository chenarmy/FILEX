import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  cancelAssistantResponse,
  clearAssistantHistory,
  createAssistantConversation,
  deleteAssistantConversation,
  getAssistantProvider,
  listAssistantConversations,
  loadAssistantHistory,
  renameAssistantConversation,
  saveAssistantHistory,
  saveAssistantProvider,
  selectAssistantConversation,
  setAssistantProviderConsent,
  streamAssistantResponse,
  updateAssistantModel,
  type AssistantChunk,
  type AssistantConversationSummary,
  type AssistantHistoryMessage,
  type AssistantProviderStatus,
  type AssistantTurn,
} from '@/api/domain/assistantApi';
import { isTauriRuntime } from '@/api/common';
import { parseAssistantDraftContent, type AssistantProposalNotice } from '@/domain/assistantProposalParser';
import { useEventsStore } from '@/stores/events';
import { useSessionsStore } from '@/stores/sessions';
import type {
  AssistantDraftProposalV1,
  AssistantProposalTargetSnapshot,
  SessionSummary,
} from '@/types/contracts';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: 'explain' | 'draft';
  content: string;
  status: 'complete' | 'streaming' | 'failed' | 'cancelled';
  proposal?: AssistantDraftProposalV1;
  proposalNotice?: AssistantProposalNotice;
}

const ASSISTANT_CONVERSATION_LIMIT = 10;

interface PendingProposalTarget {
  target: AssistantProposalTargetSnapshot | null;
  stale: boolean;
}

export const useAssistantStore = defineStore('assistant', () => {
  const provider = ref<AssistantProviderStatus>({ endpoint: '', model: '', configured: false, externalDataConsent: false });
  const messages = ref<AssistantMessage[]>([]);
  const conversations = ref<AssistantConversationSummary[]>([]);
  const activeConversationId = ref('');
  const busy = ref(false);
  const historySaving = ref(false);
  const error = ref<string | null>(null);
  const cancelError = ref<string | null>(null);
  const historyError = ref<string | null>(null);
  const activeRequestId = ref<string | null>(null);
  let unlisten: UnlistenFn | null = null;
  let activeCompletion: { requestId: string; resolve: () => void } | null = null;
  let initialization: Promise<void> | null = null;
  const browserHistories = new Map<string, AssistantMessage[]>();
  const pendingProposalTargets = new Map<string, PendingProposalTarget>();
  const sessions = useSessionsStore();

  function proposalTargetMatches(target: AssistantProposalTargetSnapshot, session: SessionSummary | null): boolean {
    return Boolean(session
      && session.id === target.sessionId
      && session.generation === target.generation
      && session.host === target.host
      && session.port === target.port
      && session.state === target.state);
  }

  function invalidateStaleProposals(): void {
    const active = sessions.activeSession;
    for (const pending of pendingProposalTargets.values()) {
      if (pending.target && !proposalTargetMatches(pending.target, active)) pending.stale = true;
    }

    const messageLists = [messages.value, ...browserHistories.values()];
    for (const list of messageLists) {
      for (const message of list) {
        if (message.proposal?.target && !proposalTargetMatches(message.proposal.target, active)) {
          message.proposal.stale = true;
        }
      }
    }
  }

  watch(
    () => {
      const session = sessions.activeSession;
      return session
        ? [session.id, session.generation, session.host, session.port, session.state]
        : null;
    },
    invalidateStaleProposals,
    { flush: 'sync' },
  );

  function makeDraftProposal(
    content: string,
    target: AssistantProposalTargetSnapshot | null,
    alreadyStale = false,
  ): Pick<AssistantMessage, 'proposal' | 'proposalNotice'> {
    const parsed = parseAssistantDraftContent(content);
    if (parsed.content === null) return parsed.notice ? { proposalNotice: parsed.notice } : {};

    const targetSnapshot = target ? { ...target } : null;
    const stale = target ? alreadyStale || !proposalTargetMatches(target, sessions.activeSession) : false;
    if (parsed.content.kind === 'change-plan.draft') {
      return {
        proposal: {
          version: 1,
          risk: 'draft',
          ...parsed.content,
          target: targetSnapshot,
          stale,
        },
      };
    }

    return {
      proposal: {
        version: 1,
        risk: 'draft',
        ...parsed.content,
        target: targetSnapshot,
        stale,
      },
    };
  }

  function hydrateHistoryMessage(message: AssistantHistoryMessage): AssistantMessage {
    const hydrated: AssistantMessage = { ...message, status: 'complete' };
    if (message.role === 'assistant' && message.mode === 'draft') {
      Object.assign(hydrated, makeDraftProposal(message.content, null));
    }
    return hydrated;
  }

  async function initializeOnce(): Promise<void> {
    const [providerResult, conversationsResult] = await Promise.all([
      getAssistantProvider(),
      listAssistantConversations(),
    ]);
    if (providerResult.ok) provider.value = providerResult.data;
    else error.value = providerResult.error.messageKey;
    if (!conversationsResult.ok) {
      historyError.value = conversationsResult.error.messageKey;
      return;
    }
    conversations.value = conversationsResult.data.conversations;
    activeConversationId.value = conversationsResult.data.activeConversationId;
    if (!activeConversationId.value) return;
    const historyResult = await loadAssistantHistory(activeConversationId.value);
    if (!historyResult.ok) {
      historyError.value = historyResult.error.messageKey;
      return;
    }
    messages.value = historyResult.data.map(hydrateHistoryMessage);
    browserHistories.set(activeConversationId.value, messages.value.map((message) => ({ ...message })));
    historyError.value = null;
  }

  async function initialize(): Promise<void> {
    initialization ??= initializeOnce();
    await initialization;
  }

  async function configure(input: { endpoint: string; model: string; apiKey: string }): Promise<boolean> {
    if (busy.value || historySaving.value) return false;
    const result = await saveAssistantProvider(input);
    if (!result.ok) {
      error.value = result.error.messageKey;
      return false;
    }
    provider.value = result.data;
    error.value = null;
    useEventsStore().record('system', 'ASSISTANT_PROVIDER_CONFIGURED', 'success');
    return true;
  }

  async function setProviderConsent(consent: boolean): Promise<boolean> {
    if (!provider.value.configured || busy.value || historySaving.value) return false;
    const result = await setAssistantProviderConsent(consent);
    if (!result.ok) {
      error.value = result.error.messageKey;
      return false;
    }
    provider.value = result.data;
    error.value = null;
    useEventsStore().record('system', consent ? 'ASSISTANT_PROVIDER_CONSENT_GRANTED' : 'ASSISTANT_PROVIDER_CONSENT_REVOKED', 'info');
    return true;
  }

  async function setModel(model: string): Promise<boolean> {
    const normalized = model.trim();
    if (!normalized || normalized.length > 120 || busy.value || historySaving.value || !provider.value.configured) return false;
    if (normalized === provider.value.model) return true;
    const result = await updateAssistantModel(normalized);
    if (!result.ok) {
      error.value = result.error.messageKey;
      return false;
    }
    provider.value = result.data;
    error.value = null;
    useEventsStore().record('system', 'ASSISTANT_PROVIDER_MODEL_CHANGED', 'info');
    return true;
  }

  async function listenForChunks(): Promise<void> {
    if (!isTauriRuntime() || unlisten) return;
    unlisten = await listen<AssistantChunk>('assistant-chunk', ({ payload }) => {
      if (payload.requestId !== activeRequestId.value) return;
      const message = messages.value.find((item) => item.id === payload.requestId && item.role === 'assistant');
      if (!message) return;
      if (payload.text) message.content += payload.text;
      if (payload.error) {
        error.value = payload.error.messageKey;
        message.status = payload.error.code === 'ASSISTANT_CANCELLED' ? 'cancelled' : 'failed';
        useEventsStore().record('system', payload.error.code, message.status === 'failed' ? 'error' : 'warning', { requestId: payload.requestId });
      } else if (payload.done) {
        message.status = 'complete';
        if (message.mode === 'draft') {
          const pending = pendingProposalTargets.get(payload.requestId);
          Object.assign(
            message,
            makeDraftProposal(message.content, pending?.target ?? null, pending?.stale ?? false),
          );
        }
        useEventsStore().record('system', 'ASSISTANT_RESPONSE_COMPLETED', 'success', { requestId: payload.requestId });
      }
      if (payload.done) cancelError.value = null;
      if (payload.done && activeCompletion?.requestId === payload.requestId) {
        const completion = activeCompletion;
        activeCompletion = null;
        completion.resolve();
      }
    });
  }

  async function persistHistory(): Promise<void> {
    if (!activeConversationId.value) return;
    const history: AssistantHistoryMessage[] = messages.value
      .filter((item) => item.status === 'complete' && item.content.trim())
      .slice(-24)
      .map(({ id, role, mode, content }) => ({ id, role, mode, content }));
    historySaving.value = true;
    try {
      const result = await saveAssistantHistory(activeConversationId.value, history);
      if (!result.ok) {
        historyError.value = result.error.messageKey;
        return;
      }
      conversations.value = result.data.conversations;
      historyError.value = null;
    } finally {
      historySaving.value = false;
    }
  }

  async function send(
    prompt: string,
    mode: 'explain' | 'draft',
    context: string | null,
    proposalTarget: AssistantProposalTargetSnapshot | null = null,
    contextFileIds: string[] = [],
  ): Promise<boolean> {
    if (!provider.value.configured) return false;
    if (!provider.value.externalDataConsent) {
      error.value = 'errors.assistantConsentRequired';
      return false;
    }
    if (busy.value || historySaving.value || !activeConversationId.value || !prompt.trim()) return false;
    const requestId = globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}`;
    const pendingTarget: PendingProposalTarget = {
      target: mode === 'draft' && proposalTarget ? { ...proposalTarget } : null,
      stale: false,
    };
    pendingProposalTargets.set(requestId, pendingTarget);
    try {
      await listenForChunks();
    } catch (cause: unknown) {
      pendingProposalTargets.delete(requestId);
      throw cause;
    }
    if (pendingTarget.target && !proposalTargetMatches(pendingTarget.target, sessions.activeSession)) {
      pendingTarget.stale = true;
    }
    const completionPromise = new Promise<void>((resolve) => {
      activeCompletion = { requestId, resolve };
    });
    const history: AssistantTurn[] = messages.value
      .filter((item) => item.status === 'complete' && item.content.trim())
      .slice(-12)
      .map((item) => ({ role: item.role, content: item.content.slice(0, 8_000) }));
    activeRequestId.value = requestId;
    cancelError.value = null;
    busy.value = true;
    error.value = null;
    messages.value.push({ id: `user-${requestId}`, role: 'user', mode, content: prompt.trim(), status: 'complete' });
    messages.value.push({ id: requestId, role: 'assistant', mode, content: '', status: 'streaming' });
    useEventsStore().record('system', 'ASSISTANT_REQUEST_STARTED', 'info', {
      requestId,
      mode,
      contextAttached: context !== null || contextFileIds.length > 0,
    });
    try {
      const result = await streamAssistantResponse({
        requestId,
        prompt: prompt.trim(),
        mode,
        context,
        contextFileIds,
        history,
      });
      if (messages.value.length > 24) messages.value.splice(0, messages.value.length - 24);
      if (!result.ok) {
        error.value = result.error.messageKey;
        const answer = messages.value.find((item) => item.id === requestId);
        if (answer) answer.status = 'failed';
        return false;
      }
      await completionPromise;
      busy.value = false;
      await persistHistory();
      return true;
    } finally {
      if (activeCompletion?.requestId === requestId) {
        const completion = activeCompletion;
        activeCompletion = null;
        completion.resolve();
      }
      busy.value = false;
      activeRequestId.value = null;
      pendingProposalTargets.delete(requestId);
    }
  }

  async function cancel(): Promise<boolean> {
    const requestId = activeRequestId.value;
    if (!requestId) return true;

    cancelError.value = null;
    const result = await cancelAssistantResponse(requestId);
    if (!result.ok) {
      cancelError.value = result.error.messageKey;
      useEventsStore().record('system', result.error.code, 'warning', { requestId });
      return false;
    }
    return true;
  }

  async function clearConversation(): Promise<void> {
    if (busy.value || historySaving.value || !activeConversationId.value) return;
    historySaving.value = true;
    try {
      if (!isTauriRuntime()) {
        browserHistories.set(activeConversationId.value, []);
        conversations.value = conversations.value.map((conversation) => conversation.id === activeConversationId.value
          ? { ...conversation, messageCount: 0, updatedAtMs: Date.now() }
          : conversation);
      } else {
        const result = await clearAssistantHistory(activeConversationId.value);
        if (!result.ok) {
          historyError.value = result.error.messageKey;
          return;
        }
        conversations.value = result.data.conversations;
      }
      messages.value = [];
      error.value = null;
      historyError.value = null;
    } finally {
      historySaving.value = false;
    }
  }

  async function createConversation(): Promise<boolean> {
    if (busy.value || historySaving.value) return false;
    historySaving.value = true;
    try {
      if (!isTauriRuntime()) {
        if (conversations.value.length >= ASSISTANT_CONVERSATION_LIMIT) {
          historyError.value = 'errors.assistantConversationLimit';
          return false;
        }
        const id = globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now()}`;
        const now = Date.now();
        conversations.value.unshift({ id, title: '', createdAtMs: now, updatedAtMs: now, messageCount: 0 });
        activeConversationId.value = id;
        browserHistories.set(id, []);
        messages.value = [];
        historyError.value = null;
        error.value = null;
        return true;
      }
      const result = await createAssistantConversation();
      if (!result.ok) {
        historyError.value = result.error.code === 'ASSISTANT_CONVERSATION_LIMIT'
          ? 'errors.assistantConversationLimit'
          : result.error.messageKey;
        return false;
      }
      conversations.value = result.data.conversations;
      activeConversationId.value = result.data.activeConversationId;
      messages.value = [];
      browserHistories.set(activeConversationId.value, []);
      historyError.value = null;
      error.value = null;
      return true;
    } finally {
      historySaving.value = false;
    }
  }

  async function selectConversation(conversationId: string): Promise<boolean> {
    if (busy.value || historySaving.value || !conversationId) return false;
    if (conversationId === activeConversationId.value) return true;
    historySaving.value = true;
    try {
      if (!isTauriRuntime()) {
        if (!conversations.value.some((conversation) => conversation.id === conversationId)) return false;
        browserHistories.set(activeConversationId.value, messages.value.map((message) => ({ ...message })));
        activeConversationId.value = conversationId;
        messages.value = (browserHistories.get(conversationId) ?? []).map((message) => ({ ...message }));
        historyError.value = null;
        error.value = null;
        return true;
      }
      const selected = await selectAssistantConversation(conversationId);
      if (!selected.ok) {
        historyError.value = selected.error.messageKey;
        return false;
      }
      conversations.value = selected.data.conversations;
      activeConversationId.value = selected.data.activeConversationId;
      messages.value = [];
      const history = await loadAssistantHistory(conversationId);
      if (!history.ok) {
        historyError.value = history.error.messageKey;
        return false;
      }
      messages.value = history.data.map(hydrateHistoryMessage);
      browserHistories.set(conversationId, messages.value.map((message) => ({ ...message })));
      historyError.value = null;
      error.value = null;
      return true;
    } finally {
      historySaving.value = false;
    }
  }

  async function renameConversation(conversationId: string, title: string): Promise<boolean> {
    if (busy.value || historySaving.value || !conversationId) return false;
    historySaving.value = true;
    try {
      if (!isTauriRuntime()) {
        conversations.value = conversations.value.map((conversation) => conversation.id === conversationId
          ? { ...conversation, title: title.trim().slice(0, 120), updatedAtMs: Date.now() }
          : conversation);
        return true;
      }
      const result = await renameAssistantConversation(conversationId, title);
      if (!result.ok) {
        historyError.value = result.error.messageKey;
        return false;
      }
      conversations.value = result.data.conversations;
      historyError.value = null;
      return true;
    } finally {
      historySaving.value = false;
    }
  }

  async function deleteConversation(conversationId: string): Promise<boolean> {
    if (busy.value || historySaving.value || !conversationId || conversations.value.length <= 1) return false;
    historySaving.value = true;
    try {
      const previousActiveId = activeConversationId.value;
      if (!isTauriRuntime()) {
        conversations.value = conversations.value.filter((conversation) => conversation.id !== conversationId);
        browserHistories.delete(conversationId);
        if (previousActiveId === conversationId) {
          const nextConversation = conversations.value[0];
          if (!nextConversation) return false;
          activeConversationId.value = nextConversation.id;
          messages.value = (browserHistories.get(activeConversationId.value) ?? []).map((message) => ({ ...message }));
        }
        historyError.value = null;
        error.value = null;
        return true;
      }
      const result = await deleteAssistantConversation(conversationId);
      if (!result.ok) {
        historyError.value = result.error.messageKey;
        return false;
      }
      conversations.value = result.data.conversations;
      activeConversationId.value = result.data.activeConversationId;
      if (previousActiveId !== activeConversationId.value) {
        messages.value = [];
        const history = await loadAssistantHistory(activeConversationId.value);
        if (!history.ok) {
          historyError.value = history.error.messageKey;
          return false;
        }
        messages.value = history.data.map(hydrateHistoryMessage);
      }
      historyError.value = null;
      error.value = null;
      return true;
    } finally {
      historySaving.value = false;
    }
  }

  return {
    provider,
    messages,
    conversations,
    activeConversationId,
    busy,
    historySaving,
    error,
    cancelError,
    historyError,
    activeRequestId,
    initialize,
    configure,
    setProviderConsent,
    setModel,
    send,
    cancel,
    clearConversation,
    createConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
  };
});
