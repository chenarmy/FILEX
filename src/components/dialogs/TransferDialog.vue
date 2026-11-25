<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, FolderOpen, ShieldAlert, X } from 'lucide-vue-next';
import { selectLocalDirectory } from '@/api/domain/filePickerApi';
import { extractLocalParentDirectory } from '@/domain/fileSelection';
import { joinDirectoryPath } from '@/domain/directoryNavigation';
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
const direction = computed(() => ui.transferDialog?.direction ?? 'upload');
const initialConflictPolicy: ConflictPolicy = ui.transferDialog?.direction === 'upload'
  ? settings.value.uploadConflictPolicy
  : 'ask';
const confirmedOverwrite = ref(initialConflictPolicy === 'overwrite');
const confirmedRelayEndpoints = ref(false);
const destinationPathTouched = ref(Boolean(ui.transferDialog?.destinationRemotePath));
const isRelay = computed(() => direction.value === 'remote_to_remote');
const profileId = computed(() => ui.transferDialog?.profileId
  ?? sessions.activeSession?.profileId
  ?? connections.activeProfile?.id);
const activeProfileId = computed(() => (
  sessions.activeSession?.profileId
  ?? connections.activeProfile?.id
  ?? null
));
const selectedRemote = computed(() => sftp.entries.find((entry) => entry.path === ui.transferDialog?.remotePath) ?? null);
const selectedLocal = computed(() => localFiles.listing?.entries.find((entry) => entry.path === ui.transferDialog?.localPath) ?? null);

function profileDisplay(id: string | null | undefined): string {
  if (!id) return '—';
  const profile = sessions.profileForId(id);
  if (profile) return `${profile.name} (${profile.username}@${profile.host}:${profile.port})`;
  const session = sessions.summaries.find((item) => item.profileId === id && item.state === 'connected');
  if (session) return `${session.username}@${session.host}:${session.port}`;
  return id;
}

const destinationOptions = computed(() => {
  const seen = new Set<string>();
  return sessions.summaries
    .filter((item) => item.sessionKind === 'ssh' && item.state === 'connected')
    .filter((item) => {
      if (seen.has(item.profileId)) return false;
      seen.add(item.profileId);
      return true;
    })
    .map((item) => ({
      profileId: item.profileId,
      label: profileDisplay(item.profileId),
      remoteCwd: sessions.sessionCwd(item.id) || '/tmp',
    }));
});

function defaultRelayDestinationPath(destProfileId: string, sourcePath: string): string {
  const cleanSource = sourcePath.trim().replace(/\/+$/, '');
  if (!cleanSource) return '';
  if (destProfileId && destProfileId === profileId.value) return `${cleanSource}.relay`;
  const option = destinationOptions.value.find((item) => item.profileId === destProfileId);
  const baseName = cleanSource.split('/').filter(Boolean).pop() ?? 'transfer-item';
  const dir = (option?.remoteCwd ?? '/tmp').replace(/\/+$/, '');
  return dir ? `${dir}/${baseName}` : `/${baseName}`;
}

const initialDestProfileId = ui.transferDialog?.destinationProfileId
  ?? destinationOptions.value.find((item) => item.profileId !== profileId.value)?.profileId
  ?? destinationOptions.value[0]?.profileId
  ?? '';

const form = reactive<{
  localPath: string;
  remotePath: string;
  destinationProfileId: string;
  destinationRemotePath: string;
  conflictPolicy: ConflictPolicy;
}>({
  localPath: ui.transferDialog?.localPath ?? '',
  remotePath: ui.transferDialog?.remotePath ?? '',
  destinationProfileId: initialDestProfileId,
  destinationRemotePath: ui.transferDialog?.destinationRemotePath
    ?? (ui.transferDialog?.direction === 'remote_to_remote'
      ? defaultRelayDestinationPath(initialDestProfileId, ui.transferDialog?.remotePath ?? '')
      : ''),
  conflictPolicy: initialConflictPolicy,
});

const needsRelayEndpointConfirm = computed(() => (
  isRelay.value && (
    profileId.value !== activeProfileId.value
    || form.destinationProfileId !== activeProfileId.value
  )
));
const relaySameEndpoint = computed(() => (
  isRelay.value
  && Boolean(profileId.value)
  && form.destinationProfileId === profileId.value
  && form.remotePath.trim() !== ''
  && form.remotePath.trim() === form.destinationRemotePath.trim()
));
const submitDisabled = computed(() => (
  (isRelay.value
    ? (
      !profileId.value
      || !form.destinationProfileId
      || !form.remotePath.trim()
      || !form.destinationRemotePath.trim()
      || relaySameEndpoint.value
      || (needsRelayEndpointConfirm.value && !confirmedRelayEndpoints.value)
    )
    : (!form.localPath.trim() || !form.remotePath.trim()))
  || (form.conflictPolicy === 'overwrite' && !confirmedOverwrite.value)
));

function handleDestinationProfileChange(): void {
  confirmedRelayEndpoints.value = false;
  if (!destinationPathTouched.value) {
    form.destinationRemotePath = defaultRelayDestinationPath(form.destinationProfileId, form.remotePath);
  }
}

async function chooseDownloadFolder(): Promise<void> {
  const selected = await selectLocalDirectory(t('transfer.chooseDownloadFolderTitle'));
  if (!selected.ok) {
    ui.notify(t(selected.error.messageKey as Parameters<typeof t>[0]));
    return;
  }
  if (!selected.data) return;
  const baseName = form.remotePath.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop()
    ?? form.localPath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
    ?? 'download';
  form.localPath = joinDirectoryPath(selected.data, baseName);
}

function close(): void {
  ui.closeTransfer();
}

async function submit(): Promise<void> {
  if (submitDisabled.value || !profileId.value) return;
  const task = await transfers.enqueueTask({
    profileId: profileId.value,
    direction: direction.value,
    localPath: isRelay.value ? '' : form.localPath.trim(),
    remotePath: form.remotePath.trim(),
    ...(isRelay.value
      ? {
        destinationProfileId: form.destinationProfileId,
        destinationRemotePath: form.destinationRemotePath.trim(),
      }
      : {}),
    conflictPolicy: form.conflictPolicy,
    totalBytes: direction.value === 'upload'
      ? (selectedLocal.value?.isDirectory ? null : selectedLocal.value?.size ?? null)
      : ((selectedRemote.value?.isDirectory || selectedRemote.value?.isSymlink) ? null : selectedRemote.value?.size ?? null),
  });
  if (task) {
    if (direction.value === 'download') {
      const parentDir = extractLocalParentDirectory(form.localPath.trim());
      if (parentDir) transfers.trackDownloadBatch(parentDir, [task.id]);
    }
    settings.value.taskTab = 'transfers';
    ui.closeTransfer();
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div>
          <ArrowLeftRight v-if="isRelay" :size="15" />
          <ArrowUpFromLine v-else-if="direction === 'upload'" :size="15" />
          <ArrowDownToLine v-else :size="15" />
          <strong id="transfer-title">{{ isRelay ? t('transfer.relayTitle') : direction === 'upload' ? t('transfer.uploadTitle') : t('transfer.downloadTitle') }}</strong>
        </div>
        <button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <p class="dialog-note">{{ t('transfer.directoryHelp') }}</p>
        <p v-if="isRelay" class="dialog-note relay-note">{{ t('transfer.relayNote') }}</p>
        <div class="form-grid">
          <template v-if="isRelay">
            <label class="field full">
              <span>{{ t('transfer.sourceHost') }}</span>
              <input :value="profileDisplay(profileId)" readonly class="mono">
            </label>
            <label class="field full">
              <span>{{ t('transfer.sourceRemotePath') }}</span>
              <input v-model="form.remotePath" autocomplete="off" spellcheck="false" class="mono">
            </label>
            <label class="field full">
              <span>{{ t('transfer.destinationHost') }}</span>
              <select v-model="form.destinationProfileId" :disabled="destinationOptions.length === 0" @change="handleDestinationProfileChange">
                <option v-if="destinationOptions.length === 0" value="">{{ t('transfer.noConnectedDestination') }}</option>
                <option v-for="option in destinationOptions" :key="option.profileId" :value="option.profileId">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label class="field full">
              <span>{{ t('transfer.destinationRemotePath') }}</span>
              <input v-model="form.destinationRemotePath" autocomplete="off" spellcheck="false" class="mono" @input="destinationPathTouched = true">
            </label>
          </template>
          <template v-else>
            <label class="field full">
              <span>{{ t('transfer.localPath') }}</span>
              <div class="setting-control-group">
                <input v-model="form.localPath" autocomplete="off" spellcheck="false">
                <button
                  v-if="direction === 'download'"
                  type="button"
                  class="button"
                  :title="t('transfer.chooseDownloadFolder')"
                  @click="chooseDownloadFolder"
                >
                  <FolderOpen :size="13" />
                </button>
              </div>
            </label>
            <label class="field full"><span>{{ t('transfer.remotePath') }}</span><input v-model="form.remotePath" autocomplete="off" spellcheck="false"></label>
          </template>
          <label class="field full"><span>{{ t('transfer.conflictPolicy') }}</span>
            <select v-model="form.conflictPolicy">
              <option value="ask">{{ t('transfer.ask') }}</option>
              <option value="overwrite">{{ t('transfer.overwrite') }}</option>
              <option value="skip">{{ t('transfer.skip') }}</option>
              <option value="rename">{{ t('transfer.rename') }}</option>
            </select>
          </label>
        </div>
        <p v-if="relaySameEndpoint" class="form-error" role="alert">{{ t('transfer.sameEndpoint') }}</p>
        <label v-if="needsRelayEndpointConfirm" class="trust-confirm overwrite-confirm">
          <input v-model="confirmedRelayEndpoints" type="checkbox">
          <ShieldAlert :size="13" /><span>{{ t('transfer.confirmRelayEndpoints', { source: profileDisplay(profileId), destination: profileDisplay(form.destinationProfileId) }) }}</span>
        </label>
        <label v-if="form.conflictPolicy === 'overwrite'" class="trust-confirm overwrite-confirm">
          <input v-model="confirmedOverwrite" type="checkbox">
          <ShieldAlert :size="13" /><span>{{ t('transfer.confirmOverwrite') }}</span>
        </label>
        <p v-if="transfers.error" class="form-error" role="alert">{{ t(transfers.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="submitDisabled">{{ t('transfer.queue') }}</button>
      </footer>
    </form>
  </div>
</template>
