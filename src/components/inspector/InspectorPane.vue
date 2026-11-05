<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  ArrowLeftRight,
  Activity,
  Columns2,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Copy,
  Edit3,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  FolderOpen,
  HardDrive,
  Info,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldQuestion,
  Star,
  Trash2,
  Upload,
  Download,
  X,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import { useSessionsStore } from '@/stores/sessions';
import { useSftpStore } from '@/stores/sftp';
import { useLocalFilesStore } from '@/stores/localFiles';
import { useMonitorStore } from '@/stores/monitor';
import { useProcessesStore } from '@/stores/processes';
import { useChecksumsStore } from '@/stores/checksums';
import { useSyncPreviewStore } from '@/stores/syncPreview';
import { useTransfersStore } from '@/stores/transfers';
import { isTauriRuntime } from '@/api/common';
import { inspectLocalEntry } from '@/api/domain/localFilesApi';
import type { AppError, AuthenticationMethod, ConnectionProfile, CreateTransferInput, DirectorySyncChangeKind, DirectorySyncEntryKind, InspectorTab, LocalFileEntry, ProcessEntry, RemoteFileEntry, UpdateConnectionProfileInput } from '@/types/contracts';

const connections = useConnectionsStore();
const settings = useSettingsStore();
const ui = useUiStore();
const sessions = useSessionsStore();
const inspectorRoot = ref<HTMLElement | null>(null);
const sftp = useSftpStore();
const localFiles = useLocalFilesStore();
const transfers = useTransfersStore();
const monitor = useMonitorStore();
const processes = useProcessesStore();
const checksums = useChecksumsStore();
const syncPreviews = useSyncPreviewStore();
const appForeground = ref(document.visibilityState === 'visible' && document.hasFocus());
function updateAppForeground(): void {
  appForeground.value = document.visibilityState === 'visible' && document.hasFocus();
}
document.addEventListener('visibilitychange', updateAppForeground);
window.addEventListener('focus', updateAppForeground);
window.addEventListener('blur', updateAppForeground);
const profile = computed(() => sessions.profileForSession(sessions.activeSession) ?? connections.activeProfile);
const quickSession = computed(() => sessions.isQuickProfile(sessions.activeSession?.profileId));
const jumpRouteLabels = computed(() => profile.value?.proxyJumpProfileIds.map((id) => {
  const jump = connections.profiles.find((candidate) => candidate.id === id);
  return jump ? `${jump.name} — ${jump.username}@${jump.host}:${jump.port}` : id;
}) ?? []);
const authenticationLabelKeys: Record<AuthenticationMethod, Parameters<typeof t>[0]> = {
  password: 'profile.authPassword',
  private_key: 'profile.authPrivateKey',
  agent: 'profile.authAgent',
};
const authenticationLabel = computed(() => profile.value
  ? t(authenticationLabelKeys[profile.value.authenticationMethod])
  : '—');
const dualPaneEnabled = computed(() => settings.value.dualPaneSftp);
const activePane = ref<'local' | 'remote'>('remote');
const remoteDropElement = ref<HTMLElement | null>(null);
const nativeDropActive = ref(false);
const localDropActive = ref(false);
const dropBusy = ref(false);
const REMOTE_FILE_DRAG_TYPE = 'application/x-filex-remote-entry';
let unlistenNativeDrop: UnlistenFn | null = null;
let inspectorUnmounted = false;
const remoteReady = computed(() => {
  const session = sessions.activeSession;
  return session !== null && session.state === 'connected' && sftp.sessionId === session.id;
});
const selectedLocalEntry = computed(() => localFiles.listing?.entries.find((entry) => entry.path === localFiles.selectedPath) ?? null);
const selectedRemoteEntry = computed(() => sftp.entries.find((entry) => entry.path === sftp.selectedPath) ?? null);
const monitorView = ref<'metrics' | 'processes'>('metrics');
const checksumDialogOpen = ref(false);
const checksumTarget = ref<{ sessionId: string; host: string; localName: string; remoteName: string } | null>(null);
const syncPreviewDialogOpen = ref(false);
const syncPreviewTarget = ref<{ sessionId: string; host: string; localRoot: string; remoteRoot: string } | null>(null);
const canCompareChecksums = computed(() => {
  const local = selectedLocalEntry.value;
  const remote = selectedRemoteEntry.value;
  return dualPaneEnabled.value
    && remoteReady.value
    && !localFiles.loading
    && !localFiles.mutating
    && !sftp.loading
    && !sftp.deleting
    && !sftp.renaming
    && local !== null
    && !local.isDirectory
    && !local.isSymlink
    && remote !== null
    && !remote.isDirectory
    && !remote.isSymlink;
});
const canPreviewDirectorySync = computed(() => dualPaneEnabled.value
  && remoteReady.value
  && localFiles.listing !== null
  && !localFiles.loading
  && !localFiles.mutating
  && !sftp.loading
  && !sftp.deleting
  && !sftp.creatingDirectory
  && !sftp.renaming);
const browserPanes = computed(() => {
  const panes: Array<{
    id: 'local' | 'remote';
    label: Parameters<typeof t>[0];
    entries: Array<LocalFileEntry | RemoteFileEntry>;
    path: string;
    loading: boolean;
    selectedPath: string | null;
    error: AppError | null;
    truncated: boolean;
  }> = [
    {
      id: dualPaneEnabled.value ? 'local' : 'remote',
      label: dualPaneEnabled.value ? 'inspector.localPane' : 'inspector.remotePane',
      entries: dualPaneEnabled.value ? (localFiles.listing?.entries ?? []) : sftp.entries,
      path: dualPaneEnabled.value ? (localFiles.listing?.path ?? '') : sftp.path,
      loading: dualPaneEnabled.value ? localFiles.loading : sftp.loading,
      selectedPath: dualPaneEnabled.value ? localFiles.selectedPath : sftp.selectedPath,
      error: dualPaneEnabled.value ? localFiles.error : sftp.error,
      truncated: dualPaneEnabled.value ? (localFiles.listing?.truncated ?? false) : false,
    },
  ];
  if (dualPaneEnabled.value) {
    panes.push({
      id: 'remote',
      label: 'inspector.remotePane',
      entries: sftp.entries,
      path: sftp.path,
      loading: sftp.loading,
      selectedPath: sftp.selectedPath,
      error: sftp.error,
      truncated: false,
    });
  }
  return panes;
});
const createDirectoryOpen = ref(false);
const directoryTargetPane = ref<'local' | 'remote'>('remote');
const newDirectoryName = ref('');
const renameDialogOpen = ref(false);
const renameTargetPane = ref<'local' | 'remote'>('remote');
const renameName = ref('');
const moveDialogOpen = ref(false);
const moveTargetPane = ref<'local' | 'remote'>('remote');
const moveSourceEntry = ref<LocalFileEntry | RemoteFileEntry | null>(null);
const moveSourceSessionId = ref<string | null>(null);
const moveDestinationDirectory = ref('');
const copyDialogOpen = ref(false);
const copyTargetPane = ref<'local' | 'remote'>('remote');
const copySourceEntry = ref<LocalFileEntry | RemoteFileEntry | null>(null);
const copySourceSessionId = ref<string | null>(null);
const copyDestinationDirectory = ref('');
const copyTargetName = ref('');
const copyOperationId = ref<string | null>(null);
const copyCancelling = ref(false);
const directoryError = computed(() => directoryTargetPane.value === 'local' ? localFiles.error : sftp.error);
const renameError = computed(() => renameTargetPane.value === 'local' ? localFiles.error : sftp.error);
const moveError = computed(() => moveTargetPane.value === 'local' ? localFiles.error : sftp.error);
const moveBusy = computed(() => moveTargetPane.value === 'local' ? localFiles.mutating : sftp.moving);
const copyError = computed(() => copyTargetPane.value === 'local' ? localFiles.error : sftp.error);
const copyBusy = computed(() => copyTargetPane.value === 'local' ? localFiles.mutating : sftp.copying);
const moveDestinationPath = computed(() => {
  const name = moveSourceEntry.value?.name;
  const directory = moveDestinationDirectory.value.trim();
  if (!name || !directory) return '—';
  return moveTargetPane.value === 'local' ? localJoin(directory, name) : remoteJoin(directory, name);
});
const copyDestinationPath = computed(() => {
  const directory = copyDestinationDirectory.value.trim();
  const name = copyTargetName.value.trim();
  if (!directory || !name) return '—';
  return copyTargetPane.value === 'local' ? localJoin(directory, name) : remoteJoin(directory, name);
});

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state]) => {
    if (checksumTarget.value && (checksumTarget.value.sessionId !== sessionId || state !== 'connected')) {
      void closeChecksumDialog();
    }
    if (syncPreviewTarget.value && (syncPreviewTarget.value.sessionId !== sessionId || state !== 'connected')) {
      void closeSyncPreviewDialog();
    }
    if (moveDialogOpen.value && moveTargetPane.value === 'remote'
      && (moveSourceSessionId.value !== sessionId || state !== 'connected')) {
      moveDialogOpen.value = false;
      moveSourceEntry.value = null;
    }
    if (copyDialogOpen.value && copyTargetPane.value === 'remote'
      && (copySourceSessionId.value !== sessionId || state !== 'connected')) {
      void requestCopyCancellation();
      copyDialogOpen.value = false;
      copySourceEntry.value = null;
    }
    if (sessionId && state === 'connected') {
      if (sftp.sessionId !== sessionId) sftp.clear();
      void sftp.load(sessionId, '.');
    } else {
      sftp.clear();
      createDirectoryOpen.value = false;
      renameDialogOpen.value = false;
      moveDialogOpen.value = false;
      moveSourceEntry.value = null;
      copyDialogOpen.value = false;
      copySourceEntry.value = null;
      activePane.value = 'remote';
    }
  },
  { immediate: true },
);

watch(dualPaneEnabled, (enabled) => {
  if (enabled) void localFiles.load(localFiles.listing?.path);
  else {
    if (copyDialogOpen.value && copyTargetPane.value === 'local') {
      void requestCopyCancellation();
      closeCopyDialog();
    }
    activePane.value = 'remote';
    if (checksumTarget.value) void closeChecksumDialog();
    if (syncPreviewTarget.value) void closeSyncPreviewDialog();
  }
}, { immediate: true });

onMounted(async () => {
  if (!isTauriRuntime()) return;
  try {
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'leave') {
        nativeDropActive.value = false;
        return;
      }
      const isTarget = isRemoteDropTarget(event.payload.position);
      if (event.payload.type === 'drop') {
        nativeDropActive.value = false;
        if (isTarget) void queueDroppedLocalPaths(event.payload.paths);
        return;
      }
      nativeDropActive.value = isTarget && !dropBusy.value;
    });
    if (inspectorUnmounted) void unlisten();
    else unlistenNativeDrop = unlisten;
  } catch {
    nativeDropActive.value = false;
  }
});

onBeforeUnmount(() => {
  inspectorUnmounted = true;
  if (copyOperationId.value) void requestCopyCancellation();
  document.removeEventListener('visibilitychange', updateAppForeground);
  window.removeEventListener('focus', updateAppForeground);
  window.removeEventListener('blur', updateAppForeground);
  if (unlistenNativeDrop) {
    void unlistenNativeDrop();
    unlistenNativeDrop = null;
  }
  void closeChecksumDialog();
  void closeSyncPreviewDialog();
});

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state, settings.value.inspectorTab] as const,
  ([sessionId, state, tab]) => {
    monitor.clear();
    if (sessionId && state === 'connected' && tab === 'monitor' && appForeground.value) void monitor.collect(sessionId);
  },
  { immediate: true },
);

watch(
  () => [
    sessions.activeSessionId,
    sessions.activeSession?.state,
    settings.value.inspectorTab,
    monitor.snapshot?.state,
    settings.value.monitorIntervalSeconds,
    appForeground.value,
    monitor.consecutiveFailures,
  ] as const,
  ([sessionId, state, tab, monitorState, intervalSeconds, foreground, consecutiveFailures], _previous, onCleanup) => {
    if (!sessionId || state !== 'connected' || tab !== 'monitor' || !foreground) return;
    if (monitorState === 'unsupported' || monitorState === 'permission_denied') return;
    const backoffFactor = 2 ** Math.min(consecutiveFailures, 4);
    const pollIntervalMs = Math.min(300_000, intervalSeconds * backoffFactor * 1_000);
    const timer = window.setInterval(() => void monitor.collect(sessionId), pollIntervalMs);
    onCleanup(() => window.clearInterval(timer));
  },
  { immediate: true },
);

watch(appForeground, (foreground) => {
  const session = sessions.activeSession;
  if (foreground && session?.state === 'connected' && settings.value.inspectorTab === 'monitor') {
    void monitor.collect(session.id);
  }
});

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state] as const,
  ([sessionId, state]) => {
    processes.clear();
    if (sessionId && state === 'connected'
      && settings.value.inspectorTab === 'monitor' && monitorView.value === 'processes') {
      void processes.collect(sessionId);
    }
  },
  { immediate: true },
);

watch(
  () => [settings.value.inspectorTab, monitorView.value] as const,
  ([tab, view]) => {
    const session = sessions.activeSession;
    if (tab === 'monitor' && view === 'processes' && session?.state === 'connected') {
      void processes.collect(session.id);
    }
  },
);

const monitorStateLabel = computed(() => {
  switch (monitor.displayState) {
    case 'live': return t('inspector.monitorLive');
    case 'stale': return t('inspector.monitorStale');
    case 'unsupported': return t('inspector.monitorUnsupported');
    case 'permission_denied': return t('inspector.monitorPermissionDenied');
    case 'failed': return t('inspector.monitorFailed');
    default: return t('inspector.monitorPending');
  }
});
const monitorBackoffSeconds = computed(() => Math.min(
  300,
  settings.value.monitorIntervalSeconds * (2 ** Math.min(monitor.consecutiveFailures, 4)),
));
const showMonitorBackoff = computed(() => monitor.consecutiveFailures > 0
  && monitor.snapshot?.state !== 'unsupported'
  && monitor.snapshot?.state !== 'permission_denied');

function formatSize(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatPermissionMode(mode: number | null): string {
  return mode === null ? '—' : mode.toString(8).padStart(4, '0');
}

function permissionModeTitle(mode: number | null): string {
  return mode === null
    ? t('inspector.permissionsUnavailable')
    : t('inspector.permissionsMode', { mode: formatPermissionMode(mode) });
}

async function closeChecksumDialog(): Promise<void> {
  checksumDialogOpen.value = false;
  checksumTarget.value = null;
  if (checksums.loading) await checksums.cancel();
  checksums.clear();
}

async function closeSyncPreviewDialog(): Promise<void> {
  syncPreviewDialogOpen.value = false;
  syncPreviewTarget.value = null;
  if (syncPreviews.loading) await syncPreviews.cancel();
  syncPreviews.clear();
}

function openChecksumComparison(): void {
  const session = sessions.activeSession;
  const local = selectedLocalEntry.value;
  const remote = selectedRemoteEntry.value;
  if (!canCompareChecksums.value || !session || !local || !remote) return;

  checksums.clear();
  checksumTarget.value = {
    sessionId: session.id,
    host: `${session.username}@${session.host} (${session.port})`,
    localName: local.name,
    remoteName: remote.name,
  };
  checksumDialogOpen.value = true;
  void checksums.compare(session.id, local.path, remote.path);
}

async function openSyncPreviewDialog(): Promise<void> {
  const session = sessions.activeSession;
  const localRoot = localFiles.listing?.path;
  const remoteRoot = sftp.path;
  if (!canPreviewDirectorySync.value || !session || !localRoot) return;
  const host = `${session.username}@${session.host} (${session.port})`;
  const accepted = await ui.confirm({
    title: t('inspector.syncPreviewConfirmTitle'),
    message: t('inspector.syncPreviewConfirmMessage', { host, localRoot, remoteRoot }),
    confirmLabel: t('inspector.previewSync'),
  });
  if (!accepted || !canPreviewDirectorySync.value || sessions.activeSession?.id !== session.id) return;

  syncPreviews.clear();
  syncPreviewTarget.value = { sessionId: session.id, host, localRoot, remoteRoot };
  syncPreviewDialogOpen.value = true;
  void syncPreviews.run(session.id, localRoot, remoteRoot);
}

function syncChangeLabel(kind: DirectorySyncChangeKind): string {
  switch (kind) {
    case 'local_only': return t('inspector.syncPreviewLocalOnly');
    case 'remote_only': return t('inspector.syncPreviewRemoteOnly');
    case 'metadata_different': return t('inspector.syncPreviewMetadataDifferent');
    case 'type_conflict': return t('inspector.syncPreviewTypeConflict');
    case 'unsupported': return t('inspector.syncPreviewUnsupported');
  }
  return t('inspector.syncPreviewUnknown');
}

function syncEntryLabel(
  kind: DirectorySyncEntryKind | null,
  size: number | null,
  modifiedAtMs: number | null,
): string {
  if (kind === null) return '—';
  if (kind === 'file') {
    const fileDetails = [t('inspector.syncPreviewKindFile'), formatSize(size)];
    const modified = formatSyncTimestamp(modifiedAtMs);
    if (modified !== '—') fileDetails.push(modified);
    return fileDetails.join(' · ');
  }
  switch (kind) {
    case 'directory': return t('inspector.syncPreviewKindDirectory');
    case 'symlink': return t('inspector.syncPreviewKindSymlink');
    case 'special': return t('inspector.syncPreviewKindSpecial');
  }
  return t('inspector.syncPreviewUnknown');
}

function formatSyncTimestamp(timestampMs: number | null): string {
  if (timestampMs === null) return '—';
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function remoteJoin(directory: string, name: string): string {
  const parent = directory.replace(/\/+$/, '');
  return parent ? `${parent}/${name}` : `/${name}`;
}

function localJoin(directory: string, name: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const parent = directory.replace(/[\\/]+$/, '');
  return parent ? `${parent}${separator}${name}` : `${separator}${name}`;
}

function bindRemoteDropElement(element: Element | ComponentPublicInstance | null): void {
  remoteDropElement.value = element instanceof HTMLElement ? element : null;
}

function isRemoteDropTarget(position: { x: number; y: number }): boolean {
  const element = remoteDropElement.value;
  if (!element || settings.value.inspectorTab !== 'files' || !remoteReady.value) return false;
  const bounds = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function isSafeTransferName(name: string): boolean {
  return name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    // eslint-disable-next-line no-control-regex -- control characters must be detected here
    && !/[\\/\u0000-\u001f\u007f]/u.test(name);
}

async function queueDroppedLocalPaths(paths: string[]): Promise<void> {
  if (dropBusy.value) return;
  const session = sessions.activeSession;
  if (!session || !remoteReady.value || settings.value.inspectorTab !== 'files') return;
  if (quickSession.value) {
    ui.notify(t('quick.savedHint'));
    return;
  }
  dropBusy.value = true;
  nativeDropActive.value = false;
  const sessionId = session.id;
  const profileId = session.profileId;
  const remoteRoot = sftp.path;
  const distinctPaths = [...new Set(paths)];
  let unsupported = Math.max(0, distinctPaths.length - 64);
  let queued = 0;
  try {
    for (const path of distinctPaths.slice(0, 64)) {
      if (!path || path.length > 4_096 || path.includes('\0')) {
        unsupported += 1;
        continue;
      }
      const inspected = await inspectLocalEntry(path);
      if (!inspected.ok) {
        transfers.error = inspected.error;
        break;
      }
      const entry = inspected.data;
      if (!isSafeTransferName(entry.name)
        || entry.isSymlink
        || (!entry.isDirectory && entry.size === null)) {
        unsupported += 1;
        continue;
      }
      const input: CreateTransferInput = {
        profileId,
        direction: 'upload',
        localPath: entry.path,
        remotePath: remoteJoin(remoteRoot, entry.name),
        conflictPolicy: 'ask',
        totalBytes: entry.isDirectory ? null : entry.size,
      };
      if (!await transfers.enqueue(input, sessionId)) break;
      queued += 1;
    }
    if (queued > 0) {
      settings.value.taskTab = 'transfers';
      settings.value.taskDrawerOpen = true;
      ui.notify(t('inspector.dropUploadQueued', { count: queued }));
    }
    if (unsupported > 0) ui.notify(t('inspector.dropUnsupportedItems', { count: unsupported }));
  } catch {
    ui.notify(t('inspector.dropFailed'));
  } finally {
    dropBusy.value = false;
  }
}

function beginRemoteFileDrag(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote', event: DragEvent): void {
  const session = sessions.activeSession;
  if (pane !== 'remote' || !session || !remoteReady.value || entry.isSymlink || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(REMOTE_FILE_DRAG_TYPE, JSON.stringify({ path: entry.path, sessionId: session.id }));
  event.dataTransfer.effectAllowed = 'copy';
}

function allowRemoteFileDrop(event: DragEvent, pane: 'local' | 'remote'): void {
  if (pane !== 'local' || !event.dataTransfer) return;
  const types = Array.from(event.dataTransfer.types);
  if (!types.includes(REMOTE_FILE_DRAG_TYPE)) return;
  event.preventDefault();
  localDropActive.value = true;
  event.dataTransfer.dropEffect = 'copy';
}

function leaveRemoteFileDrop(event: DragEvent, pane: 'local' | 'remote'): void {
  if (pane !== 'local') return;
  const element = event.currentTarget;
  if (element instanceof HTMLElement && event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
  localDropActive.value = false;
}

async function dropRemoteFileOnLocal(event: DragEvent, pane: 'local' | 'remote'): Promise<void> {
  if (pane !== 'local' || !event.dataTransfer) return;
  const raw = event.dataTransfer.getData(REMOTE_FILE_DRAG_TYPE);
  if (!raw) return;
  event.preventDefault();
  localDropActive.value = false;
  if (quickSession.value) {
    ui.notify(t('quick.savedHint'));
    return;
  }
  try {
    const payload = JSON.parse(raw) as { path?: unknown; sessionId?: unknown };
    if (typeof payload.path !== 'string' || typeof payload.sessionId !== 'string') return;
    const session = sessions.activeSession;
    const listing = localFiles.listing;
    const entry = sftp.entries.find((candidate) => candidate.path === payload.path);
    if (!session || session.id !== payload.sessionId || !remoteReady.value || !listing || !entry
      || entry.isSymlink || !isSafeTransferName(entry.name)) return;
    const input: CreateTransferInput = {
      profileId: session.profileId,
      direction: 'download',
      localPath: localJoin(listing.path, entry.name),
      remotePath: entry.path,
      conflictPolicy: 'ask',
      totalBytes: entry.isDirectory ? null : entry.size,
    };
    if (await transfers.enqueue(input, session.id)) {
      settings.value.taskTab = 'transfers';
      settings.value.taskDrawerOpen = true;
      ui.notify(t('inspector.dropDownloadQueued', { name: entry.name }));
    }
  } catch {
    ui.notify(t('inspector.dropFailed'));
  }
}

function defaultCopyName(name: string, isDirectory: boolean): string {
  if (isDirectory) return name + ' (' + t('inspector.copyNameSuffix') + ')';
  const dot = name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : name.length;
  return `${name.slice(0, stemEnd)} (${t('inspector.copyNameSuffix')})${name.slice(stemEnd)}`;
}

function openUpload(): void {
  if (!remoteReady.value) return;
  if (quickSession.value) {
    ui.notify(t('quick.savedHint'));
    return;
  }
  const source = selectedLocalEntry.value;
  if (source && !source.isSymlink) {
    ui.openTransfer('upload', remoteJoin(sftp.path, source.name), source.path, sessions.activeSession?.profileId);
  } else if (!dualPaneEnabled.value && activePane.value === 'remote' && remoteReady.value) {
    ui.openTransfer('upload', `${sftp.path.replace(/\/$/, '')}/`, undefined, sessions.activeSession?.profileId);
  }
}

async function openDownload(): Promise<void> {
  if (!remoteReady.value) return;
  if (quickSession.value) {
    ui.notify(t('quick.savedHint'));
    return;
  }
  const source = selectedRemoteEntry.value;
  if (!source || source.isSymlink) return;
  if (!localFiles.listing) await localFiles.load();
  const directory = localFiles.listing?.path;
  ui.openTransfer('download', source.path, directory ? localJoin(directory, source.name) : undefined, sessions.activeSession?.profileId);
}

async function refreshActivePane(): Promise<void> {
  if (activePane.value === 'local') await localFiles.load(localFiles.listing?.path);
  else if (sessions.activeSessionId) await sftp.load(sessions.activeSessionId, sftp.path);
}

function selectPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  activePane.value = pane;
  if (pane === 'local') {
    localFiles.select(entry);
  } else {
    sftp.select(entry);
  }
}

function openPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  selectPaneEntry(entry, pane);
  if (pane === 'local') void localFiles.open(entry);
  else void sftp.open(entry);
}

function metricUsage(total: number | null | undefined, available: number | null | undefined): string {
  if (!total || available === null || available === undefined) return '—';
  return `${Math.max(0, Math.min(100, ((total - available) / total) * 100)).toFixed(1)}%`;
}

function metricUsed(total: number | null | undefined, used: number | null | undefined): string {
  if (!total || used === null || used === undefined) return '—';
  return `${Math.max(0, Math.min(100, (used / total) * 100)).toFixed(1)}%`;
}

function metricRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  if (bytesPerSecond < 1024 * 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MiB/s`;
  return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GiB/s`;
}

function processCpu(entry: ProcessEntry): string {
  if (entry.cpuPercent !== null) return `${entry.cpuPercent.toFixed(1)}%`;
  if (entry.cpuTimeSeconds !== null) return `${entry.cpuTimeSeconds.toFixed(1)} s`;
  return '—';
}

async function terminateProcess(entry: ProcessEntry): Promise<void> {
  const session = sessions.activeSession;
  const snapshot = processes.snapshot;
  if (!session || session.state !== 'connected' || !snapshot?.snapshotId || !entry.canTerminate) return;
  if (Date.now() - snapshot.collectedAtMs > 60_000) {
    await processes.collect(session.id);
    return;
  }
  const action = snapshot.platform === 'windows'
    ? t('inspector.processActionWindows')
    : 'SIGTERM';
  const accepted = await ui.confirm({
    title: t('inspector.terminateProcessTitle'),
    message: t('inspector.terminateProcessConfirm', {
      host: session.host,
      port: session.port,
      pid: entry.pid,
      name: entry.name,
      action,
    }),
    confirmLabel: t('inspector.terminateProcess'),
    danger: true,
  });
  if (!accepted) return;
  if (await processes.terminate(session.id, entry.pid)) {
    ui.notify(t('inspector.processSignalSent', { name: entry.name, pid: entry.pid }));
  }
}

const tabs: { id: InspectorTab; label: Parameters<typeof t>[0]; icon: typeof FolderOpen }[] = [
  { id: 'files', label: 'inspector.files', icon: FolderOpen },
  { id: 'monitor', label: 'inspector.monitor', icon: Activity },
  { id: 'session', label: 'inspector.session', icon: Info },
];

function updateInput(value: ConnectionProfile, favorite = value.favorite): UpdateConnectionProfileInput {
  return {
    name: value.name,
    group: value.group,
    host: value.host,
    port: value.port,
    username: value.username,
    environment: value.environment,
    favorite,
    tags: value.tags,
    authenticationMethod: value.authenticationMethod,
    identityFile: value.identityFile,
    proxyJump: value.proxyJump,
    proxyJumpProfileIds: [...value.proxyJumpProfileIds],
  };
}

async function toggleFavorite(): Promise<void> {
  if (profile.value) await connections.update(profile.value.id, updateInput(profile.value, !profile.value.favorite));
}

async function duplicateProfile(): Promise<void> {
  if (profile.value && await connections.duplicate(profile.value.id)) ui.notify(t('profile.duplicated'));
}

async function deleteProfile(): Promise<void> {
  if (!profile.value) return;
  const accepted = await ui.confirm({
    title: t('profile.delete'),
    message: t('profile.deleteConfirm'),
    confirmLabel: t('profile.delete'),
    danger: true,
  });
  if (!accepted) return;
  if (await connections.remove(profile.value.id)) ui.notify(t('profile.deleted'));
}

async function deleteActiveEntry(): Promise<void> {
  if (activePane.value === 'local') {
    const entry = selectedLocalEntry.value;
    const sourceDirectory = localFiles.listing?.path;
    if (!entry || !sourceDirectory) return;
    const accepted = await ui.confirm({
      title: t('inspector.deleteLocal'),
      message: t('inspector.deleteLocalConfirm', { name: entry.name, path: entry.path }),
      confirmLabel: t('inspector.deleteLocal'),
      danger: true,
    });
    if (!accepted
      || localFiles.listing?.path !== sourceDirectory
      || !localFiles.listing.entries.some((candidate) => candidate.path === entry.path)) return;
    if (await localFiles.remove(entry)) ui.notify(t('inspector.localDeleted'));
    return;
  }
  const entry = selectedRemoteEntry.value;
  const sourceSession = sessions.activeSession;
  const sourceSessionId = sourceSession?.id;
  const sourceDirectory = sftp.path;
  if (!entry || !sourceSession || !sourceSessionId || sftp.sessionId !== sourceSessionId || !remoteReady.value) return;
  const accepted = await ui.confirm({
    title: t('inspector.deleteRemote'),
    message: t('inspector.deleteRemoteConfirm', {
      name: entry.name,
      path: entry.path,
      host: `${sourceSession.username}@${sourceSession.host}:${sourceSession.port}`,
    }),
    confirmLabel: t('inspector.deleteRemote'),
    danger: true,
  });
  const activeSession = sessions.activeSession;
  if (!accepted
    || sessions.activeSessionId !== sourceSessionId
    || !activeSession
    || activeSession.profileId !== sourceSession.profileId
    || activeSession.generation !== sourceSession.generation
    || activeSession.username !== sourceSession.username
    || activeSession.host !== sourceSession.host
    || activeSession.port !== sourceSession.port
    || sftp.sessionId !== sourceSessionId
    || sftp.path !== sourceDirectory
    || !remoteReady.value
    || !sftp.entries.some((candidate) => candidate.path === entry.path)) return;
  if (accepted && await sftp.remove(entry)) ui.notify(t('inspector.remoteDeleted'));
}

function openCreateDirectory(): void {
  newDirectoryName.value = '';
  directoryTargetPane.value = activePane.value;
  if (activePane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  createDirectoryOpen.value = true;
}

async function submitCreateDirectory(): Promise<void> {
  if (!newDirectoryName.value.trim()) return;
  if (directoryTargetPane.value === 'local') {
    if (await localFiles.createDirectory(newDirectoryName.value)) {
      createDirectoryOpen.value = false;
      ui.notify(t('inspector.localDirectoryCreated'));
    }
    return;
  }
  if (await sftp.createDirectory(newDirectoryName.value)) {
    createDirectoryOpen.value = false;
    ui.notify(t('inspector.directoryCreated'));
  }
}

function openRenameDialog(): void {
  const entry = activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value;
  if (!entry) return;
  renameTargetPane.value = activePane.value;
  renameName.value = entry.name;
  if (renameTargetPane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  renameDialogOpen.value = true;
}

async function submitRename(): Promise<void> {
  if (!renameName.value.trim()) return;
  if (renameTargetPane.value === 'local') {
    const entry = selectedLocalEntry.value;
    if (!entry) return;
    if (await localFiles.rename(entry, renameName.value)) {
      renameDialogOpen.value = false;
      ui.notify(t('inspector.localRenamed'));
    }
    return;
  }
  const entry = selectedRemoteEntry.value;
  if (!entry) return;
  if (await sftp.rename(entry, renameName.value)) {
    renameDialogOpen.value = false;
    ui.notify(t('inspector.remoteRenamed'));
  }
}

function openMoveDialog(): void {
  const entry = activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value;
  if (!entry) return;
  moveTargetPane.value = activePane.value;
  moveSourceEntry.value = entry;
  moveSourceSessionId.value = activePane.value === 'remote' ? sessions.activeSessionId : null;
  moveDestinationDirectory.value = '';
  if (activePane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  moveDialogOpen.value = true;
}

function closeMoveDialog(): void {
  if (moveBusy.value) return;
  moveDialogOpen.value = false;
  moveSourceEntry.value = null;
}

async function submitMove(): Promise<void> {
  const source = moveSourceEntry.value;
  const destinationDirectory = moveDestinationDirectory.value.trim();
  if (!source || !destinationDirectory) return;
  if (moveTargetPane.value === 'local') {
    if (await localFiles.move(source, destinationDirectory)) {
      closeMoveDialog();
      ui.notify(t('inspector.localMoved'));
    }
    return;
  }
  const sourceSessionId = moveSourceSessionId.value;
  if (!sourceSessionId || sessions.activeSessionId !== sourceSessionId || !remoteReady.value) {
    closeMoveDialog();
    return;
  }
  if (await sftp.move(source, destinationDirectory)) {
    closeMoveDialog();
    ui.notify(t('inspector.remoteMoved'));
  }
}

function openCopyDialog(): void {
  const entry = activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value;
  if (!entry || entry.isSymlink) return;
  copyTargetPane.value = activePane.value;
  copySourceEntry.value = entry;
  copySourceSessionId.value = activePane.value === 'remote' ? sessions.activeSessionId : null;
  copyDestinationDirectory.value = activePane.value === 'local'
    ? localFiles.listing?.path ?? ''
    : sftp.path;
  copyTargetName.value = defaultCopyName(entry.name, entry.isDirectory);
  if (activePane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  copyDialogOpen.value = true;
}

function closeCopyDialog(): void {
  if (copyBusy.value) return;
  copyDialogOpen.value = false;
  copySourceEntry.value = null;
  copyOperationId.value = null;
  copyCancelling.value = false;
}

async function requestCopyCancellation(): Promise<void> {
  const operationId = copyOperationId.value;
  if (!operationId || copyCancelling.value) return;
  copyCancelling.value = true;
  const targetPane = copyTargetPane.value;
  const cancelled = targetPane === 'local'
    ? await localFiles.cancelCopy(operationId)
    : await sftp.cancelCopy(operationId);
  if (copyOperationId.value === operationId && !cancelled) copyCancelling.value = false;
}

async function submitCopy(): Promise<void> {
  if (copyBusy.value) return;
  const source = copySourceEntry.value;
  const destinationDirectory = copyDestinationDirectory.value.trim();
  const targetName = copyTargetName.value.trim();
  if (!source || !destinationDirectory || !targetName) return;
  const operationId = crypto.randomUUID();
  copyOperationId.value = operationId;
  copyCancelling.value = false;
  try {
    if (copyTargetPane.value === 'local') {
      const copied = await localFiles.copy(
        source,
        destinationDirectory,
        targetName,
        operationId,
      );
      if (copied) {
        closeCopyDialog();
        ui.notify(t('inspector.localCopied'));
      } else if (copyCancelling.value) {
        ui.notify(t('inspector.copyCancelled'));
      }
      return;
    }
    const sourceSessionId = copySourceSessionId.value;
    if (!sourceSessionId || sessions.activeSessionId !== sourceSessionId || !remoteReady.value) {
      closeCopyDialog();
      return;
    }
    const copied = await sftp.copy(
      source,
      destinationDirectory,
      targetName,
      operationId,
    );
    if (copied) {
      closeCopyDialog();
      ui.notify(t('inspector.remoteCopied'));
    } else if (copyCancelling.value) {
      ui.notify(t('inspector.copyCancelled'));
    }
  } finally {
    if (copyOperationId.value === operationId) {
      copyOperationId.value = null;
      copyCancelling.value = false;
    }
  }
}

function focusInspector(): void {
  const target = inspectorRoot.value?.querySelector<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
  );
  (target ?? inspectorRoot.value)?.focus();
}

defineExpose({ focusInspector });
</script>

<template>
  <aside ref="inspectorRoot" class="inspector-pane" tabindex="-1">
    <div class="inspector-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="settings.value.inspectorTab === tab.id"
        @click="settings.value.inspectorTab = tab.id"
      >
        <component :is="tab.icon" :size="12" />
        {{ t(tab.label) }}
      </button>
    </div>

    <section v-if="settings.value.inspectorTab === 'files'" class="inspector-content">
      <div class="inspector-toolbar">
        <strong>{{ t('inspector.browserPath') }}</strong>
        <span>
          <button type="button" class="icon-button" :disabled="quickSession || !remoteReady || sftp.loading || (dualPaneEnabled && (activePane !== 'local' || !selectedLocalEntry || selectedLocalEntry.isSymlink))" :aria-label="t('inspector.uploadFile')" :title="quickSession ? t('quick.savedHint') : t('inspector.uploadFile')" @click="openUpload"><Upload :size="12" /></button>
          <button type="button" class="icon-button" :disabled="quickSession || !remoteReady || sftp.loading || activePane !== 'remote' || !selectedRemoteEntry || selectedRemoteEntry.isSymlink" :aria-label="t('inspector.downloadFile')" :title="quickSession ? t('quick.savedHint') : t('inspector.downloadFile')" @click="openDownload"><Download :size="12" /></button>
          <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canCompareChecksums || checksums.loading" :aria-label="t('inspector.compareChecksums')" :title="t('inspector.compareChecksums')" @click="openChecksumComparison"><ShieldCheck :size="12" /></button>
          <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canPreviewDirectorySync || syncPreviews.loading" :aria-label="t('inspector.previewSync')" :title="t('inspector.previewSync')" @click="openSyncPreviewDialog"><ArrowLeftRight :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.deleting)" :aria-label="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" :title="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" @click="deleteActiveEntry"><Trash2 :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.renaming)" :aria-label="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" :title="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" @click="openRenameDialog"><Edit3 :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.deleting || sftp.renaming || sftp.creatingDirectory || sftp.moving)" :aria-label="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" :title="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" @click="openMoveDialog"><FolderInput :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || selectedLocalEntry.isSymlink || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || selectedRemoteEntry.isSymlink || sftp.copying || sftp.moving || sftp.renaming || sftp.deleting || sftp.creatingDirectory)" :aria-label="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" :title="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" @click="openCopyDialog"><Copy :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (localFiles.loading || localFiles.mutating) : (!sessions.activeSessionId || sftp.loading)" :aria-label="t('inspector.refreshFiles')" @click="refreshActivePane"><RefreshCw :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!localFiles.listing || localFiles.mutating) : (!remoteReady || sftp.creatingDirectory)" :aria-label="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" :title="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" @click="openCreateDirectory"><FolderPlus :size="12" /></button>
          <button type="button" class="icon-button" :aria-pressed="dualPaneEnabled" :aria-label="t('inspector.toggleDualPane')" :title="t('inspector.toggleDualPane')" @click="settings.value.dualPaneSftp = !dualPaneEnabled"><Columns2 :size="12" /></button>
        </span>
      </div>
      <div class="file-browser" :class="{ 'file-browser-dual': dualPaneEnabled }">
        <section v-for="pane in browserPanes" :key="pane.id" class="file-browser-pane" :class="{ active: activePane === pane.id }" role="region" :aria-label="t(pane.label)" @mousedown="activePane = pane.id">
          <header class="file-browser-pane-heading">
            <strong>{{ t(pane.label) }}</strong>
            <div class="path-breadcrumb mono"><button type="button" class="icon-button" :disabled="pane.id === 'remote' ? !sftp.sessionId : !localFiles.listing?.parentPath" :aria-label="t('inspector.parentDirectory')" @click.stop="pane.id === 'local' ? localFiles.parent() : sftp.parent()"><ChevronUp :size="11" /></button><ChevronRight :size="11" /><span :title="pane.path">{{ pane.path }}</span></div>
          </header>
          <div
            :ref="pane.id === 'remote' ? bindRemoteDropElement : undefined"
            class="file-list"
            :class="{ 'file-list-drop-target': (pane.id === 'remote' && nativeDropActive) || (pane.id === 'local' && localDropActive) }"
            @dragover="allowRemoteFileDrop($event, pane.id)"
            @dragleave="leaveRemoteFileDrop($event, pane.id)"
            @drop="dropRemoteFileOnLocal($event, pane.id)"
          >
            <div v-if="pane.loading" class="task-empty">{{ t('inspector.loadingFiles') }}</div>
            <div v-else-if="pane.error" class="inline-notice error"><ShieldQuestion :size="14" /><span>{{ t(pane.error.messageKey as Parameters<typeof t>[0]) }}</span></div>
            <div v-else-if="pane.entries.length === 0" class="task-empty">{{ t('inspector.emptyDirectory') }}</div>
            <template v-else>
              <p v-if="pane.truncated" class="dialog-note preview-truncated">{{ t('inspector.directoryTruncated') }}</p>
              <button v-for="entry in pane.entries" :key="entry.path" type="button" class="file-row" :class="{ selected: entry.path === pane.selectedPath }" :draggable="pane.id === 'remote' && !entry.isSymlink" @dragstart="beginRemoteFileDrag(entry, pane.id, $event)" @click="selectPaneEntry(entry, pane.id)" @dblclick="openPaneEntry(entry, pane.id)" @keydown.enter.prevent="openPaneEntry(entry, pane.id)">
                <Folder v-if="entry.isDirectory" :size="13" /><File v-else :size="13" />
                <span>{{ entry.name }}</span><small>{{ formatSize(entry.size) }}</small>
                <small class="file-permissions" :title="permissionModeTitle(entry.permissionsMode)">{{ t('inspector.permissionModeShort', { mode: formatPermissionMode(entry.permissionsMode) }) }}</small>
              </button>
            </template>
            <div v-if="pane.id === 'remote' && nativeDropActive" class="file-drop-hint">{{ t('inspector.dropUploadHint') }}</div>
            <div v-if="pane.id === 'local' && localDropActive" class="file-drop-hint">{{ t('inspector.dropDownloadHint') }}</div>
          </div>
        </section>
      </div>
      <div v-if="sessions.activeSession?.state !== 'connected'" class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.fileRequiresSession') }}</span></div>
    </section>

    <section v-else-if="settings.value.inspectorTab === 'monitor'" class="inspector-content monitor-content">
      <div class="monitor-subtabs" role="tablist" :aria-label="t('inspector.monitor')">
        <button type="button" role="tab" :aria-selected="monitorView === 'metrics'" @click="monitorView = 'metrics'">{{ t('inspector.metricView') }}</button>
        <button type="button" role="tab" :aria-selected="monitorView === 'processes'" @click="monitorView = 'processes'">{{ t('inspector.processView') }}</button>
      </div>
      <section v-if="monitorView === 'metrics'">
        <div class="metric-heading"><strong>{{ t('inspector.monitor') }}</strong><span class="status-pill" :class="monitor.displayState === 'live' ? 'available' : (monitor.displayState === 'stale' || monitor.displayState === 'unsupported' || monitor.displayState === 'unprobed' ? 'pending' : 'danger')">{{ monitor.loading ? t('inspector.monitorLoading') : monitorStateLabel }}</span><button type="button" class="icon-button" :disabled="!sessions.activeSessionId || monitor.loading" :aria-label="t('inspector.refreshMonitor')" @click="sessions.activeSessionId && monitor.collect(sessions.activeSessionId)"><RefreshCw :size="12" /></button></div>
        <p v-if="showMonitorBackoff" class="monitor-backoff" role="status">{{ t('inspector.monitorBackoff', { seconds: monitorBackoffSeconds }) }}</p>
        <div class="metric-row"><Server :size="14" /><span>{{ t('inspector.system') }}</span><strong>{{ monitor.snapshot?.hostname ?? '—' }}</strong></div>
        <div class="metric-row"><Activity :size="14" /><span>{{ t('inspector.cpu') }}</span><strong>{{ monitor.snapshot?.cpuPercent === null || monitor.snapshot?.cpuPercent === undefined ? '—' : `${monitor.snapshot.cpuPercent.toFixed(1)}%` }}</strong></div>
        <div class="metric-row"><Activity :size="14" /><span>{{ t('inspector.load') }}</span><strong>{{ monitor.snapshot?.loadOne?.toFixed(2) ?? '—' }}</strong></div>
        <div class="metric-row"><MemoryStick :size="14" /><span>{{ t('inspector.memory') }}</span><strong>{{ metricUsage(monitor.snapshot?.memoryTotalKib, monitor.snapshot?.memoryAvailableKib) }}</strong></div>
        <div class="metric-row"><MemoryStick :size="14" /><span>{{ t('inspector.swap') }}</span><strong>{{ metricUsed(monitor.snapshot?.swapTotalKib, monitor.snapshot?.swapUsedKib) }}</strong></div>
        <div class="metric-row"><HardDrive :size="14" /><span>{{ t('inspector.disk') }}</span><strong>{{ metricUsage(monitor.snapshot?.rootTotalKib, monitor.snapshot?.rootAvailableKib) }}</strong></div>
        <div class="metric-row"><Download :size="14" /><span>{{ t('inspector.networkReceive') }}</span><strong>{{ metricRate(monitor.snapshot?.networkReceiveBytesPerSecond) }}</strong></div>
        <div class="metric-row"><Upload :size="14" /><span>{{ t('inspector.networkTransmit') }}</span><strong>{{ metricRate(monitor.snapshot?.networkTransmitBytesPerSecond) }}</strong></div>
        <div v-if="monitor.error" class="inline-notice error"><ShieldQuestion :size="14" /><span>{{ t(monitor.error.messageKey as Parameters<typeof t>[0]) }}</span></div>
        <div v-else-if="sessions.activeSession?.state !== 'connected'" class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.monitorRequiresSession') }}</span></div>
      </section>
      <section v-else class="process-view">
        <div class="metric-heading">
          <strong>{{ t('inspector.processes') }}</strong>
          <span class="status-pill" :class="processes.snapshot?.state === 'live' ? 'available' : 'pending'">{{ processes.loading ? t('inspector.processLoading') : processes.snapshot?.state === 'live' ? t('inspector.processLive') : processes.snapshot?.state === 'unsupported' ? t('inspector.monitorUnsupported') : t('inspector.monitorPending') }}</span>
          <button type="button" class="icon-button" :disabled="!sessions.activeSessionId || processes.loading || processes.terminatingPid !== null" :aria-label="t('inspector.refreshProcesses')" @click="sessions.activeSessionId && processes.collect(sessions.activeSessionId)"><RefreshCw :size="12" /></button>
        </div>
        <p class="process-help">{{ t('inspector.processHelp') }}</p>
        <div v-if="processes.error" class="inline-notice error"><ShieldQuestion :size="14" /><span>{{ t(processes.error.messageKey as Parameters<typeof t>[0]) }}</span></div>
        <div v-else-if="sessions.activeSession?.state !== 'connected'" class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.processRequiresSession') }}</span></div>
        <div v-else-if="processes.snapshot?.state === 'unsupported'" class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.processUnsupported') }}</span></div>
        <div v-else-if="processes.loading && !processes.snapshot" class="task-empty">{{ t('inspector.processLoading') }}</div>
        <div v-else-if="processes.snapshot && processes.snapshot.processes.length === 0" class="task-empty">{{ t('inspector.processEmpty') }}</div>
        <div v-else-if="processes.snapshot" class="process-list">
          <p v-if="processes.snapshot.truncated" class="dialog-note preview-truncated">{{ t('inspector.processTruncated') }}</p>
          <div v-for="entry in processes.snapshot.processes" :key="entry.pid" class="process-row">
            <div class="process-details">
              <strong :title="entry.name">{{ entry.name }}</strong>
              <small>PID {{ entry.pid }}<template v-if="entry.state"> · {{ t('inspector.processState') }} {{ entry.state }}</template></small>
              <small>{{ t(entry.cpuPercent !== null ? 'inspector.processCpu' : 'inspector.processCpuTime') }} {{ processCpu(entry) }} · {{ t('inspector.processMemory') }} {{ formatSize(entry.memoryBytes) }}</small>
            </div>
            <button type="button" class="icon-button process-terminate danger-button" :disabled="!entry.canTerminate || processes.loading || processes.terminatingPid !== null" :aria-label="entry.canTerminate ? t('inspector.terminateProcessTarget', { name: entry.name, pid: entry.pid }) : t('inspector.processIdentityUnavailable')" :title="entry.canTerminate ? t('inspector.terminateProcessTarget', { name: entry.name, pid: entry.pid }) : t('inspector.processIdentityUnavailable')" @click="terminateProcess(entry)"><CircleStop :size="13" /></button>
          </div>
        </div>
      </section>
    </section>

    <section v-else class="inspector-content session-content">
      <div v-if="profile" class="session-actions">
        <button type="button" class="button" @click="ui.openEditProfile(profile.id)"><Edit3 :size="12" />{{ t('profile.edit') }}</button>
        <button type="button" class="button" @click="duplicateProfile"><Copy :size="12" />{{ t('profile.duplicate') }}</button>
        <button type="button" class="button" :aria-pressed="profile.favorite" @click="toggleFavorite"><Star :size="12" />{{ t('profile.favorite') }}</button>
        <button type="button" class="button danger-button" @click="deleteProfile"><Trash2 :size="12" />{{ t('profile.delete') }}</button>
      </div>
      <dl>
        <div><dt>{{ t('inspector.host') }}</dt><dd class="mono">{{ profile?.host ?? '—' }}:{{ profile?.port ?? 22 }}</dd></div>
        <div><dt>{{ t('inspector.user') }}</dt><dd>{{ profile?.username ?? '—' }}</dd></div>
        <div><dt>{{ t('inspector.trust') }}</dt><dd class="warning-text">{{ t('inspector.trustUnknown') }}</dd></div>
        <div><dt>{{ t('inspector.credential') }}</dt><dd>{{ t('inspector.credentialNone') }}</dd></div>
        <div><dt>{{ t('profile.authentication') }}</dt><dd>{{ authenticationLabel }}</dd></div>
        <div v-if="profile?.identityFile"><dt>{{ profile.authenticationMethod === 'password' ? t('profile.identityFileIgnored') : t('profile.identityFile') }}</dt><dd class="mono">{{ profile.identityFile }}</dd></div>
        <div v-if="profile?.proxyJump"><dt>{{ t('profile.proxyJumpSource') }}</dt><dd class="mono">{{ profile.proxyJump }}</dd></div>
        <div v-if="jumpRouteLabels.length"><dt>{{ t('profile.proxyJumpRoute') }}</dt><dd class="mono">{{ jumpRouteLabels.join(' → ') }}</dd></div>
      </dl>
      <p v-if="profile?.proxyJump && profile.proxyJumpProfileIds.length === 0" class="warning-text profile-capability-warning">{{ t('profile.proxyJumpMapRequired') }}</p>
    </section>

    <div v-if="createDirectoryOpen" class="dialog-layer" @mousedown.self="createDirectoryOpen = false" @keydown.esc="createDirectoryOpen = false">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" @submit.prevent="submitCreateDirectory">
        <header class="dialog-header"><strong>{{ t(directoryTargetPane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory') }}</strong></header>
        <div class="dialog-content">
          <label class="field">
            {{ t('inspector.directoryName') }}
            <input v-model="newDirectoryName" autofocus maxlength="255" autocomplete="off" :placeholder="t('inspector.directoryName')">
          </label>
          <p v-if="directoryError" class="form-error">{{ t(directoryError.messageKey as Parameters<typeof t>[0]) }}</p>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button" @click="createDirectoryOpen = false">{{ t('settings.cancel') }}</button>
          <button type="submit" class="button primary" :disabled="!newDirectoryName.trim() || (directoryTargetPane === 'local' ? localFiles.mutating : sftp.creatingDirectory)">
            {{ (directoryTargetPane === 'local' ? localFiles.mutating : sftp.creatingDirectory) ? t('inspector.directoryCreating') : t(directoryTargetPane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="renameDialogOpen" class="dialog-layer" @mousedown.self="renameDialogOpen = false" @keydown.esc="renameDialogOpen = false">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" @submit.prevent="submitRename">
        <header class="dialog-header"><strong>{{ t(renameTargetPane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote') }}</strong></header>
        <div class="dialog-content">
          <label class="field">
            {{ t('inspector.newName') }}
            <input v-model="renameName" autofocus maxlength="255" autocomplete="off" :placeholder="t('inspector.newName')">
          </label>
          <p v-if="renameError" class="form-error">{{ t(renameError.messageKey as Parameters<typeof t>[0]) }}</p>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button" @click="renameDialogOpen = false">{{ t('settings.cancel') }}</button>
          <button type="submit" class="button primary" :disabled="!renameName.trim() || (renameTargetPane === 'local' ? localFiles.mutating : sftp.renaming)">
            {{ (renameTargetPane === 'local' ? localFiles.mutating : sftp.renaming) ? t('inspector.renaming') : t(renameTargetPane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="moveDialogOpen && moveSourceEntry" class="dialog-layer" @mousedown.self="closeMoveDialog" @keydown.esc.stop.prevent="closeMoveDialog">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="move-entry-title" :aria-busy="moveBusy" @submit.prevent="submitMove">
        <header class="dialog-header"><strong id="move-entry-title">{{ t(moveTargetPane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote') }}</strong></header>
        <div class="dialog-content">
          <dl class="move-target-list">
            <div><dt>{{ t('inspector.moveSource') }}</dt><dd class="mono">{{ moveSourceEntry.path }}</dd></div>
          </dl>
          <label class="field">
            {{ t('inspector.moveDirectory') }}
            <input v-model="moveDestinationDirectory" autofocus maxlength="4096" autocomplete="off" spellcheck="false" :placeholder="t('inspector.moveDirectoryPlaceholder')">
          </label>
          <p class="dialog-note mono">{{ t('inspector.movePreview', { path: moveDestinationPath }) }}</p>
          <p class="dialog-note">{{ t('inspector.moveHelp') }}</p>
          <p v-if="moveError" class="form-error" role="alert">{{ t(moveError.messageKey as Parameters<typeof t>[0]) }}</p>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button" :disabled="moveBusy" @click="closeMoveDialog">{{ t('settings.cancel') }}</button>
          <button type="submit" class="button primary" :disabled="!moveDestinationDirectory.trim() || moveBusy">
            {{ moveBusy ? t('inspector.moving') : t('inspector.moveEntry') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="copyDialogOpen && copySourceEntry" class="dialog-layer" @mousedown.self="closeCopyDialog" @keydown.esc.stop.prevent="closeCopyDialog">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-entry-title" :aria-busy="copyBusy" @submit.prevent="submitCopy">
        <header class="dialog-header"><strong id="copy-entry-title">{{ t(copyTargetPane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote') }}</strong></header>
        <div class="dialog-content">
          <dl class="move-target-list">
            <div><dt>{{ t('inspector.copySource') }}</dt><dd class="mono">{{ copySourceEntry.path }}</dd></div>
          </dl>
          <label class="field">
            {{ t('inspector.copyDirectory') }}
            <input v-model="copyDestinationDirectory" autofocus maxlength="4096" autocomplete="off" spellcheck="false" :placeholder="t('inspector.copyDirectoryPlaceholder')">
          </label>
          <label class="field">
            {{ t('inspector.copyName') }}
            <input v-model="copyTargetName" maxlength="255" autocomplete="off" spellcheck="false" :placeholder="t('inspector.copyName')">
          </label>
          <p class="dialog-note mono">{{ t('inspector.copyPreview', { path: copyDestinationPath }) }}</p>
          <p class="dialog-note">{{ t('inspector.copyHelp') }}</p>
          <p v-if="copyError" class="form-error" role="alert">{{ t(copyError.messageKey as Parameters<typeof t>[0]) }}</p>
        </div>
        <footer class="dialog-footer">
          <button v-if="copyBusy" type="button" class="button" :disabled="copyCancelling" @click="void requestCopyCancellation()">{{ t(copyCancelling ? 'inspector.copyCancelling' : 'inspector.copyCancel') }}</button>
          <button v-else type="button" class="button" @click="closeCopyDialog">{{ t('settings.cancel') }}</button>
          <button type="submit" class="button primary" :disabled="!copyDestinationDirectory.trim() || !copyTargetName.trim() || copyBusy">
            {{ copyBusy ? t('inspector.copying') : t('inspector.copyEntry') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="checksumDialogOpen && checksumTarget" class="dialog-layer" @mousedown.self="void closeChecksumDialog()" @keydown.esc.stop.prevent="void closeChecksumDialog()">
      <section class="dialog checksum-dialog" role="dialog" aria-modal="true" aria-labelledby="checksum-dialog-title" :aria-busy="checksums.loading" tabindex="-1">
        <header class="dialog-header">
          <div><ShieldCheck :size="14" /><strong id="checksum-dialog-title">{{ t('inspector.checksumTitle') }}</strong></div>
          <button type="button" class="icon-button" :aria-label="t('inspector.checksumClose')" @click="void closeChecksumDialog()"><X :size="13" /></button>
        </header>
        <div class="dialog-body checksum-dialog-body">
          <dl class="checksum-target-list">
            <div><dt>{{ t('inspector.checksumTargetHost') }}</dt><dd class="mono">{{ checksumTarget.host }}</dd></div>
            <div><dt>{{ t('inspector.checksumLocalFile') }}</dt><dd>{{ checksumTarget.localName }}</dd></div>
            <div><dt>{{ t('inspector.checksumRemoteFile') }}</dt><dd>{{ checksumTarget.remoteName }}</dd></div>
          </dl>
          <div v-if="checksums.loading" class="checksum-progress" role="status" aria-live="polite">
            <RefreshCw :size="14" />
            <span>{{ t(checksums.cancelling ? 'inspector.checksumCancelling' : 'inspector.checksumWorking') }}</span>
          </div>
          <p v-else-if="checksums.error" class="form-error" role="alert">{{ t(checksums.error.messageKey as Parameters<typeof t>[0]) }}</p>
          <template v-else-if="checksums.result">
            <div class="checksum-summary" :class="checksums.result.equal ? 'equal' : 'different'" role="status" aria-live="polite">
              <ShieldCheck v-if="checksums.result.equal" :size="15" />
              <ShieldQuestion v-else :size="15" />
              <strong>{{ t(checksums.result.equal ? 'inspector.checksumMatch' : 'inspector.checksumMismatch') }}</strong>
            </div>
            <div class="checksum-file-results">
              <section class="checksum-file-result">
                <div class="checksum-file-result-heading"><strong>{{ t('inspector.checksumLocalFile') }}</strong><small>{{ t('inspector.checksumBytes', { bytes: formatSize(checksums.result.localBytes) }) }}</small></div>
                <code class="checksum-digest mono">{{ checksums.result.localSha256 }}</code>
              </section>
              <section class="checksum-file-result">
                <div class="checksum-file-result-heading"><strong>{{ t('inspector.checksumRemoteFile') }}</strong><small>{{ t('inspector.checksumBytes', { bytes: formatSize(checksums.result.remoteBytes) }) }}</small></div>
                <code class="checksum-digest mono">{{ checksums.result.remoteSha256 }}</code>
              </section>
            </div>
          </template>
          <p class="dialog-note">{{ t('inspector.checksumReadOnlyHelp') }}</p>
        </div>
        <footer class="dialog-footer">
          <button v-if="checksums.loading" type="button" class="button" :disabled="checksums.cancelling" @click="void checksums.cancel()">{{ t(checksums.cancelling ? 'inspector.checksumCancelling' : 'inspector.checksumCancel') }}</button>
          <button v-else type="button" class="button primary" @click="void closeChecksumDialog()">{{ t('inspector.checksumClose') }}</button>
        </footer>
      </section>
    </div>

    <div v-if="syncPreviewDialogOpen && syncPreviewTarget" class="dialog-layer" @mousedown.self="void closeSyncPreviewDialog()" @keydown.esc.stop.prevent="void closeSyncPreviewDialog()">
      <section class="dialog sync-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-preview-dialog-title" :aria-busy="syncPreviews.loading" tabindex="-1">
        <header class="dialog-header">
          <div><ArrowLeftRight :size="14" /><strong id="sync-preview-dialog-title">{{ t('inspector.syncPreviewTitle') }}</strong></div>
          <button type="button" class="icon-button" :aria-label="t('inspector.syncPreviewClose')" @click="void closeSyncPreviewDialog()"><X :size="13" /></button>
        </header>
        <div class="dialog-body sync-preview-dialog-body">
          <dl class="sync-preview-target-list">
            <div><dt>{{ t('inspector.syncPreviewHost') }}</dt><dd class="mono">{{ syncPreviewTarget.host }}</dd></div>
            <div><dt>{{ t('inspector.syncPreviewLocalRoot') }}</dt><dd class="mono">{{ syncPreviewTarget.localRoot }}</dd></div>
            <div><dt>{{ t('inspector.syncPreviewRemoteRoot') }}</dt><dd class="mono">{{ syncPreviewTarget.remoteRoot }}</dd></div>
          </dl>
          <div v-if="syncPreviews.loading" class="sync-preview-progress" role="status" aria-live="polite">
            <RefreshCw :size="14" />
            <span>{{ t(syncPreviews.cancelling ? 'inspector.syncPreviewCancelling' : 'inspector.syncPreviewScanning') }}</span>
          </div>
          <p v-else-if="syncPreviews.error" class="form-error" role="alert">{{ t(syncPreviews.error.messageKey as Parameters<typeof t>[0]) }}</p>
          <template v-else-if="syncPreviews.preview">
            <p class="sync-preview-counts">{{ t('inspector.syncPreviewScanned', { localCount: syncPreviews.preview.localEntryCount, remoteCount: syncPreviews.preview.remoteEntryCount }) }}</p>
            <div class="sync-preview-summary-grid" :aria-label="t('inspector.syncPreviewCounts')">
              <div><strong>{{ syncPreviews.preview.localOnlyCount }}</strong><small>{{ t('inspector.syncPreviewLocalOnly') }}</small></div>
              <div><strong>{{ syncPreviews.preview.remoteOnlyCount }}</strong><small>{{ t('inspector.syncPreviewRemoteOnly') }}</small></div>
              <div><strong>{{ syncPreviews.preview.metadataDifferentCount }}</strong><small>{{ t('inspector.syncPreviewMetadataDifferent') }}</small></div>
              <div><strong>{{ syncPreviews.preview.typeConflictCount }}</strong><small>{{ t('inspector.syncPreviewTypeConflict') }}</small></div>
              <div><strong>{{ syncPreviews.preview.unsupportedCount }}</strong><small>{{ t('inspector.syncPreviewUnsupported') }}</small></div>
              <div><strong>{{ syncPreviews.preview.unchangedCount }}</strong><small>{{ t('inspector.syncPreviewUnchanged') }}</small></div>
            </div>
            <p v-if="syncPreviews.preview.truncated" class="dialog-note sync-preview-truncated">{{ t('inspector.syncPreviewTruncated') }}</p>
            <p v-if="syncPreviews.preview.entries.length === 0" class="task-empty">{{ t('inspector.syncPreviewNoChanges') }}</p>
            <div v-else class="sync-preview-list" role="list" :aria-label="t('inspector.previewSync')">
              <article v-for="entry in syncPreviews.preview.entries" :key="entry.relativePath" class="sync-preview-entry" :data-change="entry.changeKind" role="listitem">
                <div class="sync-preview-entry-heading"><code class="mono">{{ entry.relativePath }}</code><span>{{ syncChangeLabel(entry.changeKind) }}</span></div>
                <div class="sync-preview-entry-metadata">
                  <small>{{ t('inspector.syncPreviewLocalSide') }}: {{ syncEntryLabel(entry.localKind, entry.localSize, entry.localModifiedAtMs) }}</small>
                  <small>{{ t('inspector.syncPreviewRemoteSide') }}: {{ syncEntryLabel(entry.remoteKind, entry.remoteSize, entry.remoteModifiedAtMs) }}</small>
                </div>
              </article>
            </div>
            <p class="dialog-note">{{ t('inspector.syncPreviewMetadataNote') }}</p>
          </template>
        </div>
        <footer class="dialog-footer">
          <button v-if="syncPreviews.loading" type="button" class="button" :disabled="syncPreviews.cancelling" @click="void syncPreviews.cancel()">{{ t(syncPreviews.cancelling ? 'inspector.syncPreviewCancelling' : 'inspector.syncPreviewCancel') }}</button>
          <button v-else type="button" class="button primary" @click="void closeSyncPreviewDialog()">{{ t('inspector.syncPreviewClose') }}</button>
        </footer>
      </section>
    </div>
  </aside>
</template>
