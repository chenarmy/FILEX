<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ArrowDown,
  ArrowDownWideNarrow,
  CircleStop,
  Copy,
  PauseCircle,
  Play,
  PlayCircle,
  RefreshCw,
  RotateCw,
  Search,
  Skull,
  X,
} from 'lucide-vue-next';
import { currentLocale, t } from '@/i18n';
import { runRouteTrace } from '@/api/domain/networkApi';
import {
  ALL_NETWORK_INTERFACES,
  ALL_ROUTE_TABLES,
  DEFAULT_PROCESS_SORT,
  aggregateNetworkServices,
  filterNetworkEndpoints,
  filterNetworkServices,
  filterProcesses,
  filterRoutes,
  networkEndpointsForInterface,
  routeTableNames,
  sortProcesses,
  summarizeEndpointStates,
  type NetworkStateFilter,
} from '@/domain/monitorDetails';
import { useMonitorPolling } from '@/composables/useMonitorPolling';
import { useMonitorStore } from '@/stores/monitor';
import { useNetworkStore } from '@/stores/network';
import { useProcessesStore } from '@/stores/processes';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import Sparkline from '@/components/ui/Sparkline.vue';
import type {
  AppError,
  MonitorDetailsView,
  NetworkInterface,
  ProcessEntry,
  ProcessSignal,
  ProcessSortBy,
  RouteTraceResult,
} from '@/types/contracts';

type NetworkSubView = 'services' | 'connections' | 'interfaces';
type RoutesSubView = 'table' | 'trace';

const props = defineProps<{ initialView: MonitorDetailsView }>();
const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const monitor = useMonitorStore();
const processes = useProcessesStore();
const network = useNetworkStore();
const ui = useUiStore();

const activeView = ref<MonitorDetailsView>(props.initialView);
const processSortBy = ref<ProcessSortBy>(DEFAULT_PROCESS_SORT);
const processSearch = ref('');
const selectedPid = ref<number | null>(null);

const networkSubView = ref<NetworkSubView>('services');
const selectedInterfaceName = ref(ALL_NETWORK_INTERFACES);
const networkStateFilter = ref<NetworkStateFilter>('all');
const networkSearch = ref('');
const selectedServiceKey = ref<string | null>(null);
const selectedEndpointIndex = ref<number | null>(null);

const routesSubView = ref<RoutesSubView>('table');
const selectedRouteTable = ref(ALL_ROUTE_TABLES);
const routeSearch = ref('');
const routeTraceTarget = ref(sessions.activeSession?.host ?? '');
const routeTraceIncludeWhois = ref(true);
const routeTraceLoading = ref(false);
const routeTraceError = ref<AppError | null>(null);
const routeTraceResult = ref<RouteTraceResult | null>(null);

const processMenu = ref<{ x: number; y: number; entry: ProcessEntry } | null>(null);
const processMenuEl = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const isPosixProcesses = computed(() => processes.snapshot?.platform === 'posix');

const sortedProcesses = computed(() => sortProcesses(
  processes.snapshot?.processes ?? [],
  processSortBy.value,
));
const visibleProcesses = computed(() => filterProcesses(sortedProcesses.value, processSearch.value));
const maxProcessMemoryBytes = computed(() => {
  const hostTotalBytes = monitor.snapshot?.memoryTotalKib ? monitor.snapshot.memoryTotalKib * 1024 : 0;
  let maxObserved = 0;
  for (const entry of sortedProcesses.value) {
    if (entry.memoryBytes && entry.memoryBytes > maxObserved) maxObserved = entry.memoryBytes;
  }
  return hostTotalBytes > 0 ? hostTotalBytes : maxObserved;
});
const selectedProcess = computed(() => (
  visibleProcesses.value.find((entry) => entry.pid === selectedPid.value)
  ?? sortedProcesses.value.find((entry) => entry.pid === selectedPid.value)
  ?? null
));

const interfaces = computed(() => network.snapshot?.interfaces ?? []);
const selectedInterface = computed(() => interfaces.value.find((entry) => entry.name === selectedInterfaceName.value) ?? null);
const interfaceScopedEndpoints = computed(() => networkEndpointsForInterface(
  network.snapshot?.endpoints ?? [],
  selectedInterface.value,
));
const endpointStateCounts = computed(() => summarizeEndpointStates(interfaceScopedEndpoints.value));
const filteredEndpoints = computed(() => filterNetworkEndpoints(
  network.snapshot?.endpoints ?? [],
  selectedInterface.value,
  networkStateFilter.value,
  networkSearch.value,
));
const selectedEndpoint = computed(() => selectedEndpointIndex.value === null
  ? null
  : filteredEndpoints.value[selectedEndpointIndex.value] ?? null);

const allNetworkServices = computed(() => aggregateNetworkServices(interfaceScopedEndpoints.value));
const visibleServices = computed(() => filterNetworkServices(allNetworkServices.value, networkSearch.value));
const selectedService = computed(() => (
  visibleServices.value.find((entry) => entry.key === selectedServiceKey.value) ?? null
));

const availableRouteTables = computed(() => routeTableNames(network.snapshot?.routes ?? []));
const visibleRoutes = computed(() => filterRoutes(
  network.snapshot?.routes ?? [],
  selectedRouteTable.value,
  routeSearch.value,
));

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

watch(availableRouteTables, (tables) => {
  if (selectedRouteTable.value !== ALL_ROUTE_TABLES && !tables.includes(selectedRouteTable.value)) {
    selectedRouteTable.value = ALL_ROUTE_TABLES;
  }
}, { immediate: true });

watch(visibleServices, (services) => {
  if (selectedServiceKey.value && services.some((entry) => entry.key === selectedServiceKey.value)) {
    return;
  }
  selectedServiceKey.value = services[0]?.key ?? null;
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
  () => sessions.activeSession?.host,
  (host) => {
    if (host && !routeTraceTarget.value.trim()) {
      routeTraceTarget.value = host;
    }
  },
  { immediate: true },
);

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

function syncSelectedProcess(): void {
  if (selectedPid.value !== null && visibleProcesses.value.some((entry) => entry.pid === selectedPid.value)) {
    return;
  }
  selectedPid.value = visibleProcesses.value[0]?.pid ?? sortedProcesses.value[0]?.pid ?? null;
}

async function collectProcessesForCurrentSort(sessionId: string): Promise<void> {
  await processes.collect(sessionId, processSortBy.value);
  syncSelectedProcess();
}

function setProcessSort(nextSort: ProcessSortBy): void {
  if (processSortBy.value === nextSort) return;
  processSortBy.value = nextSort;
  closeProcessMenu();
  const sessionId = sessions.activeSessionId;
  if (sessionId && connected.value && processes.snapshot?.truncated) {
    void collectProcessesForCurrentSort(sessionId);
  }
}

async function loadView(view: MonitorDetailsView): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  if (view === 'overview') {
    await monitor.collect(sessionId);
  } else if (view === 'processes') {
    await collectProcessesForCurrentSort(sessionId);
  } else {
    await network.collect(sessionId);
  }
}

async function refresh(): Promise<void> {
  if (activeView.value === 'routes' && routesSubView.value === 'trace') {
    await startRouteTrace();
    return;
  }
  await loadView(activeView.value);
}

async function startRouteTrace(): Promise<void> {
  const target = routeTraceTarget.value.trim();
  if (!target || routeTraceLoading.value) return;
  routeTraceLoading.value = true;
  routeTraceError.value = null;
  try {
    const result = await runRouteTrace(target, routeTraceIncludeWhois.value, 24);
    if (result.ok) {
      routeTraceResult.value = result.data;
    } else {
      routeTraceError.value = result.error;
    }
  } finally {
    routeTraceLoading.value = false;
  }
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

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(currentLocale.value).format(value);
}

function formatSpeed(speedMbps: number | null | undefined): string {
  if (!speedMbps || speedMbps <= 0) return '—';
  if (speedMbps >= 1000 && speedMbps % 1000 === 0) return `${speedMbps / 1000} Gbps`;
  return `${speedMbps} Mbps`;
}

function formatCpu(entry: ProcessEntry): string {
  if (entry.cpuPercent !== null) return `${entry.cpuPercent.toFixed(1)}%`;
  if (entry.cpuTimeSeconds !== null) return t('monitorDetails.cpuTimeValue', { seconds: entry.cpuTimeSeconds.toFixed(1) });
  return '—';
}

function formatCpuTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return t('monitorDetails.cpuTimeValue', { seconds: seconds.toFixed(1) });
}

function processMemoryRatio(bytes: number | null | undefined): number {
  if (!bytes || bytes <= 0 || maxProcessMemoryBytes.value <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((bytes / maxProcessMemoryBytes.value) * 100)));
}

function processCpuRatio(percent: number | null | undefined): number {
  if (!percent || percent <= 0 || !Number.isFinite(percent)) return 0;
  return Math.max(2, Math.min(100, Math.round(percent)));
}

function processCommandPreview(entry: ProcessEntry): string {
  const cmd = entry.commandLine?.trim();
  if (!cmd || cmd === entry.name || cmd === `[${entry.name}]`) return '';
  return cmd;
}

function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
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
  const menuWidth = 232;
  const extraCopyItems = (entry.executablePath ? 1 : 0) + (entry.workingDirectory ? 1 : 0) + (entry.commandLine ? 1 : 0);
  const menuHeight = (isPosixProcesses.value ? 268 : 160) + extraCopyItems * 30;
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
  processMenu.value = { x, y, entry };
  void nextTick(() => processMenuEl.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
}

function handleProcessMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeProcessMenu();
    return;
  }
  const items = Array.from(processMenuEl.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[(currentIndex + 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    items[(currentIndex - 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  }
}

async function copyText(value: string): Promise<void> {
  closeProcessMenu();
  try {
    await navigator.clipboard.writeText(value);
    const preview = value.length > 64 ? `${value.slice(0, 61)}…` : value;
    ui.notify(t('monitorDetails.copied', { value: preview }));
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
    'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]',
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

const networkStateOptions = computed(() => ([
  { id: 'all' as const, label: t('monitorDetails.stateAll'), count: endpointStateCounts.value.all },
  { id: 'listen' as const, label: t('monitorDetails.stateListen'), count: endpointStateCounts.value.listen },
  { id: 'established' as const, label: t('monitorDetails.stateEstablished'), count: endpointStateCounts.value.established },
  { id: 'time_wait' as const, label: t('monitorDetails.stateTimeWait'), count: endpointStateCounts.value.time_wait },
  { id: 'other' as const, label: t('monitorDetails.stateOther'), count: endpointStateCounts.value.other },
]));
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
          <button type="button" class="icon-button" :disabled="monitor.loading || processes.loading || network.loading || routeTraceLoading" :aria-label="t('monitorDetails.refresh')" :title="t('monitorDetails.refresh')" @click="refresh"><RefreshCw :size="13" /></button>
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
              <table class="monitor-details-table mount-table">
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

      <!-- PROCESSES TAB -->
      <div v-else-if="activeView === 'processes'" class="monitor-details-body">
        <section class="monitor-details-primary" :aria-label="t('monitorDetails.processes')">
          <div class="monitor-interface-toolbar monitor-process-toolbar">
            <div class="monitor-toolbar-left">
              <div class="monitor-sort-group">
                <span class="monitor-sort-label">{{ t('monitorDetails.sortLabel') }}</span>
                <div class="monitor-sort-switch" role="group" :aria-label="t('monitorDetails.sortLabel')">
                  <button
                    type="button"
                    :class="{ active: processSortBy === 'cpu' }"
                    :aria-pressed="processSortBy === 'cpu'"
                    :title="t('monitorDetails.sortByCpuHint')"
                    :disabled="processes.terminatingPid !== null"
                    @click="setProcessSort('cpu')"
                  >
                    <ArrowDownWideNarrow :size="12" aria-hidden="true" />
                    <span>{{ t('monitorDetails.sortByCpu') }}</span>
                  </button>
                  <button
                    type="button"
                    :class="{ active: processSortBy === 'memory' }"
                    :aria-pressed="processSortBy === 'memory'"
                    :title="t('monitorDetails.sortByMemoryHint')"
                    :disabled="processes.terminatingPid !== null"
                    @click="setProcessSort('memory')"
                  >
                    <ArrowDownWideNarrow :size="12" aria-hidden="true" />
                    <span>{{ t('monitorDetails.sortByMemory') }}</span>
                  </button>
                </div>
              </div>
              <div class="monitor-search-box">
                <Search :size="12" aria-hidden="true" />
                <input
                  v-model="processSearch"
                  type="search"
                  :placeholder="t('monitorDetails.processSearchPlaceholder')"
                  :aria-label="t('monitorDetails.processSearchPlaceholder')"
                >
              </div>
            </div>
            <span class="mono">{{ t('monitorDetails.visibleRecords', { count: visibleProcesses.length }) }}</span>
          </div>
          <div v-if="processes.error" class="inline-notice error" role="alert">{{ t(processes.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="processes.loading && !processes.snapshot" class="task-empty">{{ t('inspector.processLoading') }}</div>
          <div v-else-if="processes.snapshot?.state === 'unsupported'" class="task-empty">{{ t('inspector.processUnsupported') }}</div>
          <div v-else-if="!visibleProcesses.length" class="task-empty">{{ t('inspector.processEmpty') }}</div>
          <template v-else>
            <p v-if="processes.snapshot?.truncated" class="monitor-details-notice">{{ t('inspector.processTruncated') }}</p>
            <div class="monitor-table-scroll">
              <table class="monitor-details-table process-table">
                <thead>
                  <tr>
                    <th>PID</th>
                    <th>{{ t('monitorDetails.user') }}</th>
                    <th :aria-sort="processSortBy === 'memory' ? 'descending' : 'none'">
                      <button
                        type="button"
                        class="monitor-sort-header"
                        :class="{ active: processSortBy === 'memory' }"
                        :title="t('monitorDetails.sortByMemoryHint')"
                        :aria-label="t('monitorDetails.sortByMemoryHint')"
                        :disabled="processes.terminatingPid !== null"
                        @click="setProcessSort('memory')"
                      >
                        <span>{{ t('monitorDetails.memory') }}</span>
                        <ArrowDown :size="11" class="monitor-sort-icon" aria-hidden="true" />
                      </button>
                    </th>
                    <th :aria-sort="processSortBy === 'cpu' ? 'descending' : 'none'">
                      <button
                        type="button"
                        class="monitor-sort-header"
                        :class="{ active: processSortBy === 'cpu' }"
                        :title="t('monitorDetails.sortByCpuHint')"
                        :aria-label="t('monitorDetails.sortByCpuHint')"
                        :disabled="processes.terminatingPid !== null"
                        @click="setProcessSort('cpu')"
                      >
                        <span>CPU</span>
                        <ArrowDown :size="11" class="monitor-sort-icon" aria-hidden="true" />
                      </button>
                    </th>
                    <th>{{ t('monitorDetails.nameAndCommand') }}</th>
                    <th>{{ t('monitorDetails.executablePath') }}</th>
                    <th>{{ t('monitorDetails.state') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="entry in visibleProcesses"
                    :key="entry.pid"
                    tabindex="0"
                    :class="{ selected: selectedPid === entry.pid }"
                    :aria-selected="selectedPid === entry.pid"
                    @click="selectedPid = entry.pid"
                    @contextmenu.prevent="openProcessMenu($event, entry)"
                    @keydown.enter.prevent="selectedPid = entry.pid"
                    @keydown.space.prevent="selectedPid = entry.pid"
                  >
                    <td class="mono">{{ entry.pid }}</td>
                    <td :title="entry.user ?? ''">{{ entry.user ?? '—' }}</td>
                    <td class="mono monitor-usage-cell">
                      <span v-if="processMemoryRatio(entry.memoryBytes) > 0" class="monitor-inline-bar mem" :style="{ width: `${processMemoryRatio(entry.memoryBytes)}%` }" />
                      <span class="monitor-usage-value">{{ formatBytes(entry.memoryBytes) }}</span>
                    </td>
                    <td class="mono monitor-usage-cell">
                      <span v-if="processCpuRatio(entry.cpuPercent) > 0" class="monitor-inline-bar cpu" :style="{ width: `${processCpuRatio(entry.cpuPercent)}%` }" />
                      <span class="monitor-usage-value">{{ formatCpu(entry) }}</span>
                    </td>
                    <td class="mono truncate-cell" :title="entry.commandLine || entry.name">
                      <span class="process-name-main">{{ entry.name }}</span>
                      <span v-if="processCommandPreview(entry)" class="process-cmd-preview">{{ processCommandPreview(entry) }}</span>
                    </td>
                    <td class="mono truncate-cell process-path-cell" :title="entry.executablePath ?? ''">{{ entry.executablePath ?? '—' }}</td>
                    <td class="mono">{{ entry.state ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>
        <aside class="monitor-record-detail" :aria-label="t('monitorDetails.processDetail')">
          <template v-if="selectedProcess">
            <header>
              <strong>{{ t('monitorDetails.processDetail') }}</strong>
              <button
                type="button"
                class="icon-button danger-button"
                :disabled="!selectedProcess.canTerminate || processes.loading || processes.terminatingPid !== null"
                :aria-label="t('inspector.terminateProcessTarget', { name: selectedProcess.name, pid: selectedProcess.pid })"
                @click="sendProcessSignal(selectedProcess, 'SIGTERM')"
              >
                <CircleStop :size="13" />
              </button>
            </header>
            <dl>
              <div><dt>{{ t('monitorDetails.name') }}</dt><dd class="mono">{{ selectedProcess.name }}</dd></div>
              <div><dt>PID</dt><dd class="mono">{{ selectedProcess.pid }}</dd></div>
              <div><dt>PPID</dt><dd class="mono">{{ selectedProcess.parentPid ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.user') }}</dt><dd>{{ selectedProcess.user ?? '—' }}</dd></div>
              <div>
                <dt>{{ t('monitorDetails.executablePath') }}</dt>
                <dd class="mono detail-copy-row">
                  <span>{{ selectedProcess.executablePath ?? '—' }}</span>
                  <button v-if="selectedProcess.executablePath" type="button" class="icon-button detail-copy-btn" :title="t('monitorDetails.copyField')" :aria-label="t('monitorDetails.copyExecutablePath')" @click="copyText(selectedProcess.executablePath)"><Copy :size="11" /></button>
                </dd>
              </div>
              <div>
                <dt>{{ t('monitorDetails.workingDirectory') }}</dt>
                <dd class="mono detail-copy-row">
                  <span>{{ selectedProcess.workingDirectory ?? '—' }}</span>
                  <button v-if="selectedProcess.workingDirectory" type="button" class="icon-button detail-copy-btn" :title="t('monitorDetails.copyField')" :aria-label="t('monitorDetails.copyWorkingDirectory')" @click="copyText(selectedProcess.workingDirectory)"><Copy :size="11" /></button>
                </dd>
              </div>
              <div><dt>CPU</dt><dd class="mono">{{ formatCpu(selectedProcess) }}</dd></div>
              <div><dt>{{ t('monitorDetails.cpuTime') }}</dt><dd class="mono">{{ formatCpuTime(selectedProcess.cpuTimeSeconds) }}</dd></div>
              <div><dt>{{ t('monitorDetails.memory') }}</dt><dd class="mono">{{ formatBytes(selectedProcess.memoryBytes) }}</dd></div>
              <div><dt>{{ t('monitorDetails.virtualMemory') }}</dt><dd class="mono">{{ formatBytes(selectedProcess.virtualMemoryBytes) }}</dd></div>
              <div><dt>{{ t('monitorDetails.threads') }}</dt><dd class="mono">{{ selectedProcess.threads ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.state') }}</dt><dd class="mono">{{ selectedProcess.state ?? '—' }}</dd></div>
              <div><dt>{{ t('monitorDetails.started') }}</dt><dd>{{ formatDate(selectedProcess.startedAtMs) }}</dd></div>
            </dl>
            <div v-if="selectedProcess.commandLine" class="detail-code-section">
              <div class="detail-code-head">
                <span>{{ t('monitorDetails.commandLine') }}</span>
                <button type="button" class="icon-button detail-copy-btn" :title="t('monitorDetails.copyCommandLine')" :aria-label="t('monitorDetails.copyCommandLine')" @click="copyText(selectedProcess.commandLine)"><Copy :size="11" /></button>
              </div>
              <pre class="detail-code-pre mono">{{ selectedProcess.commandLine }}</pre>
            </div>
            <p class="monitor-details-security-note">{{ t('monitorDetails.processSecurityNote') }}</p>
          </template>
          <p v-else class="task-empty">{{ t('monitorDetails.selectProcess') }}</p>
        </aside>
      </div>

      <!-- NETWORK TAB -->
      <div v-else-if="activeView === 'network'" class="monitor-details-body" :class="{ 'single-column': networkSubView === 'interfaces' }">
        <section class="monitor-details-primary" :aria-label="t('monitorDetails.network')">
          <div class="monitor-interface-toolbar">
            <div class="monitor-toolbar-left">
              <div class="monitor-sort-switch" role="group" :aria-label="t('monitorDetails.network')">
                <button type="button" :class="{ active: networkSubView === 'services' }" :aria-pressed="networkSubView === 'services'" @click="networkSubView = 'services'">{{ t('monitorDetails.networkModeServices') }}</button>
                <button type="button" :class="{ active: networkSubView === 'connections' }" :aria-pressed="networkSubView === 'connections'" @click="networkSubView = 'connections'">{{ t('monitorDetails.networkModeConnections') }}</button>
                <button type="button" :class="{ active: networkSubView === 'interfaces' }" :aria-pressed="networkSubView === 'interfaces'" @click="networkSubView = 'interfaces'">{{ t('monitorDetails.networkModeInterfaces') }}</button>
              </div>
              <label v-if="networkSubView !== 'interfaces'">{{ t('monitorDetails.interface') }}
                <select v-model="selectedInterfaceName" :disabled="network.loading || interfaces.length === 0">
                  <option :value="ALL_NETWORK_INTERFACES">{{ t('monitorDetails.allInterfaces') }}</option>
                  <option v-for="entry in interfaces" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ interfaceState(entry) }}</option>
                </select>
              </label>
              <div v-if="networkSubView !== 'interfaces'" class="monitor-search-box">
                <Search :size="12" aria-hidden="true" />
                <input
                  v-model="networkSearch"
                  type="search"
                  :placeholder="t('monitorDetails.networkSearchPlaceholder')"
                  :aria-label="t('monitorDetails.networkSearchPlaceholder')"
                >
              </div>
            </div>
            <span class="mono">
              {{ t('monitorDetails.visibleRecords', {
                count: networkSubView === 'services'
                  ? visibleServices.length
                  : networkSubView === 'connections'
                    ? filteredEndpoints.length
                    : interfaces.length,
              }) }}
            </span>
          </div>

          <div v-if="network.error" class="inline-notice error" role="alert">{{ t(network.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="network.loading && !network.snapshot" class="task-empty">{{ t('monitorDetails.networkLoading') }}</div>
          <div v-else-if="network.snapshot?.state === 'unsupported'" class="task-empty">{{ t('monitorDetails.networkUnsupported') }}</div>

          <template v-else-if="networkSubView === 'interfaces'">
            <div v-if="interfaces.length" class="monitor-table-scroll">
              <table class="monitor-details-table interface-table">
                <thead>
                  <tr>
                    <th>{{ t('monitorDetails.interface') }}</th>
                    <th>{{ t('monitorDetails.state') }}</th>
                    <th>{{ t('monitorDetails.addresses') }}</th>
                    <th>{{ t('monitorDetails.macAddress') }}</th>
                    <th>MTU</th>
                    <th>{{ t('monitorDetails.linkSpeed') }}</th>
                    <th>{{ t('monitorDetails.rxTxBytes') }}</th>
                    <th>{{ t('monitorDetails.rxTxPackets') }}</th>
                    <th>{{ t('monitorDetails.rxTxErrors') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="iface in interfaces" :key="iface.name">
                    <td class="mono">{{ iface.name }}</td>
                    <td>{{ interfaceState(iface) }}</td>
                    <td class="mono truncate-cell" :title="iface.addresses.join(', ')">{{ iface.addresses.join(', ') || '—' }}</td>
                    <td class="mono">{{ iface.macAddress ?? '—' }}</td>
                    <td class="mono">{{ iface.mtu ?? '—' }}</td>
                    <td class="mono">{{ formatSpeed(iface.speedMbps) }}</td>
                    <td class="mono">↓ {{ formatBytes(iface.receivedBytes) }} / ↑ {{ formatBytes(iface.transmittedBytes) }}</td>
                    <td class="mono">{{ formatCount(iface.rxPackets) }} / {{ formatCount(iface.txPackets) }}</td>
                    <td class="mono">{{ formatCount(iface.rxErrors) }} / {{ formatCount(iface.txErrors) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="task-empty">{{ t('monitorDetails.interfacesEmpty') }}</div>
          </template>

          <template v-else>
            <div v-if="selectedInterface" class="interface-summary">
              <span><strong>{{ t('monitorDetails.state') }}</strong>{{ interfaceState(selectedInterface) }}</span>
              <span><strong>{{ t('monitorDetails.addresses') }}</strong><span class="mono">{{ selectedInterface.addresses.join(', ') || '—' }}</span></span>
              <span v-if="selectedInterface.macAddress"><strong>MAC</strong><span class="mono">{{ selectedInterface.macAddress }}</span></span>
              <span v-if="selectedInterface.speedMbps"><strong>{{ t('monitorDetails.linkSpeed') }}</strong><span class="mono">{{ formatSpeed(selectedInterface.speedMbps) }}</span></span>
              <span><strong>MTU</strong><span class="mono">{{ selectedInterface.mtu ?? '—' }}</span></span>
              <span><strong>{{ t('monitorDetails.received') }}</strong><span class="mono">{{ formatBytes(selectedInterface.receivedBytes) }}</span></span>
              <span><strong>{{ t('monitorDetails.transmitted') }}</strong><span class="mono">{{ formatBytes(selectedInterface.transmittedBytes) }}</span></span>
            </div>
            <div v-else class="interface-summary">
              <span>{{ t('monitorDetails.allInterfacesHelp', { interfaces: interfaces.length, endpoints: network.snapshot?.endpoints.length ?? 0 }) }}</span>
            </div>

            <div v-if="networkSubView === 'connections'" class="monitor-state-pills" role="group" :aria-label="t('monitorDetails.state')">
              <button
                v-for="pill in networkStateOptions"
                :key="pill.id"
                type="button"
                class="monitor-state-pill"
                :class="{ active: networkStateFilter === pill.id }"
                :aria-pressed="networkStateFilter === pill.id"
                @click="networkStateFilter = pill.id"
              >
                <span>{{ pill.label }}</span>
                <span class="mono">{{ pill.count }}</span>
              </button>
            </div>

            <p v-if="network.snapshot?.endpointsTruncated" class="monitor-details-notice">{{ t('monitorDetails.endpointsTruncated') }}</p>

            <!-- Listening services table -->
            <template v-if="networkSubView === 'services'">
              <div v-if="visibleServices.length" class="monitor-table-scroll">
                <table class="monitor-details-table service-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>{{ t('monitorDetails.process') }}</th>
                      <th>{{ t('monitorDetails.protocol') }}</th>
                      <th>{{ t('monitorDetails.listenAddress') }}</th>
                      <th>{{ t('monitorDetails.port') }}</th>
                      <th>{{ t('monitorDetails.remoteIpCount') }}</th>
                      <th>{{ t('monitorDetails.connectionCount') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="service in visibleServices"
                      :key="service.key"
                      tabindex="0"
                      :class="{ selected: selectedServiceKey === service.key }"
                      :aria-selected="selectedServiceKey === service.key"
                      @click="selectedServiceKey = service.key"
                      @keydown.enter.prevent="selectedServiceKey = service.key"
                      @keydown.space.prevent="selectedServiceKey = service.key"
                    >
                      <td class="mono">{{ service.pid ?? '—' }}</td>
                      <td class="truncate-cell" :title="service.processName ?? ''">{{ service.processName ?? '—' }}</td>
                      <td class="mono">{{ service.protocol.toUpperCase() }}</td>
                      <td class="mono">{{ service.isListener ? (service.localAddress ?? '—') : t('monitorDetails.outboundService') }}</td>
                      <td class="mono">{{ service.localPort ?? '—' }}</td>
                      <td class="mono">{{ service.uniqueRemoteIps }}</td>
                      <td class="mono" :class="{ 'highlight-count': service.connectionCount > 0 }">{{ service.connectionCount }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="task-empty">{{ t('monitorDetails.serviceEmpty') }}</div>
            </template>

            <!-- All connections table -->
            <template v-else>
              <div v-if="filteredEndpoints.length" class="monitor-table-scroll">
                <table class="monitor-details-table endpoint-table">
                  <thead>
                    <tr>
                      <th>{{ t('monitorDetails.protocol') }}</th>
                      <th>{{ t('monitorDetails.localEndpoint') }}</th>
                      <th>{{ t('monitorDetails.remoteEndpoint') }}</th>
                      <th>{{ t('monitorDetails.state') }}</th>
                      <th>{{ t('monitorDetails.recvQ') }}</th>
                      <th>{{ t('monitorDetails.sendQ') }}</th>
                      <th>PID</th>
                      <th>{{ t('monitorDetails.process') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(entry, index) in filteredEndpoints"
                      :key="`${entry.protocol}-${entry.localAddress}-${entry.localPort}-${entry.remoteAddress}-${entry.remotePort}-${index}`"
                      tabindex="0"
                      :class="{ selected: selectedEndpointIndex === index }"
                      :aria-selected="selectedEndpointIndex === index"
                      @click="selectedEndpointIndex = index"
                      @keydown.enter.prevent="selectedEndpointIndex = index"
                      @keydown.space.prevent="selectedEndpointIndex = index"
                    >
                      <td class="mono">{{ entry.protocol.toUpperCase() }}</td>
                      <td class="mono truncate-cell" :title="endpointLabel(entry.localAddress, entry.localPort)">{{ endpointLabel(entry.localAddress, entry.localPort) }}</td>
                      <td class="mono truncate-cell" :title="endpointLabel(entry.remoteAddress, entry.remotePort)">{{ endpointLabel(entry.remoteAddress, entry.remotePort) }}</td>
                      <td class="mono">{{ entry.state ?? '—' }}</td>
                      <td class="mono">{{ entry.recvQ ?? '—' }}</td>
                      <td class="mono">{{ entry.sendQ ?? '—' }}</td>
                      <td class="mono">{{ entry.pid ?? '—' }}</td>
                      <td class="truncate-cell" :title="entry.processName ?? ''">{{ entry.processName ?? '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="task-empty">{{ t('monitorDetails.endpointEmpty') }}</div>
            </template>
          </template>
        </section>

        <!-- Network right detail panel -->
        <aside v-if="networkSubView !== 'interfaces'" class="monitor-record-detail" :aria-label="t('monitorDetails.networkDetail')">
          <template v-if="networkSubView === 'services'">
            <template v-if="selectedService">
              <header><strong>{{ selectedService.processName ?? t('monitorDetails.networkDetail') }}</strong></header>
              <dl>
                <div><dt>PID</dt><dd class="mono">{{ selectedService.pid ?? '—' }}</dd></div>
                <div><dt>{{ t('monitorDetails.protocol') }}</dt><dd class="mono">{{ selectedService.protocol.toUpperCase() }}</dd></div>
                <div><dt>{{ t('monitorDetails.listenAddress') }}</dt><dd class="mono">{{ selectedService.isListener ? endpointLabel(selectedService.localAddress, selectedService.localPort) : t('monitorDetails.outboundService') }}</dd></div>
                <div><dt>{{ t('monitorDetails.remoteIpCount') }}</dt><dd class="mono">{{ selectedService.uniqueRemoteIps }}</dd></div>
                <div><dt>{{ t('monitorDetails.connectionCount') }}</dt><dd class="mono">{{ selectedService.connectionCount }}</dd></div>
              </dl>
              <div class="service-peers-section">
                <h4>{{ t('monitorDetails.servicePeersTitle', { count: selectedService.connections.length }) }}</h4>
                <div v-if="selectedService.connections.length" class="service-peers-list">
                  <div
                    v-for="(peer, idx) in selectedService.connections"
                    :key="`${peer.remoteAddress}-${peer.remotePort}-${idx}`"
                    class="service-peer-item"
                  >
                    <div class="service-peer-row">
                      <span class="mono service-peer-addr">{{ endpointLabel(peer.remoteAddress, peer.remotePort) }}</span>
                      <span class="mono service-peer-state">{{ peer.state ?? '—' }}</span>
                    </div>
                    <div class="service-peer-meta mono">
                      <span>{{ endpointLabel(peer.localAddress, peer.localPort) }}</span>
                      <span v-if="peer.recvQ !== null && peer.recvQ !== undefined">Q {{ peer.recvQ }}/{{ peer.sendQ ?? 0 }}</span>
                    </div>
                  </div>
                </div>
                <p v-else class="monitor-details-security-note">{{ t('monitorDetails.servicePeersEmpty') }}</p>
              </div>
            </template>
            <p v-else class="task-empty">{{ t('monitorDetails.selectService') }}</p>
          </template>

          <template v-else>
            <template v-if="selectedEndpoint">
              <header><strong>{{ t('monitorDetails.networkDetail') }}</strong></header>
              <dl>
                <div><dt>{{ t('monitorDetails.protocol') }}</dt><dd class="mono">{{ selectedEndpoint.protocol.toUpperCase() }}</dd></div>
                <div>
                  <dt>{{ t('monitorDetails.localEndpoint') }}</dt>
                  <dd class="mono detail-copy-row">
                    <span>{{ endpointLabel(selectedEndpoint.localAddress, selectedEndpoint.localPort) }}</span>
                    <button type="button" class="icon-button detail-copy-btn" :title="t('monitorDetails.copyField')" @click="copyText(endpointLabel(selectedEndpoint.localAddress, selectedEndpoint.localPort))"><Copy :size="11" /></button>
                  </dd>
                </div>
                <div>
                  <dt>{{ t('monitorDetails.remoteEndpoint') }}</dt>
                  <dd class="mono detail-copy-row">
                    <span>{{ endpointLabel(selectedEndpoint.remoteAddress, selectedEndpoint.remotePort) }}</span>
                    <button v-if="selectedEndpoint.remoteAddress" type="button" class="icon-button detail-copy-btn" :title="t('monitorDetails.copyField')" @click="copyText(endpointLabel(selectedEndpoint.remoteAddress, selectedEndpoint.remotePort))"><Copy :size="11" /></button>
                  </dd>
                </div>
                <div><dt>{{ t('monitorDetails.state') }}</dt><dd class="mono">{{ selectedEndpoint.state ?? '—' }}</dd></div>
                <div><dt>{{ t('monitorDetails.recvQ') }}</dt><dd class="mono">{{ selectedEndpoint.recvQ ?? '—' }}</dd></div>
                <div><dt>{{ t('monitorDetails.sendQ') }}</dt><dd class="mono">{{ selectedEndpoint.sendQ ?? '—' }}</dd></div>
                <div><dt>PID</dt><dd class="mono">{{ selectedEndpoint.pid ?? '—' }}</dd></div>
                <div><dt>{{ t('monitorDetails.process') }}</dt><dd>{{ selectedEndpoint.processName ?? '—' }}</dd></div>
              </dl>
            </template>
            <p v-else class="task-empty">{{ t('monitorDetails.selectEndpoint') }}</p>
          </template>
        </aside>
      </div>

      <!-- ROUTES TAB -->
      <div v-else class="monitor-routes-shell">
        <div class="monitor-interface-toolbar">
          <div class="monitor-toolbar-left">
            <div class="monitor-sort-switch" role="group" :aria-label="t('monitorDetails.routes')">
              <button type="button" :class="{ active: routesSubView === 'table' }" :aria-pressed="routesSubView === 'table'" @click="routesSubView = 'table'">{{ t('monitorDetails.routesModeTable') }}</button>
              <button type="button" :class="{ active: routesSubView === 'trace' }" :aria-pressed="routesSubView === 'trace'" @click="routesSubView = 'trace'">{{ t('monitorDetails.routesModeTrace') }}</button>
            </div>
            <template v-if="routesSubView === 'table'">
              <label v-if="availableRouteTables.length > 0">{{ t('monitorDetails.routeTableFilter') }}
                <select v-model="selectedRouteTable" :disabled="network.loading">
                  <option :value="ALL_ROUTE_TABLES">{{ t('monitorDetails.allRouteTables') }}</option>
                  <option v-for="tableName in availableRouteTables" :key="tableName" :value="tableName">{{ tableName }}</option>
                </select>
              </label>
              <div class="monitor-search-box">
                <Search :size="12" aria-hidden="true" />
                <input
                  v-model="routeSearch"
                  type="search"
                  :placeholder="t('monitorDetails.routeSearchPlaceholder')"
                  :aria-label="t('monitorDetails.routeSearchPlaceholder')"
                >
              </div>
            </template>
            <form v-else class="route-trace-form" @submit.prevent="startRouteTrace">
              <input
                v-model="routeTraceTarget"
                type="text"
                class="route-trace-input mono"
                :placeholder="t('monitorDetails.routeTraceTargetPlaceholder')"
                :aria-label="t('monitorDetails.routeTraceTarget')"
                :disabled="routeTraceLoading"
              >
              <label class="route-trace-checkbox">
                <input v-model="routeTraceIncludeWhois" type="checkbox" :disabled="routeTraceLoading">
                <span>{{ t('monitorDetails.routeTraceIncludeWhois') }}</span>
              </label>
              <button type="submit" class="primary-button compact-button" :disabled="routeTraceLoading || !routeTraceTarget.trim()">
                <Play :size="12" aria-hidden="true" />
                <span>{{ routeTraceLoading ? t('monitorDetails.routeTraceRunning') : t('monitorDetails.routeTraceStart') }}</span>
              </button>
            </form>
          </div>
          <span v-if="routesSubView === 'table'" class="mono">{{ t('monitorDetails.visibleRecords', { count: visibleRoutes.length }) }}</span>
          <span v-else-if="routeTraceResult?.resolvedIp" class="mono">{{ t('monitorDetails.routeTraceResolved', { ip: routeTraceResult.resolvedIp }) }}</span>
        </div>

        <!-- OS Route Table sub-view -->
        <div v-if="routesSubView === 'table'" class="monitor-routes-view">
          <div v-if="network.error" class="inline-notice error" role="alert">{{ t(network.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="network.loading && !network.snapshot" class="task-empty">{{ t('monitorDetails.routesLoading') }}</div>
          <div v-else-if="network.snapshot?.state === 'unsupported'" class="task-empty">{{ t('monitorDetails.networkUnsupported') }}</div>
          <template v-else>
            <p v-if="network.snapshot?.routesTruncated" class="monitor-details-notice">{{ t('monitorDetails.routesTruncated') }}</p>
            <div v-if="visibleRoutes.length" class="monitor-table-scroll">
              <table class="monitor-details-table route-table">
                <thead>
                  <tr>
                    <th>{{ t('monitorDetails.routeTableFilter') }}</th>
                    <th>{{ t('monitorDetails.routeType') }}</th>
                    <th>{{ t('monitorDetails.destination') }}</th>
                    <th>{{ t('monitorDetails.gateway') }}</th>
                    <th>{{ t('monitorDetails.sourceAddress') }}</th>
                    <th>{{ t('monitorDetails.interface') }}</th>
                    <th>{{ t('monitorDetails.routeScope') }}</th>
                    <th>{{ t('monitorDetails.metric') }}</th>
                    <th>{{ t('monitorDetails.protocol') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(entry, index) in visibleRoutes" :key="`${entry.table}-${entry.destination}-${entry.interfaceName}-${index}`">
                    <td class="mono">{{ entry.table ?? 'main' }}</td>
                    <td class="mono">{{ entry.routeType ?? 'unicast' }}</td>
                    <td class="mono truncate-cell" :title="entry.destination">{{ entry.destination }}</td>
                    <td class="mono truncate-cell" :title="entry.gateway ?? ''">{{ entry.gateway ?? '—' }}</td>
                    <td class="mono truncate-cell" :title="entry.sourceAddress ?? ''">{{ entry.sourceAddress ?? '—' }}</td>
                    <td class="mono">{{ entry.interfaceName ?? '—' }}</td>
                    <td>{{ entry.scope ?? '—' }}</td>
                    <td class="mono">{{ entry.metric ?? '—' }}</td>
                    <td>{{ entry.protocol ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="task-empty">{{ t('monitorDetails.routesEmpty') }}</div>
          </template>
        </div>

        <!-- On-demand Route Trace + Whois sub-view -->
        <div v-else class="monitor-details-body">
          <section class="monitor-details-primary" :aria-label="t('monitorDetails.routesModeTrace')">
            <div v-if="routeTraceError" class="inline-notice error" role="alert">{{ t(routeTraceError.messageKey as Parameters<typeof t>[0]) }}</div>
            <div v-else-if="routeTraceLoading && !routeTraceResult" class="task-empty">{{ t('monitorDetails.routeTraceRunning') }}</div>
            <div v-else-if="!routeTraceResult" class="task-empty">{{ t('monitorDetails.routeTraceIdle') }}</div>
            <template v-else>
              <p v-if="routeTraceResult.truncated" class="monitor-details-notice">{{ t('monitorDetails.routeTraceTruncated') }}</p>
              <div class="monitor-table-scroll">
                <table class="monitor-details-table trace-table">
                  <thead>
                    <tr>
                      <th>{{ t('monitorDetails.routeTraceHop') }}</th>
                      <th>{{ t('monitorDetails.routeTraceAddress') }}</th>
                      <th>{{ t('monitorDetails.routeTraceLatency') }}</th>
                      <th>{{ t('monitorDetails.routeTraceMinMax') }}</th>
                      <th>{{ t('monitorDetails.routeTraceLoss') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="hop in routeTraceResult.hops" :key="hop.hop">
                      <td class="mono">{{ hop.hop }}</td>
                      <td class="mono">{{ hop.address ?? '*' }}</td>
                      <td class="mono">{{ formatLatency(hop.avgLatencyMs) }}</td>
                      <td class="mono">
                        {{ hop.minLatencyMs !== null && hop.maxLatencyMs !== null
                          ? `${formatLatency(hop.minLatencyMs)} / ${formatLatency(hop.maxLatencyMs)}`
                          : '—' }}
                      </td>
                      <td class="mono" :class="{ 'loss-warn': hop.lossPercent > 0 }">{{ hop.lossPercent }}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </section>
          <aside class="monitor-record-detail" :aria-label="t('monitorDetails.routeTraceWhoisTitle')">
            <header>
              <strong>{{ t('monitorDetails.routeTraceWhoisTitle') }}</strong>
              <button
                v-if="routeTraceResult?.whoisLines.length"
                type="button"
                class="icon-button detail-copy-btn"
                :title="t('monitorDetails.copyField')"
                @click="copyText(routeTraceResult.whoisLines.join('\n'))"
              >
                <Copy :size="11" />
              </button>
            </header>
            <template v-if="routeTraceResult">
              <p v-if="routeTraceResult.whoisSummary" class="whois-summary-badge">{{ routeTraceResult.whoisSummary }}</p>
              <pre v-if="routeTraceResult.whoisLines.length" class="detail-code-pre whois-pre mono">{{ routeTraceResult.whoisLines.join('\n') }}</pre>
              <p v-else class="monitor-details-security-note">{{ t('monitorDetails.routeTraceWhoisEmpty') }}</p>
            </template>
            <p v-else class="monitor-details-security-note">{{ t('monitorDetails.routesHelp') }}</p>
          </aside>
        </div>
      </div>
    </section>

    <div
      v-if="processMenu"
      ref="processMenuEl"
      class="file-context-menu process-context-menu"
      role="menu"
      :aria-label="t('monitorDetails.processContextLabel')"
      :style="{ left: `${processMenu.x}px`, top: `${processMenu.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent
      @keydown="handleProcessMenuKeydown"
    >
      <button
        type="button"
        role="menuitem"
        class="danger danger-menu-item"
        :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
        @click="sendProcessSignal(processMenu.entry, 'SIGTERM')"
      >
        <CircleStop :size="13" /><span>{{ t('monitorDetails.signalTerminate') }}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        class="danger danger-menu-item"
        :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
        @click="sendProcessSignal(processMenu.entry, 'SIGKILL')"
      >
        <Skull :size="13" /><span>{{ t('monitorDetails.signalForceKill') }}</span>
      </button>
      <template v-if="isPosixProcesses">
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGHUP')"
        >
          <RotateCw :size="13" /><span>{{ t('monitorDetails.signalReload') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGSTOP')"
        >
          <PauseCircle :size="13" /><span>{{ t('monitorDetails.signalPause') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="!processMenu.entry.canTerminate || processes.terminatingPid !== null"
          @click="sendProcessSignal(processMenu.entry, 'SIGCONT')"
        >
          <PlayCircle :size="13" /><span>{{ t('monitorDetails.signalResume') }}</span>
        </button>
      </template>
      <div class="file-context-separator" role="separator" />
      <button type="button" role="menuitem" @click="copyText(String(processMenu.entry.pid))">
        <Copy :size="13" /><span>{{ t('monitorDetails.copyPid') }}</span>
      </button>
      <button type="button" role="menuitem" @click="copyText(processMenu.entry.name)">
        <Copy :size="13" /><span>{{ t('monitorDetails.copyProcessName') }}</span>
      </button>
      <button v-if="processMenu.entry.executablePath" type="button" role="menuitem" @click="copyText(processMenu.entry.executablePath)">
        <Copy :size="13" /><span>{{ t('monitorDetails.copyExecutablePath') }}</span>
      </button>
      <button v-if="processMenu.entry.workingDirectory" type="button" role="menuitem" @click="copyText(processMenu.entry.workingDirectory)">
        <Copy :size="13" /><span>{{ t('monitorDetails.copyWorkingDirectory') }}</span>
      </button>
      <button v-if="processMenu.entry.commandLine" type="button" role="menuitem" @click="copyText(processMenu.entry.commandLine)">
        <Copy :size="13" /><span>{{ t('monitorDetails.copyCommandLine') }}</span>
      </button>
    </div>
  </div>
</template>
