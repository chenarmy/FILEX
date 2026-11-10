<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { CircleStop, RefreshCw, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useNetworkStore } from '@/stores/network';
import { useProcessesStore } from '@/stores/processes';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { NetworkInterface, ProcessEntry } from '@/types/contracts';

type MonitorDetailsView = 'processes' | 'network' | 'routes';

const props = defineProps<{ initialView: MonitorDetailsView }>();
const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const processes = useProcessesStore();
const network = useNetworkStore();
const ui = useUiStore();
const activeView = ref<MonitorDetailsView>(props.initialView);
const selectedPid = ref<number | null>(null);
const selectedInterfaceName = ref('');
const selectedEndpointIndex = ref<number | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const selectedProcess = computed(() => processes.snapshot?.processes.find((entry) => entry.pid === selectedPid.value) ?? null);
const interfaces = computed(() => network.snapshot?.interfaces ?? []);
const selectedInterface = computed(() => interfaces.value.find((entry) => entry.name === selectedInterfaceName.value) ?? null);
const filteredEndpoints = computed(() => {
  const endpoints = network.snapshot?.endpoints ?? [];
  const selected = selectedInterface.value;
  if (!selected) return endpoints;
  const addresses = new Set(selected.addresses.map((address) => address.replace(/\/\d+$/, '')));
  return endpoints.filter((endpoint) => isWildcardAddress(endpoint.localAddress) || addresses.has(endpoint.localAddress));
});
const selectedEndpoint = computed(() => selectedEndpointIndex.value === null
  ? null
  : filteredEndpoints.value[selectedEndpointIndex.value] ?? null);

watch(interfaces, (entries) => {
  if (!entries.some((entry) => entry.name === selectedInterfaceName.value)) {
    selectedInterfaceName.value = entries.find((entry) => !entry.loopback)?.name ?? entries[0]?.name ?? '';
  }
}, { immediate: true });

watch(filteredEndpoints, () => {
  selectedEndpointIndex.value = null;
});

watch(activeView, (view) => {
  void loadView(view);
});

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state]) => {
    if (!sessionId || state !== 'connected') emit('close');
  },
);

onMounted(() => {
  void loadView(activeView.value);
  void nextTick(() => closeButton.value?.focus());
});

async function loadView(view: MonitorDetailsView): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  if (view === 'processes') {
    await processes.collect(sessionId);
    selectedPid.value = processes.snapshot?.processes[0]?.pid ?? null;
  } else {
    await network.collect(sessionId);
  }
}

async function refresh(): Promise<void> {
  await loadView(activeView.value);
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
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function endpointLabel(address: string | null, port: number | null): string {
  if (!address) return '—';
  const formattedAddress = address.includes(':') ? `[${address}]` : address;
  return port === null ? formattedAddress : `${formattedAddress}:${port}`;
}

function isWildcardAddress(address: string): boolean {
  return address === '*' || address === '0.0.0.0' || address === '::' || address === '[::]';
}

function interfaceState(entry: NetworkInterface): string {
  return entry.state || t('monitorDetails.unknown');
}

async function terminateProcess(entry: ProcessEntry): Promise<void> {
  const activeSession = sessions.activeSession;
  const snapshot = processes.snapshot;
  if (!activeSession || !snapshot?.snapshotId || !entry.canTerminate) return;
  const action = snapshot.platform === 'windows' ? t('inspector.processActionWindows') : 'SIGTERM';
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
    selectedPid.value = null;
    ui.notify(t('inspector.processSignalSent', { name: entry.name, pid: entry.pid }));
  }
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
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
          <button type="button" class="icon-button" :disabled="processes.loading || network.loading" :aria-label="t('monitorDetails.refresh')" :title="t('monitorDetails.refresh')" @click="refresh"><RefreshCw :size="13" /></button>
          <button ref="closeButton" type="button" class="icon-button" :aria-label="t('monitorDetails.close')" :title="t('monitorDetails.close')" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>

      <nav class="monitor-details-tabs" role="tablist" :aria-label="t('monitorDetails.title')">
        <button v-for="view in (['processes', 'network', 'routes'] as const)" :key="view" type="button" role="tab" :aria-selected="activeView === view" @click="activeView = view">{{ t(`monitorDetails.${view}` as Parameters<typeof t>[0]) }}</button>
      </nav>

      <div v-if="!connected" class="task-empty">{{ t('monitorDetails.requiresSession') }}</div>

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
                  <tr v-for="entry in processes.snapshot.processes" :key="entry.pid" tabindex="0" :class="{ selected: selectedPid === entry.pid }" :aria-selected="selectedPid === entry.pid" @click="selectedPid = entry.pid" @keydown.enter.prevent="selectedPid = entry.pid" @keydown.space.prevent="selectedPid = entry.pid">
                    <td class="mono">{{ entry.pid }}</td><td>{{ entry.user ?? '—' }}</td><td class="mono truncate-cell" :title="entry.name">{{ entry.name }}</td><td class="mono">{{ formatCpu(entry) }}</td><td class="mono">{{ formatBytes(entry.memoryBytes) }}</td><td>{{ entry.state ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>
        <aside class="monitor-record-detail" :aria-label="t('monitorDetails.processDetail')">
          <template v-if="selectedProcess">
            <header><strong>{{ t('monitorDetails.processDetail') }}</strong><button type="button" class="icon-button danger-button" :disabled="!selectedProcess.canTerminate || processes.loading || processes.terminatingPid !== null" :aria-label="t('inspector.terminateProcessTarget', { name: selectedProcess.name, pid: selectedProcess.pid })" @click="terminateProcess(selectedProcess)"><CircleStop :size="13" /></button></header>
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
                <option v-for="entry in interfaces" :key="entry.name" :value="entry.name">{{ entry.name }} · {{ interfaceState(entry) }}</option>
              </select>
            </label>
            <span v-if="selectedInterface" class="mono">↓ {{ formatBytes(selectedInterface.receivedBytes) }} · ↑ {{ formatBytes(selectedInterface.transmittedBytes) }}</span>
          </div>
          <div v-if="network.error" class="inline-notice error" role="alert">{{ t(network.error.messageKey as Parameters<typeof t>[0]) }}</div>
          <div v-else-if="network.loading && !network.snapshot" class="task-empty">{{ t('monitorDetails.networkLoading') }}</div>
          <div v-else-if="network.snapshot?.state === 'unsupported'" class="task-empty">{{ t('monitorDetails.networkUnsupported') }}</div>
          <template v-else>
            <div v-if="selectedInterface" class="interface-summary">
              <span><strong>{{ t('monitorDetails.addresses') }}</strong> <span class="mono">{{ selectedInterface.addresses.join(', ') || '—' }}</span></span>
              <span><strong>MTU</strong> <span class="mono">{{ selectedInterface.mtu ?? '—' }}</span></span>
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
  </div>
</template>
