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
  ShieldAlert,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useUiStore } from '@/stores/ui';
import type { MonitorDetailsView, OpsCategory, SessionState } from '@/types/contracts';

const props = defineProps<{
  focused: boolean;
  connected: boolean;
  sessionState: SessionState;
  environment: string;
  environmentTone: 'production' | 'staging' | 'development' | 'local';
  sessionStateLabel: string;
  encodingLabel: string;
  columns: number;
  rows: number;
  cursorCell: { col: number; row: number } | null;
  selectedChars: number;
  elevatedRemaining?: string | null;
}>();

const emit = defineEmits<{
  'revoke-elevation': [];
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
      <span
        class="terminal-state-pill"
        :class="[sessionState, { focused }]"
        :title="t(focused ? 'terminal.inputActive' : 'terminal.inputInactive')"
        aria-live="polite"
      >
        <Circle :size="7" fill="currentColor" aria-hidden="true" />
        <span>{{ sessionStateLabel }}</span>
      </span>
      <span class="terminal-env-pill" :class="environmentTone">
        <Circle :size="6" fill="currentColor" aria-hidden="true" />
        <span>{{ environment }}</span>
      </span>
      <span v-if="elevatedRemaining" class="elevated-badge mono" role="status">
        <ShieldAlert :size="11" />
        <span>{{ t('elevated.badgeCountdown', { remaining: elevatedRemaining }) }}</span>
        <button
          type="button"
          class="elevated-badge-revoke"
          :aria-label="t('elevated.revoke')"
          @click="emit('revoke-elevation')"
        >
          {{ t('elevated.revoke') }}
        </button>
      </span>
      <span class="terminal-meta-sep" aria-hidden="true" />
      <span class="terminal-meta-item mono">{{ encodingLabel }}</span>
      <span class="terminal-meta-dot" aria-hidden="true">·</span>
      <span
        class="terminal-meta-item mono"
        :title="t('terminal.dimensionsTitle', { cols: columns, rows })"
      >{{ columns }} × {{ rows }}</span>
      <template v-if="selectedChars > 0">
        <span class="terminal-meta-dot" aria-hidden="true">·</span>
        <span class="terminal-meta-chip terminal-selection-chip mono">
          {{ t('terminal.selectionChars', { count: selectedChars }) }}
        </span>
      </template>
      <template v-else-if="cursorCell">
        <span class="terminal-meta-dot" aria-hidden="true">·</span>
        <span class="terminal-meta-item mono">
          {{ t('terminal.cursorPosition', { row: cursorCell.row, col: cursorCell.col }) }}
        </span>
      </template>
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
