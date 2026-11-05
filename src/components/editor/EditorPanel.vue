<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FileCode2, RefreshCw, Save, X } from 'lucide-vue-next';
import type * as MonacoApi from 'monaco-editor/editor/editor.api';
import { t } from '@/i18n';
import { editorLanguageForPath, useEditorStore } from '@/stores/editor';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';

const editor = useEditorStore();
const settings = useSettingsStore();
const ui = useUiStore();
const host = ref<HTMLElement | null>(null);
const loadingMonaco = ref(false);
const monacoFailed = ref(false);

let monaco: typeof MonacoApi | null = null;
let editorInstance: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let resizeObserver: ResizeObserver | null = null;
const models = new Map<string, MonacoApi.editor.ITextModel>();

const appearance = computed(() => {
  const preference = settings.value.terminalTheme;
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return settings.value.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : settings.value.theme;
});

async function ensureMonaco(): Promise<void> {
  if (monaco || loadingMonaco.value || monacoFailed.value) return;
  loadingMonaco.value = true;
  try {
    const [monacoModule, editorWorker] = await Promise.all([
      import('monaco-editor/editor/editor.api'),
      import('monaco-editor/editor/editor.worker?worker').then((worker) => worker.default),
    ] as const);
    monaco = monacoModule;
    (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new editorWorker(),
    };
  } catch {
    monacoFailed.value = true;
  } finally {
    loadingMonaco.value = false;
  }
}

function modelFor(tab: { id: string; path: string; content: string }): MonacoApi.editor.ITextModel | null {
  if (!monaco) return null;
  const cached = models.get(tab.id);
  if (cached) return cached;
  const uri = monaco.Uri.parse(`filex-editor://open/${encodeURIComponent(tab.id)}/${tab.path.replace(/^\/+/, '')}`);
  const model = monaco.editor.createModel(tab.content, editorLanguageForPath(tab.path), uri);
  models.set(tab.id, model);
  return model;
}

function bindActiveTab(): void {
  const tab = editor.activeTab;
  if (!editorInstance) return;
  if (!tab) {
    editorInstance.setModel(null);
    return;
  }
  const model = modelFor(tab);
  if (!model) return;
  if (model.getValue() !== tab.content) model.setValue(tab.content);
  editorInstance.setModel(model);
  editorInstance.updateOptions({ readOnly: tab.loading || tab.truncated });
}

function handleEdit(): void {
  const tab = editor.activeTab;
  if (!tab || !editorInstance) return;
  editor.updateContent(tab.id, editorInstance.getValue());
}

async function saveActive(): Promise<void> {
  const tab = editor.activeTab;
  if (!tab || !tab.dirty || tab.saving || tab.loading) return;
  if (await editor.save(tab.id)) ui.notify(t('editor.saved', { name: tab.name }));
}

async function reloadActive(): Promise<void> {
  const tab = editor.activeTab;
  if (!tab || tab.loading) return;
  await editor.reload(tab.id);
  if (editorInstance) editorInstance.setValue(tab.content);
}

function closeTab(tabId: string): void {
  models.get(tabId)?.dispose();
  models.delete(tabId);
  editor.close(tabId);
}

onMounted(async () => {
  await ensureMonaco();
  if (!monaco || !host.value) return;
  editorInstance = monaco.editor.create(host.value, {
    theme: appearance.value === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: Math.max(11, settings.value.terminalFontSize),
    renderWhitespace: 'selection',
    tabSize: 2,
  });
  editorInstance.onDidChangeModelContent(handleEdit);
  editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
  resizeObserver = new ResizeObserver(() => editorInstance?.layout());
  resizeObserver.observe(host.value);
  await nextTick();
  editorInstance.layout();
  bindActiveTab();
});

watch(
  () => editor.activeTabId,
  () => void bindActiveTab(),
);

watch(
  () => [editor.activeTab?.id, editor.activeTab?.loading] as const,
  () => {
    const tab = editor.activeTab;
    if (tab && editorInstance && !tab.loading && editorInstance.getValue() !== tab.content) {
      editorInstance.setValue(tab.content);
    }
    editorInstance?.updateOptions({ readOnly: Boolean(tab && (tab.loading || tab.truncated)) });
  },
);

watch(appearance, (value) => {
  editorInstance?.updateOptions({ theme: value === 'dark' ? 'vs-dark' : 'vs' });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  editorInstance?.dispose();
  for (const model of models.values()) model.dispose();
  models.clear();
  editorInstance = null;
});

function tabBadge(side: 'local' | 'remote'): string {
  return side === 'local' ? t('inspector.localPane') : t('inspector.remotePane');
}
</script>

<template>
  <section class="editor-panel" :aria-label="t('editor.title')">
    <header class="editor-tabs" role="tablist" :aria-label="t('editor.title')">
      <div v-if="editor.tabs.length === 0" class="editor-empty-tabs">{{ t('editor.empty') }}</div>
      <div
        v-for="tab in editor.tabs"
        :key="tab.id"
        class="editor-tab-item"
        :class="{ active: tab.id === editor.activeTabId }"
      >
        <button
          type="button"
          class="editor-tab"
          role="tab"
          :aria-selected="tab.id === editor.activeTabId"
          @click="editor.activeTabId = tab.id"
        >
          <FileCode2 :size="11" />
          <span class="editor-tab-name">{{ tab.name }}</span>
          <span v-if="tab.dirty" class="editor-tab-dirty" :aria-label="t('editor.unsaved')" />
          <small class="editor-tab-side">{{ tabBadge(tab.side) }}</small>
        </button>
        <button
          type="button"
          class="editor-tab-close"
          :aria-label="t('editor.closeTab', { name: tab.name })"
          @click="closeTab(tab.id)"
        >
          <X :size="11" />
        </button>
      </div>
      <span class="editor-tabs-spacer" />
      <button
        type="button"
        class="icon-button"
        :disabled="!editor.activeTab || editor.activeTab.loading"
        :aria-label="t('editor.reload')"
        :title="t('editor.reload')"
        @click="reloadActive"
      >
        <RefreshCw :size="12" />
      </button>
      <button
        type="button"
        class="icon-button"
        :disabled="!editor.activeTab || !editor.activeTab.dirty || editor.activeTab.saving"
        :aria-label="t('editor.save')"
        :title="t('editor.save')"
        @click="saveActive"
      >
        <Save :size="12" />
      </button>
    </header>
    <div class="editor-body">
      <div ref="host" class="editor-host" />
      <div v-if="loadingMonaco" class="editor-overlay">{{ t('editor.loading') }}</div>
      <div v-else-if="monacoFailed" class="editor-overlay error">{{ t('editor.loadFailed') }}</div>
      <div v-else-if="editor.tabs.length === 0" class="editor-overlay">{{ t('editor.emptyHelp') }}</div>
      <template v-else-if="editor.activeTab">
        <div v-if="editor.activeTab.loading" class="editor-overlay">{{ t('editor.loadingFile') }}</div>
        <div v-else-if="editor.activeTab.error" class="editor-overlay error">
          {{ t(editor.activeTab.error.messageKey as Parameters<typeof t>[0]) }}
        </div>
        <div v-else-if="editor.activeTab.truncated" class="editor-overlay warning">
          {{ t('editor.truncated') }}
        </div>
      </template>
    </div>
  </section>
</template>
