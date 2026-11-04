<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AlertCircle, Download, ExternalLink, FileText, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSftpStore } from '@/stores/sftp';
import { useLocalFilesStore } from '@/stores/localFiles';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';

const sftp = useSftpStore();
const localFiles = useLocalFilesStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const editing = ref(false);
const draft = ref('');
const baseline = ref('');
const dirty = computed(() => editing.value && draft.value !== baseline.value);
const draftBytes = computed(() => new TextEncoder().encode(draft.value).length);
const draftWithinLimit = computed(() => draftBytes.value <= 1024 * 1024);
const quickSession = computed(() => sessions.isQuickProfile(sessions.activeSession?.profileId));

watch(() => sftp.preview, (preview) => {
  if (!preview) return;
  draft.value = preview.content;
  baseline.value = preview.content;
  editing.value = false;
}, { immediate: true });

function startEditing(): void {
  if (!sftp.preview || sftp.preview.truncated) return;
  draft.value = sftp.preview.content;
  baseline.value = sftp.preview.content;
  sftp.previewError = null;
  editing.value = true;
}

async function close(): Promise<void> {
  if (sftp.savingPreview) return;
  if (dirty.value) {
    const accepted = await ui.confirm({
      title: t('inspector.discardChanges'),
      message: t('inspector.discardChangesConfirm'),
      confirmLabel: t('inspector.discardChanges'),
      danger: true,
    });
    if (!accepted) return;
  }
  editing.value = false;
  sftp.closePreview();
}

async function cancelEditing(): Promise<void> {
  if (sftp.savingPreview) return;
  if (dirty.value) {
    const accepted = await ui.confirm({
      title: t('inspector.discardChanges'),
      message: t('inspector.discardChangesConfirm'),
      confirmLabel: t('inspector.discardChanges'),
      danger: true,
    });
    if (!accepted) return;
  }
  editing.value = false;
  draft.value = baseline.value;
  sftp.previewError = null;
}

async function save(): Promise<void> {
  if (!draftWithinLimit.value || !dirty.value) return;
  if (await sftp.savePreview(draft.value)) {
    baseline.value = draft.value;
    editing.value = false;
    if (sftp.recoveryCopyPath) {
      ui.notify(t('inspector.recoveryCopyRetained', { path: sftp.recoveryCopyPath }));
    } else {
      ui.notify(t('inspector.fileSaved'));
    }
  }
}

async function reloadRemote(): Promise<void> {
  if (!sftp.previewPath) return;
  if (dirty.value) {
    const accepted = await ui.confirm({
      title: t('inspector.reloadRemote'),
      message: t('inspector.reloadRemoteConfirm'),
      confirmLabel: t('inspector.reloadRemote'),
      danger: true,
    });
    if (!accepted) return;
  }
  const path = sftp.previewPath;
  editing.value = false;
  await sftp.previewFile(path);
}

async function download(): Promise<void> {
  if (!sftp.previewPath) return;
  if (quickSession.value) {
    ui.notify(t('quick.savedHint'));
    return;
  }
  const path = sftp.previewPath;
  await close();
  if (sftp.previewPath) return;
  if (!localFiles.listing) await localFiles.load();
  const directory = localFiles.listing?.path;
  const name = path.split('/').at(-1) ?? path;
  const separator = directory?.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const parent = directory?.replace(/[\\/]+$/, '') ?? '';
  ui.openTransfer('download', path, directory ? `${parent}${separator}${name}` : undefined, sessions.activeSession?.profileId);
}

async function openExternally(): Promise<void> {
  if (await sftp.openPreviewExternally()) ui.notify(t('inspector.externalOpenLaunched'));
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <section class="dialog remote-text-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-preview-title">
      <header class="dialog-header">
        <strong id="remote-preview-title"><FileText :size="15" />{{ t('inspector.previewTitle') }}</strong>
        <button type="button" class="icon-button" :aria-label="t('inspector.previewClose')" @click="close"><X :size="14" /></button>
      </header>
      <div class="remote-preview-meta mono">{{ sftp.previewPath }}</div>
      <p v-if="sftp.previewPath" class="dialog-note preview-external-help">{{ t('inspector.externalOpenHelp') }}</p>
      <div v-if="sftp.previewLoading" class="dialog-content preview-state">{{ t('inspector.previewLoading') }}</div>
      <div v-else-if="sftp.preview" class="remote-preview-body">
        <div v-if="sftp.previewError" class="inline-notice error preview-error">
          <AlertCircle :size="15" />
          <span>{{ t(sftp.previewError.messageKey as Parameters<typeof t>[0]) }} <code v-if="['SFTP_SAVE_ROLLBACK_FAILED', 'SFTP_SAVE_TARGET_APPEARED'].includes(sftp.previewError.code)">{{ sftp.previewError.field }}</code></span>
        </div>
        <p v-if="sftp.preview.truncated" class="dialog-note preview-truncated">{{ t('inspector.previewTruncated') }}</p>
        <p v-if="sftp.recoveryCopyPath" class="dialog-note preview-truncated">{{ t('inspector.recoveryCopyRetained', { path: sftp.recoveryCopyPath }) }}</p>
        <p v-if="editing && !draftWithinLimit" class="form-error">{{ t('inspector.editorSizeLimit') }}</p>
        <textarea v-if="editing" v-model="draft" class="remote-text-editor" :disabled="sftp.savingPreview" spellcheck="false" :aria-label="t('inspector.previewTitle')"></textarea>
        <pre v-else class="remote-text-content" tabindex="0">{{ sftp.preview.content }}</pre>
        <div class="remote-preview-footer"><span>{{ t('inspector.previewBytes', { bytes: editing ? draftBytes : sftp.preview.bytes }) }}</span></div>
      </div>
      <div v-else-if="sftp.previewError" class="dialog-content preview-state error">
        <AlertCircle :size="15" />{{ t(sftp.previewError.messageKey as Parameters<typeof t>[0]) }}
      </div>
      <footer class="dialog-footer">
        <button v-if="sftp.previewPath && !sftp.previewLoading" type="button" class="button" :disabled="sftp.externalOpening" @click="openExternally"><ExternalLink :size="12" />{{ sftp.externalOpening ? t('inspector.externalOpenLoading') : t('inspector.externalOpen') }}</button>
        <button v-if="sftp.preview && !editing && !sftp.preview.truncated && !sftp.previewError" type="button" class="button" @click="startEditing">{{ t('inspector.editFile') }}</button>
        <button v-if="sftp.preview && !sftp.previewError" type="button" class="button" :disabled="quickSession" :title="quickSession ? t('quick.savedHint') : undefined" @click="download"><Download :size="12" />{{ t('inspector.downloadFile') }}</button>
        <button v-if="editing" type="button" class="button" :disabled="sftp.savingPreview" @click="cancelEditing">{{ t('settings.cancel') }}</button>
        <button v-if="editing" type="button" class="button primary" :disabled="!dirty || !draftWithinLimit || sftp.savingPreview || ['SFTP_PREVIEW_CONFLICT', 'SFTP_SAVE_ROLLBACK_FAILED', 'SFTP_SAVE_TARGET_APPEARED'].includes(sftp.previewError?.code ?? '')" @click="save">{{ sftp.savingPreview ? t('inspector.savingFile') : t('inspector.saveFile') }}</button>
        <button v-if="sftp.previewError?.code === 'SFTP_PREVIEW_CONFLICT'" type="button" class="button" :disabled="sftp.savingPreview" @click="reloadRemote">{{ t('inspector.reloadRemote') }}</button>
        <button type="button" class="button" :disabled="sftp.savingPreview" @click="close">{{ t('inspector.previewClose') }}</button>
      </footer>
    </section>
  </div>
</template>
