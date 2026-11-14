<script setup lang="ts">
import {
  Activity,
  Box,
  Circle,
  Cpu,
  FileText,
  HardDrive,
  Network,
  Radar,
  Route,
  ServerCog,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useUiStore } from '@/stores/ui';
import type { MonitorDetailsView, OpsCategory } from '@/types/contracts';

const props = defineProps<{
  focused: boolean;
  connected: boolean;
  environment: string;
  sessionStateLabel: string;
  encodingLabel: string;
  columns: number;
  rows: number;
  cursorCell: { col: number; row: number } | null;
  selectedChars: number;
}>();

const ui = useUiStore();

function openMonitor(view: MonitorDetailsView): void {
  if (!props.connected) return;
  ui.openMonitorDetails(view);
}

function openDocker(): void {
  if (!props.connected) return;
  ui.openDockerDialog();
}

function openOps(category: OpsCategory): void {
  if (!props.connected) return;
  ui.openOpsDialog(category);
}
</script>

<template>
  <footer class="terminal-pane-status" :aria-label="t('quickOps.barLabel')">
    <div class="terminal-status-meta">
      <span class="terminal-input-status" :class="{ active: focused }" aria-live="polite">
        <Circle :size="7" :fill="focused ? 'currentColor' : 'none'" />
        {{ t(focused ? 'terminal.inputActive' : 'terminal.inputInactive') }}
      </span>
      <span class="terminal-meta-chip">
        <Circle :size="7" fill="currentColor" />{{ environment }}
      </span>
      <span class="terminal-meta-chip">{{ sessionStateLabel }}</span>
      <span class="terminal-meta-chip mono">{{ encodingLabel }}</span>
      <span class="terminal-meta-chip mono">{{ columns }} × {{ rows }}</span>
      <span v-if="selectedChars > 0" class="terminal-meta-chip terminal-selection-chip mono">
        {{ t('terminal.selectionChars', { count: selectedChars }) }}
      </span>
      <span v-else-if="cursorCell" class="terminal-meta-chip mono">
        {{ t('terminal.cursorPosition', { row: cursorCell.row, col: cursorCell.col }) }}
      </span>
    </div>

    <div class="terminal-quick-ops" role="toolbar" :aria-label="t('quickOps.barLabel')">
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.monitorDetailsView === 'overview' }"
        :disabled="!connected"
        @click="openMonitor('overview')"
      >
        <Activity :size="12" />{{ t('quickOps.system') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.monitorDetailsView === 'processes' }"
        :disabled="!connected"
        @click="openMonitor('processes')"
      >
        <Cpu :size="12" />{{ t('quickOps.processes') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.monitorDetailsView === 'network' }"
        :disabled="!connected"
        @click="openMonitor('network')"
      >
        <Network :size="12" />{{ t('quickOps.network') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.monitorDetailsView === 'routes' }"
        :disabled="!connected"
        @click="openMonitor('routes')"
      >
        <Route :size="12" />{{ t('quickOps.routes') }}
      </button>

      <span class="quick-op-divider" aria-hidden="true" />

      <button
        type="button"
        class="quick-op-button quick-op-docker"
        :class="{ active: ui.dockerDialogOpen }"
        :disabled="!connected"
        @click="openDocker"
      >
        <Box :size="12" />{{ t('quickOps.docker') }}
      </button>

      <span class="quick-op-divider" aria-hidden="true" />

      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.opsDialogCategory === 'ports' }"
        :disabled="!connected"
        @click="openOps('ports')"
      >
        <Radar :size="12" />{{ t('quickOps.ports') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.opsDialogCategory === 'services' }"
        :disabled="!connected"
        @click="openOps('services')"
      >
        <ServerCog :size="12" />{{ t('quickOps.services') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.opsDialogCategory === 'disks' }"
        :disabled="!connected"
        @click="openOps('disks')"
      >
        <HardDrive :size="12" />{{ t('quickOps.disks') }}
      </button>
      <button
        type="button"
        class="quick-op-button"
        :class="{ active: ui.opsDialogCategory === 'logs' }"
        :disabled="!connected"
        @click="openOps('logs')"
      >
        <FileText :size="12" />{{ t('quickOps.logs') }}
      </button>
    </div>
  </footer>
</template>
