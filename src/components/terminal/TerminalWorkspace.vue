<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CopyPlus, FileText, LockKeyhole, Plus, Search, SplitSquareVertical, X } from 'lucide-vue-next';
import TerminalPane from '@/components/terminal/TerminalPane.vue';
import { isTauriRuntime } from '@/api/common';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTerminalLogsStore } from '@/stores/terminalLogs';
import { useUiStore } from '@/stores/ui';
import { t } from '@/i18n';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const settings = useSettingsStore();
const terminalLogs = useTerminalLogsStore();
const layout = ref<'single' | 'vertical' | 'horizontal'>('single');
const paneSessionIds = ref<(string | null)[]>([]);
const terminalPaneRefs = ref<InstanceType<typeof TerminalPane>[]>([]);
const focusedPaneIndex = ref(0);
const searchOpenPaneIndex = ref<number | null>(null);
const searchFocusToken = ref(0);
const visiblePanes = computed<(string | null)[]>(() => (
  paneSessionIds.value.length > 0 ? paneSessionIds.value : [null]
));
const canStartSession = computed(() => !sessions.busy
  && !sessions.challenge
  && !sessions.passwordProfileId
  && !sessions.privateKeyPassphraseProfileId);
const canDuplicateActive = computed(() => Boolean(sessions.activeSession)
  && !sessions.isQuickProfile(sessions.activeSession?.profileId)
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

function sessionName(profileId: string): string {
  return sessions.profileForId(profileId)?.name ?? t('terminal.noSession');
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
  if (searchOpenPaneIndex.value !== null && searchOpenPaneIndex.value !== index) {
    searchOpenPaneIndex.value = null;
  }
  const sessionId = paneSession(index);
  if (sessionId) sessions.selectSession(sessionId);
}

function selectSessionTab(sessionId: string): void {
  searchOpenPaneIndex.value = null;
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
  if (!connections.activeProfile) {
    ui.openQuickConnect();
    return;
  }
  searchOpenPaneIndex.value = null;
  await sessions.begin(connections.activeProfile);
}

async function duplicateActiveSession(): Promise<void> {
  const current = sessions.activeSession;
  if (!canDuplicateActive.value || !current) return;
  const profile = sessions.profileForId(current.profileId);
  if (!profile) return;
  searchOpenPaneIndex.value = null;
  await sessions.begin(profile);
}

async function createSplit(orientation: 'vertical' | 'horizontal'): Promise<void> {
  if (layout.value !== 'single') {
    layout.value = orientation;
    return;
  }
  const source = sessions.activeSession;
  if (!canDuplicateActive.value || !source) return;
  const profile = sessions.profileForId(source.profileId);
  if (!profile) return;

  const previousLayout = layout.value;
  const previousPanes = [...paneSessionIds.value];
  const previousFocus = focusedPaneIndex.value;
  const sourceSessionId = source.id;
  paneSessionIds.value = [sourceSessionId, null];
  layout.value = orientation;
  focusedPaneIndex.value = 1;
  searchOpenPaneIndex.value = null;

  try {
    await sessions.begin(profile);
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
  if (layout.value === 'single') return;
  const remainingId = paneSessionIds.value.find((_, paneIndex) => paneIndex !== index) ?? null;
  layout.value = 'single';
  paneSessionIds.value = remainingId ? [remainingId] : [];
  focusedPaneIndex.value = 0;
  searchOpenPaneIndex.value = null;
  if (remainingId) sessions.selectSession(remainingId);
}

function openSearch(index = focusedPaneIndex.value): void {
  if (!paneSession(index)) return;
  focusedPaneIndex.value = index;
  sessions.selectSession(paneSession(index) as string);
  searchOpenPaneIndex.value = index;
  searchFocusToken.value += 1;
}

function closeSearch(index: number): void {
  if (searchOpenPaneIndex.value === index) searchOpenPaneIndex.value = null;
}

function focusActiveTerminal(): void {
  terminalPaneRefs.value[focusedPaneIndex.value]?.focusTerminal();
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
    searchOpenPaneIndex.value = null;
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
      if (existingIndex !== focusedPaneIndex.value) searchOpenPaneIndex.value = null;
      focusedPaneIndex.value = existingIndex;
      return;
    }
    searchOpenPaneIndex.value = null;
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
  <section class="terminal-workspace" aria-label="Terminal workspace">
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
          <span class="terminal-tab-name">{{ sessionName(session.profileId) }}</span>
          <FileText
            v-if="terminalLogs.statusFor(session.id)?.state === 'active'"
            class="terminal-tab-log"
            :size="10"
            :aria-label="t('terminal.logActive', { size: formatLogBytes(terminalLogs.statusFor(session.id)?.bytes ?? 0) })"
          />
          <LockKeyhole v-if="session.state === 'connected'" class="terminal-tab-trust" :size="11" :aria-label="t('terminal.strictHostTrust')" :title="t('terminal.strictHostTrust')" />
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
        class="icon-button"
        :aria-label="t('terminal.search')"
        :title="t('terminal.search')"
        :disabled="!sessions.activeSession"
        @click="openSearch()"
      >
        <Search :size="13" />
      </button>
      <span class="terminal-tabs-spacer compact" />
    </div>

    <div class="terminal-pane-grid" :class="'layout-' + layout">
      <TerminalPane
        v-for="(sessionId, index) in visiblePanes"
        ref="terminalPaneRefs"
        :key="String(index) + ':' + (sessionId ?? 'empty')"
        :session-id="sessionId"
        :focused="index === focusedPaneIndex"
        :search-open="searchOpenPaneIndex === index"
        :focus-search-token="searchFocusToken"
        :can-close="layout !== 'single' && !sessions.busy"
        @focus="focusPane(index)"
        @search-open="openSearch(index)"
        @search-close="closeSearch(index)"
        @close="removePane(index)"
      />
    </div>
  </section>
</template>

<style scoped>
.terminal-workspace {
  display: grid;
  grid-template-rows: 31px minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.terminal-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
  padding-inline: 4px;
  overflow-x: auto;
  background: hsl(var(--card));
  border-bottom: 1px solid hsl(var(--border));
  scrollbar-width: thin;
}

.terminal-tab {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 92px;
  max-width: 190px;
  height: 27px;
  align-items: center;
  gap: 5px;
  padding-inline: 7px 23px;
  color: hsl(var(--muted-foreground));
  font-size: 9px;
}

.terminal-tab-item {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 92px;
  max-width: 190px;
  align-items: center;
}

.terminal-tab.active {
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border-color: hsl(var(--border));
}

.terminal-tab.active::after {
  position: absolute;
  inset-inline: 4px;
  inset-block-end: -3px;
  height: 2px;
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

.terminal-tab-log {
  flex: 0 0 auto;
  color: hsl(var(--warning));
}

.terminal-tab-close {
  position: absolute;
  inset-inline-end: 3px;
  display: inline-flex;
  flex: 0 0 auto;
  width: 19px;
  height: 27px;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  color: hsl(var(--muted-foreground));
  background: transparent;
}

.terminal-tab-close:hover,
.terminal-tab-close:focus-visible {
  color: hsl(var(--foreground));
  background: hsl(var(--accent));
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
  border-radius: 3px;
  color: hsl(var(--muted-foreground));
}

.terminal-layout-button.active {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
}

.terminal-layout-button:hover:not(:disabled) {
  color: hsl(var(--foreground));
  background: hsl(var(--accent));
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
  font-size: 8px;
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
  gap: 2px;
  padding: 2px;
  overflow: hidden;
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
</style>
