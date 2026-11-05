<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Bot, Check, Database, Eraser, ExternalLink, KeyRound, Paperclip, Pencil, Plus, Send, Settings2, Square, Trash2, WandSparkles, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import {
  releaseAssistantContextFile,
  selectAssistantContextFile,
  type AssistantContextFileReference,
} from '@/api/domain/assistantApi';
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
const showSettings = ref(false);
const consentSaving = ref(false);
const endpoint = ref('https://api.openai.com/v1');
const model = ref('gpt-4o-mini');
const apiKey = ref('');
const editingConversationTitle = ref(false);
const conversationTitleDraft = ref('');
const activeConversation = computed(() => assistant.conversations.find((conversation) => conversation.id === assistant.activeConversationId));
const activeConversationTitle = computed(() => activeConversation.value?.title || t('assistant.newConversation'));
let releaseContextOnCompletion = false;
let panelUnmounted = false;
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

function formatByteLength(bytes: number): string {
  return bytes < 1_024 ? `${bytes} B` : `${(bytes / 1_024).toFixed(1)} KiB`;
}

onBeforeUnmount(() => {
  panelUnmounted = true;
  const selected = contextFiles.value;
  contextFiles.value = [];
  if (selected.length > 0 && assistantSendInProgress.value) {
    releaseContextOnCompletion = true;
    return;
  }
  selected.forEach((file) => void releaseAssistantContextFile(file.id));
});

onMounted(async () => {
  await assistant.initialize();
  if (assistant.provider.endpoint) endpoint.value = assistant.provider.endpoint;
  if (assistant.provider.model) model.value = assistant.provider.model;
  showSettings.value = !assistant.provider.configured;
});

async function configure(): Promise<void> {
  if (!apiKey.value.trim()) return;
  const saved = await assistant.configure({ endpoint: endpoint.value, model: model.value, apiKey: apiKey.value });
  if (saved) {
    apiKey.value = '';
    showSettings.value = false;
    ui.notify(t('assistant.configured'));
  }
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
  await assistant.createConversation();
}

async function selectChat(event: Event): Promise<void> {
  const conversationId = (event.target as HTMLSelectElement).value;
  editingConversationTitle.value = false;
  await assistant.selectConversation(conversationId);
}

function beginRenameConversation(): void {
  conversationTitleDraft.value = activeConversation.value?.title ?? '';
  editingConversationTitle.value = true;
}

async function saveConversationTitle(): Promise<void> {
  const conversationId = assistant.activeConversationId;
  if (!conversationId) return;
  if (await assistant.renameConversation(conversationId, conversationTitleDraft.value)) {
    editingConversationTitle.value = false;
  }
}

async function deleteChat(): Promise<void> {
  const conversationId = assistant.activeConversationId;
  if (!conversationId || assistant.conversations.length <= 1) return;
  const accepted = await ui.confirm({
    title: t('assistant.deleteConversationTitle'),
    message: t('assistant.deleteConversationMessage', { title: activeConversationTitle.value }),
    confirmLabel: t('assistant.deleteConversation'),
    danger: true,
  });
  if (accepted && await assistant.deleteConversation(conversationId)) editingConversationTitle.value = false;
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
</script>

<template>
  <aside class="assistant-panel" aria-label="AI assistant">
    <header class="assistant-header">
      <div><Bot :size="15" /><strong>{{ t('assistant.title') }}</strong></div>
      <button type="button" class="icon-button" :aria-label="t('assistant.configure')" @click="showSettings = !showSettings"><Settings2 :size="14" /></button>
    </header>

    <section v-if="showSettings" class="assistant-config">
      <div class="assistant-config-heading"><KeyRound :size="14" /><strong>{{ t('assistant.providerSetup') }}</strong></div>
      <label>{{ t('assistant.endpoint') }}<input v-model="endpoint" type="url" placeholder="https://api.openai.com/v1"></label>
      <label>{{ t('assistant.model') }}<input v-model="model" autocomplete="off"></label>
      <label>{{ t('assistant.apiKey') }}<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="t('assistant.keyOnlyInKeyring')"></label>
      <p>{{ t('assistant.keyringNotice') }}</p>
      <p>{{ t('assistant.providerPrivacyNotice') }}</p>
      <button type="button" class="button primary" :disabled="assistant.busy || assistant.historySaving || !apiKey.trim()" @click="configure">{{ t('assistant.saveProvider') }}</button>
    </section>

    <template v-else>
      <div class="assistant-provider"><span class="state-dot" :class="{ connected: assistant.provider.configured }" />{{ assistant.provider.model }}<button type="button" :disabled="assistant.busy || assistant.historySaving || (assistant.messages.length === 0 && !assistant.historyError)" @click="clearChat"><Eraser :size="12" />{{ t('assistant.clearChat') }}</button><button type="button" @click="showSettings = true">{{ t('assistant.change') }}</button></div>
      <div class="assistant-conversation-toolbar">
        <select :value="assistant.activeConversationId" :aria-label="t('assistant.selectConversation')" :disabled="assistant.busy || assistant.historySaving || assistant.conversations.length <= 1" @change="selectChat">
          <option v-for="conversation in assistant.conversations" :key="conversation.id" :value="conversation.id">{{ conversation.title || t('assistant.newConversation') }}</option>
        </select>
        <button type="button" class="icon-button" :aria-label="t('assistant.newConversation')" :title="t('assistant.newConversation')" :disabled="assistant.busy || assistant.historySaving" @click="createChat"><Plus :size="13" /></button>
        <button type="button" class="icon-button" :aria-label="t('assistant.renameConversation')" :title="t('assistant.renameConversation')" :disabled="assistant.busy || assistant.historySaving || !assistant.activeConversationId" @click="beginRenameConversation"><Pencil :size="12" /></button>
        <button type="button" class="icon-button danger-button" :aria-label="t('assistant.deleteConversation')" :title="t('assistant.deleteConversation')" :disabled="assistant.busy || assistant.historySaving || assistant.conversations.length <= 1" @click="deleteChat"><Trash2 :size="12" /></button>
      </div>
      <div v-if="editingConversationTitle" class="assistant-conversation-rename">
        <input v-model="conversationTitleDraft" maxlength="120" :aria-label="t('assistant.conversationTitle')" :placeholder="t('assistant.conversationTitle')" @keydown.enter.prevent="saveConversationTitle" @keydown.esc.prevent="editingConversationTitle = false">
        <button type="button" class="icon-button" :aria-label="t('assistant.saveConversationTitle')" :disabled="assistant.historySaving" @click="saveConversationTitle"><Check :size="13" /></button>
        <button type="button" class="icon-button" :aria-label="t('assistant.cancel')" @click="editingConversationTitle = false"><X :size="13" /></button>
      </div>
      <div class="assistant-disclosure"><ExternalLink :size="13" /><span>{{ t('assistant.externalDisclosure') }} {{ disclosure }}</span></div>
      <div class="assistant-provider-privacy" role="note">
        <small>{{ t('assistant.providerRecipient', { endpoint: providerDestination }) }}</small>
        <p>{{ t('assistant.providerPrivacyNotice') }}</p>
        <label class="assistant-context-toggle"><input type="checkbox" :checked="assistant.provider.externalDataConsent" :disabled="assistant.busy || assistant.historySaving || consentSaving" @change="updateProviderConsent"><span>{{ t('assistant.providerDataConsent', { endpoint: providerDestination }) }}</span></label>
      </div>
      <div class="assistant-history-note"><Database :size="12" /><span>{{ t('assistant.localHistoryNotice') }}</span></div>
      <label class="assistant-context-toggle"><input v-model="attachSession" type="checkbox" :disabled="!sessions.activeSession"><span>{{ t('assistant.attachSession') }}</span></label>
      <label class="assistant-context-toggle"><input v-model="attachTerminalSelection" type="checkbox" :disabled="!ui.assistantTerminalSelection"><span>{{ t('assistant.attachTerminalSelection') }}</span></label>
      <div v-if="attachTerminalSelection && ui.assistantTerminalSelection" class="assistant-context-preview">
        {{ t('assistant.terminalSelectionPreview', { host: ui.assistantTerminalSelection.host, chars: Array.from(ui.assistantTerminalSelection.text).length, truncated: ui.assistantTerminalSelection.truncated ? t('assistant.yes') : t('assistant.no') }) }}
        <button type="button" class="button" @click="clearTerminalContext">{{ t('assistant.clearTerminalSelection') }}</button>
      </div>
      <label class="assistant-context-toggle"><input v-model="attachEvents" type="checkbox" :disabled="recentEvents.length === 0"><span>{{ t('assistant.attachEvents', { count: recentEvents.length }) }}</span></label>
      <label class="assistant-context-toggle"><input v-model="attachMonitor" type="checkbox" :disabled="!monitor.snapshot"><span>{{ t('assistant.attachMonitor') }}</span></label>
      <label class="assistant-context-toggle"><input v-model="attachTransfers" type="checkbox" :disabled="recentTransfers.length === 0"><span>{{ t('assistant.attachTransfers', { count: recentTransfers.length }) }}</span></label>
      <label class="assistant-context-toggle"><input type="checkbox" :checked="attachTunnelFailure" :disabled="failedTunnels.length === 0" @change="toggleTunnelFailureContext"><span>{{ t('assistant.attachTunnelFailure', { count: failedTunnels.length }) }}</span></label>
      <div v-if="attachTunnelFailure && selectedTunnelFailure" class="assistant-context-preview">
        <select v-model="selectedTunnelFailureId" class="assistant-context-select" :aria-label="t('assistant.selectTunnelFailure')">
          <option v-for="tunnel in failedTunnels" :key="tunnel.id" :value="tunnel.id">{{ tunnel.name }} · {{ tunnel.bindHost }}:{{ tunnel.bindPort }} · {{ tunnel.lastError?.code }}</option>
        </select>
        <div>{{ t('assistant.tunnelFailurePreview', { kind: selectedTunnelFailure.kind, bindHost: selectedTunnelFailure.bindHost, bindPort: selectedTunnelFailure.bindPort, target: selectedTunnelFailure.kind === 'dynamic' ? t('assistant.dynamicTarget') : `${selectedTunnelTargetHost ?? t('assistant.targetHostOmitted')}:${selectedTunnelFailure.targetPort ?? '—'}`, errorCode: selectedTunnelFailure.lastError?.code ?? '—' }) }}</div>
      </div>
      <div v-if="attachSession && sessions.activeSession" class="assistant-context-preview">{{ t('assistant.sessionContextPreview', { host: sessions.activeSession.host }) }}</div>
      <div class="assistant-transcript" aria-live="polite">
        <div v-if="assistant.messages.length === 0" class="assistant-empty"><WandSparkles :size="17" /><span>{{ t('assistant.empty') }}</span></div>
        <article v-for="message in assistant.messages" :key="message.id" class="assistant-message" :class="message.role">
          <small>{{ message.role === 'user' ? t('assistant.you') : t('assistant.assistantLabel') }} · {{ message.mode === 'draft' ? t('assistant.draftMode') : t('assistant.explainMode') }}</small>
          <pre>{{ visibleAssistantText(message) || (message.status === 'streaming' ? t('assistant.thinking') : '') }}</pre>
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
                  <small>{{ t('assistant.planCommandLabel', { shell: command.shell, index: commandIndex + 1 }) }}</small>
                  <pre>{{ command.command }}</pre>
                </div>
                <p class="assistant-proposal-step-note"><strong>{{ t('assistant.planExpectedEffect') }}</strong> {{ step.expectedEffect }}</p>
                <p class="assistant-proposal-step-note"><strong>{{ t('assistant.planRollback') }}</strong> {{ step.rollback }}</p>
              </section>
            </template>
            <template v-else>
              <div v-for="(command, index) in message.proposal.commands" :key="`${message.id}-${index}`" class="assistant-proposal-command">
                <small>{{ t('assistant.proposalCommandLabel', { shell: command.shell, index: index + 1 }) }}</small>
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
        </article>
      </div>
      <div class="assistant-compose">
        <div class="assistant-mode" role="group" :aria-label="t('assistant.mode')">
          <button type="button" :aria-pressed="mode === 'explain'" @click="mode = 'explain'">{{ t('assistant.explainMode') }}</button>
          <button type="button" :aria-pressed="mode === 'draft'" @click="mode = 'draft'">{{ t('assistant.draftMode') }}</button>
        </div>
        <div class="assistant-file-context">
          <div class="assistant-file-context-actions">
            <button type="button" class="button" :disabled="assistant.busy || contextFileBusy || assistantSendInProgress || contextFiles.length >= 2" @click="chooseContextFile">
              <Paperclip :size="12" />{{ contextFileBusy ? t('assistant.selectingFile') : contextFiles.length > 0 ? t('assistant.addContextFile') : t('assistant.attachContextFile') }}
            </button>
            <small v-if="contextFiles.length > 0">{{ t('assistant.localFileSelectionNotice') }}</small>
          </div>
          <div v-for="contextFile in contextFiles" :key="contextFile.id" class="assistant-context-file-selected" aria-live="polite">
            <Paperclip :size="12" />
            <strong>{{ contextFile.fileName }}</strong>
            <small>{{ contextFile.extension.toUpperCase() }} · {{ formatByteLength(contextFile.byteLength) }}</small>
            <button type="button" class="icon-button" :aria-label="t('assistant.removeContextFile')" :disabled="assistant.busy || assistantSendInProgress" @click="removeContextFile(contextFile.id)"><X :size="12" /></button>
          </div>
          <p v-if="contextFileError" class="assistant-error" role="alert">{{ contextFileErrorText }}</p>
        </div>
        <textarea v-model="prompt" :placeholder="t('assistant.promptPlaceholder')" maxlength="20000" :disabled="consentSaving" @keydown.ctrl.enter.prevent="send" />
        <div class="assistant-compose-footer">
          <small>{{ t('assistant.neverExecutes') }}</small>
          <button v-if="assistant.busy" type="button" class="button" @click="assistant.cancel"><Square :size="12" />{{ t('assistant.cancel') }}</button>
          <button v-else type="button" class="button primary" :disabled="assistant.historySaving || consentSaving || !assistant.provider.configured || !assistant.provider.externalDataConsent || !prompt.trim()" @click="send"><Send :size="12" />{{ t('assistant.send') }}</button>
        </div>
      </div>
      <p v-if="assistant.cancelError" class="assistant-error" role="alert">{{ cancelErrorText }}</p>
    </template>
    <p v-if="assistant.error && !assistant.messages.some((item) => item.status === 'failed')" class="assistant-error" role="alert">{{ errorText }}</p>
    <p v-if="assistant.historyError" class="assistant-error" role="alert">{{ historyErrorText }}</p>
  </aside>
</template>
