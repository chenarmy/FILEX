<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Check, Plus, Send, Trash2 } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useEventsStore } from '@/stores/events';
import { useSessionsStore } from '@/stores/sessions';
import { useSnippetsStore } from '@/stores/snippets';
import { useUiStore } from '@/stores/ui';
import type { CommandSnippet } from '@/types/contracts';

const snippets = useSnippetsStore();
const sessions = useSessionsStore();
const events = useEventsStore();
const ui = useUiStore();
const selectedId = ref<string | null>(null);
const name = ref('');
const folder = ref('');
const command = ref('');
const parameterValues = reactive<Record<string, string>>({});
const parameters = computed(() => [...new Set(
  [...command.value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined),
)]);
const unresolvedParameters = computed(() => parameters.value.filter((key) => parameterValues[key] === undefined));
const preview = computed(() => {
  let result = command.value;
  for (const key of parameters.value) {
    result = result.split(`{{${key}}}`).join(parameterValues[key] ?? `{{${key}}}`);
  }
  return result;
});
const previewBytes = computed(() => new TextEncoder().encode(preview.value).byteLength);
const previewTooLong = computed(() => previewBytes.value > 10_000);

function confirmationCommand(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are escaped on purpose
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => {
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }).replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

onMounted(() => { void snippets.load(); });

function clearEditor(): void {
  selectedId.value = null;
  name.value = '';
  folder.value = '';
  command.value = '';
  Object.keys(parameterValues).forEach((key) => delete parameterValues[key]);
}

function editSnippet(snippet: CommandSnippet): void {
  selectedId.value = snippet.id;
  name.value = snippet.name;
  folder.value = snippet.folder ?? '';
  command.value = snippet.command;
  Object.keys(parameterValues).forEach((key) => delete parameterValues[key]);
}

async function save(): Promise<void> {
  const trimmedFolder = folder.value.trim();
  const saved = await snippets.save({
    id: selectedId.value,
    name: name.value,
    folder: trimmedFolder || null,
    command: command.value,
  });
  if (saved) ui.notify(t('snippet.saved'));
}

const groupedItems = computed(() => {
  const groups = new Map<string, CommandSnippet[]>();
  for (const snippet of snippets.items) {
    const key = snippet.folder?.trim() || '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(snippet);
    else groups.set(key, [snippet]);
  }
  return [...groups.entries()].map(([groupFolder, items]) => ({ folder: groupFolder, items }));
});

async function remove(): Promise<void> {
  const snippet = snippets.items.find((item) => item.id === selectedId.value);
  if (!snippet) return;
  const accepted = await ui.confirm({
    title: t('snippet.delete'),
    message: t('snippet.deleteConfirm', { name: snippet.name }),
    confirmLabel: t('snippet.delete'),
    danger: true,
  });
  if (accepted && await snippets.remove(snippet.id)) {
    ui.notify(t('snippet.deleted'));
    clearEditor();
  }
}

async function sendToTerminal(): Promise<void> {
  const session = sessions.activeSession;
  const snippetId = selectedId.value;
  const commandText = preview.value;
  if (!session || session.state !== 'connected' || !snippetId || !commandText.trim() || previewTooLong.value || unresolvedParameters.value.length > 0) return;
  const sessionId = session.id;
  const accepted = await ui.confirm({
    title: t('snippet.sendTitle'),
    message: `${t('snippet.sendConfirm', { host: `${session.username}@${session.host}` })}${confirmationCommand(commandText)}`,
    confirmLabel: t('snippet.send'),
    danger: true,
  });
  if (!accepted) return;
  if (sessions.activeSessionId !== sessionId || sessions.summaries.find((item) => item.id === sessionId)?.state !== 'connected') {
    ui.notify(t('snippet.sendCancelled'));
    return;
  }
  const sent = await sessions.writeToSession(sessionId, new TextEncoder().encode(`${commandText}\r`));
  if (sent) {
    events.record('system', 'SNIPPET_SENT_TO_TERMINAL', 'warning', { snippetId, host: session.host });
    ui.notify(t('snippet.sent', { host: session.host }));
  }
}
</script>

<template>
  <section class="snippet-pane" :aria-label="t('snippet.title')">
    <header class="snippet-heading">
      <div><strong>{{ t('snippet.title') }}</strong><small>{{ t('snippet.description') }}</small></div>
      <button type="button" class="icon-button" :aria-label="t('snippet.new')" :title="t('snippet.new')" @click="clearEditor"><Plus :size="14" /></button>
    </header>
    <div class="snippet-list">
      <section v-for="group in groupedItems" :key="group.folder || '_'" class="snippet-group">
        <h3 v-if="group.folder">{{ group.folder }}</h3>
        <button v-for="snippet in group.items" :key="snippet.id" type="button" class="snippet-item" :class="{ selected: selectedId === snippet.id }" @click="editSnippet(snippet)">
          <strong>{{ snippet.name }}</strong><code>{{ snippet.command }}</code>
        </button>
      </section>
      <p v-if="!snippets.loading && snippets.items.length === 0" class="snippet-empty">{{ t('snippet.empty') }}</p>
    </div>
    <div class="snippet-editor">
      <label>{{ t('snippet.name') }}<input v-model="name" maxlength="100" :placeholder="t('snippet.namePlaceholder')"></label>
      <label>{{ t('snippet.folder') }}<input v-model="folder" maxlength="64" :placeholder="t('snippet.folderPlaceholder')"></label>
      <label>{{ t('snippet.command') }}<textarea v-model="command" rows="4" maxlength="10000" spellcheck="false" :placeholder="t('snippet.commandPlaceholder')" /></label>
      <div v-if="parameters.length" class="snippet-parameters">
        <label v-for="parameter in parameters" :key="parameter">{{ parameter }}<input v-model="parameterValues[parameter]" maxlength="4096" :placeholder="parameter"></label>
      </div>
      <p v-if="unresolvedParameters.length" class="snippet-hint">{{ t('snippet.fillParameters', { names: unresolvedParameters.join(', ') }) }}</p>
      <div class="snippet-preview"><small>{{ t('snippet.preview') }}</small><pre>{{ preview || t('snippet.previewEmpty') }}</pre></div>
      <p v-if="previewTooLong" class="snippet-error" role="alert">{{ t('snippet.commandTooLong', { bytes: previewBytes }) }}</p>
      <p v-if="snippets.error" class="snippet-error" role="alert">{{ t(snippets.error.messageKey as Parameters<typeof t>[0]) }}</p>
      <footer>
        <button v-if="selectedId" type="button" class="icon-button danger" :aria-label="t('snippet.delete')" :title="t('snippet.delete')" @click="remove"><Trash2 :size="14" /></button>
        <button v-if="selectedId && sessions.activeSession?.state === 'connected'" type="button" class="button danger" :disabled="previewTooLong || unresolvedParameters.length > 0" @click="sendToTerminal"><Send :size="13" />{{ t('snippet.send') }}</button>
        <button type="button" class="button primary" :disabled="snippets.saving" @click="save"><Check :size="13" />{{ t('snippet.save') }}</button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.snippet-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; color: hsl(var(--foreground)); font-size: 12px; }
.snippet-heading { display: flex; align-items: flex-start; justify-content: space-between; padding: 10px 10px 8px; border-bottom: 1px solid hsl(var(--border)); }
.snippet-heading div { display: grid; gap: 4px; }
.snippet-heading small, .snippet-preview small { color: hsl(var(--muted-foreground)); }
.snippet-list { max-height: 180px; overflow: auto; border-bottom: 1px solid hsl(var(--border)); }
.snippet-group h3 { margin: 8px 10px 2px; color: hsl(var(--muted-foreground)); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.snippet-item { display: grid; gap: 4px; width: 100%; padding: 8px 10px; text-align: left; color: inherit; border: 0; border-bottom: 1px solid hsl(var(--border)); background: transparent; cursor: pointer; }
.snippet-item:hover, .snippet-item.selected { background: hsl(var(--accent)); }
.snippet-item code { overflow: hidden; color: hsl(var(--muted-foreground)); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.snippet-empty { margin: 0; padding: 12px; color: hsl(var(--muted-foreground)); }
.snippet-editor { display: grid; gap: 9px; padding: 10px; overflow: auto; }
.snippet-editor > label, .snippet-parameters label { display: grid; gap: 5px; color: hsl(var(--muted-foreground)); }
.snippet-editor input, .snippet-editor textarea { width: 100%; min-width: 0; padding: 6px 7px; color: hsl(var(--foreground)); border: 1px solid hsl(var(--input)); border-radius: 4px; background: hsl(var(--card)); font: inherit; }
.snippet-editor textarea, .snippet-preview pre { font-family: var(--font-mono, monospace); }
.snippet-editor textarea { resize: vertical; }
.snippet-parameters { display: grid; gap: 7px; }
.snippet-preview { display: grid; gap: 5px; }
.snippet-preview pre { max-height: 100px; margin: 0; padding: 7px; overflow: auto; color: hsl(var(--foreground)); border: 1px solid hsl(var(--border)); border-radius: 4px; background: hsl(var(--background)); white-space: pre-wrap; overflow-wrap: anywhere; }
.snippet-error { margin: 0; color: hsl(var(--destructive)); }
.snippet-hint { margin: 0; color: hsl(var(--muted-foreground)); }
.snippet-editor footer { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.snippet-editor footer .danger { margin-right: auto; }
.button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; color: hsl(var(--foreground)); border: 1px solid hsl(var(--border)); border-radius: 4px; background: hsl(var(--card)); cursor: pointer; }
.button.primary { border-color: hsl(var(--primary)); background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
.button.danger { border-color: hsl(var(--destructive)); color: hsl(var(--destructive)); }
.button:disabled { opacity: .6; cursor: wait; }
</style>
