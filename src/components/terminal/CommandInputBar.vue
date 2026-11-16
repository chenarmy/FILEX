<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown, Copy, CornerDownLeft, History, Play, Trash2, X } from 'lucide-vue-next';
import { isLocalSession } from '@/domain/sessionCapabilities';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import { registerAltTap } from '@/domain/terminalInteractions';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import { t } from '@/i18n';
import type { ProfileCommandHistoryEntry } from '@/types/contracts';

const sessions = useSessionsStore();
const ui = useUiStore();
const draft = ref('');
const draftsBySession = createSessionStateCache<string>();
const inputRef = ref<HTMLTextAreaElement | null>(null);
const historyFilterRef = ref<HTMLInputElement | null>(null);
const historyOpen = ref(false);
const historyFilter = ref('');
const historyBrowseIndex = ref<number | null>(null);
const sending = ref(false);
const encoder = new TextEncoder();
let lastAltTapAt: number | null = null;

watch(
  () => sessions.activeSessionId,
  (nextId, prevId) => {
    if (prevId) draftsBySession.set(prevId, draft.value);
    draft.value = nextId ? (draftsBySession.get(nextId) ?? '') : '';
    historyBrowseIndex.value = null;
  },
);

const trackedSessionIds = new Set<string>();

watch(
  () => sessions.summaries.map((item) => item.id),
  (ids) => {
    const valid = new Set(ids);
    for (const id of [...trackedSessionIds]) {
      if (!valid.has(id)) {
        draftsBySession.delete(id);
        trackedSessionIds.delete(id);
      }
    }
    ids.forEach((id) => trackedSessionIds.add(id));
  },
  { immediate: true },
);

const connected = computed(() => sessions.activeSession?.state === 'connected');
const activeTargetLabel = computed(() => {
  const session = sessions.activeSession;
  if (!session) return '';
  if (isLocalSession(session)) {
    return sessions.localMetadataForSession(session.id)?.shellLabel ?? t('localTerminal.defaultTitle');
  }
  return `${session.username}@${session.host}:${session.port}`;
});
const filteredHistory = computed<ProfileCommandHistoryEntry[]>(() => {
  const query = historyFilter.value.trim().toLowerCase();
  const items = sessions.commandHistoryEntries;
  if (!query) return items;
  return items.filter((item) => item.command.toLowerCase().includes(query));
});

async function submit(): Promise<void> {
  const sessionId = sessions.activeSessionId;
  const command = draft.value;
  if (!sessionId || !connected.value || !command.trim() || sending.value) return;
  sending.value = true;
  try {
    const sent = await sessions.writeToSession(sessionId, encoder.encode(`${command}\r`));
    if (!sent) return;
    const recorded = await sessions.recordCommandHistory(command);
    if (!recorded) {
      ui.notify(t('commandBar.secretExcludedNotice'));
    }
    if (sessions.activeSessionId === sessionId && draft.value === command) {
      draft.value = '';
      historyBrowseIndex.value = null;
    }
  } finally {
    sending.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    void submit();
    return;
  }
  if (event.key === 'Escape' && historyOpen.value) {
    historyOpen.value = false;
    return;
  }
  const navigating = event.key === 'ArrowUp' || event.key === 'ArrowDown';
  if (!navigating || event.altKey || event.ctrlKey || event.metaKey) return;
  // History browsing only applies to a single-line draft so multiline edits
  // keep normal cursor movement.
  if (draft.value.includes('\n')) return;
  const items = filteredHistory.value;
  if (items.length === 0) return;
  event.preventDefault();
  const current = historyBrowseIndex.value;
  if (current === null) {
    if (event.key === 'ArrowUp') {
      historyBrowseIndex.value = 0;
      draft.value = items[0]?.command ?? '';
    }
    return;
  }
  const next = event.key === 'ArrowUp' ? current + 1 : current - 1;
  if (next < 0) {
    historyBrowseIndex.value = null;
    draft.value = '';
    return;
  }
  if (next >= items.length) return;
  historyBrowseIndex.value = next;
  draft.value = items[next]?.command ?? '';
}

function toggleHistory(): void {
  if (historyOpen.value) {
    historyOpen.value = false;
    return;
  }
  openHistory();
}

function openHistory(): void {
  historyOpen.value = true;
  historyFilter.value = '';
  void nextTick(() => window.requestAnimationFrame(() => {
    historyFilterRef.value?.focus();
  }));
}

function handleWindowKeyup(event: KeyboardEvent): void {
  const next = registerAltTap(lastAltTapAt, performance.now(), event);
  lastAltTapAt = next.lastTapAt;
  if (next.openHistory) openHistory();
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !historyOpen.value || ui.confirmation) return;
  event.preventDefault();
  historyOpen.value = false;
  inputRef.value?.focus();
}

function useHistoryItem(entry: ProfileCommandHistoryEntry): void {
  draft.value = entry.command;
  historyOpen.value = false;
  historyBrowseIndex.value = null;
  inputRef.value?.focus();
}

async function executeHistoryItem(entry: ProfileCommandHistoryEntry): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (!sessionId || !connected.value || sending.value) return;
  const confirmed = await ui.confirm({
    title: t('commandBar.confirmRunTitle'),
    message: t('commandBar.confirmRunMessage', {
      target: activeTargetLabel.value,
      command: entry.command,
    }),
    confirmLabel: t('commandBar.executeHistory'),
    danger: false,
  });
  if (!confirmed || sessions.activeSessionId !== sessionId) return;
  sending.value = true;
  try {
    const sent = await sessions.writeToSession(sessionId, encoder.encode(`${entry.command}\r`));
    if (!sent) return;
    await sessions.recordCommandHistory(entry.command);
    historyOpen.value = false;
  } finally {
    sending.value = false;
  }
}

async function copyHistoryItem(entry: ProfileCommandHistoryEntry): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(entry.command);
    ui.notify(t('commandBar.copied'));
  } catch {
    ui.notify(t('commandBar.copyFailed'));
  }
}

async function deleteHistoryItem(entry: ProfileCommandHistoryEntry): Promise<void> {
  await sessions.removeCommandHistoryEntry(entry.id);
  if (sessions.commandHistoryEntries.length === 0) historyBrowseIndex.value = null;
}

async function clearHistory(): Promise<void> {
  const accepted = await ui.confirm({
    title: t('commandBar.clearHistoryTitle'),
    message: sessions.activeHistoryPersisted
      ? t('commandBar.clearHistoryPersistedMessage')
      : t('commandBar.clearHistoryMessage'),
    confirmLabel: t('commandBar.clearHistory'),
    danger: true,
  });
  if (!accepted) return;
  await sessions.clearCommandHistory();
  historyBrowseIndex.value = null;
}

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('keyup', handleWindowKeyup);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('keyup', handleWindowKeyup);
});
</script>

<template>
  <section class="command-input-bar" :aria-label="t('commandBar.title')">
    <div class="command-input-row">
      <CornerDownLeft :size="13" class="command-input-glyph" aria-hidden="true" />
      <textarea
        ref="inputRef"
        v-model="draft"
        rows="1"
        class="command-input mono"
        :disabled="!connected"
        :placeholder="connected
          ? t('commandBar.placeholder')
          : t('commandBar.requiresSession')"
        :aria-label="t('commandBar.title')"
        spellcheck="false"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <button
        v-if="sessions.commandHistoryEntries.length > 0"
        type="button"
        class="command-input-action"
        :aria-expanded="historyOpen"
        :aria-label="t('commandBar.history')"
        :title="t('commandBar.history')"
        @click="toggleHistory"
      >
        <History :size="13" />
        <span>{{ sessions.commandHistoryEntries.length }}</span>
      </button>
      <button
        type="button"
        class="command-input-action"
        :aria-label="t('commandBar.send')"
        :title="t('commandBar.send')"
        :aria-busy="sending"
        :disabled="!connected || !draft.trim() || sending"
        @click="submit"
      >
        <CornerDownLeft :size="13" />
      </button>
    </div>
    <p v-if="!connected" class="command-input-hint">{{ t('commandBar.requiresSession') }}</p>
    <div v-if="historyOpen" class="command-history-panel" role="dialog" :aria-label="t('commandBar.history')">
      <header class="command-history-header">
        <label class="command-history-filter">
          {{ t('commandBar.historyFilter') }}
          <input ref="historyFilterRef" v-model="historyFilter" type="search" maxlength="120" :placeholder="t('commandBar.historyFilter')">
        </label>
        <button type="button" class="icon-button" :aria-label="t('commandBar.clearHistory')" :title="t('commandBar.clearHistory')" @click="clearHistory"><Trash2 :size="12" /></button>
        <button type="button" class="icon-button" :aria-label="t('settings.close')" :title="t('settings.close')" @click="historyOpen = false"><X :size="12" /></button>
      </header>
      <div v-if="filteredHistory.length === 0" class="command-history-empty">{{ t('commandBar.historyEmpty') }}</div>
      <ul v-else class="command-history-list" :aria-label="t('commandBar.history')">
        <li v-for="item in filteredHistory" :key="item.id">
          <button type="button" class="mono command-history-use" :title="t('commandBar.insertHistory')" @click="useHistoryItem(item)">
            <ChevronDown class="history-insert-glyph" :size="11" aria-hidden="true" />
            <span>{{ item.command }}</span>
          </button>
          <div class="command-history-actions">
            <button type="button" class="icon-button" :aria-label="t('commandBar.executeHistory')" :title="t('commandBar.executeHistory')" :disabled="!connected || sending" @click="executeHistoryItem(item)"><Play :size="11" /></button>
            <button type="button" class="icon-button" :aria-label="t('commandBar.copyHistory')" :title="t('commandBar.copyHistory')" @click="copyHistoryItem(item)"><Copy :size="11" /></button>
            <button type="button" class="icon-button danger" :aria-label="t('commandBar.deleteHistory')" :title="t('commandBar.deleteHistory')" @click="deleteHistoryItem(item)"><Trash2 :size="11" /></button>
          </div>
        </li>
      </ul>
      <footer class="command-history-note">
        {{ sessions.activeHistoryPersisted ? t('commandBar.historyPersistedNote') : t('commandBar.historyEphemeralNote') }}
      </footer>
    </div>
  </section>
</template>
