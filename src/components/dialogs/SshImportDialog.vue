<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CircleAlert, FileInput, LoaderCircle, ShieldAlert, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';

const connections = useConnectionsStore();
const ui = useUiStore();
const loading = ref(true);
const importing = ref(false);
const selectedAliases = ref<string[]>([]);

const preview = computed(() => connections.sshImportPreview);
const selectedCount = computed(() => selectedAliases.value.length);
const localizedPreviewWarnings = computed(() => preview.value?.warnings.map(localizeWarning) ?? []);

function localizeWarning(warning: string): string {
  if (warning === 'User is missing') return t('profile.sshConfigUserMissingWarning');
  const invalidPort = /^invalid Port (.+)$/.exec(warning);
  if (invalidPort?.[1]) return t('profile.sshConfigInvalidPortWarning', { port: invalidPort[1] });
  const unsupportedDirective = /^unsupported directive (.+)$/.exec(warning);
  if (unsupportedDirective?.[1]) return t('profile.sshConfigUnsupportedDirectiveWarning', { directive: unsupportedDirective[1] });
  const malformedDirective = /^line (\d+): malformed directive$/.exec(warning);
  if (malformedDirective?.[1]) return t('profile.sshConfigMalformedWarning', { line: malformedDirective[1] });
  const skippedPattern = /^line (\d+): skipped pattern Host (.+)$/.exec(warning);
  if (skippedPattern?.[1] && skippedPattern[2]) {
    return t('profile.sshConfigSkippedPatternWarning', {
      line: skippedPattern[1],
      host: skippedPattern[2],
    });
  }
  return warning;
}

onMounted(async () => {
  try {
    if (await connections.previewSshConfig() && preview.value) {
      selectedAliases.value = preview.value.candidates
        .filter((candidate) => candidate.username.length > 0)
        .map((candidate) => candidate.alias);
    }
  } finally {
    loading.value = false;
  }
});

function toggle(alias: string, checked: boolean): void {
  selectedAliases.value = checked
    ? [...new Set([...selectedAliases.value, alias])]
    : selectedAliases.value.filter((value) => value !== alias);
}

async function submit(): Promise<void> {
  if (selectedAliases.value.length === 0) return;
  importing.value = true;
  try {
    const count = await connections.importSshConfig(selectedAliases.value);
    if (count > 0) {
      ui.closeSshImport();
      ui.notify(t('profile.importedCount', { count }));
    }
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="ui.closeSshImport" @keydown.esc="ui.closeSshImport">
    <section class="dialog ssh-import-dialog" role="dialog" aria-modal="true" aria-labelledby="ssh-import-title">
      <header class="dialog-header">
        <div><FileInput :size="15" /><strong id="ssh-import-title">{{ t('profile.importSshConfig') }}</strong></div>
        <button type="button" class="icon-button" :aria-label="t('profile.cancel')" @click="ui.closeSshImport"><X :size="14" /></button>
      </header>
      <div class="dialog-body ssh-import-body">
        <div v-if="loading" class="pane-state"><LoaderCircle :size="18" class="spin" />{{ t('profile.importLoading') }}</div>
        <div v-else-if="connections.error" class="inline-notice error" role="alert">
          <CircleAlert :size="14" />
          <span>{{ t(connections.error.messageKey as Parameters<typeof t>[0]) }}</span>
        </div>
        <template v-else-if="preview">
          <p class="ssh-import-source mono">{{ preview.sourcePath }}</p>
          <div class="inline-notice"><ShieldAlert :size="14" /><span>{{ t('profile.importCapabilityNotice') }}</span></div>
          <div v-if="localizedPreviewWarnings.length" class="inline-notice"><ShieldAlert :size="14" /><span>{{ localizedPreviewWarnings.join(' · ') }}</span></div>
          <div class="ssh-import-list">
            <label v-for="candidate in preview.candidates" :key="candidate.alias" class="ssh-import-row">
              <input
                type="checkbox"
                :checked="selectedAliases.includes(candidate.alias)"
                :disabled="candidate.username.length === 0"
                @change="toggle(candidate.alias, ($event.target as HTMLInputElement).checked)"
              >
              <span>
                <strong>{{ candidate.alias }}</strong>
                <small class="mono">{{ candidate.username || '—' }}@{{ candidate.host }}:{{ candidate.port }}</small>
              </span>
              <span v-if="candidate.warnings.length || candidate.identityFile || candidate.proxyJump" class="ssh-import-warnings">
                <small v-for="warning in candidate.warnings" :key="warning" class="warning-text">{{ localizeWarning(warning) }}</small>
                <small v-if="candidate.identityFile" class="warning-text">{{ t('profile.importIdentityFileWarning', { path: candidate.identityFile }) }}</small>
                <small v-if="candidate.proxyJump" class="warning-text">{{ t('profile.importProxyJumpWarning', { host: candidate.proxyJump }) }}</small>
              </span>
            </label>
          </div>
          <p v-if="preview.candidates.length === 0" class="pane-state">{{ t('profile.importEmpty') }}</p>
        </template>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="ui.closeSshImport">{{ t('profile.cancel') }}</button>
        <button type="button" class="button primary" :disabled="selectedCount === 0 || importing" @click="submit">
          {{ importing ? t('profile.importing') : t('profile.importSelected', { count: selectedCount }) }}
        </button>
      </footer>
    </section>
  </div>
</template>
