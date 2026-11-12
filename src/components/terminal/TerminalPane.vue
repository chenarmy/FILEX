<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ArrowDown, ArrowUp, Bot, Circle, ClipboardPaste, Copy, Search, Trash2, X } from 'lucide-vue-next';
import '@xterm/xterm/css/xterm.css';
import { resolveTerminalPalette } from '@/domain/terminalThemes';
import { clampTerminalMenuPosition, resolveTerminalFontFamily } from '@/domain/terminalInteractions';
import { resolveCdCommand } from '@/domain/terminalCwd';
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
const terminalSurface = ref<HTMLElement | null>(null);
const terminalMenu = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const matchCount = ref(0);
const currentMatch = ref<number | null>(null);
const selectionAvailable = ref(false);
const columns = ref(120);
const rows = ref(32);
const contextMenu = ref<{
  x: number;
  y: number;
  selection: string;
  includeClear: boolean;
} | null>(null);
const systemColorScheme = ref<'dark' | 'light'>(
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
);
const terminalPalette = computed(() => {
  return resolveTerminalPalette(
    settings.value.terminalTheme,
    settings.value.theme,
    systemColorScheme.value,
  );
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
let pointerUpHandler: ((event: PointerEvent) => void) | null = null;
let contextMenuHandler: ((event: MouseEvent) => void) | null = null;
let disposeSelectionListener: (() => void) | null = null;
let disposeSearchResults: (() => void) | null = null;
let disposeOscCwd: { dispose(): void } | null = null;
let disposeResizeListener: (() => void) | null = null;
let systemThemeMedia: MediaQueryList | null = null;
let outputOffset = 0;
let outputDecoder = new TextDecoder(settings.value.terminalEncoding);
let lastResizeSignature: string | null = null;
let fontFallbackNotified = false;
let terminalInputBuffer = '';

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

async function confirmTerminalInput(text: string): Promise<boolean> {
  if (!settings.value.pasteProtection || !text.includes('\n')) return true;
  return ui.confirm({
    title: t('terminal.pasteTitle'),
    message: t('terminal.pasteConfirm').replace('{lines}', String(text.split(/\r?\n/).length)),
    confirmLabel: t('terminal.paste'),
    danger: false,
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    ui.notify(t('terminal.copied'));
    return true;
  } catch {
    ui.notify(t('terminal.copyFailed'));
    return false;
  }
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

function openContextMenuAt(event: MouseEvent | PointerEvent, includeClear: boolean): void {
  const surface = terminalSurface.value;
  if (!surface) return;
  const selection = terminal?.getSelection().trim() ?? '';
  if (!selection && !includeClear) {
    closeContextMenu();
    return;
  }
  const rect = surface.getBoundingClientRect();
  const position = clampTerminalMenuPosition(
    { x: event.clientX, y: event.clientY },
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { width: 196, height: includeClear ? 142 : 108 },
  );
  contextMenu.value = { ...position, selection, includeClear };
  void nextTick(() => {
    const menuRect = terminalMenu.value?.getBoundingClientRect();
    if (!menuRect || !contextMenu.value) return;
    const refined = clampTerminalMenuPosition(
      { x: event.clientX, y: event.clientY },
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: menuRect.width, height: menuRect.height },
    );
    contextMenu.value = { ...contextMenu.value, ...refined };
    if (includeClear) terminalMenu.value?.querySelector<HTMLButtonElement>('button')?.focus();
  });
}

async function copySelection(): Promise<void> {
  const selection = contextMenu.value?.selection ?? '';
  if (!selection) return;
  await copyText(selection);
  closeContextMenu();
  terminal?.focus();
}

async function copyAndInputSelection(): Promise<void> {
  const selection = contextMenu.value?.selection ?? '';
  if (!selection) return;
  await copyText(selection);
  if (await confirmTerminalInput(selection)) terminal?.paste(selection);
  closeContextMenu();
  terminal?.focus();
}

function searchSelection(): void {
  const selection = contextMenu.value?.selection.trim() ?? '';
  if (!selection) return;
  searchQuery.value = selection.slice(0, 256);
  closeContextMenu();
  emit('search-open');
  void nextTick(() => refreshMatch(searchQuery.value, 'next', true));
}

function clearTerminalDisplay(): void {
  terminal?.clear();
  terminal?.clearSelection();
  selectionAvailable.value = false;
  closeContextMenu();
  terminal?.focus();
}

function handleTerminalPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return;
  window.setTimeout(() => openContextMenuAt(event, false), 0);
}

function handleTerminalContextMenu(event: MouseEvent): void {
  event.preventDefault();
  openContextMenuAt(event, true);
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!contextMenu.value || terminalMenu.value?.contains(event.target as Node)) return;
  closeContextMenu();
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && contextMenu.value) {
    event.preventDefault();
    closeContextMenu();
    terminal?.focus();
  }
}

function handleContextMenuKeydown(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...(terminalMenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  if (buttons.length === 0) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const target = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : event.key === 'ArrowDown'
        ? (current + 1 + buttons.length) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
  buttons[target]?.focus();
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

function trackTerminalInput(data: string): void {
  const sessionId = props.sessionId;
  if (!sessionId) return;
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const resolved = resolveCdCommand(terminalInputBuffer, sessions.sessionCwd(sessionId));
      terminalInputBuffer = '';
      if (resolved) sessions.setSessionCwd(sessionId, resolved);
      continue;
    }
    if (character === '\x7f') {
      terminalInputBuffer = terminalInputBuffer.slice(0, -1);
      continue;
    }
    if (character === '\x03' || character === '\x1b') {
      terminalInputBuffer = '';
      continue;
    }
    if (character >= ' ' && terminalInputBuffer.length < 4_096) terminalInputBuffer += character;
  }
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
  schedulePtyResize();
}

function schedulePtyResize(force = false): void {
  if (!terminal) return;
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  const sessionId = props.sessionId;
  const fittedColumns = terminal.cols;
  const fittedRows = terminal.rows;
  const signature = sessionId ? `${sessionId}:${fittedColumns}:${fittedRows}` : null;
  if (!force && signature === lastResizeSignature) return;
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    if (sessionId && props.sessionId === sessionId) {
      lastResizeSignature = signature;
      void sessions.resizeSession(sessionId, fittedColumns, fittedRows);
    }
  }, 80);
}

function refitTerminalAfterLayout(forceResize = false): void {
  void nextTick(() => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    fitTerminal();
    if (forceResize) schedulePtyResize(true);
  })));
}

function applyTerminalFont(notifyFallback = false): void {
  if (!terminal) return;
  const resolution = resolveTerminalFontFamily(
    settings.value.terminalFontFamily,
    settings.value.terminalFontSize,
  );
  terminal.options.fontFamily = resolution.fontFamily;
  terminal.options.fontSize = settings.value.terminalFontSize;
  if (resolution.fellBack && notifyFallback && !fontFallbackNotified) {
    fontFallbackNotified = true;
    ui.notify(t('terminal.fontFallback'));
  }
  if (!resolution.fellBack) fontFallbackNotified = false;
  refitTerminalAfterLayout(true);
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
  const initialFont = resolveTerminalFontFamily(
    settings.value.terminalFontFamily,
    settings.value.terminalFontSize,
  );
  terminal = new XTerm({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    screenReaderMode: true,
    convertEol: false,
    fontFamily: initialFont.fontFamily,
    fontSize: settings.value.terminalFontSize,
    scrollback: settings.value.terminalScrollback,
    theme: terminalPalette.value,
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon({ highlightLimit: 1000 });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  const resizeListener = terminal.onResize(({ cols, rows: nextRows }) => {
    columns.value = cols;
    rows.value = nextRows;
    schedulePtyResize();
  });
  disposeResizeListener = () => resizeListener.dispose();
  const selectionListener = terminal.onSelectionChange(() => {
    selectionAvailable.value = Boolean(terminal?.getSelection().trim());
  });
  disposeSelectionListener = () => selectionListener.dispose();
  const searchResultsListener = searchAddon.onDidChangeResults((result) => {
    matchCount.value = result.resultCount;
    currentMatch.value = result.resultIndex >= 0 ? result.resultIndex + 1 : null;
  });
  disposeSearchResults = () => searchResultsListener.dispose();
  // OSC 7 (`file://host/path`) shell integration: track the working directory so
  // the file browser can follow the terminal. The payload stays in the pane.
  disposeOscCwd = terminal.parser.registerOscHandler(7, (data) => {
    const activeSessionId = props.sessionId;
    if (!activeSessionId) return false;
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    const path = match?.[1];
    if (!path) return false;
    try {
      sessions.setSessionCwd(activeSessionId, decodeURIComponent(path));
    } catch {
      // Malformed percent-encoding: ignore the report entirely.
    }
    return true;
  });

  await nextTick();
  if (terminalHost.value) terminal.open(terminalHost.value);
  const encoder = new TextEncoder();
  terminal.onData((data) => {
    trackTerminalInput(data);
    if (props.sessionId) void sessions.writeToSession(props.sessionId, encoder.encode(data));
  });
  pasteHandler = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!settings.value.pasteProtection || !text.includes('\n') || !terminal) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void confirmTerminalInput(text).then((accepted) => {
      if (accepted) terminal?.paste(text);
    });
  };
  terminal.element?.addEventListener('paste', pasteHandler, true);
  pointerUpHandler = handleTerminalPointerUp;
  contextMenuHandler = handleTerminalContextMenu;
  terminal.element?.addEventListener('pointerup', pointerUpHandler);
  terminal.element?.addEventListener('contextmenu', contextMenuHandler);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  resizeObserver = new ResizeObserver(fitTerminal);
  if (terminalHost.value) resizeObserver.observe(terminalHost.value);
  replaySession();
  fitTerminal();
  if (props.focused) terminal.focus();
  void document.fonts?.ready.then(() => applyTerminalFont(true));
});

watch(
  () => props.sessionId,
  () => {
    terminalInputBuffer = '';
    if (resizeTimer !== null) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    lastResizeSignature = null;
    closeContextMenu();
    replaySession();
    refitTerminalAfterLayout(true);
  },
);

watch(
  () => props.focused,
  (focused) => {
    if (focused && !props.searchOpen) void nextTick(() => terminal?.focus());
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
      lastResizeSignature = null;
      refitTerminalAfterLayout(true);
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
    void fontFamily;
    void fontSize;
    terminal.options.scrollback = scrollback;
    applyTerminalFont(true);
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
  if (pointerUpHandler) terminal?.element?.removeEventListener('pointerup', pointerUpHandler);
  if (contextMenuHandler) terminal?.element?.removeEventListener('contextmenu', contextMenuHandler);
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  disposeSelectionListener?.();
  disposeSearchResults?.();
  disposeResizeListener?.();
  disposeOscCwd?.dispose();
  searchAddon?.dispose();
  terminal?.dispose();
});

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemColorScheme.value = event.matches ? 'light' : 'dark';
}

function focusTerminal(): void {
  terminal?.focus();
}

function activateTerminal(): void {
  emit('focus');
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

    <div ref="terminalSurface" class="terminal-surface-shell" :style="{ backgroundColor: terminalPalette.background }" @pointerdown="activateTerminal">
      <div ref="terminalHost" class="terminal-pane-surface xterm-surface" />
      <div
        v-if="contextMenu"
        ref="terminalMenu"
        class="terminal-context-menu"
        role="menu"
        :aria-label="t('terminal.paneLabel')"
        :style="{ insetInlineStart: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @pointerdown.stop
        @keydown="handleContextMenuKeydown"
      >
        <button v-if="contextMenu.selection" type="button" role="menuitem" @click="copySelection">
          <Copy :size="13" />{{ t('terminal.copySelection') }}
        </button>
        <button v-if="contextMenu.selection" type="button" role="menuitem" @click="copyAndInputSelection">
          <ClipboardPaste :size="13" />{{ t('terminal.copyAndInput') }}
        </button>
        <button v-if="contextMenu.selection" type="button" role="menuitem" @click="searchSelection">
          <Search :size="13" />{{ t('terminal.searchSelection') }}
        </button>
        <button v-if="contextMenu.includeClear" type="button" role="menuitem" class="terminal-clear-action" @click="clearTerminalDisplay">
          <Trash2 :size="13" />{{ t('terminal.clearDisplay') }}
        </button>
      </div>
    </div>

    <footer class="terminal-pane-status">
      <span class="terminal-input-status" :class="{ active: focused }" aria-live="polite">
        <Circle :size="7" :fill="focused ? 'currentColor' : 'none'" />{{ t(focused ? 'terminal.inputActive' : 'terminal.inputInactive') }}
      </span>
      <span><Circle :size="8" fill="currentColor" />{{ profile?.environment ?? 'local' }}</span>
      <span>{{ session?.state ?? t('terminal.noSession') }}</span>
      <span>{{ terminalEncodingLabel }}</span>
      <span>{{ columns }} × {{ rows }}</span>
    </footer>
  </section>
</template>

<style scoped>
.terminal-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 0;
  background: hsl(var(--terminal-bg));
}

.terminal-pane.focused {
  box-shadow: inset 0 0 0 2px hsl(var(--ring));
}

.terminal-pane-header,
.terminal-pane-status {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-inline: 8px;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--card));
  font-size: 0.6875rem;
}

.terminal-input-status.active {
  color: hsl(var(--primary));
  font-weight: 600;
}

.terminal-pane-header {
  flex: 0 0 26px;
  height: 26px;
  border-bottom: 1px solid hsl(var(--border));
}

.terminal-pane-status {
  flex: 0 0 20px;
  height: 20px;
  border-top: 1px solid hsl(var(--border));
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
  font-size: 0.75rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-pane-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.6875rem;
}

.terminal-pane-actions {
  flex: 0 0 auto;
}

.terminal-pane-actions .icon-button {
  width: 20px;
  height: 20px;
}

.pane-reconnect {
  height: 21px;
  padding-inline: 7px;
  border: 1px solid hsl(var(--border));
  border-radius: 3px;
  color: hsl(var(--foreground));
  background: hsl(var(--secondary));
  font-size: 0.75rem;
}

.pane-reconnect:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.terminal-search {
  flex: 0 0 auto;
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
  font-size: 0.8333rem;
}

.terminal-search input:focus-visible {
  outline: 1px solid hsl(var(--ring));
}

.terminal-search-position {
  min-width: 54px;
  overflow: hidden;
  font-size: 0.75rem;
  text-align: end;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-surface-shell {
  flex: 1 1 0;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: hsl(var(--terminal-bg));
}

.terminal-pane-surface {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  padding: 8px 10px;
  overflow: hidden;
}

.terminal-pane-surface :deep(.xterm) {
  height: 100%;
}

.terminal-pane-surface :deep(.xterm-viewport) {
  scrollbar-color: hsl(var(--muted-foreground) / 0.35) transparent;
}

.terminal-context-menu {
  position: absolute;
  z-index: 8;
  display: flex;
  width: 196px;
  flex-direction: column;
  padding: 4px;
  border: 1px solid hsl(var(--border));
  border-radius: 5px;
  color: hsl(var(--popover-foreground));
  background: hsl(var(--popover));
  box-shadow: 0 8px 22px hsl(0 0% 0% / 0.34);
}

.terminal-context-menu button {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 7px;
  padding: 4px 7px;
  border: 0;
  border-radius: 3px;
  color: inherit;
  background: transparent;
  font-size: 0.8333rem;
  text-align: start;
}

.terminal-context-menu button:hover,
.terminal-context-menu button:focus-visible {
  outline: none;
  background: hsl(var(--accent));
}

.terminal-context-menu .terminal-clear-action {
  margin-top: 3px;
  padding-top: 6px;
  border-top: 1px solid hsl(var(--border));
  border-radius: 0 0 3px 3px;
  color: hsl(var(--destructive));
}

.terminal-pane-status {
  justify-content: flex-start;
  gap: 12px;
  border-top: 1px solid hsl(var(--border));
  font-size: 0.6667rem;
}
</style>
