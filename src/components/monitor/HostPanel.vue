<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  Activity,
  CircleStop,
  Copy,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Route,
  Server,
  Users,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import { useMonitorStore } from '@/stores/monitor';
import { useProcessesStore } from '@/stores/processes';
import { useSettingsStore } from '@/stores/settings';
import { useMonitorPolling } from '@/composables/useMonitorPolling';
import Sparkline from '@/components/ui/Sparkline.vue';
import MonitorDetailsDialog from '@/components/monitor/MonitorDetailsDialog.vue';
import type { ProcessEntry } from '@/types/contracts';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const settings = useSettingsStore();
const monitor = useMonitorStore();
const processes = useProcessesStore();

const processView = ref<'memory' | 'cpu' | 'command'>('memory');
const detailsView = ref<'processes' | 'network' | 'routes' | null>(null);
let detailsOpener: HTMLElement | null = null;
const connected = computed(() => sessions.activeSession?.state === 'connected');

useMonitorPolling({
  enabled: () => connected.value && settings.value.hostPanelOpen && !settings.value.focusMode,
  withProcesses: () => true,
});

const session = computed(() => sessions.activeSession);
const profileName = computed(() => (
  session.value ? sessions.profileForId(session.value.profileId)?.name ?? session.value.host : connections.activeProfile?.name ?? '—'
));
const endpoint = computed(() => (session.value
  ? `${session.value.username}@${session.value.host}`
  : connections.activeProfile
    ? `${connections.activeProfile.username}@${connections.activeProfile.host}`
    : '—'));
const endpointPort = computed(() => session.value?.port ?? connections.activeProfile?.port ?? 22);

const monitorStateLabel = computed(() => {
  switch (monitor.displayState) {
    case 'live': return t('inspector.monitorLive');
    case 'stale': return t('inspector.monitorStale');
    case 'unsupported': return t('inspector.monitorUnsupported');
    case 'permission_denied': return t('inspector.monitorPermissionDenied');
    case 'failed': return t('inspector.monitorFailed');
    default: return t('inspector.monitorPending');
  }
});

const monitorBackoffSeconds = computed(() => Math.min(
  300,
  settings.value.monitorIntervalSeconds * (2 ** Math.min(monitor.consecutiveFailures, 4)),
));
const showMonitorBackoff = computed(() => monitor.consecutiveFailures > 0
  && monitor.snapshot?.state !== 'unsupported'
  && monitor.snapshot?.state !== 'permission_denied');

function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return t('hostPanel.uptimeDays', { days, hours });
  if (hours > 0) return t('hostPanel.uptimeHours', { hours, minutes });
  return t('hostPanel.uptimeMinutes', { minutes });
}

function formatKib(kib: number | null | undefined): string | null {
  if (kib === null || kib === undefined) return null;
  if (kib >= 1024 * 1024 * 1024) return `${(kib / (1024 * 1024 * 1024)).toFixed(1)} TB`;
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`;
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MB`;
  return `${kib} KB`;
}

function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  if (bytesPerSecond < 1024 * 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MiB/s`;
  return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GiB/s`;
}

function usagePercent(total: number | null | undefined, used: number | null | undefined): number | null {
  if (!total || used === null || used === undefined) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

const memoryGauge = computed(() => {
  const snapshot = monitor.snapshot;
  const used = snapshot?.memoryTotalKib != null && snapshot?.memoryAvailableKib != null
    ? Math.max(0, snapshot.memoryTotalKib - snapshot.memoryAvailableKib)
    : null;
  return {
    usedLabel: formatKib(used),
    totalLabel: formatKib(snapshot?.memoryTotalKib),
    percent: usagePercent(snapshot?.memoryTotalKib, used),
  };
});
const swapGauge = computed(() => {
  const snapshot = monitor.snapshot;
  return {
    usedLabel: formatKib(snapshot?.swapUsedKib),
    totalLabel: formatKib(snapshot?.swapTotalKib),
    percent: usagePercent(snapshot?.swapTotalKib, snapshot?.swapUsedKib),
  };
});
const cpuPercent = computed(() => monitor.snapshot?.cpuPercent ?? null);
const loadText = computed(() => {
  const snapshot = monitor.snapshot;
  if (snapshot?.loadOne === null || snapshot?.loadOne === undefined) return '—';
  const parts = [snapshot.loadOne, snapshot.loadFive ?? snapshot.loadOne, snapshot.loadFifteen ?? snapshot.loadOne];
  return parts.map((value) => value.toFixed(2)).join(' ');
});
const mounts = computed(() => monitor.snapshot?.mounts ?? []);
const receiveHistory = computed(() => monitor.history.map((sample) => sample.receive ?? 0));
const transmitHistory = computed(() => monitor.history.map((sample) => sample.transmit ?? 0));

const topProcesses = computed(() => {
  const list = processes.snapshot?.processes ?? [];
  const sorted = [...list];
  if (processView.value === 'memory') sorted.sort((left, right) => (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0));
  else if (processView.value === 'cpu') sorted.sort((left, right) => (right.cpuPercent ?? -1) - (left.cpuPercent ?? -1));
  else sorted.sort((left, right) => left.name.localeCompare(right.name));
  return sorted.slice(0, 8);
});

function processMetric(entry: ProcessEntry): string {
  if (processView.value === 'memory') return formatBytesForProcess(entry.memoryBytes);
  if (processView.value === 'cpu') {
    if (entry.cpuPercent !== null) return `${entry.cpuPercent.toFixed(1)}%`;
    if (entry.cpuTimeSeconds !== null) return `${entry.cpuTimeSeconds.toFixed(1)} s`;
    return '—';
  }
  return `PID ${entry.pid}`;
}

function formatBytesForProcess(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} MB`;
  return `${bytes} B`;
}

function copyEndpoint(): void {
  const value = endpoint.value;
  if (!value || value === '—') return;
  void navigator.clipboard?.writeText(`${value}:${endpointPort.value}`).then(
    () => ui.notify(t('hostPanel.endpointCopied')),
    () => ui.notify(t('hostPanel.endpointCopyFailed')),
  );
}

async function refresh(): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  await monitor.collect(sessionId);
  if (processes.snapshot) await processes.collect(sessionId);
}

async function terminateProcess(entry: ProcessEntry): Promise<void> {
  const activeSession = sessions.activeSession;
  const snapshot = processes.snapshot;
  if (!activeSession || activeSession.state !== 'connected' || !snapshot?.snapshotId || !entry.canTerminate) return;
  if (Date.now() - snapshot.collectedAtMs > 60_000) {
    await processes.collect(activeSession.id);
    return;
  }
  const action = snapshot.platform === 'windows'
    ? t('inspector.processActionWindows')
    : 'SIGTERM';
  const accepted = await ui.confirm({
    title: t('inspector.terminateProcessTitle'),
    message: t('inspector.terminateProcessConfirm', {
      host: activeSession.host,
      port: activeSession.port,
      pid: entry.pid,
      name: entry.name,
      action,
    }),
    confirmLabel: t('inspector.terminateProcess'),
    danger: true,
  });
  if (!accepted) return;
  if (await processes.terminate(activeSession.id, entry.pid)) {
    ui.notify(t('inspector.processSignalSent', { name: entry.name, pid: entry.pid }));
  }
}

function openDetails(view: 'processes' | 'network' | 'routes', event: MouseEvent): void {
  detailsOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  detailsView.value = view;
}

function closeDetails(): void {
  detailsView.value = null;
  void nextTick(() => detailsOpener?.focus());
}
</script>

<template>
  <aside class="host-panel" :aria-label="t('hostPanel.title')">
    <div v-if="!connected" class="host-panel-empty">
      <Server :size="16" aria-hidden="true" />
      <p>{{ t('hostPanel.requiresSession') }}</p>
    </div>

    <template v-else>
      <section class="host-panel-card host-info-card">
        <header class="host-info-heading">
          <strong :title="profileName">{{ profileName }}</strong>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('hostPanel.copyEndpoint')"
            :title="t('hostPanel.copyEndpoint')"
            @click="copyEndpoint"
          >
            <Copy :size="11" />
          </button>
        </header>
        <dl class="host-info-list mono">
          <div><dt>IP</dt><dd :title="session?.host">{{ session?.host ?? '—' }}</dd></div>
          <div><dt>{{ t('hostPanel.connection') }}</dt><dd :title="`${endpoint}:${endpointPort}`">{{ endpoint }}:{{ endpointPort }}</dd></div>
          <div><dt>{{ t('hostPanel.user') }}</dt><dd>{{ session?.username ?? '—' }}</dd></div>
        </dl>
      </section>

      <section class="host-panel-card">
        <header class="host-panel-card-heading">
          <strong>{{ t('hostPanel.systemInfo') }}</strong>
          <span class="status-pill" :class="monitor.displayState === 'live' ? 'available' : 'pending'">
            {{ monitor.loading ? t('inspector.monitorLoading') : monitorStateLabel }}
          </span>
          <button
            type="button"
            class="icon-button"
            :disabled="!sessions.activeSessionId || monitor.loading"
            :aria-label="t('inspector.refreshMonitor')"
            @click="refresh"
          >
            <RefreshCw :size="11" />
          </button>
        </header>
        <p v-if="showMonitorBackoff" class="monitor-backoff" role="status">{{ t('inspector.monitorBackoff', { seconds: monitorBackoffSeconds }) }}</p>
        <dl class="host-metrics">
          <div class="host-metric-row">
            <dt><Activity :size="12" aria-hidden="true" />{{ t('hostPanel.running') }}</dt>
            <dd>{{ formatUptime(monitor.snapshot?.uptimeSeconds) }}</dd>
          </div>
          <div class="host-metric-row">
            <dt><Activity :size="12" aria-hidden="true" />{{ t('inspector.load') }}</dt>
            <dd class="mono host-load">{{ loadText }}</dd>
          </div>
          <div class="host-metric-row host-gauge-row">
            <dt><Cpu :size="12" aria-hidden="true" />CPU</dt>
            <dd>
              <div class="host-gauge">
                <span class="host-gauge-bar">
                  <span
                    class="host-gauge-fill"
                    :class="{ warning: (cpuPercent ?? 0) > 80 }"
                    :style="{ width: `${Math.max(0, Math.min(100, cpuPercent ?? 0))}%` }"
                  />
                </span>
                <span class="mono">{{ cpuPercent === null ? '—' : `${cpuPercent.toFixed(0)}%` }}</span>
              </div>
            </dd>
          </div>
          <div class="host-metric-row host-gauge-row">
            <dt><MemoryStick :size="12" aria-hidden="true" />{{ t('inspector.memory') }}</dt>
            <dd>
              <div class="host-gauge">
                <span class="host-gauge-bar">
                  <span
                    class="host-gauge-fill"
                    :class="{ warning: (memoryGauge.percent ?? 0) > 85 }"
                    :style="{ width: `${memoryGauge.percent ?? 0}%` }"
                  />
                </span>
                <span class="mono">{{ memoryGauge.percent === null ? '—' : `${memoryGauge.percent.toFixed(0)}%` }}</span>
              </div>
              <small class="host-gauge-detail mono">
                {{ memoryGauge.usedLabel ?? '—' }}/{{ memoryGauge.totalLabel ?? '—' }}
              </small>
            </dd>
          </div>
          <div class="host-metric-row host-gauge-row">
            <dt><MemoryStick :size="12" aria-hidden="true" />{{ t('inspector.swap') }}</dt>
            <dd>
              <div class="host-gauge">
                <span class="host-gauge-bar">
                  <span
                    class="host-gauge-fill"
                    :class="{ warning: (swapGauge.percent ?? 0) > 85 }"
                    :style="{ width: `${swapGauge.percent ?? 0}%` }"
                  />
                </span>
                <span class="mono">{{ swapGauge.percent === null ? '—' : `${swapGauge.percent.toFixed(0)}%` }}</span>
              </div>
              <small class="host-gauge-detail mono">
                {{ swapGauge.usedLabel ?? '—' }}/{{ swapGauge.totalLabel ?? '—' }}
              </small>
            </dd>
          </div>
        </dl>
        <div v-if="monitor.error" class="inline-notice error"><span>{{ t(monitor.error.messageKey as Parameters<typeof t>[0]) }}</span></div>
      </section>

      <section class="host-panel-card">
        <header class="host-panel-card-heading">
          <button type="button" class="host-panel-heading-action" @click="openDetails('processes', $event)">{{ t('hostPanel.processes') }}</button>
          <div class="host-process-tabs" role="tablist" :aria-label="t('hostPanel.processes')">
            <button
              v-for="view in (['memory', 'cpu', 'command'] as const)"
              :key="view"
              type="button"
              role="tab"
              :aria-selected="processView === view"
              :class="{ active: processView === view }"
              @click="processView = view"
            >
              {{ t(`hostPanel.processView_${view}` as Parameters<typeof t>[0]) }}
            </button>
          </div>
        </header>
        <div v-if="processes.snapshot?.state === 'unsupported'" class="host-panel-empty slim">
          <p>{{ t('inspector.processUnsupported') }}</p>
        </div>
        <div v-else-if="processes.loading && !processes.snapshot" class="host-panel-empty slim">
          <p>{{ t('inspector.processLoading') }}</p>
        </div>
        <ul v-else-if="topProcesses.length" class="host-process-list">
          <li v-for="entry in topProcesses" :key="entry.pid" class="host-process-row">
            <span class="mono host-process-name" :title="entry.name">{{ entry.name }}</span>
            <span class="mono host-process-metric">{{ processMetric(entry) }}</span>
            <button
              type="button"
              class="icon-button host-process-stop"
              :disabled="!entry.canTerminate || processes.loading || processes.terminatingPid !== null"
              :aria-label="t('inspector.terminateProcessTarget', { name: entry.name, pid: entry.pid })"
              :title="t('inspector.terminateProcessTarget', { name: entry.name, pid: entry.pid })"
              @click="terminateProcess(entry)"
            >
              <CircleStop :size="11" />
            </button>
          </li>
        </ul>
        <div v-else class="host-panel-empty slim"><p>{{ t('inspector.processEmpty') }}</p></div>
      </section>

      <section class="host-panel-card">
        <header class="host-panel-card-heading">
          <button type="button" class="host-panel-heading-action" @click="openDetails('network', $event)">{{ t('hostPanel.network') }}</button>
          <span class="mono host-network-rates">
            ↑ {{ formatRate(monitor.snapshot?.networkTransmitBytesPerSecond) }}
            ↓ {{ formatRate(monitor.snapshot?.networkReceiveBytesPerSecond) }}
          </span>
        </header>
        <div class="host-network-chart">
          <Sparkline
            :values="transmitHistory"
            :width="224"
            :height="26"
            aria-label="transmit"
          />
          <Sparkline
            :values="receiveHistory"
            :width="224"
            :height="26"
            color="hsl(135 59% 49%)"
            aria-label="receive"
          />
        </div>
        <p v-if="monitor.history.length < 2" class="host-network-note">{{ t('hostPanel.networkPending') }}</p>
      </section>

      <section class="host-panel-card host-route-card">
        <button type="button" class="host-panel-route-action" @click="openDetails('routes', $event)">
          <Route :size="12" aria-hidden="true" />
          <span>{{ t('hostPanel.routes') }}</span>
          <small>{{ t('hostPanel.routesHint') }}</small>
        </button>
      </section>

      <section v-if="mounts.length" class="host-panel-card host-mounts-card">
        <header class="host-panel-card-heading">
          <strong><HardDrive :size="12" aria-hidden="true" /> {{ t('hostPanel.disks') }}</strong>
        </header>
        <table class="host-mount-table">
          <thead>
            <tr>
              <th scope="col">{{ t('hostPanel.mountPath') }}</th>
              <th scope="col">{{ t('hostPanel.mountUsage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="mount in mounts" :key="mount.path">
              <td class="mono" :title="mount.path">{{ mount.path }}</td>
              <td class="mono">{{ formatKib(mount.totalKib - mount.availableKib) }}/{{ formatKib(mount.totalKib) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="monitor.snapshot?.osName" class="host-panel-card host-os-card">
        <header class="host-panel-card-heading">
          <strong><Users :size="12" aria-hidden="true" />{{ t('hostPanel.system') }}</strong>
        </header>
        <dl class="host-metrics">
          <div class="host-metric-row"><dt>{{ t('hostPanel.hostname') }}</dt><dd class="mono" :title="monitor.snapshot.hostname ?? '—'">{{ monitor.snapshot.hostname ?? '—' }}</dd></div>
          <div class="host-metric-row"><dt>{{ t('hostPanel.os') }}</dt><dd class="mono" :title="monitor.snapshot.osName">{{ monitor.snapshot.osName }}</dd></div>
        </dl>
      </section>
    </template>

    <Teleport to="body">
      <MonitorDetailsDialog v-if="detailsView" :initial-view="detailsView" @close="closeDetails" />
    </Teleport>
  </aside>
</template>
