import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewLocalText, saveLocalText } from '@/api/domain/localFilesApi';
import { previewRemoteText, saveRemoteText } from '@/api/domain/sftpApi';
import { useSessionsStore } from '@/stores/sessions';
import type { AppError } from '@/types/contracts';

export interface EditorTab {
  id: string;
  side: 'local' | 'remote';
  path: string;
  name: string;
  content: string;
  revision: string;
  truncated: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: AppError | null;
}

export const EDITOR_TAB_LIMIT = 8;

/** Language ids for the Monaco editor derived from the file extension. */
export function editorLanguageForPath(path: string): string {
  const extension = path.toLowerCase().split('/').pop()?.split('.').pop() ?? '';
  switch (extension) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': return 'json';
    case 'md': return 'markdown';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'hpp': return 'cpp';
    case 'cs': return 'csharp';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'html': return 'html';
    case 'xml': case 'svg': return 'xml';
    case 'yml': case 'yaml': return 'yaml';
    case 'toml': return 'ini';
    case 'ini': case 'conf': case 'cfg': return 'ini';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'sql': return 'sql';
    case 'dockerfile': return 'dockerfile';
    default:
      if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
      return 'plaintext';
  }
}

export const useEditorStore = defineStore('editor', () => {
  const tabs = ref<EditorTab[]>([]);
  const activeTabId = ref<string | null>(null);
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null);
  let loadGeneration = new Map<string, number>();

  function busy(): boolean {
    return tabs.value.some((tab) => tab.loading || tab.saving);
  }

  async function open(side: 'local' | 'remote', path: string): Promise<void> {
    if (!path || path.includes('\0')) return;
    const existing = tabs.value.find((tab) => tab.side === side && tab.path === path);
    if (existing) {
      activeTabId.value = existing.id;
      if (!existing.dirty) void reload(existing.id);
      return;
    }
    const tab: EditorTab = {
      id: crypto.randomUUID(),
      side,
      path,
      name: path.split('/').pop() || path,
      content: '',
      revision: '',
      truncated: false,
      dirty: false,
      loading: true,
      saving: false,
      error: null,
    };
    if (tabs.value.length >= EDITOR_TAB_LIMIT) {
      const closable = tabs.value.find((candidate) => !candidate.dirty && candidate.id !== activeTabId.value);
      if (!closable) return;
      close(closable.id);
    }
    tabs.value.push(tab);
    activeTabId.value = tab.id;
    await loadTab(tab.id);
  }

  async function reload(tabId: string): Promise<void> {
    await loadTab(tabId);
  }

  async function loadTab(tabId: string): Promise<void> {
    const tab = tabs.value.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const generation = (loadGeneration.get(tabId) ?? 0) + 1;
    loadGeneration.set(tabId, generation);
    tab.loading = true;
    tab.error = null;
    try {
      const sessionId = currentSessionId();
      if (tab.side === 'remote' && !sessionId) {
        tab.error = {
          code: 'SESSION_NOT_FOUND',
          messageKey: 'errors.sessionNotFound',
          retryable: false,
          remoteState: 'not_applicable',
        };
        return;
      }
      const result = tab.side === 'remote'
        ? await previewRemoteText(sessionId as string, tab.path)
        : await previewLocalText(tab.path);
      if ((loadGeneration.get(tabId) ?? 0) !== generation) return;
      if (!result.ok) {
        tab.error = result.error;
        return;
      }
      tab.content = result.data.content;
      tab.revision = result.data.revision;
      tab.truncated = result.data.truncated;
      tab.dirty = false;
    } finally {
      if ((loadGeneration.get(tabId) ?? 0) === generation) tab.loading = false;
    }
  }

  function currentSessionId(): string | null {
    return useSessionsStore().activeSessionId;
  }

  function updateContent(tabId: string, content: string): void {
    const tab = tabs.value.find((candidate) => candidate.id === tabId);
    if (!tab || tab.content === content) return;
    tab.content = content;
    tab.dirty = true;
  }

  async function save(tabId: string): Promise<boolean> {
    const tab = tabs.value.find((candidate) => candidate.id === tabId);
    if (!tab || tab.saving || tab.loading || tab.truncated) return false;
    tab.saving = true;
    tab.error = null;
    try {
      const sessionId = currentSessionId();
      if (tab.side === 'remote' && !sessionId) {
        tab.error = {
          code: 'SESSION_NOT_FOUND',
          messageKey: 'errors.sessionNotFound',
          retryable: false,
          remoteState: 'not_applicable',
        };
        return false;
      }
      const result = tab.side === 'remote'
        ? await saveRemoteText(sessionId as string, tab.path, tab.content, tab.revision)
        : await saveLocalText(tab.path, tab.content, tab.revision);
      if (!result.ok) {
        tab.error = result.error;
        return false;
      }
      tab.revision = result.data.revision;
      tab.dirty = false;
      return true;
    } finally {
      tab.saving = false;
    }
  }

  function close(tabId: string): void {
    loadGeneration.delete(tabId);
    tabs.value = tabs.value.filter((tab) => tab.id !== tabId);
    if (activeTabId.value === tabId) activeTabId.value = tabs.value.at(-1)?.id ?? null;
  }

  function clear(): void {
    loadGeneration = new Map();
    tabs.value = [];
    activeTabId.value = null;
  }

  return {
    tabs, activeTabId, activeTab, busy,
    open, reload, updateContent, save, close, clear,
  };
});
