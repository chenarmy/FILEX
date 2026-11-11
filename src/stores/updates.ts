import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  cancelUpdateDownload,
  checkForUpdates,
  getUpdateStatus,
  installUpdate,
  type UpdateInstallEvent,
} from '@/api/domain/maintenanceApi';
import {
  normalizeUpdateVersion,
  shouldOfferUpdate,
} from '@/domain/updatePolicy';
import { t } from '@/i18n';
import {
  readUpdatePreferences,
  writeUpdatePreferences,
} from '@/runtime/updatePreferencesRepository';
import { useUiStore } from '@/stores/ui';
import type { UpdateStatus } from '@/types/contracts';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing';
type UpdateMessageKey = Parameters<typeof t>[0];

export const useUpdatesStore = defineStore('updates', () => {
  const ui = useUiStore();
  const savedPreferences = readUpdatePreferences();
  const status = ref<UpdateStatus | null>(null);
  const phase = ref<UpdatePhase>('idle');
  const dialogOpen = ref(false);
  const errorKey = ref<UpdateMessageKey | null>(null);
  const lastCheckAt = ref<number | null>(savedPreferences.lastCheckAt);
  const skippedVersion = ref<string | null>(savedPreferences.skippedVersion);
  const downloadedBytes = ref(0);
  const contentLength = ref<number | null>(null);
  const cancelling = ref(false);
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let generation = 0;

  const currentVersion = computed(() => status.value?.currentVersion ?? '—');
  const availableVersion = computed(() => normalizeUpdateVersion(status.value?.availableVersion));
  const releaseNotes = computed(() => status.value?.releaseNotes ?? null);
  const configured = computed(() => status.value?.configured === true);
  const channel = computed(() => status.value?.channel ?? 'stable');
  const hasUpdateAvailable = computed(() => shouldOfferUpdate(
    currentVersion.value,
    availableVersion.value,
    skippedVersion.value,
  ));
  const isBusy = computed(() => (
    phase.value === 'checking'
    || phase.value === 'downloading'
    || phase.value === 'installing'
  ));
  const installActive = computed(() => (
    phase.value === 'downloading' || phase.value === 'installing'
  ));
  const progressPercent = computed(() => {
    if (!contentLength.value || contentLength.value <= 0) return null;
    return Math.min(100, Math.round((downloadedBytes.value / contentLength.value) * 100));
  });
  const errorMessage = computed(() => errorKey.value ? t(errorKey.value) : null);

  function savePreferences(): void {
    writeUpdatePreferences({
      lastCheckAt: lastCheckAt.value,
      skippedVersion: skippedVersion.value,
    });
  }

  async function refreshStatus(): Promise<boolean> {
    const result = await getUpdateStatus();
    if (!result.ok) return false;
    const previous = status.value;
    const preserved = previous?.channel === result.data.channel ? previous : null;
    status.value = {
      ...result.data,
      availableVersion: preserved?.availableVersion ?? null,
      releaseNotes: preserved?.releaseNotes ?? null,
      publishedAt: preserved?.publishedAt ?? null,
    };
    if (!preserved) {
      phase.value = 'idle';
      dialogOpen.value = false;
    }
    return true;
  }

  async function initialize(force = false): Promise<void> {
    if (initialized && !force) return;
    if (initialization && !force) return initialization;
    const request = refreshStatus().then((succeeded) => {
      initialized = succeeded;
    }).finally(() => {
      if (initialization === request) initialization = null;
    });
    initialization = request;
    await request;
  }

  async function check(manual = false, showDialog = true): Promise<boolean> {
    if (phase.value === 'checking' || phase.value === 'downloading' || phase.value === 'installing') {
      return false;
    }
    await initialize();
    errorKey.value = null;
    if (!configured.value) {
      if (manual) ui.notify(t('errors.updateNotConfigured'));
      return false;
    }

    const request = ++generation;
    phase.value = 'checking';
    const result = await checkForUpdates();
    if (request !== generation) return false;
    if (!result.ok) {
      phase.value = 'idle';
      errorKey.value = result.error.messageKey as UpdateMessageKey;
      if (manual) ui.notify(t(result.error.messageKey as UpdateMessageKey));
      return false;
    }

    status.value = result.data;
    lastCheckAt.value = Date.now();
    savePreferences();
    const latest = normalizeUpdateVersion(result.data.availableVersion);
    if (!latest) {
      phase.value = 'idle';
      dialogOpen.value = false;
      if (manual) ui.notify(t('settings.upToDate'));
      return true;
    }

    if (!manual && skippedVersion.value === latest) {
      phase.value = 'idle';
      return true;
    }
    if (skippedVersion.value && skippedVersion.value !== latest) {
      skippedVersion.value = null;
      savePreferences();
    }

    phase.value = 'available';
    if (showDialog) dialogOpen.value = true;
    return true;
  }

  function openDialog(): void {
    if (availableVersion.value) dialogOpen.value = true;
  }

  function dismiss(): void {
    if (installActive.value) return;
    dialogOpen.value = false;
  }

  function skipAvailableVersion(): void {
    const version = availableVersion.value;
    if (!version || installActive.value) return;
    skippedVersion.value = version;
    savePreferences();
    phase.value = 'idle';
    dialogOpen.value = false;
    errorKey.value = null;
    ui.notify(t('updates.skipped', { version }));
  }

  function applyInstallEvent(event: UpdateInstallEvent): void {
    if (event.event === 'progress') {
      downloadedBytes.value = event.data.downloadedBytes;
      contentLength.value = event.data.contentLength;
      return;
    }
    phase.value = 'installing';
  }

  async function install(): Promise<boolean> {
    const version = availableVersion.value;
    if (!version || phase.value !== 'available') return false;
    phase.value = 'downloading';
    errorKey.value = null;
    downloadedBytes.value = 0;
    contentLength.value = null;

    const result = await installUpdate(version, applyInstallEvent);
    if (result.ok) {
      phase.value = 'installing';
      ui.notify(t('settings.updateInstalling'));
      return true;
    }

    errorKey.value = result.error.messageKey as UpdateMessageKey;
    if (result.error.code === 'UPDATE_CANCELLED') {
      phase.value = 'available';
      errorKey.value = null;
      return false;
    }
    if (result.error.code === 'UPDATE_STALE' || result.error.code === 'UPDATE_NO_AVAILABLE') {
      phase.value = 'idle';
      dialogOpen.value = false;
      if (status.value) {
        status.value = {
          ...status.value,
          availableVersion: null,
          releaseNotes: null,
          publishedAt: null,
        };
      }
    } else {
      phase.value = 'available';
    }
    ui.notify(t(result.error.messageKey as UpdateMessageKey));
    return false;
  }

  async function cancelDownload(): Promise<void> {
    if (phase.value !== 'downloading' || cancelling.value) return;
    cancelling.value = true;
    try {
      const result = await cancelUpdateDownload();
      if (result.ok) {
        ui.notify(t('settings.updateCancelRequested'));
      } else {
        ui.notify(t(result.error.messageKey as UpdateMessageKey));
      }
    } finally {
      cancelling.value = false;
    }
  }

  return {
    status,
    phase,
    dialogOpen,
    errorKey,
    errorMessage,
    lastCheckAt,
    skippedVersion,
    downloadedBytes,
    contentLength,
    cancelling,
    currentVersion,
    availableVersion,
    releaseNotes,
    configured,
    channel,
    hasUpdateAvailable,
    isBusy,
    installActive,
    progressPercent,
    initialize,
    refreshStatus,
    check,
    openDialog,
    dismiss,
    skipAvailableVersion,
    install,
    cancelDownload,
  };
});
