<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Bot,
  Check,
  ChevronDown,
  Compass,
  Copy,
  Cpu,
  Database,
  Eraser,
  ExternalLink,
  KeyRound,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import {
  releaseAssistantContextFile,
  selectAssistantContextFile,
  type AssistantContextFileReference,
} from '@/api/domain/assistantApi';
import {
  assistantSuggestedModels,
  matchAssistantProviderPreset,
} from '@/domain/assistantProviders';
import AssistantMarkdown from '@/components/assistant/AssistantMarkdown.vue';
import { useAssistantStore, type AssistantMessage } from '@/stores/assistant';
import { useConnectionsStore } from '@/stores/connections';
import { useEventsStore } from '@/stores/events';
import { useMonitorStore } from '@/stores/monitor';
import { useSessionsStore } from '@/stores/sessions';
import { useTransfersStore } from '@/stores/transfers';
import { useTunnelsStore } from '@/stores/tunnels';
import { useUiStore } from '@/stores/ui';
import type { AssistantDraftProposalV1, AssistantProposalTargetSnapshot } from '@/types/contracts';

const assistant = useAssistantStore();
const connections = useConnectionsStore();
const events = useEventsStore();
const monitor = useMonitorStore();
const sessions = useSessionsStore();
const transfers = useTransfersStore();
const tunnels = useTunnelsStore();
const ui = useUiStore();

const mode = ref<'explain' | 'draft'>('explain');
const prompt = ref('');
const attachSession = ref(false);
const attachEvents = ref(false);
const attachMonitor = ref(false);
const attachTransfers = ref(false);
const attachTunnelFailure = ref(false);
const selectedTunnelFailureId = ref('');
const attachTerminalSelection = ref(false);
const contextFiles = ref<AssistantContextFileReference[]>([]);
const contextFileBusy = ref(false);
const contextFileError = ref<string | null>(null);
const assistantSendInProgress = ref(false);
const consentSaving = ref(false);
const contextOpen = ref(false);
const conversationMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const customModel = ref('');
const editingConversationTitle = ref(false);
const conversationTitleDraft = ref('');
const transcriptRef = ref<HTMLElement | null>(null);
const composerRef = ref<HTMLTextAreaElement | null>(null);
const conversationMenuRef = ref<HTMLElement | null>(null);
const modelMenuRef = ref<HTMLElement | null>(null);
const copiedCommands = ref<Record<string, boolean>>({});
let releaseContextOnCompletion = false;
let panelUnmounted = false;
const copyTimers = new Set<number>();

const activeConversation = computed(() => assistant.conversations.find((conversation) => conversation.id === assistant.activeConversationId));
const activeConversationTitle = computed(() => activeConversation.value?.title || t('assistant.newConversation'));
const providerPreset = computed(() => matchAssistantProviderPreset(assistant.provider.endpoint));
const providerLabel = computed(() => assistant.provider.endpoint ? providerPreset.value.name : t('settings.assistantNotConfigured'));
const modelSuggestions = computed(() => assistantSuggestedModels(providerPreset.value.id, assistant.provider.model));
const providerDestination = computed(() => {
  try {
    return new URL(assistant.provider.endpoint).origin;
  } catch {
    return assistant.provider.endpoint.slice(0, 160);
  }
});

watch(() => ui.assistantTerminalSelection, (selection) => {
  attachTerminalSelection.value = selection !== null;
}, { immediate: true });

const errorText = computed(() => assistant.error ? t(assistant.error as Parameters<typeof t>[0]) : '');
const contextFileErrorText = computed(() => contextFileError.value
  ? t(contextFileError.value as Parameters<typeof t>[0])
  : '');
const cancelErrorText = computed(() => assistant.cancelError ? t(assistant.cancelError as Parameters<typeof t>[0]) : '');
const historyErrorText = computed(() => assistant.historyError ? t(assistant.historyError as Parameters<typeof t>[0]) : '');

const recentEvents = computed(() => events.entries
  .filter((event) => event.severity === 'warning' || event.severity === 'error')
  .slice(0, 8));
const recentTransfers = computed(() => {
  const profileId = sessions.activeSession?.profileId ?? connections.activeProfile?.id;
  if (!profileId) return [];
  return transfers.tasks
    .filter((task) => task.profileId === profileId)
    .slice()
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, 5);
});
const failedTunnels = computed(() => tunnels.tunnels.filter((tunnel) => tunnel.state === 'failed' && tunnel.lastError !== null));
const selectedTunnelFailure = computed(() => failedTunnels.value.find((tunnel) => tunnel.id === selectedTunnelFailureId.value) ?? null);
const selectedTunnelTargetHost = computed(() => selectedTunnelFailure.value
  ? safeTunnelTargetHost(selectedTunnelFailure.value.targetHost)
  : null);

watch(failedTunnels, (failures) => {
  if (selectedTunnelFailureId.value && !failures.some((tunnel) => tunnel.id === selectedTunnelFailureId.value)) {
    selectedTunnelFailureId.value = '';
    attachTunnelFailure.value = false;
  }
});

const selectedContext = computed(() => {
  const items: Array<Record<string, unknown>> = [];
  const labels: string[] = [];
  if (attachSession.value && sessions.activeSession) {
    const session = sessions.activeSession;
    items.push({
      kind: 'active-session-summary',
      state: session.state,
      host: session.host,
      port: session.port,
      username: session.username,
      profileName: sessions.profileForId(session.profileId)?.name ?? null,
    });
    labels.push(t('assistant.disclosureSession'));
  }
  if (attachTerminalSelection.value && ui.assistantTerminalSelection) {
    const selection = ui.assistantTerminalSelection;
    items.push({
      kind: 'user-selected-terminal-output',
      host: selection.host,
      text: selection.text,
      truncated: selection.truncated,
    });
    labels.push(t('assistant.disclosureTerminalSelection', { host: selection.host }));
  }
  if (attachEvents.value && recentEvents.value.length > 0) {
    items.push({
      kind: 'recent-events',
      events: recentEvents.value.map(({ category, severity, code, occurredAt }) => ({ category, severity, code, occurredAt })),
    });
    labels.push(t('assistant.disclosureEvents', { count: recentEvents.value.length }));
  }
  if (attachMonitor.value && monitor.snapshot) {
    const {
      state,
      collectedAtMs,
      hostname,
      osName,
      uptimeSeconds,
      loadOne,
      cpuPercent,
      memoryTotalKib,
      memoryAvailableKib,
      swapTotalKib,
      swapUsedKib,
      rootTotalKib,
      rootAvailableKib,
      networkReceiveBytesPerSecond,
      networkTransmitBytesPerSecond,
    } = monitor.snapshot;
    items.push({
      kind: 'system-monitor-summary',
      state: monitor.displayState === 'stale' ? 'stale' : state,
      collectedAtMs,
      hostname,
      osName,
      uptimeSeconds,
      loadOne,
      cpuPercent,
      memoryTotalKib,
      memoryAvailableKib,
      swapTotalKib,
      swapUsedKib,
      rootTotalKib,
      rootAvailableKib,
      networkReceiveBytesPerSecond,
      networkTransmitBytesPerSecond,
    });
    labels.push(t('assistant.disclosureMonitor'));
  }
  if (attachTransfers.value && recentTransfers.value.length > 0) {
    items.push({
      kind: 'recent-transfers',
      transfers: recentTransfers.value.map(({ direction, state, bytesTransferred, totalBytes, error }) => ({
        direction,
        state,
        bytesTransferred,
        totalBytes,
        errorCode: error?.code ?? null,
      })),
    });
    labels.push(t('assistant.disclosureTransfers', { count: recentTransfers.value.length }));
  }
  if (attachTunnelFailure.value && selectedTunnelFailure.value) {
    const tunnel = selectedTunnelFailure.value;
    items.push({
      kind: 'tunnel-failure-summary',
      tunnelKind: tunnel.kind,
      state: tunnel.state,
      bindHost: tunnel.bindHost,
      bindPort: tunnel.bindPort,
      targetHost: safeTunnelTargetHost(tunnel.targetHost),
      targetPort: tunnel.targetPort,
      errorCode: tunnel.lastError?.code ?? null,
    });
    labels.push(t('assistant.disclosureTunnelFailure'));
  }
  return {
    value: items.length > 0 ? JSON.stringify({ kind: 'user-selected-filex-context', items }) : null,
    labels,
  };
});
const approvedContext = computed(() => selectedContext.value.value);
const historyForDisclosure = computed(() => assistant.messages
  .filter((item) => item.status === 'complete' && item.content.trim())
  .slice(-12));
const approximateOutgoingSize = computed(() => {
  const text = [prompt.value, approvedContext.value ?? '', ...historyForDisclosure.value.map((item) => item.content)].join('\n');
  const selectedFileBytes = contextFiles.value.reduce((total, file) => total + file.byteLength, 0);
  const bytes = new TextEncoder().encode(text).byteLength + selectedFileBytes;
  return formatByteLength(bytes);
});
const disclosure = computed(() => {
  const labels = [t('assistant.disclosurePrompt')];
  labels.push(...selectedContext.value.labels);
  if (contextFiles.value.length === 1) {
    const [selectedFile] = contextFiles.value;
    if (selectedFile) labels.push(t('assistant.disclosureLocalFile', { extension: selectedFile.extension }));
  } else if (contextFiles.value.length > 1) {
    labels.push(t('assistant.disclosureLocalFiles', { count: contextFiles.value.length }));
  }
  if (historyForDisclosure.value.length > 0) labels.push(t('assistant.disclosureHistory'));
  return `${labels.join('、')} · ${t('assistant.disclosureApproxSize', { size: approximateOutgoingSize.value })}`;
});
const contextCount = computed(() => selectedContext.value.labels.length + contextFiles.value.length);

watch(
  () => {
    const last = assistant.messages[assistant.messages.length - 1];
    return `${assistant.messages.length}:${last?.status ?? ''}:${last?.content.length ?? 0}`;
  },
  () => void scrollToBottom(),
);

function formatByteLength(bytes: number): string {
  return bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const transcript = transcriptRef.value;
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function closeMenus(): void {
  conversationMenuOpen.value = false;
  modelMenuOpen.value = false;
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (conversationMenuOpen.value && !conversationMenuRef.value?.contains(target)) {
    conversationMenuOpen.value = false;
  }
  if (modelMenuOpen.value && !modelMenuRef.value?.contains(target)) {
    modelMenuOpen.value = false;
  }
}

function openAssistantSettings(): void {
  closeMenus();
  ui.openSettings('assistant');
}

function closeAssistant(): void {
  closeMenus();
  ui.assistantOpen = false;
}

function toggleConversationMenu(): void {
  conversationMenuOpen.value = !conversationMenuOpen.value;
  modelMenuOpen.value = false;
  editingConversationTitle.value = false;
}

function toggleModelMenu(): void {
  if (!assistant.provider.configured) {
    openAssistantSettings();
    return;
  }
  if (assistant.busy || assistant.historySaving) return;
  conversationMenuOpen.value = false;
  editingConversationTitle.value = false;
  customModel.value = assistant.provider.model;
  modelMenuOpen.value = !modelMenuOpen.value;
}

function showCopied(key: string): void {
  copiedCommands.value = { ...copiedCommands.value, [key]: true };
  const timer = window.setTimeout(() => {
    const next = { ...copiedCommands.value };
    delete next[key];
    copiedCommands.value = next;
    copyTimers.delete(timer);
  }, 1_800);
  copyTimers.add(timer);
}

async function copyText(text: string, key: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    showCopied(key);
  } catch {
    ui.notify(t('assistant.copyFailed'));
  }
}

function notifyCopyFailure(): void {
  ui.notify(t('assistant.copyFailed'));
}

async function chooseContextFile(): Promise<void> {
  if (contextFiles.value.length >= 2 || contextFileBusy.value || assistant.busy || assistantSendInProgress.value) return;
  contextFileBusy.value = true;
  contextFileError.value = null;
  try {
    const result = await selectAssistantContextFile();
    if (!result.ok) {
      contextFileError.value = result.error.messageKey;
      return;
    }
    if (!result.data) return;
    if (panelUnmounted) {
      await releaseAssistantContextFile(result.data.id);
      return;
    }
    contextFiles.value = [...contextFiles.value, result.data];
    contextOpen.value = true;
  } finally {
    contextFileBusy.value = false;
  }
}

async function removeContextFile(id: string): Promise<void> {
  const selected = contextFiles.value.find((file) => file.id === id);
  contextFiles.value = contextFiles.value.filter((file) => file.id !== id);
  contextFileError.value = null;
  if (!selected) return;
  const result = await releaseAssistantContextFile(selected.id);
  if (!result.ok) contextFileError.value = result.error.messageKey;
}

async function updateProviderConsent(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  consentSaving.value = true;
  try {
    const saved = await assistant.setProviderConsent(input.checked);
    if (!saved) input.checked = assistant.provider.externalDataConsent;
  } finally {
    consentSaving.value = false;
  }
}

async function setModel(model: string): Promise<void> {
  if (!model.trim() || assistant.busy) return;
  if (model.trim() === assistant.provider.model) {
    modelMenuOpen.value = false;
    return;
  }
  if (await assistant.setModel(model.trim())) {
    modelMenuOpen.value = false;
    ui.notify(t('assistant.modelChanged'));
  }
}

function useQuickPrompt(kind: 'failure' | 'monitor' | 'plan'): void {
  mode.value = kind === 'plan' ? 'draft' : 'explain';
  const keys = {
    failure: 'assistant.quickExplainFailure',
    monitor: 'assistant.quickReviewMonitor',
    plan: 'assistant.quickDraftPlan',
  } as const;
  prompt.value = t(keys[kind]);
  void nextTick(() => composerRef.value?.focus());
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!assistant.busy) void send();
}

async function send(): Promise<void> {
  if (consentSaving.value || assistantSendInProgress.value || assistant.busy) return;
  const sentContextFiles = [...contextFiles.value];
  const sentContextFileIds = sentContextFiles.map((file) => file.id);
  assistantSendInProgress.value = true;
  try {
    const active = attachSession.value ? sessions.activeSession : null;
    const proposalTarget: AssistantProposalTargetSnapshot | null = mode.value === 'draft' && active
      ? {
        sessionId: active.id,
        generation: active.generation,
        host: active.host,
        port: active.port,
        state: active.state,
      }
      : null;
    const submitted = await assistant.send(
      prompt.value,
      mode.value,
      approvedContext.value,
      proposalTarget,
      sentContextFileIds,
    );
    if (submitted) prompt.value = '';
  } finally {
    assistantSendInProgress.value = false;
    if (releaseContextOnCompletion && sentContextFileIds.length > 0) {
      releaseContextOnCompletion = false;
      const sentIds = new Set(sentContextFileIds);
      contextFiles.value = contextFiles.value.filter((file) => !sentIds.has(file.id));
      sentContextFileIds.forEach((id) => void releaseAssistantContextFile(id));
    }
  }
}

async function stop(): Promise<void> {
  await assistant.cancel();
}

function proposalIsStale(proposal: AssistantDraftProposalV1): boolean {
  const target = proposal.target;
  if (!target) return false;
  const active = sessions.activeSession;
  return proposal.stale
    || !active
    || active.id !== target.sessionId
    || active.generation !== target.generation
    || active.host !== target.host
    || active.port !== target.port
    || active.state !== target.state;
}

function visibleAssistantText(message: AssistantMessage): string {
  if (!message.proposal) return message.content;
  const proposalFence = message.proposal.kind === 'change-plan.draft'
    ? /\x60{3}filex-change-plan-v1[ \t]*\r?\n[\s\S]*?\x60{3}/i
    : /\x60{3}(?:bash|sh|zsh|shell|powershell|pwsh|cmd)[ \t]*\r?\n[\s\S]*?\x60{3}/gi;
  return message.content.replace(proposalFence, '').trim();
}

async function clearChat(): Promise<void> {
  const accepted = await ui.confirm({
    title: t('assistant.clearHistoryTitle'),
    message: t('assistant.clearHistoryMessage'),
    confirmLabel: t('assistant.clearChat'),
    danger: true,
  });
  if (accepted) await assistant.clearConversation();
}

async function createChat(): Promise<void> {
  editingConversationTitle.value = false;
  conversationMenuOpen.value = false;
  if (await assistant.createConversation()) void nextTick(() => composerRef.value?.focus());
}

async function selectChat(conversationId: string): Promise<boolean> {
  if (conversationId === assistant.activeConversationId) {
    conversationMenuOpen.value = false;
    return true;
  }
  editingConversationTitle.value = false;
  const selected = await assistant.selectConversation(conversationId);
  if (selected) conversationMenuOpen.value = false;
  return selected;
}

function beginRenameConversation(): void {
  conversationTitleDraft.value = activeConversation.value?.title ?? '';
  editingConversationTitle.value = true;
  conversationMenuOpen.value = true;
}

async function saveConversationTitle(): Promise<void> {
  const conversationId = assistant.activeConversationId;
  if (!conversationId) return;
  if (await assistant.renameConversation(conversationId, conversationTitleDraft.value)) {
    editingConversationTitle.value = false;
  }
}

async function selectAndRenameConversation(conversationId: string): Promise<void> {
  if (await selectChat(conversationId)) beginRenameConversation();
}

async function deleteChat(conversationId = assistant.activeConversationId): Promise<void> {
  if (!conversationId || assistant.conversations.length <= 1) return;
  const title = assistant.conversations.find((conversation) => conversation.id === conversationId)?.title
    || t('assistant.newConversation');
  const accepted = await ui.confirm({
    title: t('assistant.deleteConversationTitle'),
    message: t('assistant.deleteConversationMessage', { title }),
    confirmLabel: t('assistant.deleteConversation'),
    danger: true,
  });
  if (accepted && await assistant.deleteConversation(conversationId)) {
    editingConversationTitle.value = false;
    if (assistant.conversations.length === 0) conversationMenuOpen.value = false;
  }
}

function clearTerminalContext(): void {
  ui.clearTerminalSelection();
  attachTerminalSelection.value = false;
}

function toggleTunnelFailureContext(event: Event): void {
  const enabled = (event.currentTarget as HTMLInputElement).checked;
  if (!enabled) {
    attachTunnelFailure.value = false;
    return;
  }
  const selected = failedTunnels.value.find((tunnel) => tunnel.id === selectedTunnelFailureId.value)
    ?? failedTunnels.value[0];
  if (!selected) return;
  selectedTunnelFailureId.value = selected.id;
  attachTunnelFailure.value = true;
}

function safeTunnelTargetHost(host: string | null): string | null {
  if (!host || host.length > 253) return null;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    const parsed = new URL(`ssh://${urlHost}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i.test(parsed.hostname) ? parsed.hostname : null;
  } catch {
    return null;
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  await assistant.initialize();
  void scrollToBottom();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  copyTimers.forEach((timer) => window.clearTimeout(timer));
  copyTimers.clear();
  panelUnmounted = true;
  const selected = contextFiles.value;
  contextFiles.value = [];
  if (selected.length > 0 && assistantSendInProgress.value) {
    releaseContextOnCompletion = true;
    return;
  }
  selected.forEach((file) => void releaseAssistantContextFile(file.id));
});
</script>

<template>
  <aside class="assistant-panel" :aria-label="t('assistant.title')" @keydown.esc="closeMenus">
    <header class="assistant-header">
      <div ref="conversationMenuRef" class="assistant-conversation-control">
        <button
          type="button"
          class="assistant-title-button"
          :aria-expanded="conversationMenuOpen"
          :title="t('assistant.conversationMenu')"
          @click="toggleConversationMenu"
        >
          <span class="assistant-brand-icon"><Bot :size="14" /></span>
          <strong>{{ activeConversationTitle }}</strong>
          <ChevronDown :size="12" />
        </button>
        <section v-if="conversationMenuOpen" class="assistant-popover assistant-conversation-menu" :aria-label="t('assistant.conversationMenu')">
          <header>
            <strong>{{ t('assistant.conversationMenu') }}</strong>
            <button type="button" :disabled="assistant.busy || assistant.historySaving" @click="createChat">
              <Plus :size="12" />{{ t('assistant.newChat') }}
            </button>
          </header>
          <div class="assistant-conversation-list">
            <article
              v-for="conversation in assistant.conversations"
              :key="conversation.id"
              class="assistant-conversation-row"
              :class="{ active: conversation.id === assistant.activeConversationId }"
            >
              <button type="button" class="assistant-conversation-select" @click="selectChat(conversation.id)">
                <MessageSquare :size="12" />
                <span>
                  <strong>{{ conversation.title || t('assistant.newConversation') }}</strong>
                  <small>{{ t('assistant.messageCount', { count: conversation.messageCount }) }}</small>
                </span>
              </button>
              <div class="assistant-conversation-actions">
                <button
                  type="button"
                  :aria-label="t('assistant.renameConversation')"
                  :title="t('assistant.renameConversation')"
                  :disabled="assistant.busy || assistant.historySaving"
                  @click="selectAndRenameConversation(conversation.id)"
                >
                  <Pencil :size="11" />
                </button>
                <button
                  type="button"
                  :aria-label="t('assistant.deleteConversation')"
                  :title="t('assistant.deleteConversation')"
                  :disabled="assistant.busy || assistant.historySaving || assistant.conversations.length <= 1"
                  @click="deleteChat(conversation.id)"
                >
                  <Trash2 :size="11" />
                </button>
              </div>
            </article>
          </div>
          <form v-if="editingConversationTitle" class="assistant-conversation-rename" @submit.prevent="saveConversationTitle">
            <input
              v-model="conversationTitleDraft"
              maxlength="120"
              :aria-label="t('assistant.conversationTitle')"
              :placeholder="t('assistant.conversationTitle')"
              @keydown.esc.prevent="editingConversationTitle = false"
            >
            <button type="button" :aria-label="t('assistant.saveConversationTitle')" :disabled="assistant.historySaving" @click="saveConversationTitle">
              <Check :size="12" />
            </button>
            <button type="button" :aria-label="t('assistant.cancel')" @click="editingConversationTitle = false">
              <X :size="12" />
            </button>
          </form>
        </section>
      </div>
      <div class="assistant-header-actions">
        <button type="button" class="icon-button" :aria-label="t('assistant.newChat')" :title="t('assistant.newChat')" :disabled="assistant.busy || assistant.historySaving" @click="createChat">
          <Plus :size="13" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('assistant.clearChat')" :title="t('assistant.clearChat')" :disabled="assistant.busy || assistant.historySaving || assistant.messages.length === 0" @click="clearChat">
          <Eraser :size="13" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('assistant.openProviderSettings')" :title="t('assistant.openProviderSettings')" @click="openAssistantSettings">
          <Settings2 :size="13" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('assistant.close')" :title="t('assistant.close')" @click="closeAssistant">
          <X :size="13" />
        </button>
      </div>
    </header>

    <div class="assistant-control-bar">
      <button
        type="button"
        class="assistant-control-pill"
        :class="{ active: contextOpen, populated: contextCount > 0 }"
        :aria-expanded="contextOpen"
        @click="contextOpen = !contextOpen"
      >
        <Compass :size="12" />
        <span>{{ contextCount > 0 ? t('assistant.contextAttached', { count: contextCount }) : t('assistant.context') }}</span>
      </button>
      <div ref="modelMenuRef" class="assistant-model-control">
        <button
          type="button"
          class="assistant-control-pill assistant-model-pill"
          :class="{ active: modelMenuOpen, unconfigured: !assistant.provider.configured }"
          :aria-expanded="modelMenuOpen"
          @click="toggleModelMenu"
        >
          <Cpu :size="12" />
          <span>{{ assistant.provider.configured ? `${providerLabel} / ${assistant.provider.model}` : t('assistant.configure') }}</span>
          <ChevronDown :size="11" />
        </button>
        <section v-if="modelMenuOpen" class="assistant-popover assistant-model-menu" :aria-label="t('assistant.modelSelector')">
          <header>
            <div><span>{{ t('assistant.profile') }}</span><strong>{{ providerLabel }}</strong></div>
            <button type="button" @click="openAssistantSettings"><Settings2 :size="12" />{{ t('assistant.change') }}</button>
          </header>
          <div class="assistant-model-current">
            <span>{{ t('assistant.activeModel') }}</span>
            <code>{{ assistant.provider.model }}</code>
          </div>
          <div v-if="modelSuggestions.length > 0" class="assistant-model-suggestions">
            <small>{{ t('assistant.modelSuggestions') }}</small>
            <button
              v-for="suggestion in modelSuggestions"
              :key="suggestion"
              type="button"
              :class="{ selected: suggestion === assistant.provider.model }"
              :disabled="assistant.busy || assistant.historySaving"
              @click="setModel(suggestion)"
            >
              <span>{{ suggestion }}</span>
              <Check v-if="suggestion === assistant.provider.model" :size="12" />
            </button>
          </div>
          <form class="assistant-custom-model" @submit.prevent="setModel(customModel)">
            <label>
              <span>{{ t('assistant.customModel') }}</span>
              <input v-model="customModel" maxlength="120" autocomplete="off" spellcheck="false">
            </label>
            <button type="submit" :disabled="assistant.busy || assistant.historySaving || !customModel.trim()">{{ t('assistant.applyModel') }}</button>
          </form>
        </section>
      </div>
    </div>

    <section v-if="!assistant.provider.configured" class="assistant-setup-card">
      <KeyRound :size="17" />
      <div>
        <strong>{{ t('assistant.setupTitle') }}</strong>
        <p>{{ t('assistant.setupHelp') }}</p>
      </div>
      <button type="button" class="button primary" @click="openAssistantSettings">{{ t('assistant.openSettings') }}</button>
    </section>

    <section v-else-if="!assistant.provider.externalDataConsent" class="assistant-consent-card">
      <ShieldAlert :size="16" />
      <div>
        <strong>{{ t('assistant.consentRequiredTitle') }}</strong>
        <p>{{ t('assistant.consentRequiredHelp') }}</p>
        <p>{{ t('assistant.providerPrivacyNotice') }}</p>
        <small>{{ t('assistant.providerRecipient', { endpoint: providerDestination }) }}</small>
        <label class="assistant-consent-toggle">
          <input
            type="checkbox"
            :checked="assistant.provider.externalDataConsent"
            :disabled="assistant.busy || assistant.historySaving || consentSaving"
            @change="updateProviderConsent"
          >
          <span>{{ t('assistant.providerDataConsent', { endpoint: providerDestination }) }}</span>
        </label>
      </div>
    </section>

    <div v-if="assistant.provider.configured" class="assistant-disclosure-strip">
      <ExternalLink :size="12" />
      <span>{{ t('assistant.externalDisclosure') }} {{ disclosure }}</span>
    </div>

    <div ref="transcriptRef" class="assistant-transcript">
      <div v-if="assistant.messages.length === 0" class="assistant-empty">
        <span class="assistant-empty-icon"><WandSparkles :size="20" /></span>
        <div>
          <strong>{{ t('assistant.title') }}</strong>
          <p>{{ t('assistant.empty') }}</p>
        </div>
        <div class="assistant-quick-prompts">
          <span>{{ t('assistant.quickSuggestions') }}</span>
          <button type="button" @click="useQuickPrompt('failure')">{{ t('assistant.quickExplainFailure') }}</button>
          <button type="button" @click="useQuickPrompt('monitor')">{{ t('assistant.quickReviewMonitor') }}</button>
          <button type="button" @click="useQuickPrompt('plan')">{{ t('assistant.quickDraftPlan') }}</button>
        </div>
      </div>

      <article v-for="message in assistant.messages" :key="message.id" class="assistant-message" :class="message.role">
        <header>
          <span v-if="message.role === 'assistant'" class="assistant-message-avatar"><Sparkles :size="11" /></span>
          <strong>{{ message.role === 'user' ? t('assistant.you') : t('assistant.assistantLabel') }}</strong>
          <small>{{ message.mode === 'draft' ? t('assistant.draftMode') : t('assistant.explainMode') }}</small>
          <span v-if="message.status === 'cancelled'">{{ t('assistant.cancel') }}</span>
        </header>
        <div class="assistant-message-body">
          <p v-if="message.role === 'user'" class="assistant-user-text">{{ message.content }}</p>
          <AssistantMarkdown
            v-else-if="visibleAssistantText(message)"
            :content="visibleAssistantText(message)"
            @copy-failed="notifyCopyFailure"
          />
          <p v-else-if="message.status === 'streaming'" class="assistant-thinking">
            <Sparkles :size="12" />{{ t('assistant.thinking') }}
          </p>
          <section v-if="message.proposal" class="assistant-command-proposal" :class="{ 'is-stale': proposalIsStale(message.proposal) }" :aria-label="t(message.proposal.kind === 'change-plan.draft' ? 'assistant.changePlanTitle' : 'assistant.proposalTitle')">
            <div class="assistant-proposal-heading"><strong>{{ t(message.proposal.kind === 'change-plan.draft' ? 'assistant.changePlanTitle' : 'assistant.proposalTitle') }}</strong><code>{{ message.proposal.kind }}@{{ message.proposal.version }}</code></div>
            <div class="assistant-proposal-meta">
              <span>{{ t('assistant.proposalRisk') }}</span>
              <span>{{ message.proposal.target ? t('assistant.proposalTarget', { host: message.proposal.target.host, port: message.proposal.target.port }) : t('assistant.proposalNoTarget') }}</span>
              <strong v-if="proposalIsStale(message.proposal)">{{ t('assistant.proposalStale') }}</strong>
            </div>
            <template v-if="message.proposal.kind === 'change-plan.draft'">
              <h4 class="assistant-proposal-plan-title">{{ message.proposal.title }}</h4>
              <p class="assistant-proposal-summary">{{ message.proposal.summary }}</p>
              <section v-for="(step, stepIndex) in message.proposal.steps" :key="`${message.id}-step-${stepIndex}`" class="assistant-proposal-step">
                <strong class="assistant-proposal-step-title">{{ t('assistant.planStep', { index: stepIndex + 1, title: step.title }) }}</strong>
                <div v-for="(command, commandIndex) in step.commands" :key="`${message.id}-step-${stepIndex}-command-${commandIndex}`" class="assistant-proposal-command">
                  <header>
                    <small>{{ t('assistant.planCommandLabel', { shell: command.shell, index: commandIndex + 1 }) }}</small>
                    <button type="button" :aria-label="t('assistant.copyCode')" :title="t('assistant.copyCode')" @click="copyText(command.command, `${message.id}-${stepIndex}-${commandIndex}`)">
                      <Check v-if="copiedCommands[`${message.id}-${stepIndex}-${commandIndex}`]" :size="11" />
                      <Copy v-else :size="11" />
                    </button>
                  </header>
                  <pre>{{ command.command }}</pre>
                </div>
                <p class="assistant-proposal-step-note"><strong>{{ t('assistant.planExpectedEffect') }}</strong> {{ step.expectedEffect }}</p>
                <p class="assistant-proposal-step-note"><strong>{{ t('assistant.planRollback') }}</strong> {{ step.rollback }}</p>
              </section>
            </template>
            <template v-else>
              <div v-for="(command, index) in message.proposal.commands" :key="`${message.id}-${index}`" class="assistant-proposal-command">
                <header>
                  <small>{{ t('assistant.proposalCommandLabel', { shell: command.shell, index: index + 1 }) }}</small>
                  <button type="button" :aria-label="t('assistant.copyCode')" :title="t('assistant.copyCode')" @click="copyText(command.command, `${message.id}-${index}`)">
                    <Check v-if="copiedCommands[`${message.id}-${index}`]" :size="11" />
                    <Copy v-else :size="11" />
                  </button>
                </header>
                <pre>{{ command.command }}</pre>
              </div>
            </template>
            <p>{{ t('assistant.proposalNeverExecuted') }}</p>
          </section>
          <p v-if="message.proposalNotice === 'too_many'" class="assistant-proposal-notice" role="status">{{ t('assistant.proposalTooMany') }}</p>
          <p v-else-if="message.proposalNotice === 'too_large'" class="assistant-proposal-notice" role="status">{{ t('assistant.proposalTooLarge') }}</p>
          <p v-else-if="message.proposalNotice === 'unsafe_control'" class="assistant-proposal-notice" role="status">{{ t('assistant.proposalUnsafeCharacters') }}</p>
          <p v-else-if="message.proposalNotice === 'plan_invalid'" class="assistant-proposal-notice" role="status">{{ t('assistant.planInvalid') }}</p>
          <p v-else-if="message.proposalNotice === 'plan_too_many'" class="assistant-proposal-notice" role="status">{{ t('assistant.planTooMany') }}</p>
          <p v-else-if="message.proposalNotice === 'plan_too_large'" class="assistant-proposal-notice" role="status">{{ t('assistant.planTooLarge') }}</p>
          <p v-else-if="message.proposalNotice === 'plan_unsafe_control'" class="assistant-proposal-notice" role="status">{{ t('assistant.planUnsafeCharacters') }}</p>
          <span v-if="message.status === 'failed'" class="form-error">{{ errorText }}</span>
        </div>
      </article>
    </div>

    <section v-if="contextOpen" class="assistant-context-drawer" :aria-label="t('assistant.contextDetails')">
      <header>
        <strong>{{ t('assistant.contextDetails') }}</strong>
        <button type="button" class="icon-button" :aria-label="t('assistant.collapseMenu')" @click="contextOpen = false"><X :size="12" /></button>
      </header>
      <div class="assistant-context-options">
        <label class="assistant-context-toggle"><input v-model="attachSession" type="checkbox" :disabled="!sessions.activeSession"><span>{{ t('assistant.attachSession') }}</span></label>
        <label class="assistant-context-toggle"><input v-model="attachTerminalSelection" type="checkbox" :disabled="!ui.assistantTerminalSelection"><span>{{ t('assistant.attachTerminalSelection') }}</span></label>
        <label class="assistant-context-toggle"><input v-model="attachEvents" type="checkbox" :disabled="recentEvents.length === 0"><span>{{ t('assistant.attachEvents', { count: recentEvents.length }) }}</span></label>
        <label class="assistant-context-toggle"><input v-model="attachMonitor" type="checkbox" :disabled="!monitor.snapshot"><span>{{ t('assistant.attachMonitor') }}</span></label>
        <label class="assistant-context-toggle"><input v-model="attachTransfers" type="checkbox" :disabled="recentTransfers.length === 0"><span>{{ t('assistant.attachTransfers', { count: recentTransfers.length }) }}</span></label>
        <label class="assistant-context-toggle"><input type="checkbox" :checked="attachTunnelFailure" :disabled="failedTunnels.length === 0" @change="toggleTunnelFailureContext"><span>{{ t('assistant.attachTunnelFailure', { count: failedTunnels.length }) }}</span></label>
      </div>
      <div v-if="attachTerminalSelection && ui.assistantTerminalSelection" class="assistant-context-preview">
        {{ t('assistant.terminalSelectionPreview', { host: ui.assistantTerminalSelection.host, chars: Array.from(ui.assistantTerminalSelection.text).length, truncated: ui.assistantTerminalSelection.truncated ? t('assistant.yes') : t('assistant.no') }) }}
        <button type="button" class="button" @click="clearTerminalContext">{{ t('assistant.clearTerminalSelection') }}</button>
      </div>
      <div v-if="attachTunnelFailure && selectedTunnelFailure" class="assistant-context-preview">
        <select v-model="selectedTunnelFailureId" class="assistant-context-select" :aria-label="t('assistant.selectTunnelFailure')">
          <option v-for="tunnel in failedTunnels" :key="tunnel.id" :value="tunnel.id">{{ tunnel.name }} · {{ tunnel.bindHost }}:{{ tunnel.bindPort }} · {{ tunnel.lastError?.code }}</option>
        </select>
        <div>{{ t('assistant.tunnelFailurePreview', { kind: selectedTunnelFailure.kind, bindHost: selectedTunnelFailure.bindHost, bindPort: selectedTunnelFailure.bindPort, target: selectedTunnelFailure.kind === 'dynamic' ? t('assistant.dynamicTarget') : `${selectedTunnelTargetHost ?? t('assistant.targetHostOmitted')}:${selectedTunnelFailure.targetPort ?? '—'}`, errorCode: selectedTunnelFailure.lastError?.code ?? '—' }) }}</div>
      </div>
      <div v-if="attachSession && sessions.activeSession" class="assistant-context-preview">{{ t('assistant.sessionContextPreview', { host: sessions.activeSession.host }) }}</div>
      <p class="assistant-history-note"><Database :size="12" /><span>{{ t('assistant.localHistoryNotice') }}</span></p>
    </section>

    <div class="assistant-compose">
      <div class="assistant-compose-toolbar">
        <div class="assistant-mode" role="group" :aria-label="t('assistant.mode')">
          <button type="button" :aria-pressed="mode === 'explain'" :disabled="assistant.busy" @click="mode = 'explain'">
            <MessageSquare :size="11" />{{ t('assistant.explainMode') }}
          </button>
          <button type="button" :aria-pressed="mode === 'draft'" :disabled="assistant.busy" @click="mode = 'draft'">
            <WandSparkles :size="11" />{{ t('assistant.draftMode') }}
          </button>
        </div>
        <button
          type="button"
          class="assistant-attach-button"
          :disabled="assistant.busy || contextFileBusy || assistantSendInProgress || contextFiles.length >= 2"
          :aria-label="t('assistant.attachContextFile')"
          :title="t('assistant.attachContextFile')"
          @click="chooseContextFile"
        >
          <Paperclip :size="12" />
        </button>
      </div>
      <div v-if="contextFiles.length > 0" class="assistant-file-chips">
        <div v-for="contextFile in contextFiles" :key="contextFile.id" class="assistant-file-chip">
          <Paperclip :size="11" />
          <span :title="contextFile.fileName">{{ contextFile.fileName }}</span>
          <small>{{ contextFile.extension.toUpperCase() }} · {{ formatByteLength(contextFile.byteLength) }}</small>
          <button type="button" class="icon-button" :aria-label="t('assistant.removeContextFile')" :disabled="assistant.busy || assistantSendInProgress" @click="removeContextFile(contextFile.id)"><X :size="11" /></button>
        </div>
      </div>
      <p v-if="contextFiles.length > 0" class="assistant-file-note">{{ t('assistant.localFileSelectionNotice') }}</p>
      <p v-if="contextFileError" class="assistant-error" role="alert">{{ contextFileErrorText }}</p>
      <textarea
        ref="composerRef"
        v-model="prompt"
        :placeholder="t('assistant.promptPlaceholder')"
        maxlength="20000"
        :disabled="consentSaving || assistant.busy"
        @keydown="handleComposerKeydown"
      />
      <div class="assistant-compose-footer">
        <small>{{ t('assistant.neverExecutes') }} {{ t('assistant.sendHint') }}</small>
        <button v-if="assistant.busy" type="button" class="button" @click="stop"><Square :size="12" />{{ t('assistant.cancel') }}</button>
        <button
          v-else
          type="button"
          class="button primary"
          :disabled="assistant.historySaving || consentSaving || !assistant.provider.configured || !assistant.provider.externalDataConsent || !prompt.trim()"
          @click="send"
        >
          <Send :size="12" />{{ t('assistant.send') }}
        </button>
      </div>
    </div>

    <p v-if="assistant.cancelError" class="assistant-error" role="alert">{{ cancelErrorText }}</p>
    <p v-if="assistant.error && !assistant.messages.some((item) => item.status === 'failed')" class="assistant-error" role="alert">{{ errorText }}</p>
    <p v-if="assistant.historyError" class="assistant-error" role="alert">{{ historyErrorText }}</p>
    <div class="sr-only" role="status" aria-live="polite">
      {{ assistant.busy ? t('assistant.thinking') : assistant.provider.externalDataConsent ? '' : t('assistant.consentRequiredTitle') }}
    </div>
  </aside>
</template>
