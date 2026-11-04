<script setup lang="ts">
import { ArrowDownToLine, CircleDot, ListTree, Network, Pause, Play, RotateCcw, Square, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import type { TaskTab, TransferState, TunnelState } from '@/types/contracts';
import { useTransfersStore } from '@/stores/transfers';
import { useTunnelsStore } from '@/stores/tunnels';
import { useEventsStore } from '@/stores/events';

const settings = useSettingsStore();
const transfers = useTransfersStore();
const tunnels = useTunnelsStore();
const events = useEventsStore();
const transferStateLabels: Record<TransferState, Parameters<typeof t>[0]> = {
  queued: 'tasks.transferStateQueued',
  running: 'tasks.transferStateRunning',
  paused: 'tasks.transferStatePaused',
  completed: 'tasks.transferStateCompleted',
  failed: 'tasks.transferStateFailed',
  cancelled: 'tasks.transferStateCancelled',
};
const tabs: { id: TaskTab; label: Parameters<typeof t>[0]; icon: typeof ArrowDownToLine }[] = [
  { id: 'transfers', label: 'tasks.transfers', icon: ArrowDownToLine },
  { id: 'tunnels', label: 'tasks.tunnels', icon: Network },
  { id: 'events', label: 'tasks.events', icon: ListTree },
];

function beginResize(event: PointerEvent): void {
  event.preventDefault();
  const startY = event.clientY;
  const initial = settings.value.taskDrawerHeight;
  const move = (next: PointerEvent) => {
    settings.value.taskDrawerHeight = Math.min(360, Math.max(96, initial + startY - next.clientY));
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop, { once: true });
}

function resizeByKeyboard(event: KeyboardEvent): void {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const delta = event.key === 'ArrowUp' ? 12 : -12;
  settings.value.taskDrawerHeight = Math.min(360, Math.max(96, settings.value.taskDrawerHeight + delta));
}

function tunnelStateText(state: TunnelState): string {
  if (state === 'starting') return t('tunnel.stateStarting');
  if (state === 'listening') return t('tunnel.stateListening');
  if (state === 'stopping') return t('tunnel.stateStopping');
  if (state === 'failed') return t('tunnel.stateFailed');
  return t('tunnel.stateStopped');
}

function transferStateText(state: TransferState): string {
  return t(transferStateLabels[state]);
}
</script>

<template>
  <section class="task-drawer">
    <button class="task-resizer" type="button" role="separator" aria-orientation="horizontal" aria-label="Resize task drawer" @pointerdown="beginResize" @keydown="resizeByKeyboard" />
    <header class="task-header">
      <div class="task-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="settings.value.taskTab === tab.id"
          @click="settings.value.taskTab = tab.id"
        >
          <component :is="tab.icon" :size="12" />{{ t(tab.label) }}
        </button>
      </div>
      <button type="button" class="icon-button" aria-label="Close task drawer" @click="settings.value.taskDrawerOpen = false">
        <X :size="13" />
      </button>
    </header>
    <div v-if="settings.value.taskTab === 'transfers'" class="transfer-list">
      <div v-if="transfers.loading" class="task-empty">{{ t('tasks.loadingTransfers') }}</div>
      <div v-else-if="transfers.tasks.length === 0" class="task-empty">{{ t('tasks.noTransfers') }}</div>
      <div v-for="task in transfers.tasks" v-else :key="task.id" class="transfer-row">
        <ArrowDownToLine :size="12" :class="{ upload: task.direction === 'upload' }" />
        <span><strong>{{ task.direction === 'upload' ? task.localPath : task.remotePath }}</strong><small>{{ task.direction === 'upload' ? task.remotePath : task.localPath }}</small></span>
        <span class="transfer-progress"><small>{{ transferStateText(task.state) }}</small><progress v-if="task.state === 'completed'" value="1" max="1" /><progress v-else-if="task.totalBytes !== null && task.totalBytes > 0" :value="task.bytesTransferred" :max="task.totalBytes" /><progress v-else /></span>
        <button v-if="task.state === 'queued' || task.state === 'running'" type="button" class="icon-button" :title="t('tasks.pauseTransfer')" @click="transfers.pause(task.id)"><Pause :size="11" /></button>
        <button v-else-if="task.state === 'paused'" type="button" class="icon-button" :title="t('tasks.resumeTransfer')" @click="transfers.retry(task.id)"><Play :size="11" /></button>
        <button v-if="['queued', 'running', 'paused'].includes(task.state)" type="button" class="icon-button" :title="t('tasks.cancelTransfer')" @click="transfers.cancel(task.id)"><Square :size="11" /></button>
        <button v-if="task.state === 'cancelled' || task.state === 'failed'" type="button" class="icon-button" :title="t('tasks.retryTransfer')" @click="transfers.retry(task.id)"><RotateCcw :size="11" /></button>
      </div>
      <div v-if="transfers.error" class="task-empty" role="alert">{{ t(transfers.error.messageKey as Parameters<typeof t>[0]) }}</div>
    </div>
    <div v-else-if="settings.value.taskTab === 'tunnels'" class="transfer-list">
      <div v-if="tunnels.tunnels.length === 0" class="task-empty">{{ t('tasks.noTunnels') }}</div>
      <div v-for="tunnel in tunnels.tunnels" v-else :key="tunnel.id" class="transfer-row">
        <Network :size="12" />
        <span><strong>{{ tunnel.name }}</strong><small>{{ tunnel.bindHost }}:{{ tunnel.bindPort }} → {{ tunnel.kind === 'dynamic' ? 'SOCKS5' : `${tunnel.targetHost}:${tunnel.targetPort}` }}</small></span>
        <span><small>{{ tunnelStateText(tunnel.state) }}</small><small v-if="tunnel.lastError">{{ t(tunnel.lastError.messageKey as Parameters<typeof t>[0]) }}</small></span>
        <button v-if="tunnel.state === 'starting' || tunnel.state === 'listening' || tunnel.state === 'stopping'" type="button" class="icon-button" :disabled="tunnels.isStopPending(tunnel.id)" :title="t('tunnel.stop')" @click="tunnels.stop(tunnel.id)"><Square :size="11" /></button>
      </div>
    </div>
    <div v-else class="event-list">
      <div class="event-toolbar"><span>{{ events.entries.length }} / 500</span><button type="button" class="button" :disabled="events.entries.length === 0" @click="events.clear">{{ t('tasks.clearEvents') }}</button></div>
      <div v-if="events.entries.length === 0" class="task-empty">{{ t('tasks.noEvents') }}</div>
      <div v-for="entry in events.entries" v-else :key="entry.id" class="event-row" :data-severity="entry.severity">
        <CircleDot :size="11" /><time>{{ new Date(entry.occurredAt).toLocaleTimeString() }}</time><span><strong>{{ entry.code }}</strong><small>{{ entry.category }}<template v-if="Object.keys(entry.details).length"> · {{ JSON.stringify(entry.details) }}</template></small></span>
      </div>
    </div>
  </section>
</template>
