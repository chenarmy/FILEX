<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  CircleStop,
  Copy,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCw,
  Skull,
  X,
} from 'lucide-vue-next';
import { currentLocale, t } from '@/i18n';
import { ALL_NETWORK_INTERFACES, networkEndpointsForInterface } from '@/domain/monitorDetails';
import { useMonitorPolling } from '@/composables/useMonitorPolling';
import { useMonitorStore } from '@/stores/monitor';
import { useNetworkStore } from '@/stores/network';
import { useProcessesStore } from '@/stores/processes';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import Sparkline from '@/components/ui/Sparkline.vue';
import type {
  MonitorDetailsView,
  NetworkInterface,
  ProcessEntry,
  ProcessSignal,
} from '@/types/contracts';

const props = defineProps<{ initialView: MonitorDetailsView }>();
const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const monitor = useMonitorStore();
const processes = useProcessesStore();
const network = useNetworkStore();
const ui = useUiStore();
const activeView = ref<MonitorDetailsView>(props.initialView);
const selectedPid = ref<number | null>(null);
const selectedInterfaceName = ref(ALL_NETWORK_INTERFACES);
const selectedEndpointIndex = ref<number | null>(null);
const processMenu = ref<{ x: number; y: number; entry: ProcessEntry } | null>(null);
const processMenuEl = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const isPosixProcesses = computed(() => processes.snapshot?.platform === 'posix');
const selectedProcess = computed(() => processes.snapshot?.processes.find((entry) => entry.pid === selectedPid.value) ?? null);
const interfaces = computed(() => network.snapshot?.interfaces ?? []);
const selectedInterface = computed(() => interfaces.value.find((entry) => entry.name === selectedInterfaceName.value) ?? null);
const filteredEndpoints = computed(() => networkEndpointsForInterface(
  network.snapshot?.endpoints ?? [],
  selectedInterface.value,
));
const selectedEndpoint = computed(() => selectedEndpointIndex.value === null
  ? null
  : filteredEndpoints.value[selectedEndpointIndex.value] ?? null);

useMonitorPolling({
  enabled: () => connected.value && activeView.value === 'overview',
  withProcesses: () => false,
  preserveDataOnPause: true,
});

const memoryUsedKib = computed(() => {
  const s = monitor.snapshot;
  if (!s || s.memoryTotalKib === null || s.memoryAvailableKib === null) return null;
  return Math.max(0, s.memoryTotalKib - s.memoryAvailableKib);
});
const cpuUsage = computed(() => {
  const cpu = monitor.snapshot?.cpuPercent;
  if (cpu === null || cpu === undefined || !Number.isFinite(cpu)) return null;
  return Math.max(0, Math.min(100, Math.round(cpu)));
});
const memoryUsage = computed(() => usagePercent(monitor.snapshot?.memoryTotalKib, memoryUsedKib.value));
const swapUsage = computed(() => usagePercent(monitor.snapshot?.swapTotalKib, monitor.snapshot?.swapUsedKib));
const rxHistory = computed(() => monitor.history.map((sample) => sample.receive ?? 0));
const txHistory = computed(() => monitor.history.map((sample) => sample.transmit ?? 0));

watch(interfaces, (entries) => {
  if (selectedInterfaceName.value !== ALL_NETWORK_INTERFACES
    && !entries.some((entry) => entry.name === selectedInterfaceName.value)) {
    selectedInterfaceName.value = ALL_NETWORK_INTERFACES;
  }
}, { immediate: true });

watch(filteredEndpoints, () => {
  selectedEndpointIndex.value = null;
});

watch(
  () => props.initialView,
  (view) => {
    activeView.value = view;
  },
);

watch(activeView, (view) => {
  closeProcessMenu();
  void loadView(view);
});

watch(
  () => sessions.activeSessionId,
  (sessionId, previousSessionId) => {
    if (previousSessionId && sessionId !== previousSessionId) emit('close');
  },
);

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state]) => {
    if (!sessionId || state !== 'connected') emit('close');
  },
);

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!processMenu.value) return;
  if (processMenuEl.value?.contains(event.target as Node)) return;
  closeProcessMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  void loadView(activeView.value);
  void nextTick(() => closeButton.value?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
});

async function loadView(view: MonitorDetailsView): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  if (view === 'overview') {
    await monitor.collect(sessionId);
  } else if (view === 'processes') {
    await processes.collect(sessionId);
    selectedPid.value = processes.snapshot?.processes[0]?.pid ?? null;
  } else {
    await network.collect(sessionId);
  }
}

async function refresh(): Promise<void> {
  await loadView(activeView.value);
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return t('hostPanel.uptimeDays', { days, hours });
  if (hours > 0) return t('hostPanel.uptimeHours', { hours, minutes });
  return t('hostPanel.uptimeMinutes', { minutes });
}

function formatKib(kib: number | null | undefined): string {
  if (kib === null || kib === undefined) return '—';
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
  if (!total || used === null || used === undefined || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function meterTone(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 88) return 'danger';
  if (percent >= 72) return 'warn';
  return '';
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatCpu(entry: ProcessEntry): string {
  if (entry.cpuPercent !== null) return `${entry.cpuPercent.toFixed(1)}%`;
  if (entry.cpuTimeSeconds !== null) return t('monitorDetails.cpuTimeValue', { seconds: entry.cpuTimeSeconds.toFixed(1) });
  return '—';
}

function formatDate(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(currentLocale.value, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
}

function endpointLabel(address: string | null, port: number | null): string {
  if (!address) return '—';
  const formattedAddress = address.includes(':') ? `[${address}]` : address;
  return port === null ? formattedAddress : `${formattedAddress}:${port}`;
}

function interfaceState(entry: NetworkInterface): string {
  return entry.state || t('monitorDetails.unknown');
}

function closeProcessMenu(): void {
  processMenu.value = null;
}

function openProcessMenu(event: MouseEvent, entry: ProcessEntry): void {
  selectedPid.value = entry.pid;
  const menuWidth = 216;
  const menuHeight = 250;
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
  processMenu.value = { x, y, entry };
  void nextTick(() => processMenuEl.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
}

async function copyProcessField(value: string): Promise<void> {
  closeProcessMenu();
  try {
    await navigator.clipboard.writeText(value);
    ui.notify(t('monitorDetails.copied', { value }));
  } catch {
    ui.notify(t('terminal.copyFailed'));
  }
}

async function sendProcessSignal(entry: ProcessEntry, signal: ProcessSignal = 'SIGTERM'): Promise<void> {
  closeProcessMenu();
  const activeSession = sessions.activeSession;
  const snapshot = processes.snapshot;
  if (!activeSession || !snapshot?.snapshotId || !entry.canTerminate) return;
  const action = snapshot.platform === 'windows' ? t('inspector.processActionWindows') : signal;
  const accepted = await ui.confirm({
    title: signal === 'SIGTERM'
      ? t('inspector.terminateProcessTitle')
      : t('monitorDetails.processActionConfirmTitle'),
    message: signal === 'SIGTERM'
      ? t('inspector.terminateProcessConfirm', {
        host: activeSession.host,
        port: activeSession.port,
        pid: entry.pid,
        name: entry.name,
        action,
      })
      : t('monitorDetails.processActionConfirm', {
        host: activeSession.host,
        port: activeSession.port,
        pid: entry.pid,
        name: entry.name,
        action,
      }),
    confirmLabel: signal === 'SIGTERM'
      ? t('inspector.terminateProcess')
      : t('monitorDetails.processActionConfirmLabel', { action }),
    danger: signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGSTOP',
  });
  if (!accepted) return;
  if (await processes.terminate(activeSession.id, entry.pid, signal)) {
    selectedPid.value = null;
    ui.notify(t('inspector.processSignalSent', { name: entry.name, pid: entry.pid }));
  }
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (processMenu.value) {
      closeProcessMenu();
      return;
    }
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(dialogRoot.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), select:not(:disabled), [tabindex="0"]',
  ) ?? []).filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>

<template>
  <div class="dialog-layer monitor-details-layer" @mousedown.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
    <section ref="dialogRoot" class="dialog monitor-details-dialog" role="dialog" aria-modal="true" :aria-labelledby="`monitor-details-${activeView}`" @keydown="handleDialogKeydown">
      <header class="monitor-details-header">
        <div class="monitor-details-title">
          <strong :id="`monitor-details-${activeView}`">{{ t('monitorDetails.title') }}</strong>
          <span class="mono">{{ sessions.activeSession?.username }}@{{ sessions.activeSession?.host }}:{{ sessions.activeSession?.port }}</span>
        </div>
        <div class="monitor-details-actions">
          <button type="button" class="icon-button" :disabled="monitor.loading || processes.loading || network.loading" :aria-label="t('monitorDetails.refresh')" :title="t('monitorDetails.refresh')" @click="refresh"><RefreshCw :size="13" /></button>
          <button ref="closeButton" type="button" class="icon-button" :aria-label="t('monitorDetails.close')" :title="t('monitorDetails.close')" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>

      <nav class="monitor-details-tabs" role="tablist" :aria-label="t('monitorDetails.title')">
        <button v-for="view in (['overview', 'processes', 'network', 'routes'] as const)" :key="view" type="button" role="tab" :aria-selected="activeView === view" @click="activeView = view">{{ t(`monitorDetails.${view}` as Parameters<typeof t>[0]) }}</button>
      </nav>

      <div v-if="!connected" class="task-empty">{{ t('monitorDetails.requiresSession') }}</div>

      <div v-else-if="activeView === 'overview'" class="monitor-overview-shell">
        <div v-if="monitor.error" class="inline-notice error" role="alert">{{ t(monitor.error.messageKey as Parameters<typeof t>[0]) }}</div>
        <div v-else-if="monitor.loading && !monitor.snapshot" class="task-empty">{{ t('inspector.monitorPending') }}</div>
        <div v-else-if="monitor.snapshot?.state === 'unsupported'" class="task-empty">{{ t('inspector.monitorUnsupported') }}</div>
        <div v-else-if="monitor.snapshot?.state === 'permission_denied'" class="task-empty">{{ t('inspector.monitorPermissionDenied') }}</div>
        <template v-else-if="monitor.snapshot">
          <div class="monitor-overview-cards">
            <article class="monitor-overview-card">
              <h3>{{ t('hostPanel.systemInfo') }}</h3>
              <dl>
                <div><dt>{{ t('hostPanel.running') }}</dt><dd class="mono">{{ formatUptime(monitor.snapshot.uptimeSeconds) }}</dd></div>
                <div>
                  <dt>{{ t('inspector.load') }}</dt>
                  <dd class="mono">
                    {{ monitor.snapshot.loadOne?.toFixed(2) ?? '—' }}
                    {{ monitor.snapshot.loadFive !== null && monitor.snapshot.loadFive !== undefined ? monitor.snapshot.loadFive.toFixed(2) : '' }}
                    {{ monitor.snapshot.loadFifteen !== null && monitor.snapshot.loadFifteen !== undefined ? monitor.snapshot.loadFifteen.toFixed(2) : '' }}
                  </dd>
                </div>
              </dl>
            </article>
            <article class="monitor-overview-card">
              <h3>CPU &amp; {{ t('inspector.memory') }}</h3>
              <div class="host-meter">
                <div class="host-meter-head"><span>CPU</span><strong class="mono">{{ cpuUsage !== null ? `${cpuUsage}%` : '—' }}</strong></div>
                <div class="host-meter-track"><span class="host-meter-fill" :class="meterTone(cpuUsage)" :style="{ width: `${cpuUsage ?? 0}%` }" /></div>
              </div>
              <div class="host-meter">
                <div class="host-meter-head"><span>{{ t('inspector.memory') }}</span><strong class="mono">{{ memoryUsage !== null ? `${memoryUsage}%` : '—' }}</strong></div>
                <div class="host-meter-track"><span class="host-meter-fill" :class="meterTone(memoryUsage)" :style="{ width: `${memoryUsage ?? 0}%` }" /></div>
                <div class="host-meter-sub mono">{{ formatKib(memoryUsedKib) }} / {{ formatKib(monitor.snapshot.memoryTotalKib) }}</div>
              </div>
              <div class="host-meter">
                <div class="host-meter-head"><span>{{ t('inspector.swap') }}</span><strong class="mono">{{ swapUsage !== null ? `${swapUsage}%` : '—' }}</strong></div>
                <div class="host-meter-track"><span class="host-meter-fill" :class="meterTone(swapUsage)" :style="{ width: `${swapUsage ?? 0}%` }" /></div>
                <div class="host-meter-sub mono">{{ formatKib(monitor.snapshot.swapUsedKib) }} / {{ formatKib(monitor.snapshot.swapTotalKib) }}</div>
              </div>
            </article>
            <article class="monitor-overview-card">
              <h3>{{ t('hostPanel.network') }}</h3>
              <div class="host-network-rates mono">
                <span>↑ {{ formatRate(monitor.snapshot.networkTransmitBytesPerSecond) }}</span>
                <span>↓ {{ formatRate(monitor.snapshot.networkReceiveBytesPerSecond) }}</span>
              </div>
              <div class="host-network-chart">
                <Sparkline :values="txHistory" :width="240" :height="30" aria-label="transmit" />
                <Sparkline :values="rxHistory" :width="240" :height="30" color="hsl(135 59% 49%)" aria-label="receive" />
              </div>
            </article>
          </div>
          <section class="monitor-overview-mounts">
            <h3>{{ t('monitorDetails.disksTitle') }}</h3>
            <div v-if="monitor.snapshot.mounts?.length" class="monitor-table-scroll">
              <table class="monitor-details-table">
                <thead>
                  <tr>
                    <th>{{ t('monitorDetails.mountPath') }}</th>
                    <th>{{ t('monitorDetails.usedTotal') }}</th>
                    <th>{{ t('monitorDetails.available') }}</th>
                    <th>{{ t('monitorDetails.usage') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="mount in monitor.snapshot.mounts" :key="mount.path">
                    <td class="mono">{{ mount.path }}</td>
                    <td class="mono">{{ formatKib(Math.max(0, mount.totalKib - mount.availableKib)) }} / {{ formatKib(mount.totalKib) }}</td>
                    <td class="mono">{{ formatKib(mount.availableKib) }}</td>
                    <td class="mono">{{ usagePercent(mount.totalKib, Math.max(0, mount.totalKib - mount.availableKib)) !== null ? `${usagePercent(mount.totalKib, Math.max(0, mount.totalKib - mount.availableKib))}%` : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="task-empty">{{ t('monitorDetails.mountEmpty') }}</p>
          </section>
        </template>
      </div>

      <div v-else-if="activeView === 'processes'" class="monitor-details-body">
        <section class="monitor-details-primary" :aria-label="t('monitorDetails.processes')">
          <div v-if="processes.error" class="inline-notice error" role="alert">{{ t(processes.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="processes.loading && !processes.snapshot" class="task-empty">{{ t('inspector.processLoading') }}</div>
          <div v-else-if="processes.snapshot?.state === 'unsupported'" class="task-empty">{{ t('inspector.processUnsupported') }}</div>
          <div v-else-if="!processes.snapshot?.processes.length" class="task-empty">{{ t('inspector.processEmpty') }}</div>
          <template v-else>
            <p v-if="processes.snapshot.truncated" class="monitor-details-notice">{{ t('inspector.processTruncated') }}</p>
            <div class="monitor-table-scroll">
              <table class="monitor-details-table">
                <thead><tr><th>PID</th><th>{{ t('monitorDetails.user') }}</th><th>{{ t('monitorDetails.name') }}</th><th>CPU</th><th>{{ t('monitorDetails.memory') }}</th><th>{{ t('monitorDetails.state') }}</th></tr></thead>
                <tbody>
                  <tr
                    v-for="entry in processes.snapshot.processes"
                    :key="entry.pid"
                    tabindex="0"
                    :class="{ selected: selectedPid === entry.pid }"
                    :aria-selected="selectedPid === entry.pid"
                    @click="selectedPid = entry.pid"
                    @contextmenu.prevent="openProcessMenu($event, entry)"
                    @keydown.enter.prevent="selectedPid = entry.pid"
                    @keydown.space.prevent="selectedPid = entry.pid"
                  >
                    <td class="mono">{{ entry.pid }}</td><td>{{ entry.user ?? '—' }}</td><td class="mono truncate-cell" :title="entry.name">{{ entry.name }}</td><td class="mono">{{ formatCpu(entry) }}</td><td class="mono">{{ formatBytes(entry.memoryBytes) }}</td><td>{{ entry.state ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>
        <aside class="monitor-record-detail" :aria-label="t('monitorDetails.processDetail')">
          <template v-if="selectedProcess">
            <header><strong>{{ t('monitorDetails.processDetail') }}</strong><button type="button" class="icon-button danger-button" :disabled="!selectedProcess.canTerminate || processes.loading || processes.terminatingPid !== null" :aria-label="t('inspector.terminateProcessTarget', { name: selectedProcess.name, pid: selectedProcess.pid })" @click="sendProcessSignal(selectedProcess, 'SIGTERM')"><CircleStop :size="13" /></button></header>
            <dl>
              <div><dt>{{ t('monitorDetails.name') }}</dt><dd class="mono">{{ selectedProcess.name }}</dd></div>
              <div><dt>PID</dt><dd class="mono">{{ selectedProcess.pid }}</dd></div>
              <div><dt>PPID</dt><dd class="mono">{{ selectedProcess.parentPid ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.user') }}</dt><dd>{{ selectedProcess.user ?? '—' }}</dd></div>
              <div><dt>CPU</dt><dd class="mono">{{ formatCpu(selectedProcess) }}</dd></div>
              <div><dt>{{ t('monitorDetails.memory') }}</dt><dd class="mono">{{ formatBytes(selectedProcess.memoryBytes) }}</dd></div>
              <div><dt>{{ t('monitorDetails.state') }}</dt><dd>{{ selectedProcess.state ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.started') }}</dt><dd>{{ formatDate(selectedProcess.startedAtMs) }}</dd></div>
            </dl>
            <p class="monitor-details-security-note">{{ t('monitorDetails.processSecurityNote') }}</p>
          </template>
          <p v-else class="task-empty">{{ t('monitorDetails.selectProcess') }}</p>
        </aside>
      </div>

      <div v-else-if="activeView === 'network'" class="monitor-details-body">
        <section class="monitor-details-primary" :aria-label="t('monitorDetails.network')">
          <div class="monitor-interface-toolbar">
            <label>{{ t('monitorDetails.interface') }}
              <select v-model="selectedInterfaceName" :disabled="network.loading || interfaces.length === 0">
                <option :value="ALL_NETWORK_INTERFACES">{{ t('monitorDetails.allInterfaces') }}</option>
                <option v-for="entry in interfaces" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ interfaceState(entry) }}</option>
              </select>
            </label>
            <span class="mono">{{ t('monitorDetails.visibleRecords', { count: filteredEndpoints.length }) }}</span>
          </div>
          <div v-if="network.error" class="inline-notice error" role="alert">{{ t(network.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="network.loading && !network.snapshot" class="task-empty">{{ t('monitorDetails.networkLoading') }}</div>
          <div v-else-if="network.snapshot?.state === 'unsupported'" class="task-empty">{{ t('monitorDetails.networkUnsupported') }}</div>
          <template v-else>
            <div v-if="selectedInterface" class="interface-summary">
              <span><strong>{{ t('monitorDetails.state') }}</strong>{{ interfaceState(selectedInterface) }}</span>
              <span><strong>{{ t('monitorDetails.addresses') }}</strong><span class="mono">{{ selectedInterface.addresses.join(', ') || '—' }}</span></span>
              <span><strong>MTU</strong><span class="mono">{{ selectedInterface.mtu ?? '—' }}</span></span>
              <span><strong>{{ t('monitorDetails.received') }}</strong><span class="mono">{{ formatBytes(selectedInterface.receivedBytes) }}</span></span>
              <span><strong>{{ t('monitorDetails.transmitted') }}</strong><span class="mono">{{ formatBytes(selectedInterface.transmittedBytes) }}</span></span>
            </div>
            <div v-else class="interface-summary">
              <span>{{ t('monitorDetails.allInterfacesHelp', { interfaces: interfaces.length, endpoints: network.snapshot?.endpoints.length ?? 0 }) }}</span>
            </div>
            <p v-if="network.snapshot?.endpointsTruncated" class="monitor-details-notice">{{ t('monitorDetails.endpointsTruncated') }}</p>
            <div v-if="filteredEndpoints.length" class="monitor-table-scroll">
              <table class="monitor-details-table">
                <thead><tr><th>{{ t('monitorDetails.protocol') }}</th><th>{{ t('monitorDetails.localEndpoint') }}</th><th>{{ t('monitorDetails.remoteEndpoint') }}</th><th>{{ t('monitorDetails.state') }}</th><th>PID</th><th>{{ t('monitorDetails.process') }}</th></tr></thead>
                <tbody>
                  <tr v-for="(entry, index) in filteredEndpoints" :key="`${entry.protocol}-${entry.localAddress}-${entry.localPort}-${entry.remoteAddress}-${entry.remotePort}-${index}`" tabindex="0" :class="{ selected: selectedEndpointIndex === index }" :aria-selected="selectedEndpointIndex === index" @click="selectedEndpointIndex = index" @keydown.enter.prevent="selectedEndpointIndex = index" @keydown.space.prevent="selectedEndpointIndex = index">
                    <td class="mono">{{ entry.protocol.toUpperCase() }}</td><td class="mono">{{ endpointLabel(entry.localAddress, entry.localPort) }}</td><td class="mono">{{ endpointLabel(entry.remoteAddress, entry.remotePort) }}</td><td>{{ entry.state ?? '—' }}</td><td class="mono">{{ entry.pid ?? '—' }}</td><td class="truncate-cell" :title="entry.processName ?? ''">{{ entry.processName ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="task-empty">{{ t('monitorDetails.endpointEmpty') }}</div>
          </template>
        </section>
        <aside class="monitor-record-detail" :aria-label="t('monitorDetails.networkDetail')">
          <template v-if="selectedEndpoint">
            <header><strong>{{ t('monitorDetails.networkDetail') }}</strong></header>
            <dl>
              <div><dt>{{ t('monitorDetails.protocol') }}</dt><dd class="mono">{{ selectedEndpoint.protocol.toUpperCase() }}</dd></div>
              <div><dt>{{ t('monitorDetails.localEndpoint') }}</dt><dd class="mono">{{ endpointLabel(selectedEndpoint.localAddress, selectedEndpoint.localPort) }}</dd></div>
              <div><dt>{{ t('monitorDetails.remoteEndpoint') }}</dt><dd class="mono">{{ endpointLabel(selectedEndpoint.remoteAddress, selectedEndpoint.remotePort) }}</dd></div>
              <div><dt>{{ t('monitorDetails.state') }}</dt><dd>{{ selectedEndpoint.state ?? '—' }}</dd></div>
              <div><dt>PID</dt><dd class="mono">{{ selectedEndpoint.pid ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.process') }}</dt><dd>{{ selectedEndpoint.processName ?? '—' }}</dd></div>
            </dl>
          </template>
          <p v-else class="task-empty">{{ t('monitorDetails.selectEndpoint') }}</p>
        </aside>
      </div>

      <div v-else class="monitor-routes-view">
        <div v-if="network.error" class="inline-notice error" role="alert">{{ t(network.error.messageKey as Parameters<typeof t>[0]) }}</div>
        <div v-else-if="network.loading && !network.snapshot" class="task-empty">{{ t('monitorDetails.routesLoading') }}</div>
        <div v-else-if="network.snapshot?.state === 'unsupported'" class="task-empty">{{ t('monitorDetails.networkUnsupported') }}</div>
        <template v-else>
          <p class="monitor-details-security-note">{{ t('monitorDetails.routesHelp') }}</p>
          <p v-if="network.snapshot?.routesTruncated" class="monitor-details-notice">{{ t('monitorDetails.routesTruncated') }}</p>
          <div v-if="network.snapshot?.routes.length" class="monitor-table-scroll">
            <table class="monitor-details-table route-table">
              <thead><tr><th>{{ t('monitorDetails.destination') }}</th><th>{{ t('monitorDetails.gateway') }}</th><th>{{ t('monitorDetails.interface') }}</th><th>{{ t('monitorDetails.metric') }}</th><th>{{ t('monitorDetails.protocol') }}</th></tr></thead>
              <tbody><tr v-for="(entry, index) in network.snapshot.routes" :key="`${entry.destination}-${entry.interfaceName}-${index}`"><td class="mono">{{ entry.destination }}</td><td class="mono">{{ entry.gateway ?? '—' }}</td><td>{{ entry.interfaceName ?? '—' }}</td><td class="mono">{{ entry.metric ?? '—' }}</td><td>{{ entry.protocol ?? '—' }}</td></tr></tbody>
            </table>
          </div>
          <div v-else class="task-empty">{{ t('monitorDetails.routesEmpty') }}</div>
        </template>
      </div>
    </section>

    <div
      v-if="processMenu"
      ref="processMenuEl"
      class="terminal-context-menu process-context-menu"
      role="menu"
      :aria-label="t('monitorDetails.processContextLabel')"
      :style="{ left: `${processMenu.x}px`, top: `${processMenu.y}px` }"
      @pointerdown.stop
    >
      <button
        type="button"
        role="menuitem"
        class="danger-menu-item"
        :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
        @click="sendProcessSignal(processMenu.entry, 'SIGTERM')"
      >
        <CircleStop :size="13" />{{ t('monitorDetails.signalTerminate') }}
      </button>
      <button
        type="button"
        role="menuitem"
        class="danger-menu-item"
        :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
        @click="sendProcessSignal(processMenu.entry, 'SIGKILL')"
      >
        <Skull :size="13" />{{ t('monitorDetails.signalForceKill') }}
      </button>
      <template v-if="isPosixProcesses">
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGHUP')"
        >
          <RotateCw :size="13" />{{ t('monitorDetails.signalReload') }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGSTOP')"
        >
          <PauseCircle :size="13" />{{ t('monitorDetails.signalPause') }}
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGCONT')"
        >
          <PlayCircle :size="13" />{{ t('monitorDetails.signalResume') }}
        </button>
      </template>
      <button type="button" role="menuitem" @click="copyProcessField(String(processMenu.entry.pid))">
        <Copy :size="13" />{{ t('monitorDetails.copyPid') }}
      </button>
      <button type="button" role="menuitem" @click="copyProcessField(processMenu.entry.name)">
        <Copy :size="13" />{{ t('monitorDetails.copyProcessName') }}
      </button>
    </div>
  </div>
</template>
