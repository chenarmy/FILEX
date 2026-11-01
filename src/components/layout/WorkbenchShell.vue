<script setup lang="ts">
import { computed } from 'vue';
import {
  Activity,
  FolderOpen,
  KeyRound,
  MonitorCog,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SplitSquareVertical,
  Terminal,
} from 'lucide-vue-next';
import ConnectionsPane from '@/components/connections/ConnectionsPane.vue';
import TerminalWorkspace from '@/components/terminal/TerminalWorkspace.vue';
import InspectorPane from '@/components/inspector/InspectorPane.vue';
import TaskDrawer from '@/components/tasks/TaskDrawer.vue';
import StatusBar from '@/components/layout/StatusBar.vue';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';

const connections = useConnectionsStore();
const settings = useSettingsStore();
const ui = useUiStore();
const activeName = computed(() => connections.activeProfile?.name ?? '—');
</script>

<template>
  <main class="workbench-shell" :class="{ 'task-open': settings.value.taskDrawerOpen }">
    <header class="context-bar">
      <div class="brand" aria-label="FILEX">
        <span class="brand-mark"><Terminal :size="15" /></span>
        <span>FILEX</span>
      </div>
      <button type="button" class="workspace-picker">
        <span class="environment-dot development" aria-hidden="true" />
        <span>{{ t('app.workspace') }}</span>
      </button>
      <label class="global-search">
        <Search :size="14" aria-hidden="true" />
        <span class="sr-only">{{ t('app.searchPlaceholder') }}</span>
        <input v-model="connections.query" type="search" :placeholder="t('app.searchPlaceholder')">
        <kbd>Ctrl K</kbd>
      </label>
      <div class="context-actions">
        <button type="button" class="button primary" @click="ui.openAddProfile">
          <Plus :size="14" />
          <span>{{ t('app.newSession') }}</span>
        </button>
        <button type="button" class="icon-button" :aria-label="t('app.settings')" :title="t('app.settings')" @click="ui.openSettings">
          <Settings :size="15" />
        </button>
      </div>
    </header>

    <div class="action-bar">
      <div class="action-context">
        <span class="environment-badge production">PROD</span>
        <strong>{{ activeName }}</strong>
      </div>
      <div class="toolbar-actions">
        <button type="button" class="toolbar-button" disabled :title="t('app.sshPending')">
          <RefreshCw :size="13" />{{ t('terminal.reconnect') }}
        </button>
        <button type="button" class="toolbar-button" disabled :title="t('app.sshPending')">
          <SplitSquareVertical :size="13" />{{ t('terminal.split') }}
        </button>
        <span class="toolbar-divider" />
        <button type="button" class="toolbar-button" :class="{ active: settings.value.inspectorTab === 'files' }" @click="settings.value.inspectorTab = 'files'">
          <FolderOpen :size="13" />{{ t('terminal.files') }}
        </button>
        <button type="button" class="toolbar-button" :class="{ active: settings.value.inspectorTab === 'monitor' }" @click="settings.value.inspectorTab = 'monitor'">
          <Activity :size="13" />{{ t('terminal.monitor') }}
        </button>
        <button type="button" class="toolbar-button" disabled :title="t('app.sshPending')">
          <KeyRound :size="13" />{{ t('terminal.tunnel') }}
        </button>
      </div>
      <div class="security-summary">
        <ShieldCheck :size="13" />
        <span>{{ t('inspector.trustUnknown') }}</span>
      </div>
    </div>

    <section class="workbench-main">
      <ConnectionsPane />
      <div class="center-column">
        <TerminalWorkspace />
      </div>
      <InspectorPane />
    </section>

    <TaskDrawer v-if="settings.value.taskDrawerOpen" />
    <StatusBar />
    <div class="sr-only" role="status" aria-live="polite">
      {{ connections.activeProfile ? `Selected ${connections.activeProfile.name}` : '' }}
    </div>
    <MonitorCog class="sr-only" />
  </main>
</template>
