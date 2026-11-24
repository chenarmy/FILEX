<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  Ban,
  CheckCircle2,
  CircleDot,
  Clock,
  Cpu,
  Layers,
  ListTree,
  Loader2,
  Network,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-vue-next';
import { hasCapability } from '@/domain/sessionCapabilities';
import { canResumeTransferTask, resumeStateLabelKey } from '@/domain/transferResume';
import { t } from '@/i18n';
import { type ConsoleEvent, useEventsStore } from '@/stores/events';
import { isRemoteJobActiveState, useRemoteJobsStore } from '@/stores/remoteJobs';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTransfersStore } from '@/stores/transfers';
import { useTunnelsStore } from '@/stores/tunnels';
import type {
  RemoteJobKind,
  RemoteJobState,
  RemoteJobSummary,
  TaskTab,
  TransferResumeState,
  TransferState,
  TransferTask,
  TunnelState,
  TunnelSummary,
} from '@/types/contracts';

type ActivityItemKind = 'transfer' | 'job' | 'tunnel' | 'event';

interface UnifiedActivityRow {
  uid: string;
  kind: ActivityItemKind;
  itemId: string;
  timestampMs: number;
  active: boolean;
  title: string;
  hostLabel: string;
  stateLabel: string;
  severity: 'neutral' | 'running' | 'success' | 'warning' | 'danger';
  durationText: string;
  transfer?: TransferTask;
  job?: RemoteJobSummary;
  tunnel?: TunnelSummary;
  eventEntry?: ConsoleEvent;
}

const settings = useSettingsStore();
const sessions = useSessionsStore();
const transfers = useTransfersStore();
const tunnels = useTunnelsStore();
const remoteJobs = useRemoteJobsStore();
const events = useEventsStore();

const transferFilter = ref<'all' | 'active' | 'history'>('all');
const activityScope = ref<'all' | 'active'>('all');
const selectedDetail = ref<{ kind: ActivityItemKind; id: string } | null>(null);

const jobForm = reactive<{
  kind: RemoteJobKind;
  targetPath: string;
  serviceName: string;
  maxLines: number;
}>({
  kind: 'check_system_health',
  targetPath: '/var/log',
  serviceName: '',
  maxLines: 100,
});

const visibleTransfers = computed(() => {
  if (transferFilter.value === 'active') return transfers.activeTasks;
  if (transferFilter.value === 'history') return transfers.historyTasks;
  return transfers.tasks;
});

const activeSshJobSession = computed(() => {
  const session = sessions.activeSession;
  if (!session || session.state !== 'connected') return null;
  if (!hasCapability(session, 'remote_jobs')) return null;
  return session;
});

const transferStateLabels: Record<TransferState, Parameters<typeof t>[0]> = {
  queued: 'tasks.transferStateQueued',
  running: 'tasks.transferStateRunning',
  paused: 'tasks.transferStatePaused',
  completed: 'tasks.transferStateCompleted',
  failed: 'tasks.transferStateFailed',
  cancelled: 'tasks.transferStateCancelled',
};

const jobStateLabels: Record<RemoteJobState, Parameters<typeof t>[0]> = {
  queued: 'jobs.stateQueued',
  running: 'jobs.stateRunning',
  stopping: 'jobs.stateStopping',
  completed: 'jobs.stateCompleted',
  failed: 'jobs.stateFailed',
  cancelled: 'jobs.stateCancelled',
  outcome_uncertain: 'jobs.stateOutcomeUncertain',
};

const jobKindLabels: Record<RemoteJobKind, Parameters<typeof t>[0]> = {
  tail_system_log: 'jobs.kindTailSystemLog',
  inspect_disk_usage: 'jobs.kindInspectDiskUsage',
  check_service_health: 'jobs.kindCheckServiceHealth',
  inspect_listening_ports: 'jobs.kindInspectListeningPorts',
  check_system_health: 'jobs.kindCheckSystemHealth',
};

const activeTunnelCount = computed(() => (
  tunnels.tunnels.filter((item) => item.state === 'starting' || item.state === 'listening' || item.state === 'stopping').length
));

const totalActivityCount = computed(() => (
  transfers.tasks.length + remoteJobs.jobs.length + tunnels.tunnels.length + events.entries.length
));

const tabs = computed<{ id: TaskTab; label: Parameters<typeof t>[0]; count: number; icon: typeof ArrowDownToLine }[]>(() => [
  { id: 'all', label: 'tasks.all', count: totalActivityCount.value, icon: Layers },
  { id: 'transfers', label: 'tasks.transfers', count: transfers.activeTasks.length, icon: ArrowDownToLine },
  { id: 'jobs', label: 'tasks.jobs', count: remoteJobs.activeJobs.length, icon: Cpu },
  { id: 'tunnels', label: 'tasks.tunnels', count: activeTunnelCount.value, icon: Network },
  { id: 'events', label: 'tasks.events', count: events.entries.length, icon: ListTree },
]);

function formatDurationMs(startMs: number | null | undefined, endMs: number | null | undefined): string {
  if (!startMs) return '—';
  const finish = endMs ?? Date.now();
  const seconds = Math.max(0, Math.round((finish - startMs) / 1000));
  return t('tasks.durationSeconds', { seconds });
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

function jobStateText(state: RemoteJobState): string {
  return t(jobStateLabels[state]);
}

function resumeStateText(state: TransferResumeState): string | null {
  const key = resumeStateLabelKey(state);
  return key ? t(key) : null;
}

function canResumeTransfer(task: TransferTask): boolean {
  return canResumeTransferTask(task);
}

function profileDisplayName(profileId: string | null): string {
  if (!profileId) return '';
  return sessions.profileForId(profileId)?.name ?? profileId;
}

function transferPrimaryLabel(task: TransferTask): string {
  if (task.direction === 'remote_to_remote') {
    return `${profileDisplayName(task.profileId)}:${task.remotePath}`;
  }
  return task.direction === 'upload' ? task.localPath : task.remotePath;
}

function transferSecondaryLabel(task: TransferTask): string {
  if (task.direction === 'remote_to_remote') {
    return `→ ${profileDisplayName(task.destinationProfileId)}:${task.destinationRemotePath ?? ''}`;
  }
  return task.direction === 'upload' ? task.remotePath : task.localPath;
}

function jobSeverity(state: RemoteJobState): UnifiedActivityRow['severity'] {
  if (state === 'completed') return 'success';
  if (state === 'running' || state === 'stopping' || state === 'queued') return 'running';
  if (state === 'outcome_uncertain') return 'warning';
  if (state === 'failed') return 'danger';
  return 'neutral';
}

function transferSeverity(state: TransferState): UnifiedActivityRow['severity'] {
  if (state === 'completed') return 'success';
  if (state === 'running' || state === 'queued') return 'running';
  if (state === 'paused') return 'warning';
  if (state === 'failed') return 'danger';
  return 'neutral';
}

function tunnelSeverity(state: TunnelState): UnifiedActivityRow['severity'] {
  if (state === 'listening') return 'success';
  if (state === 'starting' || state === 'stopping') return 'running';
  if (state === 'failed') return 'danger';
  return 'neutral';
}

function eventSeverity(severity: ConsoleEvent['severity']): UnifiedActivityRow['severity'] {
  if (severity === 'success') return 'success';
  if (severity === 'warning') return 'warning';
  if (severity === 'error') return 'danger';
  return 'neutral';
}

const unifiedRows = computed<UnifiedActivityRow[]>(() => {
  const items: UnifiedActivityRow[] = [];

  for (const task of transfers.tasks) {
    items.push({
      uid: `transfer:${task.id}`,
      kind: 'transfer',
      itemId: task.id,
      timestampMs: task.updatedAtMs,
      active: task.state === 'queued' || task.state === 'running' || task.state === 'paused',
      title: transferPrimaryLabel(task),
      hostLabel: task.direction === 'remote_to_remote'
        ? `${profileDisplayName(task.profileId)} → ${profileDisplayName(task.destinationProfileId)}`
        : profileDisplayName(task.profileId),
      stateLabel: transferStateText(task.state),
      severity: transferSeverity(task.state),
      durationText: formatDurationMs(task.createdAtMs, ['completed', 'failed', 'cancelled'].includes(task.state) ? task.updatedAtMs : null),
      transfer: task,
    });
  }

  for (const job of remoteJobs.jobs) {
    items.push({
      uid: `job:${job.id}`,
      kind: 'job',
      itemId: job.id,
      timestampMs: job.finishedAtMs ?? job.startedAtMs ?? job.createdAtMs,
      active: isRemoteJobActiveState(job.state),
      title: job.commandLabel,
      hostLabel: `${job.targetUsername}@${job.targetHost}:${job.targetPort}`,
      stateLabel: jobStateText(job.state),
      severity: jobSeverity(job.state),
      durationText: formatDurationMs(job.startedAtMs ?? job.createdAtMs, job.finishedAtMs),
      job,
    });
  }

  for (const tunnel of tunnels.tunnels) {
    const active = tunnel.state === 'starting' || tunnel.state === 'listening' || tunnel.state === 'stopping';
    items.push({
      uid: `tunnel:${tunnel.id}`,
      kind: 'tunnel',
      itemId: tunnel.id,
      timestampMs: active ? Date.now() : 0,
      active,
      title: tunnel.name,
      hostLabel: `${tunnel.bindHost}:${tunnel.bindPort} → ${tunnel.kind === 'dynamic' ? 'SOCKS5' : `${tunnel.targetHost}:${tunnel.targetPort}`}`,
      stateLabel: tunnelStateText(tunnel.state),
      severity: tunnelSeverity(tunnel.state),
      durationText: active ? tunnelStateText(tunnel.state) : '—',
      tunnel,
    });
  }

  for (const entry of events.entries) {
    const ts = Date.parse(entry.occurredAt) || 0;
    items.push({
      uid: `event:${entry.id}`,
      kind: 'event',
      itemId: entry.id,
      timestampMs: ts,
      active: false,
      title: entry.code,
      hostLabel: typeof entry.details.host === 'string' ? entry.details.host : entry.category,
      stateLabel: entry.severity,
      severity: eventSeverity(entry.severity),
      durationText: new Date(entry.occurredAt).toLocaleTimeString(),
      eventEntry: entry,
    });
  }

  const filtered = activityScope.value === 'active'
    ? items.filter((item) => item.active)
    : items;

  return filtered.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.timestampMs - left.timestampMs;
  });
});

const inspectedTransfer = computed(() => (
  selectedDetail.value?.kind === 'transfer'
    ? transfers.tasks.find((item) => item.id === selectedDetail.value?.id) ?? null
    : null
));

const inspectedJob = computed(() => (
  selectedDetail.value?.kind === 'job'
    ? remoteJobs.jobs.find((item) => item.id === selectedDetail.value?.id) ?? null
    : null
));

const inspectedJobOutput = computed(() => (
  inspectedJob.value ? remoteJobs.outputByJob[inspectedJob.value.id] ?? null : null
));

const inspectedTunnel = computed(() => (
  selectedDetail.value?.kind === 'tunnel'
    ? tunnels.tunnels.find((item) => item.id === selectedDetail.value?.id) ?? null
    : null
));

const inspectedEvent = computed(() => (
  selectedDetail.value?.kind === 'event'
    ? events.entries.find((item) => item.id === selectedDetail.value?.id) ?? null
    : null
));

const hasDetail = computed(() => Boolean(
  inspectedTransfer.value || inspectedJob.value || inspectedTunnel.value || inspectedEvent.value,
));

watch(
  () => remoteJobs.selectedJobId,
  (id) => {
    if (id && !selectedDetail.value) {
      selectedDetail.value = { kind: 'job', id };
    }
  },
);

async function selectRow(kind: ActivityItemKind, id: string): Promise<void> {
  if (selectedDetail.value?.kind === kind && selectedDetail.value.id === id) {
    selectedDetail.value = null;
    if (kind === 'job') await remoteJobs.selectJob(null);
    return;
  }
  selectedDetail.value = { kind, id };
  if (kind === 'job') {
    await remoteJobs.selectJob(id);
  }
}

function closeDetails(): void {
  selectedDetail.value = null;
  void remoteJobs.selectJob(null);
}

async function startJob(): Promise<void> {
  const session = activeSshJobSession.value;
  if (!session) return;
  const started = await remoteJobs.start({
    sessionId: session.id,
    kind: jobForm.kind,
    targetPath: jobForm.kind === 'inspect_disk_usage' ? jobForm.targetPath.trim() || '/var/log' : null,
    serviceName: jobForm.kind === 'check_service_health' ? jobForm.serviceName.trim() || null : null,
    maxLines: jobForm.kind === 'tail_system_log' ? jobForm.maxLines : null,
  });
  if (started) {
    selectedDetail.value = { kind: 'job', id: started.id };
  }
}

function beginResize(event: PointerEvent): void {
  event.preventDefault();
  const startY = event.clientY;
  const initial = settings.value.taskDrawerHeight;
  const move = (next: PointerEvent) => {
    settings.value.taskDrawerHeight = Math.min(360, Math.max(96, Math.round(initial + startY - next.clientY)));
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
</script>

<template>
  <section class="task-drawer">
    <button
      class="task-resizer"
      type="button"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('tasks.resizeDrawer')"
      @pointerdown="beginResize"
      @keydown="resizeByKeyboard"
    />
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
          <component :is="tab.icon" :size="12" />
          <span>{{ t(tab.label) }}</span>
          <span v-if="tab.count > 0" class="tab-count">{{ tab.count }}</span>
        </button>
      </div>
      <button type="button" class="icon-button" :aria-label="t('tasks.closeDrawer')" @click="settings.value.taskDrawerOpen = false">
        <X :size="13" />
      </button>
    </header>

    <div class="activity-workspace" :class="{ 'with-detail': hasDetail }">
      <div v-if="settings.value.taskTab === 'all'" class="transfer-list">
        <div class="transfer-toolbar">
          <div class="transfer-filters" role="group" :aria-label="t('tasks.activityLabel')">
            <button
              type="button"
              class="transfer-filter-chip"
              :class="{ active: activityScope === 'all' }"
              :aria-pressed="activityScope === 'all'"
              @click="activityScope = 'all'"
            >
              {{ t('tasks.activityAllFilter') }} ({{ totalActivityCount }})
            </button>
            <button
              type="button"
              class="transfer-filter-chip"
              :class="{ active: activityScope === 'active' }"
              :aria-pressed="activityScope === 'active'"
              @click="activityScope = 'active'"
            >
              {{ t('tasks.activityActiveFilter') }}
            </button>
          </div>
        </div>
        <div v-if="unifiedRows.length === 0" class="task-empty">{{ t('tasks.noActivity') }}</div>
        <div
          v-for="row in unifiedRows"
          v-else
          :key="row.uid"
          class="transfer-row activity-row"
          :class="{ selected: selectedDetail?.kind === row.kind && selectedDetail.id === row.itemId }"
        >
          <ArrowDownToLine v-if="row.kind === 'transfer'" :size="12" />
          <Cpu v-else-if="row.kind === 'job'" :size="12" />
          <Network v-else-if="row.kind === 'tunnel'" :size="12" />
          <CircleDot v-else :size="12" />
          <button type="button" class="activity-row-button" @click="selectRow(row.kind, row.itemId)">
            <strong>{{ row.title }}</strong>
            <small>
              <span class="activity-kind-badge">{{ t(row.kind === 'transfer' ? 'tasks.kindTransfer' : row.kind === 'job' ? 'tasks.kindJob' : row.kind === 'tunnel' ? 'tasks.kindTunnel' : 'tasks.kindEvent') }}</span>
              <span>{{ row.hostLabel }}</span>
              <span>· {{ row.durationText }}</span>
            </small>
          </button>
          <span class="activity-state-cell" :data-severity="row.severity">
            <Loader2 v-if="row.severity === 'running'" :size="12" />
            <CheckCircle2 v-else-if="row.severity === 'success'" :size="12" />
            <AlertTriangle v-else-if="row.severity === 'warning'" :size="12" />
            <XCircle v-else-if="row.severity === 'danger'" :size="12" />
            <Clock v-else :size="12" />
            <span>{{ row.stateLabel }}</span>
          </span>
          <div class="transfer-actions">
            <template v-if="row.job">
              <button
                v-if="isRemoteJobActiveState(row.job.state)"
                type="button"
                class="icon-button"
                :title="t('jobs.cancelAction')"
                :aria-label="t('jobs.cancelAction')"
                @click="remoteJobs.cancel(row.job.id)"
              >
                <Square :size="11" />
              </button>
              <button
                v-if="row.job.state === 'running' || row.job.state === 'stopping'"
                type="button"
                class="icon-button"
                :title="t('jobs.terminateAction')"
                :aria-label="t('jobs.terminateAction')"
                @click="remoteJobs.terminate(row.job.id)"
              >
                <OctagonX :size="11" />
              </button>
            </template>
            <template v-else-if="row.transfer">
              <button
                v-if="row.transfer.state === 'queued' || row.transfer.state === 'running'"
                type="button"
                class="icon-button"
                :title="t('tasks.pauseTransfer')"
                :aria-label="t('tasks.pauseTransfer')"
                @click="transfers.pause(row.transfer.id)"
              >
                <Pause :size="11" />
              </button>
              <button
                v-else-if="canResumeTransfer(row.transfer)"
                type="button"
                class="icon-button"
                :title="t('tasks.resumeTransfer')"
                :aria-label="t('tasks.resumeTransfer')"
                @click="transfers.retry(row.transfer.id)"
              >
                <Play :size="11" />
              </button>
              <button
                v-if="['queued', 'running', 'paused'].includes(row.transfer.state)"
                type="button"
                class="icon-button"
                :title="t('tasks.cancelTransfer')"
                :aria-label="t('tasks.cancelTransfer')"
                @click="transfers.cancel(row.transfer.id)"
              >
                <Square :size="11" />
              </button>
            </template>
            <template v-else-if="row.tunnel && row.active">
              <button
                type="button"
                class="icon-button"
                :disabled="tunnels.isStopPending(row.tunnel.id)"
                :title="t('tunnel.stop')"
                :aria-label="t('tunnel.stop')"
                @click="tunnels.stop(row.tunnel.id)"
              >
                <Square :size="11" />
              </button>
            </template>
          </div>
        </div>
      </div>

      <div v-else-if="settings.value.taskTab === 'transfers'" class="transfer-list">
        <div class="transfer-toolbar">
          <div class="transfer-filters" role="group" :aria-label="t('tasks.transferFilterLabel')">
            <button type="button" class="transfer-filter-chip" :class="{ active: transferFilter === 'all' }" :aria-pressed="transferFilter === 'all'" @click="transferFilter = 'all'">{{ t('tasks.transferFilterAll') }} ({{ transfers.tasks.length }})</button>
            <button type="button" class="transfer-filter-chip" :class="{ active: transferFilter === 'active' }" :aria-pressed="transferFilter === 'active'" @click="transferFilter = 'active'">{{ t('tasks.transferFilterActive') }} ({{ transfers.activeTasks.length }})</button>
            <button type="button" class="transfer-filter-chip" :class="{ active: transferFilter === 'history' }" :aria-pressed="transferFilter === 'history'" @click="transferFilter = 'history'">{{ t('tasks.transferFilterHistory') }} ({{ transfers.historyTasks.length }})</button>
          </div>
          <button type="button" class="button" :disabled="transfers.historyTasks.length === 0" @click="transfers.clearCompleted">
            <Trash2 :size="11" />{{ t('tasks.clearTransferHistory') }}
          </button>
        </div>
        <div v-if="transfers.loading" class="task-empty">{{ t('tasks.loadingTransfers') }}</div>
        <div v-else-if="visibleTransfers.length === 0" class="task-empty">{{ transferFilter === 'history' ? t('tasks.noTransferHistory') : t('tasks.noTransfers') }}</div>
        <div
          v-for="task in visibleTransfers"
          v-else
          :key="task.id"
          class="transfer-row"
          :class="{ selected: selectedDetail?.kind === 'transfer' && selectedDetail.id === task.id }"
        >
          <ArrowLeftRight v-if="task.direction === 'remote_to_remote'" :size="12" />
          <ArrowDownToLine v-else :size="12" :class="{ upload: task.direction === 'upload' }" />
          <button type="button" class="activity-row-button" @click="selectRow('transfer', task.id)">
            <strong>{{ transferPrimaryLabel(task) }}</strong>
            <small>{{ transferSecondaryLabel(task) }}<template v-if="['completed', 'failed', 'cancelled'].includes(task.state)"> · {{ new Date(task.updatedAtMs).toLocaleTimeString() }}</template></small>
          </button>
          <span class="transfer-progress">
            <small class="transfer-status-line">
              <span>{{ transferStateText(task.state) }}</span>
              <span v-if="task.direction === 'remote_to_remote'" class="transfer-relay-badge">{{ t('transfer.relayBadge') }}</span>
              <span v-if="resumeStateText(task.resumeState)" class="transfer-resume-badge" :data-resume-state="task.resumeState">{{ resumeStateText(task.resumeState) }}</span>
              <template v-if="task.error"> · {{ t(task.error.messageKey as Parameters<typeof t>[0]) }}</template>
            </small>
            <progress v-if="task.state === 'completed'" value="1" max="1" />
            <progress v-else-if="task.totalBytes !== null && task.totalBytes > 0" :value="task.bytesTransferred" :max="task.totalBytes" />
            <progress v-else />
          </span>
          <div class="transfer-actions">
            <button v-if="task.state === 'queued' || task.state === 'running'" type="button" class="icon-button" :title="t('tasks.pauseTransfer')" :aria-label="t('tasks.pauseTransfer')" @click="transfers.pause(task.id)"><Pause :size="11" /></button>
            <button v-else-if="canResumeTransfer(task)" type="button" class="icon-button" :title="t('tasks.resumeTransfer')" :aria-label="t('tasks.resumeTransfer')" @click="transfers.retry(task.id)"><Play :size="11" /></button>
            <button v-if="['paused', 'failed', 'cancelled'].includes(task.state) && (task.resumeState === 'identity_changed' || task.stagingPath !== null)" type="button" class="icon-button" :title="t('tasks.resetTransferStaging')" :aria-label="t('tasks.resetTransferStaging')" @click="transfers.resetStaging(task.id)"><RotateCcw :size="11" /></button>
            <button v-else-if="task.state === 'cancelled' || (task.state === 'failed' && task.resumeState !== 'identity_changed')" type="button" class="icon-button" :title="t('tasks.retryTransfer')" :aria-label="t('tasks.retryTransfer')" @click="transfers.retry(task.id)"><RotateCcw :size="11" /></button>
            <button v-if="['queued', 'running', 'paused'].includes(task.state)" type="button" class="icon-button" :title="t('tasks.cancelTransfer')" :aria-label="t('tasks.cancelTransfer')" @click="transfers.cancel(task.id)"><Square :size="11" /></button>
          </div>
        </div>
        <div v-if="transfers.error" class="task-empty" role="alert">{{ t(transfers.error.messageKey as Parameters<typeof t>[0]) }}</div>
      </div>

      <div v-else-if="settings.value.taskTab === 'jobs'" class="transfer-list">
        <div class="transfer-toolbar job-launcher">
          <div class="job-launcher-fields">
            <label class="sr-only" for="remote-job-kind">{{ t('jobs.presetLabel') }}</label>
            <select id="remote-job-kind" v-model="jobForm.kind">
              <option value="check_system_health">{{ t('jobs.kindCheckSystemHealth') }}</option>
              <option value="tail_system_log">{{ t('jobs.kindTailSystemLog') }}</option>
              <option value="inspect_disk_usage">{{ t('jobs.kindInspectDiskUsage') }}</option>
              <option value="check_service_health">{{ t('jobs.kindCheckServiceHealth') }}</option>
              <option value="inspect_listening_ports">{{ t('jobs.kindInspectListeningPorts') }}</option>
            </select>
            <input
              v-if="jobForm.kind === 'inspect_disk_usage'"
              v-model="jobForm.targetPath"
              type="text"
              :placeholder="t('jobs.targetPathPlaceholder')"
            >
            <input
              v-else-if="jobForm.kind === 'check_service_health'"
              v-model="jobForm.serviceName"
              type="text"
              :placeholder="t('jobs.serviceNamePlaceholder')"
            >
            <select v-else-if="jobForm.kind === 'tail_system_log'" v-model.number="jobForm.maxLines" :aria-label="t('jobs.maxLinesLabel')">
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="250">250</option>
              <option :value="500">500</option>
            </select>
            <button
              type="button"
              class="button primary"
              :disabled="!activeSshJobSession || remoteJobs.busy"
              @click="startJob"
            >
              <Play :size="11" />{{ t('jobs.startButton') }}
            </button>
          </div>
          <small v-if="!activeSshJobSession" class="job-launcher-hint">{{ t('jobs.needSshSession') }}</small>
          <small v-else class="job-launcher-hint mono">{{ activeSshJobSession.username }}@{{ activeSshJobSession.host }}:{{ activeSshJobSession.port }}</small>
        </div>
        <div v-if="remoteJobs.error" class="task-empty" role="alert">{{ t(remoteJobs.error.messageKey as Parameters<typeof t>[0]) }}</div>
        <div v-if="remoteJobs.jobs.length === 0" class="task-empty">{{ t('jobs.noJobs') }}</div>
        <div
          v-for="job in remoteJobs.jobs"
          v-else
          :key="job.id"
          class="transfer-row"
          :class="{ selected: selectedDetail?.kind === 'job' && selectedDetail.id === job.id }"
        >
          <Cpu :size="12" />
          <button type="button" class="activity-row-button" @click="selectRow('job', job.id)">
            <strong>{{ job.commandLabel }} <small class="activity-kind-badge">{{ t(jobKindLabels[job.kind]) }}</small></strong>
            <small>{{ job.targetUsername }}@{{ job.targetHost }}:{{ job.targetPort }} · {{ formatDurationMs(job.startedAtMs ?? job.createdAtMs, job.finishedAtMs) }} · {{ job.outputEndOffset }} B</small>
          </button>
          <span class="activity-state-cell" :data-severity="jobSeverity(job.state)">
            <Loader2 v-if="job.state === 'running' || job.state === 'stopping' || job.state === 'queued'" :size="12" />
            <CheckCircle2 v-else-if="job.state === 'completed'" :size="12" />
            <AlertTriangle v-else-if="job.state === 'outcome_uncertain'" :size="12" />
            <Ban v-else-if="job.state === 'cancelled'" :size="12" />
            <XCircle v-else :size="12" />
            <span>{{ jobStateText(job.state) }}</span>
          </span>
          <div class="transfer-actions">
            <button
              v-if="isRemoteJobActiveState(job.state)"
              type="button"
              class="icon-button"
              :title="t('jobs.cancelAction')"
              :aria-label="t('jobs.cancelAction')"
              @click="remoteJobs.cancel(job.id)"
            >
              <Square :size="11" />
            </button>
            <button
              v-if="job.state === 'running' || job.state === 'stopping'"
              type="button"
              class="icon-button"
              :title="t('jobs.terminateAction')"
              :aria-label="t('jobs.terminateAction')"
              @click="remoteJobs.terminate(job.id)"
            >
              <OctagonX :size="11" />
            </button>
            <button
              v-if="!isRemoteJobActiveState(job.state)"
              type="button"
              class="icon-button"
              :title="t('jobs.dismissAction')"
              :aria-label="t('jobs.dismissAction')"
              @click="remoteJobs.dismiss(job.id)"
            >
              <Trash2 :size="11" />
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="settings.value.taskTab === 'tunnels'" class="transfer-list">
        <div v-if="tunnels.tunnels.length === 0" class="task-empty">{{ t('tasks.noTunnels') }}</div>
        <div
          v-for="tunnel in tunnels.tunnels"
          v-else
          :key="tunnel.id"
          class="transfer-row"
          :class="{ selected: selectedDetail?.kind === 'tunnel' && selectedDetail.id === tunnel.id }"
        >
          <Network :size="12" />
          <button type="button" class="activity-row-button" @click="selectRow('tunnel', tunnel.id)">
            <strong>{{ tunnel.name }}</strong>
            <small>{{ tunnel.bindHost }}:{{ tunnel.bindPort }} → {{ tunnel.kind === 'dynamic' ? 'SOCKS5' : `${tunnel.targetHost}:${tunnel.targetPort}` }}</small>
          </button>
          <span><small>{{ tunnelStateText(tunnel.state) }}</small><small v-if="tunnel.lastError">{{ t(tunnel.lastError.messageKey as Parameters<typeof t>[0]) }}</small></span>
          <button v-if="tunnel.state === 'starting' || tunnel.state === 'listening' || tunnel.state === 'stopping'" type="button" class="icon-button" :disabled="tunnels.isStopPending(tunnel.id)" :title="t('tunnel.stop')" @click="tunnels.stop(tunnel.id)"><Square :size="11" /></button>
        </div>
      </div>

      <div v-else class="event-list">
        <div class="event-toolbar"><span>{{ events.entries.length }} / 500</span><button type="button" class="button" :disabled="events.entries.length === 0" @click="events.clear">{{ t('tasks.clearEvents') }}</button></div>
        <div v-if="events.entries.length === 0" class="task-empty">{{ t('tasks.noEvents') }}</div>
        <div
          v-for="entry in events.entries"
          v-else
          :key="entry.id"
          class="event-row"
          :data-severity="entry.severity"
        >
          <CircleDot :size="11" />
          <time>{{ new Date(entry.occurredAt).toLocaleTimeString() }}</time>
          <button type="button" class="activity-row-button" @click="selectRow('event', entry.id)">
            <strong>{{ entry.code }}</strong>
            <small>{{ entry.category }}<template v-if="Object.keys(entry.details).length"> · {{ JSON.stringify(entry.details) }}</template></small>
          </button>
        </div>
      </div>

      <aside v-if="hasDetail" class="activity-detail-pane" :aria-label="t('tasks.detailsTitle')">
        <header class="activity-detail-header">
          <strong>{{ t('tasks.detailsTitle') }}</strong>
          <button type="button" class="icon-button" :aria-label="t('tasks.closeDetails')" @click="closeDetails">
            <X :size="13" />
          </button>
        </header>

        <div v-if="inspectedJob" class="activity-detail-body">
          <div class="activity-detail-meta">
            <span><strong>{{ inspectedJob.commandLabel }}</strong> ({{ jobStateText(inspectedJob.state) }})</span>
            <small>{{ t('jobs.targetHostLabel') }}: {{ inspectedJob.targetUsername }}@{{ inspectedJob.targetHost }}:{{ inspectedJob.targetPort }} ({{ t('jobs.sessionGenLabel') }} #{{ inspectedJob.sessionGeneration }})</small>
            <small>
              {{ t(inspectedJob.riskClass === 'read_only' ? 'jobs.riskReadOnly' : 'jobs.riskBoundedDiagnostic') }}
              <template v-if="inspectedJob.exitCode !== null && inspectedJob.exitCode !== undefined"> · {{ t('jobs.exitCodeLabel') }}: {{ inspectedJob.exitCode }}</template>
              <template v-if="inspectedJob.exitSignal"> · {{ t('jobs.exitSignalLabel') }}: {{ inspectedJob.exitSignal }}</template>
              · {{ t('jobs.offsetsLabel') }}: {{ inspectedJob.outputStartOffset }}..{{ inspectedJob.outputEndOffset }}
            </small>
            <small v-if="inspectedJob.error" class="activity-detail-error">{{ t(inspectedJob.error.messageKey as Parameters<typeof t>[0]) }} ({{ inspectedJob.error.code }})</small>
          </div>
          <div class="activity-detail-actions">
            <button type="button" class="button" @click="remoteJobs.loadOutput(inspectedJob.id)">
              <RefreshCw :size="11" />{{ t('jobs.reloadOutput') }}
            </button>
            <button
              v-if="isRemoteJobActiveState(inspectedJob.state)"
              type="button"
              class="button"
              @click="remoteJobs.cancel(inspectedJob.id)"
            >
              <Square :size="11" />{{ t('jobs.cancelAction') }}
            </button>
            <button
              v-if="inspectedJob.state === 'running' || inspectedJob.state === 'stopping'"
              type="button"
              class="button danger"
              @click="remoteJobs.terminate(inspectedJob.id)"
            >
              <OctagonX :size="11" />{{ t('jobs.terminateAction') }}
            </button>
          </div>
          <small v-if="inspectedJobOutput?.truncated || inspectedJob.outputTruncated" class="activity-detail-warning">{{ t('jobs.outputTruncated') }}</small>
          <pre class="activity-output-pre">{{ inspectedJobOutput?.content || t('jobs.outputEmpty') }}</pre>
        </div>

        <div v-else-if="inspectedTransfer" class="activity-detail-body">
          <div class="activity-detail-meta">
            <span><strong>{{ transferPrimaryLabel(inspectedTransfer) }}</strong> ({{ transferStateText(inspectedTransfer.state) }})</span>
            <small>{{ transferSecondaryLabel(inspectedTransfer) }}</small>
            <small v-if="inspectedTransfer.stagingPath">{{ inspectedTransfer.stagingPath }}</small>
            <small v-if="inspectedTransfer.error" class="activity-detail-error">{{ t(inspectedTransfer.error.messageKey as Parameters<typeof t>[0]) }} ({{ inspectedTransfer.error.code }})</small>
          </div>
        </div>

        <div v-else-if="inspectedTunnel" class="activity-detail-body">
          <div class="activity-detail-meta">
            <span><strong>{{ inspectedTunnel.name }}</strong> ({{ tunnelStateText(inspectedTunnel.state) }})</span>
            <small>{{ inspectedTunnel.bindHost }}:{{ inspectedTunnel.bindPort }} → {{ inspectedTunnel.kind === 'dynamic' ? 'SOCKS5' : `${inspectedTunnel.targetHost}:${inspectedTunnel.targetPort}` }}</small>
            <small v-if="inspectedTunnel.lastError" class="activity-detail-error">{{ t(inspectedTunnel.lastError.messageKey as Parameters<typeof t>[0]) }} ({{ inspectedTunnel.lastError.code }})</small>
          </div>
        </div>

        <div v-else-if="inspectedEvent" class="activity-detail-body">
          <div class="activity-detail-meta">
            <span><strong>{{ inspectedEvent.code }}</strong> ({{ inspectedEvent.severity }})</span>
            <small>{{ inspectedEvent.category }} · {{ new Date(inspectedEvent.occurredAt).toLocaleString() }}</small>
          </div>
          <pre class="activity-output-pre">{{ JSON.stringify(inspectedEvent.details, null, 2) }}</pre>
        </div>
      </aside>
    </div>
  </section>
</template>
