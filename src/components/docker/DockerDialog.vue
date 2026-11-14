<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  Box,
  Copy,
  FileText,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useDockerStore } from '@/stores/docker';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { DockerContainerAction, DockerContainerEntry } from '@/types/contracts';

type DockerTab = 'containers' | 'images' | 'logs';

const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const docker = useDockerStore();
const ui = useUiStore();

const activeTab = ref<DockerTab>('containers');
const filterQuery = ref('');
const selectedContainerId = ref<string | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const containers = computed(() => docker.snapshot?.containers ?? []);
const images = computed(() => docker.snapshot?.images ?? []);

const filteredContainers = computed(() => {
  const query = filterQuery.value.trim().toLowerCase();
  if (!query) return containers.value;
  return containers.value.filter((entry) => (
    entry.name.toLowerCase().includes(query)
    || entry.image.toLowerCase().includes(query)
    || entry.state.toLowerCase().includes(query)
    || entry.ports.toLowerCase().includes(query)
    || entry.id.toLowerCase().includes(query)
  ));
});

const filteredImages = computed(() => {
  const query = filterQuery.value.trim().toLowerCase();
  if (!query) return images.value;
  return images.value.filter((entry) => (
    entry.repository.toLowerCase().includes(query)
    || entry.tag.toLowerCase().includes(query)
    || entry.id.toLowerCase().includes(query)
  ));
});

const selectedContainer = computed(() => (
  containers.value.find((entry) => entry.id === selectedContainerId.value) ?? null
));

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state], [prevId]) => {
    if ((prevId && sessionId !== prevId) || !sessionId || state !== 'connected') {
      emit('close');
    }
  },
);

onMounted(() => {
  void refresh();
  void nextTick(() => closeButton.value?.focus());
});

async function refresh(): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  await docker.collect(sessionId);
  if (activeTab.value === 'logs' && selectedContainerId.value) {
    await docker.fetchLogs(sessionId, selectedContainerId.value);
  }
}

async function openContainerLogs(entry: DockerContainerEntry): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  selectedContainerId.value = entry.id;
  activeTab.value = 'logs';
  await docker.fetchLogs(sessionId, entry.id);
}

async function refreshLogs(): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value || !selectedContainerId.value) return;
  await docker.fetchLogs(sessionId, selectedContainerId.value);
}

async function runAction(entry: DockerContainerEntry, action: DockerContainerAction): Promise<void> {
  const session = sessions.activeSession;
  if (!session || !connected.value) return;
  const shortId = entry.id.slice(0, 12);
  if (action === 'stop' || action === 'restart' || action === 'remove') {
    const titleKey = action === 'stop'
      ? 'docker.confirm.stopTitle'
      : action === 'restart'
        ? 'docker.confirm.restartTitle'
        : 'docker.confirm.removeTitle';
    const messageKey = action === 'stop'
      ? 'docker.confirm.stopMessage'
      : action === 'restart'
        ? 'docker.confirm.restartMessage'
        : 'docker.confirm.removeMessage';
    const accepted = await ui.confirm({
      title: t(titleKey),
      message: t(messageKey, { host: `${session.host}:${session.port}`, name: entry.name, id: shortId }),
      confirmLabel: t(`docker.actions.${action}` as Parameters<typeof t>[0]),
      danger: action === 'remove' || action === 'stop',
    });
    if (!accepted) return;
  }
  const ok = await docker.performAction(session.id, entry.id, action);
  if (ok) {
    ui.notify(t('docker.actionSucceeded', {
      name: entry.name,
      action: t(`docker.actions.${action}` as Parameters<typeof t>[0]),
    }));
  }
}

async function copyLogs(): Promise<void> {
  const text = docker.logs?.lines.join('\n') ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ui.notify(t('opsDialog.copied'));
  } catch {
    ui.notify(t('terminal.copyFailed'));
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
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
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
    <section
      ref="dialogRoot"
      class="dialog monitor-details-dialog docker-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="docker-dialog-title"
      @keydown="handleDialogKeydown"
    >
      <header class="monitor-details-header">
        <div class="monitor-details-title">
          <strong id="docker-dialog-title" class="dialog-title-with-icon">
            <Box :size="15" />{{ t('docker.title') }}
          </strong>
          <span class="mono">{{ sessions.activeSession?.username }}@{{ sessions.activeSession?.host }}:{{ sessions.activeSession?.port }}</span>
          <span v-if="docker.snapshot?.serverVersion" class="status-pill live mono">
            {{ t('docker.serverVersion', { version: docker.snapshot.serverVersion }) }}
          </span>
        </div>
        <div class="monitor-details-actions">
          <button
            type="button"
            class="icon-button"
            :disabled="docker.loading || docker.actingContainerId !== null"
            :aria-label="t('docker.refresh')"
            :title="t('docker.refresh')"
            @click="refresh"
          >
            <RefreshCw :size="13" />
          </button>
          <button
            ref="closeButton"
            type="button"
            class="icon-button"
            :aria-label="t('docker.close')"
            :title="t('docker.close')"
            @click="emit('close')"
          >
            <X :size="14" />
          </button>
        </div>
      </header>

      <nav class="monitor-details-tabs" role="tablist" :aria-label="t('docker.title')">
        <button type="button" role="tab" :aria-selected="activeTab === 'containers'" @click="activeTab = 'containers'">
          {{ t('docker.containersTab', { count: containers.length }) }}
        </button>
        <button type="button" role="tab" :aria-selected="activeTab === 'images'" @click="activeTab = 'images'">
          {{ t('docker.imagesTab', { count: images.length }) }}
        </button>
        <button type="button" role="tab" :aria-selected="activeTab === 'logs'" @click="activeTab = 'logs'">
          {{ t('docker.logsTab') }}
        </button>
        <div v-if="activeTab !== 'logs'" class="docker-filter-box">
          <Search :size="12" aria-hidden="true" />
          <input
            v-model="filterQuery"
            type="search"
            maxlength="128"
            :aria-label="t('docker.searchPlaceholder')"
            :placeholder="t('docker.searchPlaceholder')"
          >
        </div>
      </nav>

      <div v-if="!connected" class="task-empty">{{ t('docker.requiresSession') }}</div>
      <div v-else-if="docker.error" class="inline-notice error" role="alert">
        {{ t(docker.error.messageKey as Parameters<typeof t>[0]) }}
      </div>
      <div v-else-if="docker.loading && !docker.snapshot" class="task-empty">{{ t('docker.loading') }}</div>
      <div v-else-if="docker.snapshot?.availability === 'not_installed'" class="task-empty">
        {{ t('docker.notInstalled') }}
      </div>
      <div v-else-if="docker.snapshot?.availability === 'permission_denied'" class="task-empty">
        {{ t('docker.permissionDenied') }}
      </div>
      <div v-else-if="docker.snapshot?.availability === 'daemon_stopped'" class="task-empty">
        {{ t('docker.daemonStopped') }}
        <span v-if="docker.snapshot.detailNote" class="mono"> · {{ docker.snapshot.detailNote }}</span>
      </div>
      <div v-else-if="docker.snapshot?.availability === 'unsupported'" class="task-empty">
        {{ t('docker.unsupported') }}
      </div>

      <template v-else>
        <p v-if="docker.snapshot?.truncated" class="monitor-details-notice">{{ t('docker.truncated') }}</p>

        <div v-if="activeTab === 'containers'" class="docker-table-shell">
          <div v-if="filteredContainers.length" class="monitor-table-scroll">
            <table class="monitor-details-table docker-table">
              <thead>
                <tr>
                  <th>{{ t('docker.columns.name') }}</th>
                  <th>{{ t('docker.columns.image') }}</th>
                  <th>{{ t('docker.columns.state') }}</th>
                  <th>{{ t('docker.columns.status') }}</th>
                  <th>{{ t('docker.columns.ports') }}</th>
                  <th>{{ t('docker.columns.resources') }}</th>
                  <th>{{ t('docker.columns.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in filteredContainers" :key="entry.id">
                  <td>
                    <div class="docker-name-cell">
                      <strong>{{ entry.name || entry.id.slice(0, 12) }}</strong>
                      <span class="mono docker-short-id">{{ entry.id.slice(0, 12) }}</span>
                    </div>
                  </td>
                  <td class="mono truncate-cell" :title="entry.image">{{ entry.image }}</td>
                  <td>
                    <span class="docker-state-pill" :class="`state-${entry.state}`">{{ entry.state }}</span>
                  </td>
                  <td class="truncate-cell" :title="entry.status">{{ entry.status }}</td>
                  <td class="mono truncate-cell" :title="entry.ports">{{ entry.ports || '—' }}</td>
                  <td class="mono">
                    <template v-if="entry.cpuPercent || entry.memoryUsage">
                      {{ entry.cpuPercent ?? '—' }} · {{ entry.memoryUsage ?? '—' }}
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td>
                    <div class="docker-row-actions">
                      <button
                        v-if="entry.state !== 'running' && entry.state !== 'paused'"
                        type="button"
                        class="docker-action-btn primary"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.start')"
                        @click="runAction(entry, 'start')"
                      >
                        <Play :size="11" />{{ t('docker.actions.start') }}
                      </button>
                      <button
                        v-if="entry.state === 'running'"
                        type="button"
                        class="docker-action-btn"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.pause')"
                        @click="runAction(entry, 'pause')"
                      >
                        <Pause :size="11" />{{ t('docker.actions.pause') }}
                      </button>
                      <button
                        v-if="entry.state === 'paused'"
                        type="button"
                        class="docker-action-btn primary"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.unpause')"
                        @click="runAction(entry, 'unpause')"
                      >
                        <Play :size="11" />{{ t('docker.actions.unpause') }}
                      </button>
                      <button
                        v-if="entry.state === 'running'"
                        type="button"
                        class="docker-action-btn"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.restart')"
                        @click="runAction(entry, 'restart')"
                      >
                        <RotateCw :size="11" />{{ t('docker.actions.restart') }}
                      </button>
                      <button
                        v-if="entry.state === 'running' || entry.state === 'paused'"
                        type="button"
                        class="docker-action-btn danger"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.stop')"
                        @click="runAction(entry, 'stop')"
                      >
                        <Square :size="11" />{{ t('docker.actions.stop') }}
                      </button>
                      <button
                        type="button"
                        class="docker-action-btn"
                        :disabled="docker.actingContainerId !== null"
                        :title="t('docker.actions.logs')"
                        @click="openContainerLogs(entry)"
                      >
                        <FileText :size="11" />{{ t('docker.actions.logs') }}
                      </button>
                      <button
                        type="button"
                        class="docker-action-btn danger"
                        :disabled="docker.actingContainerId !== null"
                        :aria-label="`${t('docker.actions.remove')} ${entry.name}`"
                        :title="t('docker.actions.remove')"
                        @click="runAction(entry, 'remove')"
                      >
                        <Trash2 :size="11" />
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="task-empty">{{ t('docker.noContainers') }}</div>
        </div>

        <div v-else-if="activeTab === 'images'" class="docker-table-shell">
          <div v-if="filteredImages.length" class="monitor-table-scroll">
            <table class="monitor-details-table">
              <thead>
                <tr>
                  <th>{{ t('docker.columns.repository') }}</th>
                  <th>{{ t('docker.columns.tag') }}</th>
                  <th>{{ t('docker.columns.id') }}</th>
                  <th>{{ t('docker.columns.size') }}</th>
                  <th>{{ t('docker.columns.created') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="img in filteredImages" :key="`${img.id}-${img.repository}-${img.tag}`">
                  <td class="mono">{{ img.repository }}</td>
                  <td class="mono">{{ img.tag }}</td>
                  <td class="mono">{{ img.id }}</td>
                  <td class="mono">{{ img.size }}</td>
                  <td>{{ img.createdSince }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="task-empty">{{ t('docker.noImages') }}</div>
        </div>

        <div v-else class="docker-logs-shell">
          <div v-if="!selectedContainerId" class="task-empty">{{ t('docker.selectContainerForLogs') }}</div>
          <template v-else>
            <div class="docker-logs-toolbar">
              <strong class="mono">{{ selectedContainer?.name ?? selectedContainerId.slice(0, 12) }}</strong>
              <div class="docker-row-actions">
                <button type="button" class="docker-action-btn" :disabled="docker.logsLoading" @click="refreshLogs">
                  <RefreshCw :size="12" />{{ t('docker.actions.refreshLogs') }}
                </button>
                <button type="button" class="docker-action-btn" :disabled="!docker.logs?.lines.length" @click="copyLogs">
                  <Copy :size="12" />{{ t('opsDialog.copyOutput') }}
                </button>
              </div>
            </div>
            <div v-if="docker.logsLoading && !docker.logs" class="task-empty">{{ t('docker.loading') }}</div>
            <pre v-else-if="docker.logs?.lines.length" class="ops-command-pre mono">{{ docker.logs.lines.join('\n') }}</pre>
            <div v-else class="task-empty">{{ t('docker.logsEmpty') }}</div>
          </template>
        </div>
      </template>
    </section>
  </div>
</template>
