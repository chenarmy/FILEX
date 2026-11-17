<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CopyPlus, CornerDownLeft, FileText, LockKeyhole, Plus, RefreshCw, Search, SplitSquareVertical, Terminal, X } from 'lucide-vue-next';
import CommandInputBar from '@/components/terminal/CommandInputBar.vue';
import TerminalPane from '@/components/terminal/TerminalPane.vue';
import { isTauriRuntime } from '@/api/common';
import { isLocalSession } from '@/domain/sessionCapabilities';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTerminalLogsStore } from '@/stores/terminalLogs';
import { useUiStore } from '@/stores/ui';
import { t } from '@/i18n';
import type { SessionSummary } from '@/types/contracts';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const settings = useSettingsStore();
const terminalLogs = useTerminalLogsStore();
const layout = ref<'single' | 'vertical' | 'horizontal'>('single');
const paneSessionIds = ref<(string | null)[]>([]);
const paneRefs = new Map<string, { focusTerminal: () => void }>();
const focusedPaneIndex = ref(0);
const searchOpenSessionIds = ref<string[]>([]);
const searchFocusToken = ref(0);
const visiblePanes = computed<(string | null)[]>(() => (
  paneSessionIds.value.length > 0 ? paneSessionIds.value : [null]
));
const emptyPaneIndex = computed(() => visiblePanes.value.indexOf(null));

function setPaneRef(key: string, instance: unknown): void {
  if (instance && typeof instance === 'object' && 'focusTerminal' in instance) {
    paneRefs.set(key, instance as { focusTerminal: () => void });
  } else {
    paneRefs.delete(key);
  }
}

function paneIndexForSession(sessionId: string): number {
  return visiblePanes.value.indexOf(sessionId);
}
const canStartSession = computed(() => !sessions.busy
  && !sessions.challenge
  && !sessions.passwordProfileId
  && !sessions.privateKeyPassphraseProfileId);
const canDuplicateActive = computed(() => Boolean(sessions.activeSession)
  && !sessions.isQuickProfile(sessions.activeSession?.profileId)
  && (isLocalSession(sessions.activeSession) || Boolean(sessions.profileForId(sessions.activeSession?.profileId ?? '')))
  && canStartSession.value);
const activeLogStatus = computed(() => terminalLogs.statusFor(sessions.activeSessionId));
const activeLogRunning = computed(() => activeLogStatus.value?.state === 'active');
const canToggleLog = computed(() => isTauriRuntime()
  && sessions.activeSession?.state === 'connected'
  && !terminalLogs.isBusy(sessions.activeSessionId ?? ''));
const logStatusText = computed(() => {
  const status = activeLogStatus.value;
  if (!status || status.state === 'inactive') return '';
  if (status.state === 'active') return t('terminal.logActive', { size: formatLogBytes(status.bytes) });
  if (status.state === 'limit_reached') return t('terminal.logLimitReached');
  if (status.state === 'interrupted') return t('terminal.logInterrupted');
  return t('terminal.logFailed');
});

function sessionName(sessionOrProfileId: SessionSummary | string): string {
  if (typeof sessionOrProfileId === 'string') {
    return sessions.profileForId(sessionOrProfileId)?.name ?? t('terminal.noSession');
  }
  if (isLocalSession(sessionOrProfileId)) {
    return sessions.localMetadataForSession(sessionOrProfileId.id)?.shellLabel ?? t('localTerminal.defaultTitle');
  }
  return sessions.profileForId(sessionOrProfileId.profileId)?.name ?? t('terminal.noSession');
}

function formatLogBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function showLogError(): void {
  if (!terminalLogs.error) return;
  ui.notify(t(terminalLogs.error.messageKey as Parameters<typeof t>[0]));
}

const canReconnect = computed(() => !isLocalSession(sessions.activeSession)
  && Boolean(connections.activeProfile)
  && !sessions.busy
  && !sessions.challenge);
const canDisconnect = computed(() => sessions.activeSession?.state === 'connected' && !sessions.busy);

async function reconnect(): Promise<void> {
  if (!canReconnect.value) return;
  if (
    sessions.activeSession
    && connections.activeProfile?.id === sessions.activeSession.profileId
    && ['disconnected', 'failed'].includes(sessions.activeSession.state)
  ) await sessions.reconnectActive();
  else if (connections.activeProfile) await sessions.begin(connections.activeProfile);
}

async function toggleTerminalLog(): Promise<void> {
  const session = sessions.activeSession;
  if (!session || session.state !== 'connected' || terminalLogs.isBusy(session.id)) return;
  terminalLogs.clearError();
  if (activeLogRunning.value) {
    if (await terminalLogs.stop(session.id)) ui.notify(t('terminal.logStopped'));
    else showLogError();
    return;
  }
  if (!settings.value.terminalLogging) {
    ui.notify(t('terminal.logEnableInSettings'));
    return;
  }
  const accepted = await ui.confirm({
    title: t('terminal.logStartTitle'),
    message: t('terminal.logStartMessage', {
      endpoint: `${session.username}@${session.host}:${session.port}`,
    }),
    confirmLabel: t('terminal.logStartConfirm'),
  });
  if (!accepted) return;
  if (await terminalLogs.start(session.id)) {
    const status = terminalLogs.statusFor(session.id);
    ui.notify(t('terminal.logStarted', { path: status?.path ?? '' }));
  } else {
    showLogError();
  }
}

function paneSession(index: number): string | null {
  return paneSessionIds.value[index] ?? null;
}

function focusPane(index: number): void {
  if (index < 0 || index >= visiblePanes.value.length) return;
  focusedPaneIndex.value = index;
  const sessionId = paneSession(index);
  if (sessionId) sessions.selectSession(sessionId);
}

function selectSessionTab(sessionId: string): void {
  if (layout.value === 'single') {
    paneSessionIds.value = [sessionId];
    focusedPaneIndex.value = 0;
  } else {
    const currentIndex = Math.min(focusedPaneIndex.value, paneSessionIds.value.length - 1);
    const otherIndex = paneSessionIds.value.findIndex((item, index) => item === sessionId && index !== currentIndex);
    if (otherIndex >= 0) paneSessionIds.value[otherIndex] = paneSessionIds.value[currentIndex] ?? null;
    paneSessionIds.value[currentIndex] = sessionId;
    focusedPaneIndex.value = currentIndex;
  }
  sessions.selectSession(sessionId);
}

async function startNewSession(): Promise<void> {
  if (!canStartSession.value) return;
  ui.openQuickConnect();
}

async function duplicateActiveSession(): Promise<void> {
  const current = sessions.activeSession;
  if (!canDuplicateActive.value || !current) return;
  if (isLocalSession(current)) {
    const meta = sessions.localMetadataForSession(current.id);
    await sessions.openLocalSession({
      shellKind: meta?.shellKind ?? null,
      workingDirectory: meta?.workingDirectory ?? null,
      columns: 120,
      rows: 32,
    });
    return;
  }
  const profile = sessions.profileForId(current.profileId);
  if (!profile) return;
  await sessions.begin(profile);
}

async function createSplit(orientation: 'vertical' | 'horizontal'): Promise<void> {
  if (layout.value !== 'single') {
    layout.value = orientation;
    return;
  }
  const source = sessions.activeSession;
  if (!canDuplicateActive.value || !source) return;
  const sourceIsLocal = isLocalSession(source);
  const profile = sourceIsLocal ? null : sessions.profileForId(source.profileId);
  if (!sourceIsLocal && !profile) return;

  const previousLayout = layout.value;
  const previousPanes = [...paneSessionIds.value];
  const previousFocus = focusedPaneIndex.value;
  const sourceSessionId = source.id;
  paneSessionIds.value = [sourceSessionId, null];
  layout.value = orientation;
  focusedPaneIndex.value = 1;

  try {
    if (sourceIsLocal) {
      const meta = sessions.localMetadataForSession(source.id);
      await sessions.openLocalSession({
        shellKind: meta?.shellKind ?? null,
        workingDirectory: meta?.workingDirectory ?? null,
        columns: 120,
        rows: 32,
      });
    } else if (profile) {
      await sessions.begin(profile);
    }
  } catch (error) {
    layout.value = previousLayout;
    paneSessionIds.value = previousPanes;
    focusedPaneIndex.value = previousFocus;
    throw error;
  }
  const duplicateId = sessions.activeSessionId;
  if (!duplicateId || duplicateId === sourceSessionId) {
    layout.value = previousLayout;
    paneSessionIds.value = previousPanes;
    focusedPaneIndex.value = previousFocus;
    return;
  }
  paneSessionIds.value = [sourceSessionId, duplicateId];
  focusedPaneIndex.value = 1;
  sessions.selectSession(duplicateId);
}

function removePane(index: number): void {
  if (layout.value === 'single' || index < 0) return;
  const remainingId = paneSessionIds.value.find((_, paneIndex) => paneIndex !== index) ?? null;
  layout.value = 'single';
  paneSessionIds.value = remainingId ? [remainingId] : [];
  focusedPaneIndex.value = 0;
  if (remainingId) sessions.selectSession(remainingId);
}

function openSearchForSession(sessionId: string): void {
  const index = paneIndexForSession(sessionId);
  if (index >= 0) focusedPaneIndex.value = index;
  sessions.selectSession(sessionId);
  if (!searchOpenSessionIds.value.includes(sessionId)) {
    searchOpenSessionIds.value = [...searchOpenSessionIds.value, sessionId];
  }
  searchFocusToken.value += 1;
}

function openSearch(index = focusedPaneIndex.value): void {
  const sessionId = paneSession(index);
  if (!sessionId) return;
  openSearchForSession(sessionId);
}

function closeSearchForSession(sessionId: string): void {
  if (searchOpenSessionIds.value.includes(sessionId)) {
    searchOpenSessionIds.value = searchOpenSessionIds.value.filter((id) => id !== sessionId);
  }
}

function focusActiveTerminal(): void {
  const sessionId = paneSession(focusedPaneIndex.value);
  paneRefs.get(sessionId ?? '__empty__')?.focusTerminal();
}

function selectRelativeSession(direction: 1 | -1): void {
  const available = sessions.summaries;
  if (available.length < 2) return;
  const currentIndex = available.findIndex((session) => session.id === sessions.activeSessionId);
  const startIndex = currentIndex < 0 ? (direction > 0 ? -1 : 0) : currentIndex;
  const nextIndex = (startIndex + direction + available.length) % available.length;
  const nextSession = available[nextIndex];
  if (nextSession) selectSessionTab(nextSession.id);
}

function reconcilePanes(): void {
  const validIds = new Set(sessions.summaries.map((item) => item.id));
  if (searchOpenSessionIds.value.some((id) => !validIds.has(id))) {
    searchOpenSessionIds.value = searchOpenSessionIds.value.filter((id) => validIds.has(id));
  }
  const hasPendingSplitSlot = paneSessionIds.value.includes(null);
  if (layout.value !== 'single' && hasPendingSplitSlot && sessions.busy) return;

  const liveIds = paneSessionIds.value.filter((sessionId): sessionId is string => (
    Boolean(sessionId && validIds.has(sessionId))
  ));
  if (layout.value !== 'single' && liveIds.length < 2) {
    const remainingId = liveIds[0] ?? (
      sessions.activeSessionId && validIds.has(sessions.activeSessionId)
        ? sessions.activeSessionId
        : null
    );
    layout.value = 'single';
    paneSessionIds.value = remainingId ? [remainingId] : [];
    focusedPaneIndex.value = 0;
    return;
  }
  if (layout.value === 'single') {
    const activeId = sessions.activeSessionId;
    const selectedId = activeId && validIds.has(activeId) ? activeId : liveIds[0] ?? null;
    paneSessionIds.value = selectedId ? [selectedId] : [];
    focusedPaneIndex.value = 0;
    return;
  }
  paneSessionIds.value = paneSessionIds.value.map((sessionId) => (
    sessionId && validIds.has(sessionId) ? sessionId : null
  ));
  focusedPaneIndex.value = Math.min(focusedPaneIndex.value, paneSessionIds.value.length - 1);
}

watch(
  () => sessions.activeSessionId,
  (sessionId) => {
    if (!sessionId) return;
    const existingIndex = paneSessionIds.value.indexOf(sessionId);
    if (existingIndex >= 0) {
      focusedPaneIndex.value = existingIndex;
      return;
    }
    if (layout.value === 'single') {
      paneSessionIds.value = [sessionId];
      focusedPaneIndex.value = 0;
      return;
    }
    const targetIndex = Math.max(0, Math.min(focusedPaneIndex.value, paneSessionIds.value.length - 1));
    paneSessionIds.value[targetIndex] = sessionId;
  },
  { immediate: true },
);

watch(
  () => [sessions.summaries.map((item) => item.id), sessions.busy] as const,
  reconcilePanes,
  { immediate: true },
);

defineExpose({ focusActiveTerminal, openSearch, selectRelativeSession, startNewSession });
</script>

<template>
  <section
    class="terminal-workspace"
    :class="{ 'composer-open': settings.value.compactComposerOpen }"
    aria-label="Terminal workspace"
  >
    <Teleport defer to="#session-tabs-slot">
      <div class="terminal-tabs" role="tablist" :aria-label="t('terminal.sessions')">
        <div
          v-for="session in sessions.summaries"
          :key="session.id"
          class="terminal-tab-item"
          role="presentation"
        >
          <button
            type="button"
            class="terminal-tab"
            :class="{ active: session.id === sessions.activeSessionId }"
            role="tab"
            :aria-selected="session.id === sessions.activeSessionId"
            @click="selectSessionTab(session.id)"
          >
            <span class="state-dot" :class="session.state" />
            <span class="terminal-tab-name" :title="sessionName(session)">{{ sessionName(session) }}</span>
            <span v-if="isLocalSession(session)" class="terminal-tab-kind">{{ t('localTerminal.badge') }}</span>
            <FileText
              v-if="terminalLogs.statusFor(session.id)?.state === 'active'"
              class="terminal-tab-log"
              :size="10"
              :aria-label="t('terminal.logActive', { size: formatLogBytes(terminalLogs.statusFor(session.id)?.bytes ?? 0) })"
            />
            <LockKeyhole v-if="session.state === 'connected' && !isLocalSession(session)" class="terminal-tab-trust" :size="11" :aria-label="t('terminal.strictHostTrust')" :title="t('terminal.strictHostTrust')" />
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="t('terminal.closeSession')"
            :title="t('terminal.closeSession')"
            @click="sessions.closeSession(session.id)"
          >
            <X :size="12" />
          </button>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('terminal.newSession')"
          :title="t('terminal.newSession')"
          :disabled="!canStartSession"
          @click="startNewSession"
        >
          <Plus :size="13" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('localTerminal.title')"
          :title="t('localTerminal.title')"
          :disabled="!canStartSession"
          @click="ui.openLocalTerminalDialog"
        >
          <Terminal :size="13" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('terminal.duplicateSession')"
          :title="t('terminal.duplicateSession')"
          :disabled="!canDuplicateActive"
          @click="duplicateActiveSession"
        >
          <CopyPlus :size="13" />
        </button>
        <span class="terminal-tabs-spacer" />
        <button
          type="button"
          class="terminal-layout-button"
          :class="{ active: layout === 'vertical' }"
          :aria-label="t('terminal.splitVertical')"
          :title="t('terminal.splitVertical')"
          :disabled="!canDuplicateActive"
          @click="createSplit('vertical')"
        >
          <SplitSquareVertical :size="13" />
        </button>
        <button
          type="button"
          class="terminal-layout-button"
          :class="{ active: layout === 'horizontal' }"
          :aria-label="t('terminal.splitHorizontal')"
          :title="t('terminal.splitHorizontal')"
          :disabled="!canDuplicateActive"
          @click="createSplit('horizontal')"
        >
          <SplitSquareVertical class="horizontal-split-icon" :size="13" />
        </button>
        <span
          v-if="logStatusText"
          class="terminal-log-indicator"
          :class="{ active: activeLogRunning }"
          role="status"
        >{{ logStatusText }}</span>
        <button
          type="button"
          class="terminal-layout-button"
          :class="{ active: activeLogRunning }"
          :aria-label="t(activeLogRunning ? 'terminal.logStop' : 'terminal.logStart')"
          :aria-pressed="activeLogRunning"
          :title="t(activeLogRunning ? 'terminal.logStop' : 'terminal.logStart')"
          :disabled="!canToggleLog"
          @click="toggleTerminalLog"
        >
          <FileText :size="13" />
        </button>
        <button
          type="button"
          class="terminal-layout-button"
          :class="{ active: settings.value.compactComposerOpen }"
          :aria-label="t('commandBar.toggleButton')"
          :aria-pressed="settings.value.compactComposerOpen"
          :title="t('commandBar.toggleButton')"
          @click="settings.value.compactComposerOpen = !settings.value.compactComposerOpen"
        >
          <CornerDownLeft :size="13" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('terminal.search')"
          :title="t('terminal.search')"
          :disabled="!sessions.activeSession"
          @click="openSearch()"
        >
          <Search :size="13" />
        </button>
        <span class="terminal-tabs-spacer compact" />
        <button
          type="button"
          class="toolbar-button reconnect-button"
          :disabled="!canReconnect"
          @click="reconnect"
        >
          <RefreshCw :size="13" />{{ t('terminal.reconnect') }}
        </button>
        <button
          type="button"
          class="toolbar-button"
          :disabled="!canDisconnect"
          @click="sessions.disconnectActive"
        >
          <X :size="13" />{{ t('terminal.disconnect') }}
        </button>
      </div>
    </Teleport>

    <div class="terminal-pane-grid" :class="'layout-' + layout">
      <TerminalPane
        v-for="session in sessions.summaries"
        v-show="paneIndexForSession(session.id) >= 0"
        :key="session.id"
        :ref="(el) => setPaneRef(session.id, el)"
        :session-id="session.id"
        :visible="paneIndexForSession(session.id) >= 0"
        :focused="paneIndexForSession(session.id) === focusedPaneIndex"
        :search-open="searchOpenSessionIds.includes(session.id)"
        :focus-search-token="searchFocusToken"
        :can-close="layout !== 'single' && !sessions.busy"
        :style="paneIndexForSession(session.id) >= 0 ? { order: paneIndexForSession(session.id) } : undefined"
        @focus="focusPane(paneIndexForSession(session.id))"
        @search-open="openSearchForSession(session.id)"
        @search-close="closeSearchForSession(session.id)"
        @close="removePane(paneIndexForSession(session.id))"
      />
      <TerminalPane
        v-if="emptyPaneIndex >= 0"
        key="__empty__"
        :ref="(el) => setPaneRef('__empty__', el)"
        :session-id="null"
        :visible="true"
        :focused="emptyPaneIndex === focusedPaneIndex"
        :search-open="false"
        :focus-search-token="searchFocusToken"
        :can-close="layout !== 'single' && !sessions.busy"
        :style="{ order: emptyPaneIndex }"
        @focus="focusPane(emptyPaneIndex)"
        @close="removePane(emptyPaneIndex)"
      />
    </div>
    <CommandInputBar v-if="settings.value.compactComposerOpen" />
  </section>
</template>

<style scoped>
.terminal-workspace {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.terminal-workspace.composer-open {
  grid-template-rows: minmax(0, 1fr) auto;
}

/* The tab strip is teleported into the shell's #session-tabs-slot; keep its
   layout here so all tab behavior stays in one component. */
.terminal-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
  padding-inline: 6px;
  overflow-x: auto;
  background: transparent;
  scrollbar-width: thin;
}

.terminal-tab {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 88px;
  max-width: 184px;
  height: 26px;
  align-items: center;
  gap: 5px;
  padding-inline: 9px 24px;
  color: hsl(var(--muted-foreground));
  font-size: 0.7857rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control) var(--radius-control) 0 0;
  transition: color var(--duration-micro) var(--ease-arco),
    background var(--duration-micro) var(--ease-arco);
}

.terminal-tab:hover {
  color: hsl(var(--foreground));
  background: hsl(var(--fill-subtle));
}

.terminal-tab-item {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 88px;
  max-width: 184px;
  align-items: center;
}

.terminal-tab.active {
  color: hsl(var(--foreground));
  font-weight: 500;
  background: hsl(var(--background));
  border-color: hsl(var(--border-subtle));
  border-bottom-color: transparent;
}

.terminal-tab.active::after {
  position: absolute;
  inset-inline: 6px;
  inset-block-end: -1px;
  height: 2px;
  border-radius: 2px;
  background: hsl(var(--primary));
  content: '';
}

.terminal-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-tab-trust {
  flex: 0 0 auto;
  color: hsl(var(--success));
}

.terminal-tab-kind {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid hsl(var(--border));
  border-radius: 2px;
  color: hsl(var(--muted-foreground));
  font-size: 0.625rem;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.03em;
}

.terminal-tab-log {
  flex: 0 0 auto;
  color: hsl(var(--warning));
}

.terminal-tab-close {
  position: absolute;
  inset-inline-end: 4px;
  display: inline-flex;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-control);
  color: hsl(var(--muted-foreground));
  background: transparent;
  transition: color var(--duration-micro) var(--ease-arco),
    background var(--duration-micro) var(--ease-arco);
}

.terminal-tab-close:hover,
.terminal-tab-close:focus-visible {
  color: hsl(var(--foreground));
  background: hsl(var(--fill-subtle));
  outline: none;
}

.terminal-tabs-spacer {
  flex: 1 0 6px;
}

.terminal-tabs-spacer.compact {
  flex: 0 0 1px;
}

.terminal-layout-button {
  display: inline-flex;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: hsl(var(--muted-foreground));
  transition: color var(--duration-micro) var(--ease-arco),
    background var(--duration-micro) var(--ease-arco);
}

.terminal-layout-button.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}

.terminal-layout-button:hover:not(:disabled) {
  color: hsl(var(--foreground));
  background: hsl(var(--fill-subtle));
}

.terminal-layout-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.terminal-log-indicator {
  display: inline-flex;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 150px;
  align-items: center;
  overflow: hidden;
  color: hsl(var(--warning));
  font-size: 0.7143rem;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-log-indicator.active {
  color: hsl(var(--success));
}

.horizontal-split-icon {
  transform: rotate(90deg);
}

.terminal-pane-grid {
  display: grid;
  min-width: 0;
  min-height: 0;
  gap: 1px;
  padding: 0;
  overflow: hidden;
  background: transparent;
}

.terminal-pane-grid.layout-vertical,
.terminal-pane-grid.layout-horizontal {
  background: hsl(var(--border));
}

.terminal-pane-grid.layout-single {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}

.terminal-pane-grid.layout-vertical {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
}

.terminal-pane-grid.layout-horizontal {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: repeat(2, minmax(0, 1fr));
}

.terminal-pane-grid :deep(.terminal-pane) {
  border: 0;
}

.terminal-pane-grid.layout-single :deep(.terminal-pane-header) {
  display: none;
}
</style>
