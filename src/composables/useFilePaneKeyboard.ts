import { nextTick, reactive, ref, type ComponentPublicInstance } from 'vue';
import {
  createEmptyTypeaheadState,
  isFileCopyShortcut,
  isFilePasteShortcut,
  isTypeaheadTriggerKey,
  resolveArrowSelectionIndex,
  resolveTypeaheadMatch,
  TYPEAHEAD_RESET_MS,
  type TypeaheadState,
} from '@/domain/fileTypeahead';

export interface VirtualListScrollHandle {
  scrollToIndex: (index: number) => void;
}

export interface TypeaheadIndicator {
  pane: 'local' | 'remote';
  query: string;
  matched: boolean;
}

export interface FilePaneEntryLike {
  name: string;
  path: string;
}

function isEditableOrBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor, .xterm, .path-bookmarks-popover, [role="dialog"], [role="menu"], .dialog-layer',
    ),
  );
}

function hasTextSelection(): boolean {
  const selection = window.getSelection()?.toString() ?? '';
  return selection.length > 0;
}

export function useFilePaneKeyboard<T extends FilePaneEntryLike>(options: {
  getEntries: (pane: 'local' | 'remote') => readonly T[];
  getSelectedPath: (pane: 'local' | 'remote') => string | null;
  selectEntry: (entry: T, pane: 'local' | 'remote') => void;
  isBlocked: () => boolean;
  onCopyLocal: () => unknown;
  onPasteUpload: (pane: 'local' | 'remote', event?: ClipboardEvent) => unknown;
  onRename?: (pane: 'local' | 'remote') => unknown;
  onSelectAll?: (pane: 'local' | 'remote') => unknown;
  onClearSelection?: (pane: 'local' | 'remote') => boolean;
}) {
  const listElements = reactive<Record<'local' | 'remote', HTMLElement | null>>({
    local: null,
    remote: null,
  });
  const virtualLists = reactive<Record<'local' | 'remote', VirtualListScrollHandle | null>>({
    local: null,
    remote: null,
  });
  const typeaheadStates = reactive<Record<'local' | 'remote', TypeaheadState>>({
    local: createEmptyTypeaheadState(),
    remote: createEmptyTypeaheadState(),
  });
  const typeaheadIndicator = ref<TypeaheadIndicator | null>(null);
  let indicatorTimer: number | null = null;
  let lastPasteShortcutAt = 0;

  function bindListElement(
    pane: 'local' | 'remote',
    element: Element | ComponentPublicInstance | null,
  ): HTMLElement | null {
    const resolved = element instanceof HTMLElement ? element : null;
    listElements[pane] = resolved;
    return resolved;
  }

  function bindVirtualList(
    pane: 'local' | 'remote',
    instance: Element | ComponentPublicInstance | null,
  ): void {
    if (
      instance
      && typeof instance === 'object'
      && 'scrollToIndex' in instance
      && typeof (instance as Partial<VirtualListScrollHandle>).scrollToIndex === 'function'
    ) {
      virtualLists[pane] = instance as unknown as VirtualListScrollHandle;
    } else {
      virtualLists[pane] = null;
    }
  }

  function clearTypeahead(): void {
    typeaheadStates.local = createEmptyTypeaheadState();
    typeaheadStates.remote = createEmptyTypeaheadState();
    typeaheadIndicator.value = null;
    if (indicatorTimer !== null) {
      window.clearTimeout(indicatorTimer);
      indicatorTimer = null;
    }
  }

  function showTypeaheadIndicator(pane: 'local' | 'remote', query: string, matched: boolean): void {
    typeaheadIndicator.value = { pane, query, matched };
    if (indicatorTimer !== null) window.clearTimeout(indicatorTimer);
    indicatorTimer = window.setTimeout(() => {
      typeaheadIndicator.value = null;
      indicatorTimer = null;
    }, TYPEAHEAD_RESET_MS + 150);
  }

  function focusListContainer(pane: 'local' | 'remote'): void {
    listElements[pane]?.focus({ preventScroll: true });
  }

  async function scrollAndFocusRow(
    pane: 'local' | 'remote',
    entryPath: string,
    index: number,
  ): Promise<void> {
    const virtualList = virtualLists[pane];
    if (virtualList) {
      virtualList.scrollToIndex(index);
    }
    await nextTick();
    const listEl = listElements[pane];
    if (!listEl) return;
    const rows = listEl.querySelectorAll<HTMLElement>('.file-row');
    for (const row of rows) {
      if (row.dataset.entryPath === entryPath) {
        if (!virtualList) {
          row.scrollIntoView?.({ block: 'nearest' });
        }
        row.focus({ preventScroll: true });
        return;
      }
    }
  }

  function handlePaneKeydown(pane: 'local' | 'remote', event: KeyboardEvent): void {
    if (event.defaultPrevented || options.isBlocked() || isEditableOrBlockedTarget(event.target)) return;

    if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      if (options.getSelectedPath(pane)) {
        event.preventDefault();
        event.stopPropagation();
        clearTypeahead();
        void options.onRename?.(pane);
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
      const inFileList = event.target instanceof HTMLElement && Boolean(event.target.closest('.file-list'));
      if (inFileList && options.onSelectAll) {
        event.preventDefault();
        event.stopPropagation();
        clearTypeahead();
        if (!event.repeat) void options.onSelectAll(pane);
        return;
      }
    }

    if (isFileCopyShortcut(event)) {
      if (hasTextSelection()) return;
      if (pane === 'local') {
        event.preventDefault();
        event.stopPropagation();
        clearTypeahead();
        void options.onCopyLocal();
      }
      return;
    }

    if (isFilePasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      clearTypeahead();
      lastPasteShortcutAt = Date.now();
      void options.onPasteUpload(pane);
      return;
    }

    if (event.key === 'Escape') {
      if (typeaheadIndicator.value !== null) {
        event.preventDefault();
        event.stopPropagation();
        clearTypeahead();
        return;
      }
      if (options.onClearSelection?.(pane)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      const inFileList = event.target instanceof HTMLElement && Boolean(event.target.closest('.file-list'));
      if (!inFileList) return;
      const entries = options.getEntries(pane);
      const currentPath = options.getSelectedPath(pane);
      const currentIndex = currentPath ? entries.findIndex((entry) => entry.path === currentPath) : -1;
      const nextIndex = resolveArrowSelectionIndex(entries.length, currentIndex, event.key);
      if (nextIndex === null) return;
      const targetEntry = entries[nextIndex];
      if (!targetEntry) return;
      event.preventDefault();
      clearTypeahead();
      options.selectEntry(targetEntry, pane);
      void scrollAndFocusRow(pane, targetEntry.path, nextIndex);
      return;
    }

    if (!isTypeaheadTriggerKey(event)) return;
    const entries = options.getEntries(pane);
    if (entries.length === 0) return;

    event.preventDefault();
    event.stopPropagation();

    const result = resolveTypeaheadMatch(
      entries,
      options.getSelectedPath(pane),
      event.key,
      typeaheadStates[pane],
      Date.now(),
      TYPEAHEAD_RESET_MS,
    );
    typeaheadStates[pane] = result.nextState;
    showTypeaheadIndicator(pane, result.displayQuery, result.matched);
    if (result.entry) {
      options.selectEntry(result.entry, pane);
      void scrollAndFocusRow(pane, result.entry.path, result.index);
    }
  }

  function handlePanePaste(pane: 'local' | 'remote', event: ClipboardEvent): void {
    if (event.defaultPrevented || options.isBlocked() || isEditableOrBlockedTarget(event.target)) return;
    if (Date.now() - lastPasteShortcutAt < 120) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearTypeahead();
    void options.onPasteUpload(pane, event);
  }

  function dispose(): void {
    clearTypeahead();
  }

  return {
    typeaheadIndicator,
    bindListElement,
    bindVirtualList,
    clearTypeahead,
    focusListContainer,
    scrollAndFocusRow,
    handlePaneKeydown,
    handlePanePaste,
    dispose,
  };
}
