<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ArrowDownToLine, ArrowUpFromLine, ShieldAlert, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSettingsStore } from '@/stores/settings';
import { useSftpStore } from '@/stores/sftp';
import { useLocalFilesStore } from '@/stores/localFiles';
import { useTransfersStore } from '@/stores/transfers';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { ConflictPolicy } from '@/types/contracts';

const ui = useUiStore();
const transfers = useTransfersStore();
const connections = useConnectionsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
const sftp = useSftpStore();
const localFiles = useLocalFilesStore();
const confirmedOverwrite = ref(false);
const direction = computed(() => ui.transferDialog?.direction ?? 'upload');
const profileId = computed(() => ui.transferDialog?.profileId
  ?? sessions.activeSession?.profileId
  ?? connections.activeProfile?.id);
const quickTarget = computed(() => sessions.isQuickProfile(profileId.value));
const selectedRemote = computed(() => sftp.entries.find((entry) => entry.path === ui.transferDialog?.remotePath) ?? null);
const selectedLocal = computed(() => localFiles.listing?.entries.find((entry) => entry.path === ui.transferDialog?.localPath) ?? null);
const form = reactive<{ localPath: string; remotePath: string; conflictPolicy: ConflictPolicy }>({
  localPath: ui.transferDialog?.localPath ?? '',
  remotePath: ui.transferDialog?.remotePath ?? '',
  conflictPolicy: 'ask',
});

function close(): void {
  ui.closeTransfer();
}

async function submit(): Promise<void> {
  if (!profileId.value || !form.localPath.trim() || !form.remotePath.trim()) return;
  if (quickTarget.value) {
    ui.notify(t('quick.savedHint'));
    ui.closeTransfer();
    return;
  }
  if (form.conflictPolicy === 'overwrite' && !confirmedOverwrite.value) return;
  const queued = await transfers.enqueue({
    profileId: profileId.value,
    direction: direction.value,
    localPath: form.localPath.trim(),
    remotePath: form.remotePath.trim(),
    conflictPolicy: form.conflictPolicy,
    totalBytes: direction.value === 'upload'
      ? (selectedLocal.value?.isDirectory ? null : selectedLocal.value?.size ?? null)
      : (selectedRemote.value?.isDirectory ? null : selectedRemote.value?.size ?? null),
  });
  if (queued) {
    settings.value.taskTab = 'transfers';
    settings.value.taskDrawerOpen = true;
    ui.closeTransfer();
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div>
          <ArrowUpFromLine v-if="direction === 'upload'" :size="15" />
          <ArrowDownToLine v-else :size="15" />
          <strong id="transfer-title">{{ direction === 'upload' ? t('transfer.uploadTitle') : t('transfer.downloadTitle') }}</strong>
        </div>
        <button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <p class="dialog-note">{{ t('transfer.directoryHelp') }}</p>
        <p v-if="quickTarget" class="quick-connect-hint">{{ t('quick.savedHint') }}</p>
        <div class="form-grid">
          <label class="field full"><span>{{ t('transfer.localPath') }}</span><input v-model="form.localPath" autocomplete="off" spellcheck="false"></label>
          <label class="field full"><span>{{ t('transfer.remotePath') }}</span><input v-model="form.remotePath" autocomplete="off" spellcheck="false"></label>
          <label class="field full"><span>{{ t('transfer.conflictPolicy') }}</span>
            <select v-model="form.conflictPolicy">
              <option value="ask">{{ t('transfer.ask') }}</option>
              <option value="overwrite">{{ t('transfer.overwrite') }}</option>
              <option value="skip">{{ t('transfer.skip') }}</option>
              <option value="rename">{{ t('transfer.rename') }}</option>
            </select>
          </label>
        </div>
        <label v-if="form.conflictPolicy === 'overwrite'" class="trust-confirm overwrite-confirm">
          <input v-model="confirmedOverwrite" type="checkbox">
          <ShieldAlert :size="13" /><span>{{ t('transfer.confirmOverwrite') }}</span>
        </label>
        <p v-if="transfers.error" class="form-error" role="alert">{{ t(transfers.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="quickTarget || !form.localPath.trim() || !form.remotePath.trim() || (form.conflictPolicy === 'overwrite' && !confirmedOverwrite)">{{ t('transfer.queue') }}</button>
      </footer>
    </form>
  </div>
</template>
