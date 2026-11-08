<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ChevronDown, CornerDownLeft, History, Trash2, X } from 'lucide-vue-next';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import { t } from '@/i18n';

const sessions = useSessionsStore();
const ui = useUiStore();
const draft = ref('');
const inputRef = ref<HTMLTextAreaElement | null>(null);
const historyOpen = ref(false);
const historyFilter = ref('');
const historyBrowseIndex = ref<number | null>(null);
const sending = ref(false);
const encoder = new TextEncoder();

const connected = computed(() => sessions.activeSession?.state === 'connected');
const filteredHistory = computed(() => {
  const query = historyFilter.value.trim().toLowerCase();
  const items = [...sessions.commandHistory].reverse();
  if (!query) return items;
  return items.filter((item) => item.toLowerCase().includes(query));
});

async function submit(): Promise<void> {
  const sessionId = sessions.activeSessionId;
  const command = draft.value;
  if (!sessionId || !connected.value || !command.trim() || sending.value) return;
  sending.value = true;
  try {
    const sent = await sessions.writeToSession(sessionId, encoder.encode(`${command}\r`));
    if (!sent) return;
    sessions.recordCommandHistory(command);
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
      draft.value = items[0] ?? '';
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
  draft.value = items[next] ?? '';
}

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value;
  historyFilter.value = '';
  if (historyOpen.value) void nextTick(() => window.requestAnimationFrame(() => {
    const panel = document.querySelector<HTMLInputElement>('.command-history-filter input');
    panel?.focus();
  }));
}

function useHistoryItem(command: string): void {
  draft.value = command;
  historyOpen.value = false;
  historyBrowseIndex.value = null;
  inputRef.value?.focus();
}

async function clearHistory(): Promise<void> {
  const accepted = await ui.confirm({
    title: t('commandBar.clearHistoryTitle'),
    message: t('commandBar.clearHistoryMessage'),
    confirmLabel: t('commandBar.clearHistory'),
    danger: true,
  });
  if (!accepted) return;
  sessions.clearCommandHistory();
  historyBrowseIndex.value = null;
}
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
        v-if="sessions.commandHistory.length > 0"
        type="button"
        class="command-input-action"
        :aria-expanded="historyOpen"
        :aria-label="t('commandBar.history')"
        :title="t('commandBar.history')"
        @click="toggleHistory"
      >
        <History :size="13" />
        <span>{{ sessions.commandHistory.length }}</span>
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
          <input v-model="historyFilter" type="search" maxlength="120" :placeholder="t('commandBar.historyFilter')">
        </label>
        <button type="button" class="icon-button" :aria-label="t('commandBar.clearHistory')" :title="t('commandBar.clearHistory')" @click="clearHistory"><Trash2 :size="12" /></button>
        <button type="button" class="icon-button" :aria-label="t('settings.close')" :title="t('settings.close')" @click="historyOpen = false"><X :size="12" /></button>
      </header>
      <div v-if="filteredHistory.length === 0" class="command-history-empty">{{ t('commandBar.historyEmpty') }}</div>
      <ul v-else class="command-history-list" role="listbox" :aria-label="t('commandBar.history')">
        <li v-for="item in filteredHistory" :key="item">
          <button type="button" role="option" :aria-selected="false" class="mono" :title="item" @click="useHistoryItem(item)">
            <ChevronDown class="history-insert-glyph" :size="11" aria-hidden="true" />
            <span>{{ item }}</span>
          </button>
        </li>
      </ul>
      <footer class="command-history-note">{{ t('commandBar.historyNote') }}</footer>
    </div>
  </section>
</template>
