<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Activity,
  Bot,
  CircleAlert,
  Command,
  FolderOpen,
  Info,
  KeyRound,
  Maximize2,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Terminal,
  X,
  Zap,
} from 'lucide-vue-next';
import ConnectionsPane from '@/components/connections/ConnectionsPane.vue';
import TerminalWorkspace from '@/components/terminal/TerminalWorkspace.vue';
import CommandInputBar from '@/components/terminal/CommandInputBar.vue';
import FileBrowserPanel from '@/components/files/FileBrowserPanel.vue';
import HostPanel from '@/components/monitor/HostPanel.vue';
import InspectorPane from '@/components/inspector/InspectorPane.vue';
import CommandPalette from '@/components/dialogs/CommandPalette.vue';
import AssistantPanel from '@/components/assistant/AssistantPanel.vue';
import TaskDrawer from '@/components/tasks/TaskDrawer.vue';
import StatusBar from '@/components/layout/StatusBar.vue';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSettingsStore } from '@/stores/settings';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { CommandPaletteCommand, CommandPaletteCommandId } from '@/types/commandPalette';
import {
  formatKeyboardShortcut,
  matchesKeyboardShortcut,
  type KeyboardShortcutAction,
} from '@/utils/keyboardShortcuts';

const connections = useConnectionsStore();
const settings = useSettingsStore();
const ui = useUiStore();
const sessions = useSessionsStore();
const sessionErrorVisible = computed(() => sessions.error !== null
  && sessions.passwordProfileId === null
  && sessions.privateKeyPassphraseProfileId === null
  && (!sessions.challenge || sessions.challenge.trust === 'trusted'));
const sessionErrorText = computed(() => sessionErrorVisible.value && sessions.error
  ? t(sessions.error.messageKey as Parameters<typeof t>[0])
  : '');
const connectionsPane = ref<{ focusFilter: () => void } | null>(null);
const terminalWorkspace = ref<{
  focusActiveTerminal: () => void;
  openSearch: () => void;
  selectRelativeSession: (direction: 1 | -1) => void;
} | null>(null);
const inspectorPane = ref<{ focusInspector: () => void } | null>(null);

const focusMode = computed(() => settings.value.focusMode);
const hasActiveSession = computed(() => sessions.activeSession !== null);
const hostPanelVisible = computed(() => settings.value.hostPanelOpen && !focusMode.value && hasActiveSession.value);
const fileBrowserVisible = computed(() => settings.value.fileBrowserOpen && !focusMode.value);
const commandBarVisible = computed(() => !focusMode.value && hasActiveSession.value);
const detailsPaneVisible = computed(() => !focusMode.value && settings.value.detailsPaneOpen);

const commandPaletteCommands = computed<CommandPaletteCommand[]>(() => {
  const shortcuts = settings.value.shortcuts;
  const activeSession = sessions.activeSession;
  const canDisconnect = activeSession?.state === 'connected' && !sessions.busy;
  return [
    { id: 'quickConnect', label: t('commands.quickConnect'), shortcut: shortcuts.quickConnect, disabled: sessions.busy || Boolean(sessions.challenge) || Boolean(sessions.passwordProfileId) },
    { id: 'newSession', label: t('commands.newSession'), shortcut: shortcuts.newSession, disabled: sessions.busy || Boolean(sessions.challenge) },
    { id: 'closeActiveTab', label: t('commands.closeActiveTab'), shortcut: shortcuts.closeActiveTab, disabled: !activeSession || sessions.busy },
    { id: 'nextSession', label: t('commands.nextSession'), shortcut: shortcuts.nextSession, disabled: sessions.summaries.length < 2 },
    { id: 'previousSession', label: t('commands.previousSession'), shortcut: shortcuts.previousSession, disabled: sessions.summaries.length < 2 },
    { id: 'terminalSearch', label: t('commands.terminalSearch'), shortcut: shortcuts.terminalSearch, disabled: !activeSession },
    { id: 'toggleFiles', label: t('commands.showFiles'), shortcut: shortcuts.toggleFiles },
    { id: 'showMonitor', label: t('commands.showMonitor') },
    { id: 'toggleFocusMode', label: t('commands.toggleFocusMode'), shortcut: shortcuts.toggleFocusMode },
    { id: 'toggleTaskDrawer', label: t('commands.toggleTaskDrawer'), shortcut: shortcuts.toggleTaskDrawer },
    { id: 'showEvents', label: t('commands.showEvents'), shortcut: shortcuts.showEvents },
    { id: 'toggleAssistant', label: t('commands.toggleAssistant'), shortcut: shortcuts.toggleAssistant },
    { id: 'focusConnections', label: t('commands.focusConnections'), shortcut: shortcuts.focusConnections },
    { id: 'focusTerminal', label: t('commands.focusTerminal'), shortcut: shortcuts.focusTerminal },
    { id: 'focusInspector', label: t('commands.focusInspector'), shortcut: shortcuts.focusInspector },
    { id: 'openSettings', label: t('commands.openSettings'), shortcut: shortcuts.openSettings },
    { id: 'disconnectActiveSession', label: t('commands.disconnectActiveSession'), disabled: !canDisconnect },
  ];
});

async function startSession(): Promise<void> {
  if (
    sessions.activeSession
    && connections.activeProfile?.id === sessions.activeSession.profileId
    && ['disconnected', 'failed'].includes(sessions.activeSession.state)
  ) await sessions.reconnectActive();
  else if (connections.activeProfile) await sessions.begin(connections.activeProfile);
  else ui.openQuickConnect();
}

async function createNewSession(): Promise<void> {
  if (sessions.busy || sessions.challenge) return;
  if (connections.activeProfile) await sessions.begin(connections.activeProfile);
  else ui.openQuickConnect();
}

function toggleFocusMode(): void {
  settings.value.focusMode = !settings.value.focusMode;
}

async function focusInspector(): Promise<void> {
  ui.assistantOpen = false;
  settings.value.detailsPaneOpen = true;
  await nextTick();
  inspectorPane.value?.focusInspector();
}

function runShortcutAction(action: KeyboardShortcutAction): void {
  switch (action) {
    case 'quickConnect':
      if (sessions.busy || sessions.challenge || sessions.passwordProfileId) return;
      ui.openQuickConnect();
      break;
    case 'newSession':
      void createNewSession();
      break;
    case 'closeActiveTab':
      if (sessions.activeSession && !sessions.busy) void sessions.closeSession(sessions.activeSession.id);
      break;
    case 'nextSession':
      terminalWorkspace.value?.selectRelativeSession(1);
      break;
    case 'previousSession':
      terminalWorkspace.value?.selectRelativeSession(-1);
      break;
    case 'terminalSearch':
      terminalWorkspace.value?.openSearch();
      break;
    case 'toggleFiles':
      settings.value.fileBrowserOpen = !settings.value.fileBrowserOpen;
      break;
    case 'toggleFocusMode':
      toggleFocusMode();
      break;
    case 'toggleTaskDrawer':
      settings.value.taskDrawerOpen = !settings.value.taskDrawerOpen;
      break;
    case 'commandPalette':
      ui.openCommandPalette();
      break;
    case 'toggleAssistant':
      ui.toggleAssistant();
      break;
    case 'focusConnections':
      void connectionsPane.value?.focusFilter();
      break;
    case 'focusTerminal':
      terminalWorkspace.value?.focusActiveTerminal();
      break;
    case 'focusInspector':
      void focusInspector();
      break;
    case 'openSettings':
      ui.openSettings();
      break;
    case 'showEvents':
      settings.value.taskTab = 'events';
      settings.value.taskDrawerOpen = true;
      break;
  }
}

function runCommand(commandId: CommandPaletteCommandId): void {
  if (commandId === 'showMonitor') {
    settings.value.hostPanelOpen = true;
    return;
  }
  if (commandId === 'disconnectActiveSession') {
    if (!sessions.busy && sessions.activeSession?.state === 'connected') void sessions.disconnectActive();
    return;
  }
  runShortcutAction(commandId);
}

async function startSessionForActiveProfile(): Promise<void> {
  await startSession();
}

function beginPaneResize(side: 'connections' | 'inspector' | 'host', event: PointerEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const initial = side === 'connections'
    ? settings.value.connectionsPaneWidth
    : side === 'host'
      ? settings.value.hostPanelWidth
      : settings.value.inspectorPaneWidth;
  const move = (next: PointerEvent) => {
    const delta = side === 'inspector' ? startX - next.clientX : next.clientX - startX;
    let min = 180;
    let max = 420;
    if (side === 'host') {
      min = 200;
      max = 420;
    } else if (side === 'inspector') {
      min = settings.value.dualPaneSftp ? 540 : 220;
      max = settings.value.dualPaneSftp ? 760 : 480;
    }
    const width = Math.min(max, Math.max(min, initial + delta));
    if (side === 'connections') settings.value.connectionsPaneWidth = width;
    else if (side === 'host') settings.value.hostPanelWidth = width;
    else settings.value.inspectorPaneWidth = width;
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once: true });
}

function beginFileBrowserResize(event: PointerEvent): void {
  event.preventDefault();
  const startY = event.clientY;
  const initial = settings.value.fileBrowserHeight;
  const move = (next: PointerEvent) => {
    const delta = startY - next.clientY;
    settings.value.fileBrowserHeight = Math.min(480, Math.max(160, initial + delta));
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once: true });
}

function resizePaneByKeyboard(side: 'connections' | 'inspector' | 'host', event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  if (side === 'connections') {
    settings.value.connectionsPaneWidth = Math.min(420, Math.max(180, settings.value.connectionsPaneWidth + direction * 12));
  } else if (side === 'host') {
    settings.value.hostPanelWidth = Math.min(420, Math.max(200, settings.value.hostPanelWidth + direction * 12));
  } else {
    const min = settings.value.dualPaneSftp ? 540 : 220;
    const max = settings.value.dualPaneSftp ? 760 : 480;
    settings.value.inspectorPaneWidth = Math.min(max, Math.max(min, settings.value.inspectorPaneWidth - direction * 12));
  }
}

function resizeFileBrowserByKeyboard(event: KeyboardEvent): void {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === 'ArrowUp' ? 1 : -1;
  settings.value.fileBrowserHeight = Math.min(480, Math.max(160, settings.value.fileBrowserHeight + direction * 12));
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || ui.settingsOpen) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const actions = Object.keys(settings.value.shortcuts) as KeyboardShortcutAction[];
  const action = actions.find((candidate) => matchesKeyboardShortcut(event, settings.value.shortcuts[candidate]));
  if (!action) return;
  if (event.repeat) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (ui.commandPaletteOpen) {
    if (action === 'commandPalette') {
      event.preventDefault();
      event.stopPropagation();
      ui.closeCommandPalette();
    }
    return;
  }
  if (
    ui.addProfileOpen
    || ui.quickConnectOpen
    || ui.sshImportOpen
    || ui.transferDialog
    || ui.tunnelDialogOpen
    || ui.confirmation
    || Boolean(sessions.challenge && sessions.challenge.trust !== 'trusted')
    || Boolean(sessions.passwordProfileId)
    || Boolean(sessions.privateKeyPassphraseProfileId)
  ) return;
  if (target?.closest('[role="dialog"], .dialog-layer')) return;

  const isEditing = target?.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]') === true;
  const isTerminalInput = Boolean(target?.closest('.xterm'));
  const globalWhileEditing = ['quickConnect', 'commandPalette', 'openSettings'].includes(action);
  if (isEditing && !isTerminalInput && !globalWhileEditing) return;
  if (action === 'terminalSearch' && !sessions.activeSession) return;
  if (['nextSession', 'previousSession'].includes(action) && sessions.summaries.length < 2) return;
  if (action === 'closeActiveTab' && (!sessions.activeSession || sessions.busy)) return;
  if (action === 'newSession' && (sessions.busy || sessions.challenge)) return;

  event.preventDefault();
  event.stopPropagation();
  runShortcutAction(action);
}

onMounted(() => window.addEventListener('keydown', handleShortcut, true));
onBeforeUnmount(() => window.removeEventListener('keydown', handleShortcut, true));
</script>

<template>
  <main class="workbench-shell" :class="{ 'task-open': settings.value.taskDrawerOpen, 'focus-mode': focusMode }">
    <header class="context-bar">
      <div class="brand" aria-label="FILEX">
        <span class="brand-mark"><Terminal :size="15" /></span>
        <span>FILEX</span>
      </div>
      <label class="global-search">
        <Search :size="14" aria-hidden="true" />
        <span class="sr-only">{{ t('app.searchPlaceholder') }}</span>
        <input v-model="connections.query" type="search" :placeholder="t('app.searchPlaceholder')">
      </label>
      <div class="context-actions">
        <button type="button" class="button primary" :disabled="sessions.busy" @click="startSessionForActiveProfile">
          <Plus :size="14" />
          <span>{{ t('app.newSession') }}</span>
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('app.quickConnect')"
          :title="`${t('app.quickConnect')} · ${formatKeyboardShortcut(settings.value.shortcuts.quickConnect)}`"
          :disabled="sessions.busy || Boolean(sessions.challenge) || Boolean(sessions.passwordProfileId)"
          @click="ui.openQuickConnect"
        >
          <Zap :size="15" />
        </button>
        <span class="toolbar-divider" />
        <button
          type="button"
          class="icon-button"
          :class="{ active: fileBrowserVisible }"
          :aria-pressed="fileBrowserVisible"
          :aria-label="t('terminal.files')"
          :title="`${t('terminal.files')} · ${formatKeyboardShortcut(settings.value.shortcuts.toggleFiles)}`"
          @click="settings.value.fileBrowserOpen = !settings.value.fileBrowserOpen"
        >
          <FolderOpen :size="15" />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: hostPanelVisible }"
          :aria-pressed="hostPanelVisible"
          :aria-label="t('terminal.monitor')"
          :title="t('terminal.monitor')"
          :disabled="!hasActiveSession"
          @click="settings.value.hostPanelOpen = !settings.value.hostPanelOpen"
        >
          <Activity :size="15" />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('terminal.tunnel')"
          :title="t('terminal.tunnel')"
          :disabled="sessions.activeSession?.state !== 'connected' || sessions.isQuickProfile(sessions.activeSession?.profileId)"
          @click="ui.openTunnel()"
        >
          <KeyRound :size="15" />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: ui.assistantOpen }"
          :aria-pressed="ui.assistantOpen"
          :aria-label="t('assistant.title')"
          :title="t('assistant.title')"
          @click="ui.toggleAssistant"
        >
          <Bot :size="15" />
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ active: detailsPaneVisible }"
          :aria-pressed="detailsPaneVisible"
          :aria-label="t('terminal.details')"
          :title="t('terminal.details')"
          @click="settings.value.detailsPaneOpen = !settings.value.detailsPaneOpen"
        >
          <Info :size="15" />
        </button>
        <span class="toolbar-divider" />
        <button
          type="button"
          class="icon-button"
          :class="{ active: focusMode }"
          :aria-pressed="focusMode"
          :aria-label="t('commands.toggleFocusMode')"
          :title="`${t('commands.toggleFocusMode')} · ${formatKeyboardShortcut(settings.value.shortcuts.toggleFocusMode)}`"
          @click="toggleFocusMode"
        >
          <Maximize2 :size="15" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('commands.title')" :title="`${t('commands.title')} · ${formatKeyboardShortcut(settings.value.shortcuts.commandPalette)}`" @click="ui.openCommandPalette">
          <Command :size="15" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('app.settings')" :title="t('app.settings')" @click="ui.openSettings">
          <Settings :size="15" />
        </button>
      </div>
    </header>

    <div class="session-tabs-bar">
      <div id="session-tabs-slot" class="session-tabs-slot" />
      <div v-if="sessionErrorVisible" class="security-summary error" role="alert" :title="sessionErrorText">
        <CircleAlert :size="13" />
        <span>{{ sessionErrorText }}</span>
        <button type="button" class="icon-button" :aria-label="t('app.dismissNotice')" :title="t('app.dismissNotice')" @click="sessions.clearError"><X :size="12" /></button>
      </div>
      <div v-else-if="!hasActiveSession" class="security-summary">
        <ShieldCheck :size="13" />
        <span>{{ t('inspector.trustUnknown') }}</span>
      </div>
    </div>

    <section class="workbench-main">
      <ConnectionsPane v-if="!focusMode" ref="connectionsPane" />
      <button
        v-if="!focusMode"
        class="pane-resizer"
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize connections pane"
        @pointerdown="beginPaneResize('connections', $event)"
        @keydown="resizePaneByKeyboard('connections', $event)"
      />
      <template v-if="hostPanelVisible">
        <HostPanel />
        <button
          class="pane-resizer"
          type="button"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize host panel"
          @pointerdown="beginPaneResize('host', $event)"
          @keydown="resizePaneByKeyboard('host', $event)"
        />
      </template>
      <div class="center-column">
        <TerminalWorkspace ref="terminalWorkspace" />
        <CommandInputBar v-if="commandBarVisible" />
        <template v-if="fileBrowserVisible">
          <button
            class="pane-resizer horizontal"
            type="button"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize file browser"
            @pointerdown="beginFileBrowserResize($event)"
            @keydown="resizeFileBrowserByKeyboard($event)"
          />
          <div class="file-browser-panel-slot" :style="{ height: `${settings.value.fileBrowserHeight}px` }">
            <FileBrowserPanel />
          </div>
        </template>
      </div>
      <template v-if="!focusMode">
        <AssistantPanel v-if="ui.assistantOpen" />
        <InspectorPane v-else-if="detailsPaneVisible" ref="inspectorPane" />
      </template>
    </section>

    <TaskDrawer v-if="settings.value.taskDrawerOpen" />
    <StatusBar />
    <CommandPalette
      v-if="ui.commandPaletteOpen"
      :commands="commandPaletteCommands"
      @select="runCommand"
      @close="ui.closeCommandPalette"
    />
    <div class="sr-only" role="status" aria-live="polite">
      {{ connections.activeProfile ? `Selected ${connections.activeProfile.name}` : '' }}
    </div>
  </main>
</template>
