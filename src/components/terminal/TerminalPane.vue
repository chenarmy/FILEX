<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ArrowDown, ArrowUp, Bot, Circle, Search, X } from 'lucide-vue-next';
import '@xterm/xterm/css/xterm.css';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { t } from '@/i18n';
import type { TerminalEncoding } from '@/types/contracts';

const props = defineProps<{
  sessionId: string | null;
  focused: boolean;
  searchOpen: boolean;
  focusSearchToken: number;
  canClose: boolean;
}>();

const emit = defineEmits<{
  focus: [];
  'search-open': [];
  'search-close': [];
  close: [];
}>();

const sessions = useSessionsStore();
const settings = useSettingsStore();
const ui = useUiStore();
const session = computed(() => sessions.summaries.find((item) => item.id === props.sessionId) ?? null);
const profile = computed(() => sessions.profileForSession(session.value));
const sessionName = computed(() => profile.value?.name ?? t('terminal.noSession'));
const terminalHost = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const matchCount = ref(0);
const currentMatch = ref<number | null>(null);
const selectionAvailable = ref(false);
const columns = ref(120);
const rows = ref(32);
const systemColorScheme = ref<'dark' | 'light'>(
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
);
const terminalPalette = computed(() => {
  const preference = settings.value.terminalTheme;
  const appearance = preference === 'match'
    ? (settings.value.theme === 'system' ? systemColorScheme.value : settings.value.theme)
    : preference;
  return appearance === 'light'
    ? {
        background: '#f8fafc',
        foreground: '#1e293b',
        cursor: '#2563eb',
        selectionBackground: '#93c5fd80',
      }
    : {
        background: '#080c14',
        foreground: '#d7e0ef',
        cursor: '#7aa2f7',
        selectionBackground: '#334155aa',
      };
});
const terminalEncodingLabel = computed(() => {
  const labels: Record<TerminalEncoding, string> = {
    'utf-8': 'UTF-8',
    gbk: 'GBK',
    big5: 'Big5',
    shift_jis: 'Shift_JIS',
    'windows-1252': 'Windows-1252',
  };
  return labels[settings.value.terminalEncoding];
});

let terminal: XTerm | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: number | null = null;
let searchRefreshTimer: number | null = null;
let pasteHandler: ((event: ClipboardEvent) => void) | null = null;
let disposeSelectionListener: (() => void) | null = null;
let disposeSearchResults: (() => void) | null = null;
let systemThemeMedia: MediaQueryList | null = null;
let outputOffset = 0;
let outputDecoder = new TextDecoder(settings.value.terminalEncoding);

const searchOptions = {
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  decorations: {
    matchBackground: '#234a7b',
    matchBorder: '#3b82f6',
    matchOverviewRuler: '#60a5fa',
    activeMatchBackground: '#8a6115',
    activeMatchBorder: '#f59e0b',
    activeMatchColorOverviewRuler: '#fbbf24',
  },
};

const searchPosition = computed(() => {
  if (matchCount.value === 0) return '';
  return (currentMatch.value === null ? '—' : String(currentMatch.value)) + ' / ' + String(matchCount.value);
});

function refreshMatch(term: string, direction: 'next' | 'previous', incremental = false): void {
  if (!searchAddon || !term.trim()) {
    searchAddon?.clearDecorations();
    matchCount.value = 0;
    currentMatch.value = null;
    return;
  }
  const found = direction === 'next'
    ? searchAddon.findNext(term, { ...searchOptions, incremental })
    : searchAddon.findPrevious(term, searchOptions);
  if (!found) {
    matchCount.value = 0;
    currentMatch.value = null;
  }
}

function handleSearchInput(): void {
  const term = searchQuery.value.slice(0, 256);
  if (term !== searchQuery.value) searchQuery.value = term;
  if (!term.trim()) {
    searchAddon?.clearDecorations();
    terminal?.clearSelection();
    matchCount.value = 0;
    currentMatch.value = null;
    return;
  }
  refreshMatch(term, 'next', true);
}

function searchNext(): void {
  refreshMatch(searchQuery.value, 'next');
}

function searchPrevious(): void {
  refreshMatch(searchQuery.value, 'previous');
}

function clearSearch(): void {
  searchQuery.value = '';
  matchCount.value = 0;
  currentMatch.value = null;
  selectionAvailable.value = false;
  searchAddon?.clearDecorations();
  terminal?.clearSelection();
}

function closeSearch(): void {
  clearSearch();
  emit('search-close');
  terminal?.focus();
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) searchPrevious();
    else searchNext();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
  }
}

function openSearch(): void {
  emit('search-open');
}

function attachSelectionToAssistant(): void {
  const selection = terminal?.getSelection().trim();
  if (!selection || !session.value) return;
  ui.attachTerminalSelection(session.value.host, selection);
}

function replaySession(): void {
  if (!terminal) return;
  terminal.reset();
  outputOffset = 0;
  outputDecoder = new TextDecoder(settings.value.terminalEncoding);
  clearSearch();
  const sessionId = props.sessionId;
  if (!sessionId) {
    terminal.writeln(t('terminal.prompt'));
    return;
  }
  const chunks = sessions.outputBuffers[sessionId] ?? [];
  const outputStart = sessions.outputBufferStarts[sessionId] ?? 0;
  for (const chunk of chunks) writeDecodedOutput(chunk);
  outputOffset = outputStart + chunks.length;
}

function writeDecodedOutput(chunk: Uint8Array): void {
  const text = outputDecoder.decode(chunk, { stream: true });
  if (text) terminal?.write(text);
}

function scheduleSearchRefresh(): void {
  if (!props.searchOpen || !searchQuery.value.trim()) return;
  if (searchRefreshTimer !== null) window.clearTimeout(searchRefreshTimer);
  searchRefreshTimer = window.setTimeout(() => {
    searchRefreshTimer = null;
    refreshMatch(searchQuery.value, 'next', true);
  }, 250);
}

function appendSessionOutput(): void {
  const sessionId = props.sessionId;
  if (!terminal || !sessionId) return;
  const chunks = sessions.outputBuffers[sessionId] ?? [];
  const outputStart = sessions.outputBufferStarts[sessionId] ?? 0;
  const start = Math.max(0, outputOffset - outputStart);
  const pending = chunks.slice(start);
  outputOffset = outputStart + chunks.length;
  if (pending.length === 0) return;
  pending.forEach(writeDecodedOutput);
  scheduleSearchRefresh();
}

function fitTerminal(): void {
  if (!terminal || !fitAddon || !terminalHost.value) return;
  if (terminalHost.value.clientWidth < 2 || terminalHost.value.clientHeight < 2) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  columns.value = terminal.cols;
  rows.value = terminal.rows;
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  const sessionId = props.sessionId;
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    if (sessionId && props.sessionId === sessionId) {
      void sessions.resizeSession(sessionId, terminal?.cols ?? columns.value, terminal?.rows ?? rows.value);
    }
  }, 100);
}

async function reconnect(): Promise<void> {
  if (!session.value) return;
  emit('focus');
  await sessions.reconnectSession(session.value.id);
}

onMounted(async () => {
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)');
  systemColorScheme.value = systemThemeMedia.matches ? 'light' : 'dark';
  systemThemeMedia.addEventListener('change', handleSystemThemeChange);
  terminal = new XTerm({
    cursorBlink: true,
    convertEol: false,
    fontFamily: settings.value.terminalFontFamily,
    fontSize: settings.value.terminalFontSize,
    scrollback: settings.value.terminalScrollback,
    theme: terminalPalette.value,
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon({ highlightLimit: 1000 });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  const selectionListener = terminal.onSelectionChange(() => {
    selectionAvailable.value = Boolean(terminal?.getSelection().trim());
  });
  disposeSelectionListener = () => selectionListener.dispose();
  const searchResultsListener = searchAddon.onDidChangeResults((result) => {
    matchCount.value = result.resultCount;
    currentMatch.value = result.resultIndex >= 0 ? result.resultIndex + 1 : null;
  });
  disposeSearchResults = () => searchResultsListener.dispose();

  await nextTick();
  if (terminalHost.value) terminal.open(terminalHost.value);
  const encoder = new TextEncoder();
  terminal.onData((data) => {
    if (props.sessionId) void sessions.writeToSession(props.sessionId, encoder.encode(data));
  });
  pasteHandler = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!settings.value.pasteProtection || !text.includes('\n') || !terminal) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void ui.confirm({
      title: t('terminal.pasteTitle'),
      message: t('terminal.pasteConfirm').replace('{lines}', String(text.split(/\r?\n/).length)),
      confirmLabel: t('terminal.paste'),
      danger: false,
    }).then((accepted) => {
      if (accepted) terminal?.paste(text);
    });
  };
  terminal.element?.addEventListener('paste', pasteHandler, true);
  resizeObserver = new ResizeObserver(fitTerminal);
  if (terminalHost.value) resizeObserver.observe(terminalHost.value);
  replaySession();
  fitTerminal();
});

watch(
  () => props.sessionId,
  () => {
    replaySession();
    void nextTick(fitTerminal);
  },
);

watch(
  () => sessions.outputRevision,
  () => appendSessionOutput(),
);

watch(
  () => settings.value.terminalEncoding,
  () => replaySession(),
);

watch(terminalPalette, (palette) => {
  if (terminal) terminal.options.theme = palette;
});

watch(
  () => session.value?.state,
  (state) => {
    if (state === 'connected') {
      void nextTick(fitTerminal);
    } else if (state === 'connecting' || state === 'disconnected' || state === 'failed') {
      appendSessionOutput();
      const trailingText = outputDecoder.decode();
      if (trailingText) terminal?.write(trailingText);
    }
  },
);

watch(
  () => [settings.value.terminalFontFamily, settings.value.terminalFontSize, settings.value.terminalScrollback] as const,
  ([fontFamily, fontSize, scrollback]) => {
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.scrollback = scrollback;
    void nextTick(fitTerminal);
  },
);

watch(
  () => props.searchOpen,
  (open) => {
    if (open) {
      void nextTick(() => {
        searchInput.value?.focus();
        searchInput.value?.select();
      });
    } else {
      clearSearch();
    }
  },
);

watch(
  () => props.focusSearchToken,
  () => {
    if (props.searchOpen) {
      void nextTick(() => {
        searchInput.value?.focus();
        searchInput.value?.select();
      });
    }
  },
);

onBeforeUnmount(() => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  if (searchRefreshTimer !== null) window.clearTimeout(searchRefreshTimer);
  systemThemeMedia?.removeEventListener('change', handleSystemThemeChange);
  resizeObserver?.disconnect();
  if (pasteHandler) terminal?.element?.removeEventListener('paste', pasteHandler, true);
  disposeSelectionListener?.();
  disposeSearchResults?.();
  searchAddon?.dispose();
  terminal?.dispose();
});

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemColorScheme.value = event.matches ? 'light' : 'dark';
}

function focusTerminal(): void {
  terminal?.focus();
}

defineExpose({ focusTerminal });
</script>

<template>
  <section
    class="terminal-pane"
    :class="{ focused, searching: searchOpen, disconnected: session && session.state !== 'connected' }"
    :aria-label="session ? sessionName + ' terminal' : t('terminal.paneLabel')"
    @focusin="emit('focus')"
  >
    <header class="terminal-pane-header">
      <div class="terminal-pane-heading">
        <span v-if="session" class="state-dot" :class="session.state" />
        <strong>{{ sessionName }}</strong>
        <span v-if="session" class="mono terminal-pane-host">{{ session.username }}@{{ session.host }}:{{ session.port }}</span>
      </div>
      <div class="terminal-pane-actions">
        <button type="button" class="icon-button" :aria-label="t('terminal.search')" :title="t('terminal.search')" :disabled="!session" @click="openSearch">
          <Search :size="13" />
        </button>
        <button
          v-if="selectionAvailable && session"
          type="button"
          class="icon-button"
          :aria-label="t('assistant.attachTerminalSelection')"
          :title="t('assistant.attachTerminalSelection')"
          @click="attachSelectionToAssistant"
        >
          <Bot :size="13" />
        </button>
        <button
          v-if="session && ['disconnected', 'failed'].includes(session.state)"
          type="button"
          class="pane-reconnect"
          :disabled="sessions.busy"
          @click="reconnect"
        >
          {{ t('terminal.reconnectPane') }}
        </button>
        <button
          v-if="canClose"
          type="button"
          class="icon-button"
          :aria-label="t('terminal.removePane')"
          :title="t('terminal.removePane')"
          @click="emit('close')"
        >
          <X :size="13" />
        </button>
      </div>
    </header>

    <div v-if="searchOpen" class="terminal-search" role="search">
      <Search :size="13" aria-hidden="true" />
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        maxlength="256"
        :aria-label="t('terminal.search')"
        :placeholder="t('terminal.searchPlaceholder')"
        @input="handleSearchInput"
        @keydown="handleSearchKeydown"
      >
      <span class="terminal-search-position" aria-live="polite">
        {{ searchQuery && matchCount === 0 ? t('terminal.searchNoMatches') : searchPosition }}
      </span>
      <button type="button" class="icon-button" :aria-label="t('terminal.previousMatch')" :title="t('terminal.previousMatch')" :disabled="!searchQuery.trim()" @click="searchPrevious">
        <ArrowUp :size="13" />
      </button>
      <button type="button" class="icon-button" :aria-label="t('terminal.nextMatch')" :title="t('terminal.nextMatch')" :disabled="!searchQuery.trim()" @click="searchNext">
        <ArrowDown :size="13" />
      </button>
      <button type="button" class="icon-button" :aria-label="t('terminal.closeSearch')" :title="t('terminal.closeSearch')" @click="closeSearch">
        <X :size="13" />
      </button>
    </div>

    <div ref="terminalHost" class="terminal-pane-surface xterm-surface" :style="{ backgroundColor: terminalPalette.background }" />

    <footer class="terminal-pane-status">
      <span><Circle :size="8" fill="currentColor" />{{ profile?.environment ?? 'local' }}</span>
      <span>{{ session?.state ?? t('terminal.noSession') }}</span>
      <span>{{ terminalEncodingLabel }}</span>
      <span>{{ columns }} × {{ rows }}</span>
    </footer>
  </section>
</template>

<style scoped>
.terminal-pane {
  display: grid;
  grid-template-rows: 29px minmax(0, 1fr) 22px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--terminal-bg));
}

.terminal-pane.searching {
  grid-template-rows: 29px auto minmax(0, 1fr) 22px;
}

.terminal-pane.focused {
  box-shadow: inset 0 0 0 1px hsl(var(--ring));
}

.terminal-pane-header,
.terminal-pane-status {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-inline: 7px;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--card));
  font-size: 9px;
}

.terminal-pane-header {
  border-bottom: 1px solid hsl(var(--border));
}

.terminal-pane-heading,
.terminal-pane-actions,
.terminal-pane-status span {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.terminal-pane-heading strong {
  overflow: hidden;
  color: hsl(var(--foreground));
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-pane-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-pane-actions {
  flex: 0 0 auto;
}

.terminal-pane-actions .icon-button {
  width: 22px;
  height: 22px;
}

.pane-reconnect {
  height: 21px;
  padding-inline: 7px;
  border: 1px solid hsl(var(--border));
  border-radius: 3px;
  color: hsl(var(--foreground));
  background: hsl(var(--secondary));
  font-size: 9px;
}

.pane-reconnect:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.terminal-search {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-bottom: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  background: hsl(var(--card));
}

.terminal-search input {
  width: min(320px, 48%);
  min-width: 48px;
  height: 23px;
  padding-inline: 6px;
  border: 1px solid hsl(var(--input));
  border-radius: 3px;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  font-size: 10px;
}

.terminal-search input:focus-visible {
  outline: 1px solid hsl(var(--ring));
}

.terminal-search-position {
  min-width: 54px;
  overflow: hidden;
  font-size: 9px;
  text-align: end;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-pane-surface {
  min-width: 0;
  min-height: 0;
  padding: 8px 10px;
  overflow: hidden;
  background: hsl(var(--terminal-bg));
}

.terminal-pane-surface :deep(.xterm) {
  height: 100%;
}

.terminal-pane-surface :deep(.xterm-viewport) {
  scrollbar-color: hsl(var(--muted-foreground) / 0.35) transparent;
}

.terminal-pane-status {
  justify-content: flex-start;
  gap: 12px;
  border-top: 1px solid hsl(var(--border));
  font-size: 8px;
}
</style>
