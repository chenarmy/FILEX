<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { Copy, RefreshCw, Search, Terminal, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useOpsStore } from '@/stores/ops';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { OpsCategory, OpsCommandSection } from '@/types/contracts';

const OPS_TABS: readonly OpsCategory[] = ['overview', 'ports', 'services', 'disks', 'logs'];

const props = defineProps<{ initialCategory: OpsCategory }>();
const emit = defineEmits<{ close: [] }>();

const sessions = useSessionsStore();
const ops = useOpsStore();
const ui = useUiStore();

const activeCategory = ref<OpsCategory>(props.initialCategory);
const filterQuery = ref('');
const closeButton = ref<HTMLButtonElement | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const currentSnapshot = computed(() => ops.snapshots[activeCategory.value] ?? null);
const isLoading = computed(() => ops.loadingCategory === activeCategory.value);

const visibleSections = computed<OpsCommandSection[]>(() => {
  const sections = currentSnapshot.value?.sections ?? [];
  const query = filterQuery.value.trim().toLowerCase();
  if (!query) return sections;
  return sections
    .map((section) => ({
      ...section,
      lines: section.lines.filter((line) => line.toLowerCase().includes(query)),
    }))
    .filter((section) => section.lines.length > 0);
});

watch(
  () => props.initialCategory,
  (category) => {
    activeCategory.value = category;
  },
);

watch(activeCategory, (category) => {
  void loadCategory(category);
});

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state], [prevId]) => {
    if ((prevId && sessionId !== prevId) || !sessionId || state !== 'connected') {
      emit('close');
    }
  },
);

onMounted(() => {
  void loadCategory(activeCategory.value);
  void nextTick(() => closeButton.value?.focus());
});

async function loadCategory(category: OpsCategory): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value) return;
  await ops.collect(sessionId, category);
}

async function refresh(): Promise<void> {
  await loadCategory(activeCategory.value);
}

async function copyAllOutput(): Promise<void> {
  const text = visibleSections.value
    .map((section) => `# ${section.commandLabel}\n${section.lines.join('\n')}`)
    .join('\n\n');
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
    'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
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
      class="dialog monitor-details-dialog ops-details-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ops-dialog-title"
      @keydown="handleDialogKeydown"
    >
      <header class="monitor-details-header">
        <div class="monitor-details-title">
          <strong id="ops-dialog-title" class="dialog-title-with-icon">
            <Terminal :size="15" />{{ t('opsDialog.title') }}
          </strong>
          <span class="mono">{{ sessions.activeSession?.username }}@{{ sessions.activeSession?.host }}:{{ sessions.activeSession?.port }}</span>
          <span v-if="currentSnapshot?.hostname" class="status-pill mono">
            {{ currentSnapshot.hostname }}
          </span>
        </div>
        <div class="monitor-details-actions">
          <button
            type="button"
            class="icon-button"
            :disabled="!visibleSections.length"
            :aria-label="t('opsDialog.copyOutput')"
            :title="t('opsDialog.copyOutput')"
            @click="copyAllOutput"
          >
            <Copy :size="13" />
          </button>
          <button
            type="button"
            class="icon-button"
            :disabled="isLoading"
            :aria-label="t('opsDialog.refresh')"
            :title="t('opsDialog.refresh')"
            @click="refresh"
          >
            <RefreshCw :size="13" />
          </button>
          <button
            ref="closeButton"
            type="button"
            class="icon-button"
            :aria-label="t('opsDialog.close')"
            :title="t('opsDialog.close')"
            @click="emit('close')"
          >
            <X :size="14" />
          </button>
        </div>
      </header>

      <nav class="monitor-details-tabs" role="tablist" :aria-label="t('opsDialog.title')">
        <button
          v-for="tab in OPS_TABS"
          :key="tab"
          type="button"
          role="tab"
          :aria-selected="activeCategory === tab"
          @click="activeCategory = tab"
        >
          {{ t(`opsDialog.tabs.${tab}` as Parameters<typeof t>[0]) }}
        </button>
        <div class="docker-filter-box">
          <Search :size="12" aria-hidden="true" />
          <input
            v-model="filterQuery"
            type="search"
            maxlength="128"
            :aria-label="t('opsDialog.searchPlaceholder')"
            :placeholder="t('opsDialog.searchPlaceholder')"
          >
        </div>
      </nav>

      <div v-if="!connected" class="task-empty">{{ t('opsDialog.requiresSession') }}</div>
      <div v-else-if="ops.error" class="inline-notice error" role="alert">
        {{ t(ops.error.messageKey as Parameters<typeof t>[0]) }}
      </div>
      <div v-else-if="isLoading && !currentSnapshot" class="task-empty">{{ t('opsDialog.loading') }}</div>
      <div v-else-if="currentSnapshot?.state === 'unsupported'" class="task-empty">{{ t('opsDialog.unsupported') }}</div>
      <div v-else-if="visibleSections.length === 0" class="task-empty">{{ t('opsDialog.empty') }}</div>

      <div v-else class="ops-sections-scroll">
        <div v-if="currentSnapshot?.osRelease || currentSnapshot?.kernel" class="ops-host-banner mono">
          <span v-if="currentSnapshot.osRelease">{{ currentSnapshot.osRelease }}</span>
          <span v-if="currentSnapshot.kernel">{{ currentSnapshot.kernel }}</span>
        </div>
        <article v-for="section in visibleSections" :key="section.id" class="ops-command-section">
          <header class="ops-section-header">
            <strong>{{ t(section.titleKey as Parameters<typeof t>[0]) }}</strong>
            <span class="ops-command-pill mono">{{ section.commandLabel }}</span>
          </header>
          <p v-if="section.truncated" class="monitor-details-notice">{{ t('opsDialog.truncated') }}</p>
          <pre class="ops-command-pre mono">{{ section.lines.join('\n') || '—' }}</pre>
        </article>
      </div>
    </section>
  </div>
</template>
