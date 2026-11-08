<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  Bot,
  Database,
  FolderOpen,
  Keyboard,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
} from 'lucide-vue-next';
import { getCredentialStoreStatus, getRuntimePaths } from '@/api/domain/runtimeApi';
import {
  cancelUpdateDownload as cancelUpdateDownloadApi,
  checkForUpdates as checkForUpdatesApi,
  createBackup,
  createDiagnostics,
  getUpdateStatus,
  installUpdate as installUpdateApi,
  restoreBackup,
  selectBackupFile,
} from '@/api/domain/maintenanceApi';
import {
  importKnownHosts,
  listHostTrustRecords,
  previewKnownHostsImport,
  selectKnownHostsFile,
} from '@/api/domain/trustApi';
import TerminalThemePicker from '@/components/settings/TerminalThemePicker.vue';
import AssistantSettingsPanel from '@/components/settings/AssistantSettingsPanel.vue';
import { t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useTerminalLogsStore } from '@/stores/terminalLogs';
import { useUiStore, type SettingsSection } from '@/stores/ui';
import {
  formatKeyboardShortcut,
  getKeyboardShortcutValidationError,
  keyboardShortcutCandidateFromEvent,
  type KeyboardShortcutAction,
} from '@/utils/keyboardShortcuts';
import type {
  CredentialStoreStatus,
  HostTrustRecord,
  KnownHostsImportCandidate,
  KnownHostsImportPreview,
  KnownHostsImportWarningKind,
  RuntimePaths,
  SafeSettings,
  UpdateStatus,
} from '@/types/contracts';

const settings = useSettingsStore();
const ui = useUiStore();
const terminalLogs = useTerminalLogsStore();
const activeSection = ref<SettingsSection>(ui.settingsSection);
const draft = reactive<SafeSettings>({ ...settings.value, shortcuts: { ...settings.value.shortcuts } });
const saving = ref(false);
const recordingShortcut = ref<KeyboardShortcutAction | null>(null);
const shortcutRecordingError = ref<Parameters<typeof t>[0] | null>(null);
const credentialStatus = ref<CredentialStoreStatus | 'not_probed' | 'probing'>('not_probed');
const trustRecords = ref<HostTrustRecord[]>([]);
const trustSearch = ref('');
const trustLoading = ref(false);
const trustLoadError = ref<string | null>(null);
const knownHostsPreview = ref<KnownHostsImportPreview | null>(null);
const trustImportBusy = ref(false);
const trustImportError = ref<string | null>(null);
const trustImportNotice = ref<string | null>(null);
const maintenanceBusy = ref(false);
const backupRestorePath = ref('');
const updateStatus = ref<UpdateStatus | null>(null);
const runtimePaths = ref<RuntimePaths | null>(null);
const updateBusy = ref(false);
const updateCancelBusy = ref(false);
const updatePhase = ref<'idle' | 'downloading' | 'installing'>('idle');
const updateDownloadedBytes = ref(0);
const updateContentLength = ref<number | null>(null);
const updateNotice = ref('');
const assistantSettingsRef = ref<{ save: () => Promise<boolean>; reset: () => void } | null>(null);

const credentialStatusLabel = computed(() => {
  const labels = {
    available: 'settings.credentialAvailable',
    locked: 'settings.credentialLocked',
    unavailable: 'settings.credentialUnavailable',
    unsupported: 'settings.credentialUnsupported',
    not_probed: 'settings.notProbed',
    probing: 'settings.probing',
  } as const;
  return t(labels[credentialStatus.value]);
});

const credentialStatusClass = computed(() => ({
  available: credentialStatus.value === 'available',
  pending: credentialStatus.value === 'probing' || credentialStatus.value === 'not_probed',
  danger: credentialStatus.value === 'locked' || credentialStatus.value === 'unavailable',
}));
const updateChannelPending = computed(() => Boolean(
  updateStatus.value && draft.updateChannel !== updateStatus.value.channel,
));
const runtimeDataDirectory = computed(() => runtimePaths.value?.dataDirectory
  ?? t('settings.runtimePathUnavailable'));
const updateProgressPercent = computed(() => {
  const total = updateContentLength.value;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((updateDownloadedBytes.value / total) * 100));
});
const updateProgressLabel = computed(() => {
  const percent = updateProgressPercent.value;
  return percent === null
    ? t('settings.updateDownloading')
    : t('settings.updateDownloadProgress', { percent });
});
const updateInstallActive = computed(() => updatePhase.value !== 'idle');

const trustImportChangedCount = computed(() => knownHostsPreview.value?.candidates
  .filter((candidate) => isTrustImportChanged(candidate)).length ?? 0);

const trustImportWarningLabels: Record<KnownHostsImportWarningKind, Parameters<typeof t>[0]> = {
  hashed_host: 'settings.trustImportWarningHashedHost',
  host_pattern: 'settings.trustImportWarningHostPattern',
  marked_entry: 'settings.trustImportWarningMarkedEntry',
  unsupported_key: 'settings.trustImportWarningUnsupportedKey',
  invalid_entry: 'settings.trustImportWarningInvalidEntry',
  conflicting_key: 'settings.trustImportWarningConflictingKey',
};

const visibleTrustRecords = computed(() => {
  const search = trustSearch.value.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  return trustRecords.value
    .map((record) => {
      const key = `${record.host.toLocaleLowerCase()}\u0000${record.port}\u0000${record.algorithm}`;
      const current = !seen.has(key);
      seen.add(key);
      return { ...record, current };
    })
    .filter((record) => !search || [record.host, record.algorithm, record.fingerprintSha256, record.previousFingerprintSha256 ?? '']
      .some((value) => value.toLocaleLowerCase().includes(search)));
});

const sections: { id: SettingsSection; label: Parameters<typeof t>[0]; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'assistant', label: 'settings.assistant', icon: Bot },
  { id: 'terminal', label: 'settings.terminal', icon: TerminalSquare },
  { id: 'connections', label: 'settings.connections', icon: Server },
  { id: 'security', label: 'settings.security', icon: ShieldCheck },
  { id: 'storage', label: 'settings.storage', icon: Database },
  { id: 'updates', label: 'settings.updates', icon: RefreshCw },
  { id: 'shortcuts', label: 'settings.shortcuts', icon: Keyboard },
];

const shortcutActions: { action: KeyboardShortcutAction; label: Parameters<typeof t>[0] }[] = [
  { action: 'quickConnect', label: 'commands.quickConnect' },
  { action: 'newSession', label: 'commands.newSession' },
  { action: 'closeActiveTab', label: 'commands.closeActiveTab' },
  { action: 'nextSession', label: 'commands.nextSession' },
  { action: 'previousSession', label: 'commands.previousSession' },
  { action: 'terminalSearch', label: 'commands.terminalSearch' },
  { action: 'toggleFiles', label: 'commands.showFiles' },
  { action: 'toggleFocusMode', label: 'commands.toggleFocusMode' },
  { action: 'toggleTaskDrawer', label: 'commands.toggleTaskDrawer' },
  { action: 'commandPalette', label: 'commands.title' },
  { action: 'toggleAssistant', label: 'commands.toggleAssistant' },
  { action: 'focusConnections', label: 'commands.focusConnections' },
  { action: 'focusTerminal', label: 'commands.focusTerminal' },
  { action: 'focusInspector', label: 'commands.focusInspector' },
  { action: 'openSettings', label: 'commands.openSettings' },
  { action: 'showEvents', label: 'commands.showEvents' },
];

async function save(): Promise<void> {
  if (recordingShortcut.value || saving.value || updateInstallActive.value) return;
  saving.value = true;
  try {
    const assistantSaved = await assistantSettingsRef.value?.save();
    if (assistantSaved === false) return;
    const saved = await settings.save({ ...draft, shortcuts: { ...draft.shortcuts } });
    if (!saved) {
      ui.notify(t('errors.settingsSaveFailed'));
      return;
    }
    let loggingStopError: string | null = null;
    if (!draft.terminalLogging) {
      const stopped = await terminalLogs.stopAll();
      if (!stopped && terminalLogs.error) {
        loggingStopError = t(terminalLogs.error.messageKey as Parameters<typeof t>[0]);
      }
    }
    ui.closeSettings();
    ui.notify(loggingStopError ?? t('settings.saved'));
  } finally {
    saving.value = false;
  }
}

function close(): void {
  if (!saving.value && !updateInstallActive.value) ui.closeSettings();
}

function reset(): void {
  const defaults = settings.reset();
  switch (activeSection.value) {
    case 'appearance':
      Object.assign(draft, {
        theme: defaults.theme,
        locale: defaults.locale,
        uiFontFamily: defaults.uiFontFamily,
        uiFontSize: defaults.uiFontSize,
        reduceMotion: defaults.reduceMotion,
      });
      break;
    case 'assistant':
      assistantSettingsRef.value?.reset();
      break;
    case 'terminal':
      Object.assign(draft, {
        terminalFontFamily: defaults.terminalFontFamily,
        terminalFontSize: defaults.terminalFontSize,
        terminalTheme: defaults.terminalTheme,
        terminalEncoding: defaults.terminalEncoding,
        terminalScrollback: defaults.terminalScrollback,
        pasteProtection: defaults.pasteProtection,
        terminalLogging: defaults.terminalLogging,
      });
      break;
    case 'connections':
      Object.assign(draft, {
        connectionTimeoutSeconds: defaults.connectionTimeoutSeconds,
        keepaliveSeconds: defaults.keepaliveSeconds,
        reconnectAttempts: defaults.reconnectAttempts,
        monitorIntervalSeconds: defaults.monitorIntervalSeconds,
        inspectorTab: defaults.inspectorTab,
        dualPaneSftp: defaults.dualPaneSftp,
        taskTab: defaults.taskTab,
        taskDrawerOpen: defaults.taskDrawerOpen,
        connectionsPaneWidth: defaults.connectionsPaneWidth,
        inspectorPaneWidth: defaults.inspectorPaneWidth,
        assistantPaneWidth: defaults.assistantPaneWidth,
        taskDrawerHeight: defaults.taskDrawerHeight,
      });
      break;
    case 'security':
      break;
    case 'storage':
      draft.backupSchedule = defaults.backupSchedule;
      break;
    case 'updates':
      draft.updateChannel = defaults.updateChannel;
      break;
    case 'shortcuts':
      draft.shortcuts = { ...defaults.shortcuts };
      break;
  }
  recordingShortcut.value = null;
  shortcutRecordingError.value = null;
}

function beginShortcutRecording(action: KeyboardShortcutAction): void {
  recordingShortcut.value = recordingShortcut.value === action ? null : action;
  shortcutRecordingError.value = null;
}

function selectSection(section: SettingsSection): void {
  activeSection.value = section;
  recordingShortcut.value = null;
  shortcutRecordingError.value = null;
}

function captureShortcut(action: KeyboardShortcutAction, event: KeyboardEvent): void {
  if (recordingShortcut.value !== action) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    recordingShortcut.value = null;
    shortcutRecordingError.value = null;
    return;
  }
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;

  const binding = keyboardShortcutCandidateFromEvent(event);
  if (!binding) {
    shortcutRecordingError.value = 'settings.shortcutModifierRequired';
    return;
  }
  const error = getKeyboardShortcutValidationError(binding, draft.shortcuts, action);
  if (error) {
    const errorMessages = {
      invalid: 'settings.shortcutInvalid',
      reserved: 'settings.shortcutReserved',
      conflict: 'settings.shortcutConflict',
    } as const;
    shortcutRecordingError.value = errorMessages[error];
    return;
  }
  draft.shortcuts[action] = binding;
  recordingShortcut.value = null;
  shortcutRecordingError.value = null;
}

async function runMaintenance(kind: 'backup' | 'diagnostics'): Promise<void> {
  if (kind === 'backup') {
    const accepted = await ui.confirm({
      title: t('settings.backupExportConfirmTitle'),
      message: t('settings.backupExportConfirmMessage'),
      confirmLabel: t('settings.createBackup'),
    });
    if (!accepted) return;
  }

  maintenanceBusy.value = true;
  try {
    const result = kind === 'backup' ? await createBackup() : await createDiagnostics();
    if (!result.ok) {
      const messageKey = result.error.code === 'DESKTOP_RUNTIME_REQUIRED'
        ? 'errors.desktopRuntimeRequired'
        : result.error.code === 'BACKUP_ALREADY_EXISTS'
          ? 'errors.backupAlreadyExists'
          : 'errors.maintenanceFailed';
      ui.notify(t(messageKey));
      return;
    }
    if (result.data === null) return;
    if (kind === 'backup') backupRestorePath.value = result.data.path;
    ui.notify(`${t(kind === 'backup' ? 'settings.backupCreated' : 'settings.diagnosticsCreated')} ${result.data.path}`);
  } finally {
    maintenanceBusy.value = false;
  }
}

async function runBackupRestore(): Promise<void> {
  const path = backupRestorePath.value.trim();
  if (!path) return;
  const accepted = await ui.confirm({
    title: t('settings.restoreConfirmTitle'),
    message: t('settings.restoreConfirmMessage'),
    confirmLabel: t('settings.restoreBackup'),
    danger: true,
  });
  if (!accepted) return;
  maintenanceBusy.value = true;
  try {
    const result = await restoreBackup(path);
    if (!result.ok) {
      ui.notify(t(result.error.messageKey as Parameters<typeof t>[0]));
      return;
    }
    ui.notify(t('settings.backupRestored'));
    window.setTimeout(() => window.location.reload(), 500);
  } finally {
    maintenanceBusy.value = false;
  }
}

async function chooseBackupFile(): Promise<void> {
  maintenanceBusy.value = true;
  try {
    const result = await selectBackupFile(t('settings.backupPickerTitle'), t('settings.backupPickerFilter'));
    if (!result.ok) {
      ui.notify(t(result.error.code === 'DESKTOP_RUNTIME_REQUIRED' ? 'errors.desktopRuntimeRequired' : 'errors.backupPickerFailed'));
      return;
    }
    if (result.data !== null) backupRestorePath.value = result.data;
  } finally {
    maintenanceBusy.value = false;
  }
}

async function checkForUpdatesNow(): Promise<void> {
  if (updateBusy.value || !updateStatus.value?.configured || updateChannelPending.value) return;
  updateBusy.value = true;
  updateNotice.value = '';
  try {
    const result = await checkForUpdatesApi();
    if (!result.ok) {
      updateNotice.value = t(result.error.messageKey as Parameters<typeof t>[0]);
      return;
    }
    updateStatus.value = result.data;
    updateNotice.value = result.data.availableVersion
      ? t('settings.updateAvailable', { version: result.data.availableVersion })
      : t('settings.upToDate');
  } finally {
    updateBusy.value = false;
  }
}

async function installAvailableUpdate(): Promise<void> {
  const version = updateStatus.value?.availableVersion;
  if (!version || updateBusy.value || updateChannelPending.value) return;
  const accepted = await ui.confirm({
    title: t('settings.updateConfirmTitle'),
    message: t('settings.updateConfirmMessage', { version }),
    confirmLabel: t('settings.installUpdate'),
  });
  if (!accepted) return;

  updateBusy.value = true;
  updatePhase.value = 'downloading';
  updateDownloadedBytes.value = 0;
  updateContentLength.value = null;
  updateNotice.value = '';
  try {
    const result = await installUpdateApi(version, (event) => {
      if (event.event === 'progress') {
        updateDownloadedBytes.value = event.data.downloadedBytes;
        updateContentLength.value = event.data.contentLength;
      } else {
        updatePhase.value = 'installing';
      }
    });
    if (!result.ok) {
      updateNotice.value = t(result.error.messageKey as Parameters<typeof t>[0]);
      if (result.error.code === 'UPDATE_STALE' || result.error.code === 'UPDATE_NO_AVAILABLE') {
        if (updateStatus.value) {
          updateStatus.value = { ...updateStatus.value, availableVersion: null, releaseNotes: null, publishedAt: null };
        }
      }
      return;
    }
    updateNotice.value = t('settings.updateInstalling');
    ui.notify(t('settings.updateInstalling'));
  } finally {
    updateBusy.value = false;
    updatePhase.value = 'idle';
  }
}

async function cancelUpdateDownload(): Promise<void> {
  if (updateCancelBusy.value || updatePhase.value !== 'downloading') return;
  updateCancelBusy.value = true;
  try {
    const result = await cancelUpdateDownloadApi();
    updateNotice.value = t(result.ok
      ? 'settings.updateCancelRequested'
      : result.error.messageKey as Parameters<typeof t>[0]);
  } finally {
    updateCancelBusy.value = false;
  }
}

async function loadTrustLedger(): Promise<void> {
  trustLoading.value = true;
  trustLoadError.value = null;
  try {
    const result = await listHostTrustRecords();
    if (!result.ok) {
      trustLoadError.value = 'settings.trustLoadFailed';
      return;
    }
    trustRecords.value = result.data;
  } finally {
    trustLoading.value = false;
  }
}

async function refreshTrustLedger(): Promise<void> {
  if (trustLoading.value || trustImportBusy.value) return;
  knownHostsPreview.value = null;
  trustImportError.value = null;
  await loadTrustLedger();
}

function isTrustImportChanged(candidate: KnownHostsImportCandidate): boolean {
  return candidate.currentFingerprintSha256 !== null
    && candidate.currentFingerprintSha256 !== candidate.fingerprintSha256;
}

function trustEndpointLabel(host: string, port: number): string {
  const endpointHost = host.startsWith('[') || !host.includes(':') ? host : `[${host}]`;
  return `${endpointHost}:${port}`;
}

async function chooseKnownHostsFile(): Promise<void> {
  if (trustImportBusy.value) return;
  trustImportBusy.value = true;
  trustImportError.value = null;
  trustImportNotice.value = null;
  try {
    const selected = await selectKnownHostsFile(t('settings.trustImportPickerTitle'));
    if (!selected.ok) {
      trustImportError.value = selected.error.messageKey;
      return;
    }
    if (!selected.data) return;

    knownHostsPreview.value = null;
    const result = await previewKnownHostsImport(selected.data);
    if (!result.ok) {
      trustImportError.value = result.error.messageKey;
      return;
    }
    knownHostsPreview.value = result.data;
  } catch {
    trustImportError.value = 'errors.unexpected';
  } finally {
    trustImportBusy.value = false;
  }
}

async function commitKnownHostsImport(): Promise<void> {
  const preview = knownHostsPreview.value;
  if (!preview || preview.candidates.length === 0 || trustImportBusy.value) return;

  trustImportBusy.value = true;
  trustImportError.value = null;
  trustImportNotice.value = null;
  try {
    const changedCandidates = preview.candidates.filter((candidate) => isTrustImportChanged(candidate));
    const changedHostSummary = changedCandidates
      .slice(0, 5)
      .map((candidate) => trustEndpointLabel(candidate.host, candidate.port));
    if (changedCandidates.length > changedHostSummary.length) {
      changedHostSummary.push(t('settings.trustImportMoreChangedHosts', {
        count: changedCandidates.length - changedHostSummary.length,
      }));
    }
    const accepted = await ui.confirm({
      title: t('settings.trustImportConfirmTitle'),
      message: t('settings.trustImportConfirmMessage', {
        fileName: preview.fileName,
        count: preview.candidates.length,
        changedCount: trustImportChangedCount.value,
        changedHosts: changedHostSummary.join(' · ') || t('settings.trustImportNoChangedHosts'),
      }),
      confirmLabel: t('settings.trustImportButton', { count: preview.candidates.length }),
      danger: trustImportChangedCount.value > 0,
    });
    if (!accepted) return;

    const result = await importKnownHosts({
      candidates: preview.candidates,
      observedAt: new Date().toISOString(),
    });
    if (!result.ok) {
      trustImportError.value = result.error.messageKey;
      if (result.error.code === 'TRUST_IMPORT_STALE') knownHostsPreview.value = null;
      return;
    }

    trustImportNotice.value = t('settings.trustImportSucceeded', {
      imported: result.data.importedCount,
      changed: result.data.changedCount,
      unchanged: result.data.unchangedCount,
    });
    knownHostsPreview.value = null;
    await loadTrustLedger();
    ui.notify(trustImportNotice.value);
  } catch {
    trustImportError.value = 'errors.unexpected';
  } finally {
    trustImportBusy.value = false;
  }
}

onMounted(async () => {
  credentialStatus.value = 'probing';
  const trustLoad = loadTrustLedger();
  const [credentialResult, updateResult, pathsResult] = await Promise.all([
    getCredentialStoreStatus(),
    getUpdateStatus(),
    getRuntimePaths(),
  ]);
  credentialStatus.value = credentialResult.ok ? credentialResult.data : 'unavailable';
  updateStatus.value = updateResult.ok ? updateResult.data : null;
  runtimePaths.value = pathsResult.ok ? pathsResult.data : null;
  await trustLoad;
});
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <section class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="dialog-header">
        <strong id="settings-title">{{ t('settings.title') }}</strong>
        <button type="button" class="icon-button" aria-label="Close" :disabled="saving || updateInstallActive" @click="close"><X :size="14" /></button>
      </header>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <button
            v-for="(section, index) in sections"
            :key="section.id"
            type="button"
            :autofocus="index === 0"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            @click="selectSection(section.id)"
          >
            <component :is="section.icon" :size="14" />
            <span>{{ t(section.label) }}</span>
          </button>
        </nav>

        <div class="settings-content">
          <AssistantSettingsPanel v-show="activeSection === 'assistant'" ref="assistantSettingsRef" />

          <section v-if="activeSection === 'appearance'">
            <h2>{{ t('settings.appearance') }}</h2>
            <p>{{ t('settings.themeHelp') }}</p>
            <div class="setting-row">
              <div><strong>{{ t('settings.theme') }}</strong><small>{{ t('settings.themeHelp') }}</small></div>
              <div class="segmented">
                <button type="button" :aria-pressed="draft.theme === 'system'" @click="draft.theme = 'system'">{{ t('settings.system') }}</button>
                <button type="button" :aria-pressed="draft.theme === 'dark'" @click="draft.theme = 'dark'">{{ t('settings.dark') }}</button>
                <button type="button" :aria-pressed="draft.theme === 'light'" @click="draft.theme = 'light'">{{ t('settings.light') }}</button>
              </div>
            </div>
            <div class="setting-row">
              <div><strong>{{ t('settings.language') }}</strong></div>
              <select v-model="draft.locale"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
            </div>
            <div class="setting-row">
              <div><strong>{{ t('settings.uiSize') }}</strong><small>11–20 px</small></div>
              <label class="range-control"><input v-model.number="draft.uiFontSize" type="range" min="11" max="20"><span>{{ draft.uiFontSize }} px</span></label>
            </div>
            <p class="settings-license-note">{{ t('settings.harmonyFontNotice') }}</p>
            <div class="setting-row">
              <div><strong>{{ t('settings.reduceMotion') }}</strong></div>
              <label class="switch"><input v-model="draft.reduceMotion" type="checkbox"><span /></label>
            </div>
          </section>

          <section v-else-if="activeSection === 'terminal'">
            <h2>{{ t('settings.terminal') }}</h2>
            <p>{{ t('settings.terminalThemeHelp') }}</p>
            <TerminalThemePicker v-model="draft.terminalTheme" :app-theme="draft.theme" />
            <div class="setting-row"><div><strong>{{ t('settings.terminalFont') }}</strong></div><input v-model="draft.terminalFontFamily"></div>
            <div class="setting-row"><div><strong>{{ t('settings.terminalSize') }}</strong></div><label class="range-control"><input v-model.number="draft.terminalFontSize" type="range" min="11" max="24"><span>{{ draft.terminalFontSize }} px</span></label></div>
            <div class="setting-row"><div><strong>{{ t('settings.terminalEncoding') }}</strong><small>{{ t('settings.terminalEncodingHelp') }}</small></div><select v-model="draft.terminalEncoding"><option value="utf-8">UTF-8</option><option value="gbk">GBK</option><option value="big5">Big5</option><option value="shift_jis">Shift_JIS</option><option value="windows-1252">Windows-1252</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.scrollback') }}</strong><small>{{ t('settings.scrollbackHelp') }}</small></div><select v-model.number="draft.terminalScrollback"><option :value="5000">{{ t('settings.scrollbackLines', { count: '5,000' }) }}</option><option :value="10000">{{ t('settings.scrollbackLines', { count: '10,000' }) }}</option><option :value="25000">{{ t('settings.scrollbackLines', { count: '25,000' }) }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.multilinePasteProtection') }}</strong></div><label class="switch"><input v-model="draft.pasteProtection" type="checkbox"><span /></label></div>
            <div class="setting-row"><div><strong>{{ t('settings.logging') }}</strong><small>{{ t('settings.loggingHelp') }}</small></div><label class="switch"><input v-model="draft.terminalLogging" type="checkbox"><span /></label></div>
          </section>

          <section v-else-if="activeSection === 'connections'">
            <h2>{{ t('settings.connections') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.connectionTimeout') }}</strong></div><select v-model.number="draft.connectionTimeoutSeconds"><option :value="10">{{ t('settings.secondsValue', { n: 10 }) }}</option><option :value="15">{{ t('settings.secondsValue', { n: 15 }) }}</option><option :value="30">{{ t('settings.secondsValue', { n: 30 }) }}</option><option :value="60">{{ t('settings.secondsValue', { n: 60 }) }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.keepaliveInterval') }}</strong></div><select v-model.number="draft.keepaliveSeconds"><option :value="30">{{ t('settings.secondsValue', { n: 30 }) }}</option><option :value="60">{{ t('settings.secondsValue', { n: 60 }) }}</option><option :value="0">{{ t('settings.off') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.automaticReconnect') }}</strong><small>{{ t('settings.automaticReconnectHelp') }}</small></div><select v-model.number="draft.reconnectAttempts"><option :value="3">{{ t('settings.attemptsValue', { count: 3 }) }}</option><option :value="5">{{ t('settings.attemptsValue', { count: 5 }) }}</option><option :value="0">{{ t('settings.off') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.monitorInterval') }}</strong><small>{{ t('settings.monitorIntervalHelp') }}</small></div><select v-model.number="draft.monitorIntervalSeconds"><option :value="15">{{ t('settings.secondsValue', { n: 15 }) }}</option><option :value="30">{{ t('settings.secondsValue', { n: 30 }) }}</option><option :value="60">{{ t('settings.secondsValue', { n: 60 }) }}</option></select></div>
          </section>

          <section v-else-if="activeSection === 'security'">
            <h2>{{ t('settings.security') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.safeStorage') }}</strong><small>{{ t('settings.safeStorageHelp') }}</small></div><span class="status-pill" :class="credentialStatusClass">{{ credentialStatusLabel }}</span></div>
            <div class="setting-row"><div><strong>{{ t('settings.hostKeyPolicy') }}</strong></div><select><option>{{ t('settings.hostKeyStrict') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.trustedHosts') }}</strong><small>{{ t('settings.trustedHostsHelp') }}</small></div><span class="mono">{{ trustRecords.length }}</span></div>
            <div class="trust-ledger-toolbar">
              <label class="trust-ledger-search"><span class="sr-only">{{ t('settings.trustSearch') }}</span><input v-model="trustSearch" type="search" :placeholder="t('settings.trustSearch')"></label>
              <button type="button" class="button" :disabled="trustImportBusy || trustLoading" @click="chooseKnownHostsFile"><FolderOpen :size="12" />{{ t('settings.importKnownHosts') }}</button>
              <button type="button" class="button" :disabled="trustLoading || trustImportBusy" @click="refreshTrustLedger"><RefreshCw :size="12" :class="{ spin: trustLoading }" />{{ t('settings.refreshTrust') }}</button>
            </div>
            <p v-if="trustImportError" class="trust-ledger-error" role="alert">{{ t(trustImportError as Parameters<typeof t>[0]) }}</p>
            <p v-if="trustImportNotice" class="trust-import-notice" role="status">{{ trustImportNotice }}</p>
            <section v-if="knownHostsPreview" class="trust-import-preview" :aria-label="t('settings.trustImportPreviewTitle')">
              <header class="trust-import-heading">
                <div><strong>{{ t('settings.trustImportPreviewTitle') }}</strong><small class="mono">{{ knownHostsPreview.fileName }}</small></div>
                <div class="trust-import-heading-actions">
                  <span>{{ t('settings.trustImportCandidateCount', { count: knownHostsPreview.candidates.length }) }}</span>
                  <button type="button" class="icon-button" :aria-label="t('settings.trustImportDismiss')" :disabled="trustImportBusy" @click="knownHostsPreview = null"><X :size="12" /></button>
                </div>
              </header>
              <ul v-if="knownHostsPreview.warnings.length" class="trust-import-warnings">
                <li v-for="warning in knownHostsPreview.warnings" :key="warning.kind">
                  <span>{{ t(trustImportWarningLabels[warning.kind]) }}</span><strong>{{ warning.count }}</strong>
                </li>
              </ul>
              <p v-if="knownHostsPreview.candidates.length === 0" class="trust-ledger-empty">{{ t('settings.trustImportNoCandidates') }}</p>
              <div v-else class="trust-import-candidates">
                <article
                  v-for="candidate in knownHostsPreview.candidates"
                  :key="`${candidate.host}:${candidate.port}:${candidate.algorithm}`"
                  class="trust-import-candidate"
                  :class="{ changed: isTrustImportChanged(candidate) }"
                >
                  <div class="trust-import-candidate-heading">
                    <strong class="mono">{{ trustEndpointLabel(candidate.host, candidate.port) }}</strong>
                    <span v-if="isTrustImportChanged(candidate)" class="trust-import-status changed">{{ t('settings.trustImportChangesCurrent') }}</span>
                    <span v-else-if="candidate.currentFingerprintSha256" class="trust-import-status unchanged">{{ t('settings.trustImportAlreadyCurrent') }}</span>
                    <span v-else class="trust-import-status new">{{ t('settings.trustImportNewHost') }}</span>
                  </div>
                  <small>{{ candidate.algorithm }} · {{ t('settings.trustImportSourceLine', { line: candidate.sourceLine }) }}</small>
                  <div class="trust-import-fingerprints">
                    <small v-if="candidate.currentFingerprintSha256" :class="{ changed: isTrustImportChanged(candidate) }"><span>{{ t('settings.trustImportCurrentFingerprint') }}: </span><code>{{ candidate.currentFingerprintSha256 }}</code></small>
                    <small><span>{{ t('settings.trustImportCandidateFingerprint') }}: </span><code>{{ candidate.fingerprintSha256 }}</code></small>
                  </div>
                </article>
              </div>
              <div class="trust-import-actions">
                <small>{{ t('settings.trustImportHelp') }}</small>
                <button type="button" class="button primary" :disabled="trustImportBusy || knownHostsPreview.candidates.length === 0" @click="commitKnownHostsImport">
                  {{ trustImportBusy ? t('settings.trustImportWorking') : t('settings.trustImportButton', { count: knownHostsPreview.candidates.length }) }}
                </button>
              </div>
            </section>
            <p v-if="trustLoadError" class="trust-ledger-error" role="alert">{{ t(trustLoadError as Parameters<typeof t>[0]) }}</p>
            <p v-else-if="trustLoading && trustRecords.length === 0" class="trust-ledger-empty">{{ t('settings.trustLoading') }}</p>
            <p v-else-if="trustRecords.length === 0" class="trust-ledger-empty">{{ t('settings.trustNoRecords') }}</p>
            <p v-else-if="visibleTrustRecords.length === 0" class="trust-ledger-empty">{{ t('settings.trustNoMatches') }}</p>
            <div v-else class="trust-ledger-list">
              <article v-for="record in visibleTrustRecords" :key="record.id" class="trust-ledger-row" :class="{ historical: !record.current }">
                <div class="trust-ledger-heading">
                  <strong class="mono">{{ trustEndpointLabel(record.host, record.port) }}</strong>
                  <span class="trust-ledger-status" :class="record.current ? 'current' : 'historical'">{{ t(record.current ? 'settings.trustCurrent' : 'settings.trustHistory') }}</span>
                  <span class="trust-ledger-source">{{ t(record.source === 'imported_known_hosts' ? 'settings.trustSourceKnownHosts' : 'settings.trustSourceManual') }}</span>
                </div>
                <small>{{ record.algorithm }}</small>
                <span class="mono trust-ledger-fingerprint">{{ record.fingerprintSha256 }}</span>
                <small v-if="record.previousFingerprintSha256" class="trust-ledger-previous"><span>{{ t('settings.trustPreviousFingerprint') }}: </span><code>{{ record.previousFingerprintSha256 }}</code></small>
                <div class="trust-ledger-times"><small>{{ t('settings.trustFirstSeen') }}: {{ new Date(record.firstSeenAt).toLocaleString() }}</small><small>{{ t('settings.trustLastSeen') }}: {{ new Date(record.lastSeenAt).toLocaleString() }}</small></div>
              </article>
            </div>
          </section>

          <section v-else-if="activeSection === 'storage'">
            <h2>{{ t('settings.storage') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.dataDirectory') }}</strong><small>{{ t('settings.localData') }}</small></div><input :value="runtimeDataDirectory" readonly></div>
            <div class="setting-row"><div><strong>{{ t('settings.automaticBackup') }}</strong><small>{{ t('settings.automaticBackupHelp') }}</small></div><select v-model="draft.backupSchedule"><option value="daily">{{ t('settings.daily') }}</option><option value="weekly">{{ t('settings.weekly') }}</option><option value="off">{{ t('settings.off') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.backupNow') }}</strong><small>{{ t('settings.backupHelp') }}</small></div><button type="button" class="button" :disabled="maintenanceBusy" @click="runMaintenance('backup')">{{ t('settings.createBackup') }}</button></div>
            <div class="setting-row"><div><strong>{{ t('settings.restoreBackup') }}</strong><small>{{ t('settings.restoreBackupHelp') }}</small></div><div class="setting-control-group"><input v-model="backupRestorePath" type="text" spellcheck="false" :aria-label="t('settings.backupPathLabel')" :placeholder="t('settings.backupPathPlaceholder')"><button type="button" class="button" :disabled="maintenanceBusy" @click="chooseBackupFile"><FolderOpen :size="14" aria-hidden="true" />{{ t('settings.chooseBackupFile') }}</button></div></div>
            <div class="setting-row"><div><strong>{{ t('settings.restoreBackup') }}</strong></div><button type="button" class="button danger" :disabled="maintenanceBusy || !backupRestorePath.trim()" @click="runBackupRestore">{{ t('settings.restoreBackup') }}</button></div>
          </section>

          <section v-else-if="activeSection === 'updates'">
            <h2>{{ t('settings.updates') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.updateChannel') }}</strong></div><select v-model="draft.updateChannel"><option value="stable">{{ t('settings.stable') }}</option><option value="beta">Beta</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.version') }}</strong></div><span class="mono">FILEX {{ updateStatus?.currentVersion ?? '—' }}</span></div>
            <div class="setting-row"><div><strong>{{ t('settings.updaterStatus') }}</strong><small>{{ updateStatus?.configured ? t('settings.updaterConfigured') : t('settings.updaterNeedsSigning') }}</small><small v-if="updateChannelPending">{{ t('settings.updateChannelSaveHint') }}</small><small v-if="updateNotice" aria-live="polite">{{ updateNotice }}</small></div><span class="mono">{{ updateStatus?.channel ?? draft.updateChannel }}</span></div>
            <div class="setting-row"><div><strong>{{ t('settings.checkUpdates') }}</strong><small v-if="updateStatus?.availableVersion">{{ t('settings.updateAvailable', { version: updateStatus.availableVersion }) }}</small><small v-if="updatePhase === 'downloading'" aria-live="polite">{{ updateProgressLabel }}</small><small v-else-if="updatePhase === 'installing'" aria-live="polite">{{ t('settings.updateInstalling') }}</small></div><div class="setting-control-group"><button type="button" class="button" :disabled="updateBusy || !updateStatus?.configured || updateChannelPending" @click="checkForUpdatesNow">{{ updateBusy ? (updatePhase === 'downloading' ? t('settings.updateDownloading') : updatePhase === 'installing' ? t('settings.updateInstallingShort') : t('settings.checkingUpdates')) : t('settings.checkUpdates') }}</button><button v-if="updatePhase === 'downloading'" type="button" class="button danger" :disabled="updateCancelBusy" @click="cancelUpdateDownload">{{ updateCancelBusy ? t('settings.updateCancelling') : t('settings.cancelUpdateDownload') }}</button><button v-else-if="updateStatus?.availableVersion" type="button" class="button primary" :disabled="updateBusy || updateChannelPending" @click="installAvailableUpdate">{{ t('settings.installUpdate') }}</button></div></div>
            <div v-if="updateStatus?.releaseNotes" class="setting-row update-notes-row"><div><strong>{{ t('settings.updateNotes') }}</strong><pre>{{ updateStatus.releaseNotes }}</pre></div></div>
            <div class="setting-row"><div><strong>{{ t('settings.diagnostics') }}</strong><small>{{ t('settings.diagnosticsHelp') }}</small></div><button type="button" class="button" :disabled="maintenanceBusy" @click="runMaintenance('diagnostics')">{{ t('settings.createDiagnostics') }}</button></div>
          </section>

          <section v-else-if="activeSection === 'shortcuts'">
            <h2>{{ t('settings.shortcuts') }}</h2>
            <p>{{ t('settings.shortcutsHelp') }}</p>
            <div class="shortcut-list">
              <div v-for="shortcut in shortcutActions" :key="shortcut.action" class="shortcut-row">
                <strong>{{ t(shortcut.label) }}</strong>
                <div class="shortcut-control">
                  <button
                    type="button"
                    class="shortcut-binding"
                    :class="{ recording: recordingShortcut === shortcut.action }"
                    :aria-pressed="recordingShortcut === shortcut.action"
                    :aria-label="t(recordingShortcut === shortcut.action ? 'settings.shortcutListening' : 'settings.shortcutRecord', { action: t(shortcut.label) })"
                    @click="beginShortcutRecording(shortcut.action)"
                    @keydown="captureShortcut(shortcut.action, $event)"
                  >
                    {{ recordingShortcut === shortcut.action ? t('settings.shortcutPress') : formatKeyboardShortcut(draft.shortcuts[shortcut.action]) }}
                  </button>
                  <small v-if="recordingShortcut === shortcut.action && shortcutRecordingError" class="shortcut-error" role="alert">
                    {{ t(shortcutRecordingError) }}
                  </small>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
      <footer class="dialog-footer settings-footer">
        <button type="button" class="button" :disabled="saving || updateInstallActive" @click="reset">{{ t('settings.reset') }}</button>
        <span class="spacer" />
        <button type="button" class="button" :disabled="saving || updateInstallActive" @click="close">{{ t('settings.cancel') }}</button>
        <button type="button" class="button primary" :disabled="recordingShortcut !== null || saving || updateInstallActive" @click="save">{{ saving ? t('settings.saving') : t('settings.save') }}</button>
      </footer>
    </section>
  </div>
</template>
