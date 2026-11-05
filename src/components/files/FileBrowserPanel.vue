<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  ArrowLeftRight,
  Columns2,
  ChevronRight,
  ChevronUp,
  Copy,
  Edit3,
  File,
  FileCode2,
  Folder,
  FolderInput,
  FolderPlus,
  HelpCircle,
  Send,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Upload,
  Download,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useEventsStore } from '@/stores/events';
import { useSettingsStore } from '@/stores/settings';
import { useSessionsStore } from '@/stores/sessions';
import { useSftpStore } from '@/stores/sftp';
import { useLocalFilesStore } from '@/stores/localFiles';
import { useChecksumsStore } from '@/stores/checksums';
import { useSyncPreviewStore } from '@/stores/syncPreview';
import { useTransfersStore } from '@/stores/transfers';
import { useSnippetsStore } from '@/stores/snippets';
import { useUiStore } from '@/stores/ui';
import { useEditorStore } from '@/stores/editor';
import { isTauriRuntime } from '@/api/common';
import { inspectLocalEntry } from '@/api/domain/localFilesApi';
import VirtualList from '@/components/ui/VirtualList.vue';
import PermissionDialog from '@/components/dialogs/PermissionDialog.vue';
import EditorPanel from '@/components/editor/EditorPanel.vue';
import { ownerLabel } from '@/domain/permissions';
import type {
  AppError,
  CommandSnippet,
  CreateTransferInput,
  DirectorySyncChangeKind,
  DirectorySyncEntryKind,
  LocalFileEntry,
  RemoteFileEntry,
} from '@/types/contracts';

const VIRTUALIZE_THRESHOLD = 200;

const settings = useSettingsStore();
const ui = useUiStore();
const sessions = useSessionsStore();
const events = useEventsStore();
const sftp = useSftpStore();
const localFiles = useLocalFilesStore();
const transfers = useTransfersStore();
const snippets = useSnippetsStore();
const checksums = useChecksumsStore();
const syncPreviews = useSyncPreviewStore();
const editor = useEditorStore();

const view = ref<'files' | 'commands' | 'editor'>('files');
const dualPaneEnabled = computed(() => settings.value.dualPaneSftp);
const activePane = ref<'local' | 'remote'>('remote');
const remoteDropElement = ref<HTMLElement | null>(null);
const nativeDropActive = ref(false);
const localDropActive = ref(false);
const dropBusy = ref(false);
const REMOTE_FILE_DRAG_TYPE = 'application/x-filex-remote-entry';
let unlistenNativeDrop: UnlistenFn | null = null;
let panelUnmounted = false;
const panelOpen = computed(() => settings.value.fileBrowserOpen && !settings.value.focusMode);

const quickSession = computed(() => sessions.isQuickProfile(sessions.activeSession?.profileId));
const remoteReady = computed(() => {
  const session = sessions.activeSession;
  return session !== null && session.state === 'connected' && sftp.sessionId === session.id;
});
const selectedLocalEntry = computed(() => localFiles.listing?.entries.find((entry) => entry.path === localFiles.selectedPath) ?? null);
const selectedRemoteEntry = computed(() => sftp.entries.find((entry) => entry.path === sftp.selectedPath) ?? null);
const sessionHost = computed(() => {
  const session = sessions.activeSession;
  return session ? `${session.username}@${session.host} (${session.port})` : '';
});

const runningTransfers = computed(() => transfers.tasks.filter((task) => task.state === 'running' || task.state === 'queued').length);

const followTerminal = computed({
  get: () => settings.value.followTerminalCwd,
  set: (value: boolean) => { settings.value.followTerminalCwd = value; },
});
const terminalCwd = computed(() => sessions.sessionCwd(sessions.activeSessionId));
const followHelpOpen = ref(false);

// ---- listing panes -------------------------------------------------------

interface BrowserPane {
  id: 'local' | 'remote';
  label: Parameters<typeof t>[0];
  entries: Array<LocalFileEntry | RemoteFileEntry>;
  path: string;
  loading: boolean;
  selectedPath: string | null;
  error: AppError | null;
  truncated: boolean;
}

const browserPanes = computed<BrowserPane[]>(() => {
  const panes: BrowserPane[] = [
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

// Inline-dialog state is declared before the immediate watchers below so their
// first synchronous run cannot hit a temporal dead zone.
const checksumDialogOpen = ref(false);
const checksumTarget = ref<{ sessionId: string; host: string; localName: string; remoteName: string } | null>(null);
const syncPreviewDialogOpen = ref(false);
const syncPreviewTarget = ref<{ sessionId: string; host: string; localRoot: string; remoteRoot: string } | null>(null);
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
const permissionTarget = ref<RemoteFileEntry | null>(null);

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
    if (sessionId && state === 'connected' && panelOpen.value) {
      if (sftp.sessionId !== sessionId) sftp.clear();
      void sftp.load(sessionId, terminalCwd.value && followTerminal.value ? terminalCwd.value : '.');
    } else if (!sessionId || state !== 'connected') {
      sftp.clear();
      closeInlineDialogs();
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

// Follow-terminal: sync the remote pane to the shell's OSC 7 working directory.
watch(
  () => [sessions.activeSessionId, terminalCwd.value, followTerminal.value, panelOpen.value] as const,
  ([sessionId, cwd, follow, open]) => {
    if (!sessionId || !follow || !open || !cwd) return;
    const session = sessions.activeSession;
    if (!session || session.id !== sessionId || session.state !== 'connected') return;
    if (sftp.sessionId === sessionId && sftp.path === cwd) return;
    void sftp.load(sessionId, cwd);
  },
);

onMounted(async () => {
  void snippets.load();
  void transfers.load();
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
    if (panelUnmounted) void unlisten();
    else unlistenNativeDrop = unlisten;
  } catch {
    nativeDropActive.value = false;
  }
});

onBeforeUnmount(() => {
  panelUnmounted = true;
  if (copyOperationId.value) void requestCopyCancellation();
  if (unlistenNativeDrop) {
    void unlistenNativeDrop();
    unlistenNativeDrop = null;
  }
  void closeChecksumDialog();
  void closeSyncPreviewDialog();
});

function closeInlineDialogs(): void {
  createDirectoryOpen.value = false;
  renameDialogOpen.value = false;
  moveDialogOpen.value = false;
  moveSourceEntry.value = null;
  copyDialogOpen.value = false;
  copySourceEntry.value = null;
  permissionTarget.value = null;
  followHelpOpen.value = false;
}

// ---- formatting ----------------------------------------------------------

function formatSize(size: number | null): string {
  if (size === null) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatTimestamp(timestampMs: number | null): string {
  if (timestampMs === null) return '—';
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function formatPermissionMode(mode: number | null): string {
  return mode === null ? '—' : mode.toString(8).padStart(4, '0');
}

function entryTypeLabel(entry: LocalFileEntry | RemoteFileEntry): string {
  if (entry.isSymlink) return t('files.typeSymlink');
  if (entry.isDirectory) return t('files.typeDirectory');
  return t('files.typeFile');
}

// ---- row interactions ----------------------------------------------------

function selectPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  activePane.value = pane;
  if (pane === 'local') localFiles.select(entry);
  else sftp.select(entry);
}

function openPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  selectPaneEntry(entry, pane);
  if (pane === 'local') void localFiles.open(entry);
  else void sftp.open(entry);
}

async function openEntryInEditor(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): Promise<void> {
  if (entry.isDirectory || entry.isSymlink) return;
  view.value = 'editor';
  await editor.open(pane, entry.path);
}

async function refreshActivePane(): Promise<void> {
  if (activePane.value === 'local') await localFiles.load(localFiles.listing?.path);
  else if (sessions.activeSessionId) await sftp.load(sessions.activeSessionId, sftp.path);
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
  if (!element || !panelOpen.value || !remoteReady.value) return false;
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
  if (!session || !remoteReady.value || !panelOpen.value) return;
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

// ---- toolbar actions -----------------------------------------------------

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

async function openSelectedInEditor(): Promise<void> {
  if (activePane.value === 'local') {
    const entry = selectedLocalEntry.value;
    if (entry) await openEntryInEditor(entry, 'local');
    return;
  }
  const entry = selectedRemoteEntry.value;
  if (entry && remoteReady.value) await openEntryInEditor(entry, 'remote');
}

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
    host: sessionHost.value,
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
  const host = sessionHost.value;
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
    const modified = formatTimestamp(modifiedAtMs);
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

// ---- entry mutations -----------------------------------------------------

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
      host: sessionHost.value,
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

function defaultCopyName(name: string, isDirectory: boolean): string {
  if (isDirectory) return name + ' (' + t('inspector.copyNameSuffix') + ')';
  const dot = name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : name.length;
  return `${name.slice(0, stemEnd)} (${t('inspector.copyNameSuffix')})${name.slice(stemEnd)}`;
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

function openPermissionDialog(): void {
  const entry = selectedRemoteEntry.value;
  if (!entry || !remoteReady.value) return;
  permissionTarget.value = entry;
}

async function submitPermissionChange(mode: number): Promise<void> {
  const entry = permissionTarget.value;
  if (!entry || !remoteReady.value) return;
  if (await sftp.changeMode(entry, mode)) {
    permissionTarget.value = null;
    ui.notify(t('permissions.updated', { name: entry.name }));
  }
}

function openTaskDrawer(): void {
  settings.value.taskTab = 'transfers';
  settings.value.taskDrawerOpen = true;
}

// ---- commands sub-tab ----------------------------------------------------

const commandFilter = ref('');
const commandSnippetId = ref<string | null>(null);
const parameterValues = reactive<Record<string, string>>({});
const selectedSnippet = computed<CommandSnippet | null>(() => (
  commandSnippetId.value
    ? snippets.items.find((item) => item.id === commandSnippetId.value) ?? null
    : null
));
const parameters = computed(() => [...new Set(
  [...(selectedSnippet.value?.command ?? '').matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined),
)]);
const unresolvedParameters = computed(() => parameters.value.filter((key) => parameterValues[key] === undefined));
const snippetPreview = computed(() => {
  let result = selectedSnippet.value?.command ?? '';
  for (const key of parameters.value) {
    result = result.split(`{{${key}}}`).join(parameterValues[key] ?? `{{${key}}}`);
  }
  return result;
});
const snippetPreviewTooLong = computed(() => new TextEncoder().encode(snippetPreview.value).byteLength > 10_000);
const filteredSnippets = computed(() => {
  const query = commandFilter.value.trim().toLowerCase();
  if (!query) return snippets.items;
  return snippets.items.filter((item) => item.name.toLowerCase().includes(query)
    || item.command.toLowerCase().includes(query)
    || (item.folder ?? '').toLowerCase().includes(query));
});
const groupedSnippets = computed(() => {
  const groups = new Map<string, CommandSnippet[]>();
  for (const snippet of filteredSnippets.value) {
    const key = snippet.folder?.trim() || '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(snippet);
    else groups.set(key, [snippet]);
  }
  return [...groups.entries()].map(([folder, items]) => ({ folder, items }));
});

function confirmationCommand(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are escaped on purpose
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => {
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }).replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function selectCommandSnippet(snippet: CommandSnippet): void {
  if (commandSnippetId.value === snippet.id) {
    commandSnippetId.value = null;
    return;
  }
  commandSnippetId.value = snippet.id;
  Object.keys(parameterValues).forEach((key) => delete parameterValues[key]);
}

async function sendSnippet(): Promise<void> {
  const session = sessions.activeSession;
  const snippet = selectedSnippet.value;
  const commandText = snippetPreview.value;
  if (!session || session.state !== 'connected' || !snippet || !commandText.trim()
    || snippetPreviewTooLong.value || unresolvedParameters.value.length > 0) return;
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
    events.record('system', 'SNIPPET_SENT_TO_TERMINAL', 'warning', { snippetId: snippet.id, host: session.host });
    ui.notify(t('snippet.sent', { host: session.host }));
  }
}

const views: Array<{ id: 'files' | 'commands' | 'editor'; label: Parameters<typeof t>[0] }> = [
  { id: 'files', label: 'files.tabFiles' },
  { id: 'commands', label: 'files.tabCommands' },
  { id: 'editor', label: 'files.tabEditor' },
];
</script>

<template>
  <section class="file-browser-panel" :aria-label="t('files.title')">
    <header class="file-browser-panel-header">
      <div class="file-browser-subtabs" role="tablist" :aria-label="t('files.title')">
        <button
          v-for="item in views"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="view === item.id"
          :class="{ active: view === item.id }"
          @click="view = item.id"
        >
          {{ t(item.label) }}
        </button>
      </div>

      <template v-if="view === 'files'">
        <button
          type="button"
          class="chip-toggle"
          :class="{ active: followTerminal }"
          :aria-pressed="followTerminal"
          :disabled="!remoteReady"
          :title="t('files.followTerminalHint')"
          @click="followTerminal = !followTerminal"
        >
          <Terminal :size="11" />
          {{ t('files.followTerminal') }}
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('files.followTerminalHelpLabel')"
          :title="t('files.followTerminalHelpLabel')"
          @click="followHelpOpen = !followHelpOpen"
        >
          <HelpCircle :size="12" />
        </button>
        <span class="file-browser-panel-spacer" />
        <span class="path-breadcrumb mono file-browser-path" :title="sftp.path">{{ sftp.path }}</span>
        <span class="file-browser-panel-spacer" />
        <button type="button" class="icon-button" :disabled="quickSession || !remoteReady || sftp.loading || (dualPaneEnabled && (activePane !== 'local' || !selectedLocalEntry || selectedLocalEntry.isSymlink))" :aria-label="t('inspector.uploadFile')" :title="quickSession ? t('quick.savedHint') : t('inspector.uploadFile')" @click="openUpload"><Upload :size="12" /></button>
        <button type="button" class="icon-button" :disabled="quickSession || !remoteReady || sftp.loading || activePane !== 'remote' || !selectedRemoteEntry || selectedRemoteEntry.isSymlink" :aria-label="t('inspector.downloadFile')" :title="quickSession ? t('quick.savedHint') : t('inspector.downloadFile')" @click="openDownload"><Download :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane !== 'remote' || !remoteReady || !selectedRemoteEntry || selectedRemoteEntry.isSymlink || sftp.changingMode" :aria-label="t('permissions.title')" :title="t('permissions.title')" @click="openPermissionDialog"><ShieldCheck :size="12" /></button>
        <button type="button" class="icon-button" :disabled="!selectedLocalEntry && !selectedRemoteEntry" :aria-label="t('editor.openAction')" :title="t('editor.openAction')" @click="openSelectedInEditor"><FileCode2 :size="12" /></button>
        <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canCompareChecksums || checksums.loading" :aria-label="t('inspector.compareChecksums')" :title="t('inspector.compareChecksums')" @click="openChecksumComparison"><ShieldCheck :size="12" /></button>
        <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canPreviewDirectorySync || syncPreviews.loading" :aria-label="t('inspector.previewSync')" :title="t('inspector.previewSync')" @click="openSyncPreviewDialog"><ArrowLeftRight :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.deleting)" :aria-label="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" :title="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" @click="deleteActiveEntry"><Trash2 :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.renaming)" :aria-label="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" :title="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" @click="openRenameDialog"><Edit3 :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.deleting || sftp.renaming || sftp.creatingDirectory || sftp.moving)" :aria-label="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" :title="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" @click="openMoveDialog"><FolderInput :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!selectedLocalEntry || selectedLocalEntry.isSymlink || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || selectedRemoteEntry.isSymlink || sftp.copying || sftp.moving || sftp.renaming || sftp.deleting || sftp.creatingDirectory)" :aria-label="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" :title="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" @click="openCopyDialog"><Copy :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (localFiles.loading || localFiles.mutating) : (!sessions.activeSessionId || sftp.loading)" :aria-label="t('inspector.refreshFiles')" @click="refreshActivePane"><RefreshCw :size="12" /></button>
        <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!localFiles.listing || localFiles.mutating) : (!remoteReady || sftp.creatingDirectory)" :aria-label="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" :title="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" @click="openCreateDirectory"><FolderPlus :size="12" /></button>
        <button type="button" class="icon-button" :aria-pressed="dualPaneEnabled" :aria-label="t('inspector.toggleDualPane')" :title="t('inspector.toggleDualPane')" @click="settings.value.dualPaneSftp = !dualPaneEnabled"><Columns2 :size="12" /></button>
      </template>
      <template v-else>
        <span class="file-browser-panel-spacer" />
      </template>
    </header>

    <div v-if="followHelpOpen" class="file-browser-follow-help inline-notice" role="note">
      <HelpCircle :size="13" />
      <span>{{ t('files.followTerminalHelp') }}</span>
      <button type="button" class="icon-button" :aria-label="t('app.dismissNotice')" @click="followHelpOpen = false"><X :size="11" /></button>
    </div>

    <div v-if="view === 'files'" class="file-browser file-browser-dual">
      <section
        v-for="pane in browserPanes"
        :key="pane.id"
        class="file-browser-pane"
        :class="{ active: activePane === pane.id }"
        role="region"
        :aria-label="t(pane.label)"
        @mousedown="activePane = pane.id"
      >
        <header class="file-browser-pane-heading">
          <strong>{{ t(pane.label) }}</strong>
          <div class="path-breadcrumb mono">
            <button type="button" class="icon-button" :disabled="pane.id === 'remote' ? !sftp.sessionId : !localFiles.listing?.parentPath" :aria-label="t('inspector.parentDirectory')" @click.stop="pane.id === 'local' ? localFiles.parent() : sftp.parent()"><ChevronUp :size="11" /></button>
            <ChevronRight :size="11" />
            <span :title="pane.path">{{ pane.path }}</span>
          </div>
        </header>
        <div
          :ref="pane.id === 'remote' ? bindRemoteDropElement : undefined"
          class="file-list file-table"
          :class="{ 'file-list-drop-target': (pane.id === 'remote' && nativeDropActive) || (pane.id === 'local' && localDropActive) }"
          @dragover="allowRemoteFileDrop($event, pane.id)"
          @dragleave="leaveRemoteFileDrop($event, pane.id)"
          @drop="dropRemoteFileOnLocal($event, pane.id)"
        >
          <div class="file-table-header mono" aria-hidden="true">
            <span>{{ t('files.columnName') }}</span>
            <span>{{ t('files.columnSize') }}</span>
            <span>{{ t('files.columnType') }}</span>
            <span>{{ t('files.columnModified') }}</span>
            <span>{{ t('files.columnPermissions') }}</span>
            <span>{{ t('files.columnOwner') }}</span>
          </div>
          <div v-if="pane.loading" class="task-empty">{{ t('inspector.loadingFiles') }}</div>
          <div v-else-if="pane.error" class="inline-notice error"><ShieldQuestion :size="14" /><span>{{ t(pane.error.messageKey as Parameters<typeof t>[0]) }}</span></div>
          <div v-else-if="pane.entries.length === 0" class="task-empty">{{ t('inspector.emptyDirectory') }}</div>
          <template v-else>
            <p v-if="pane.truncated" class="dialog-note preview-truncated">{{ t('inspector.directoryTruncated') }}</p>
            <VirtualList v-if="pane.entries.length > VIRTUALIZE_THRESHOLD" :items="pane.entries" :row-height="34" class="file-table-body">
              <template #default="{ item }">
                <button
                  type="button"
                  class="file-row file-table-row"
                  :class="{ selected: item.path === pane.selectedPath }"
                  :draggable="pane.id === 'remote' && !item.isSymlink"
                  @dragstart="beginRemoteFileDrag(item, pane.id, $event)"
                  @click="selectPaneEntry(item, pane.id)"
                  @dblclick="openPaneEntry(item, pane.id)"
                  @keydown.enter.prevent="openPaneEntry(item, pane.id)"
                >
                  <span class="file-cell file-cell-name"><Folder v-if="item.isDirectory" :size="13" /><File v-else :size="13" /><span class="mono" :title="item.name">{{ item.name }}</span></span>
                  <span class="file-cell mono">{{ formatSize(item.size) }}</span>
                  <span class="file-cell">{{ entryTypeLabel(item) }}</span>
                  <span class="file-cell mono">{{ formatTimestamp(item.modifiedAtMs) }}</span>
                  <span class="file-cell mono file-permissions" :title="formatPermissionMode(item.permissionsMode)">{{ formatPermissionMode(item.permissionsMode) }}</span>
                  <span class="file-cell mono">{{ ownerLabel(item) }}</span>
                </button>
              </template>
            </VirtualList>
            <div v-else class="file-table-body">
              <button
                v-for="entry in pane.entries"
                :key="entry.path"
                type="button"
                class="file-row file-table-row"
                :class="{ selected: entry.path === pane.selectedPath }"
                :draggable="pane.id === 'remote' && !entry.isSymlink"
                @dragstart="beginRemoteFileDrag(entry, pane.id, $event)"
                @click="selectPaneEntry(entry, pane.id)"
                @dblclick="openPaneEntry(entry, pane.id)"
                @keydown.enter.prevent="openPaneEntry(entry, pane.id)"
              >
                <span class="file-cell file-cell-name"><Folder v-if="entry.isDirectory" :size="13" /><File v-else :size="13" /><span class="mono" :title="entry.name">{{ entry.name }}</span></span>
                <span class="file-cell mono">{{ formatSize(entry.size) }}</span>
                <span class="file-cell">{{ entryTypeLabel(entry) }}</span>
                <span class="file-cell mono">{{ formatTimestamp(entry.modifiedAtMs) }}</span>
                <span class="file-cell mono file-permissions" :title="formatPermissionMode(entry.permissionsMode)">{{ formatPermissionMode(entry.permissionsMode) }}</span>
                <span class="file-cell mono">{{ ownerLabel(entry) }}</span>
              </button>
            </div>
          </template>
          <div v-if="pane.id === 'remote' && nativeDropActive" class="file-drop-hint">{{ t('inspector.dropUploadHint') }}</div>
          <div v-if="pane.id === 'local' && localDropActive" class="file-drop-hint">{{ t('inspector.dropDownloadHint') }}</div>
        </div>
      </section>
    </div>

    <div v-else-if="view === 'commands'" class="file-commands">
      <div class="file-commands-list">
        <label class="file-commands-search">
          {{ t('snippet.searchPlaceholder') }}
          <input v-model="commandFilter" type="search" maxlength="120" :placeholder="t('snippet.searchPlaceholder')">
        </label>
        <section v-for="group in groupedSnippets" :key="group.folder || '_'" class="file-commands-group">
          <h3 v-if="group.folder">{{ group.folder }}</h3>
          <button
            v-for="snippet in group.items"
            :key="snippet.id"
            type="button"
            class="file-commands-item"
            :class="{ selected: snippet.id === commandSnippetId }"
            @click="selectCommandSnippet(snippet)"
          >
            <strong>{{ snippet.name }}</strong>
            <code class="mono">{{ snippet.command }}</code>
          </button>
        </section>
        <p v-if="!snippets.loading && snippets.items.length === 0" class="task-empty">{{ t('snippet.empty') }}</p>
        <p v-if="snippets.error" class="inline-notice error"><span>{{ t(snippets.error.messageKey as Parameters<typeof t>[0]) }}</span></p>
      </div>
      <div v-if="selectedSnippet" class="file-commands-send">
        <header><strong>{{ selectedSnippet.name }}</strong><code class="mono">{{ selectedSnippet.command }}</code></header>
        <div v-if="parameters.length" class="file-commands-parameters">
          <label v-for="parameter in parameters" :key="parameter">{{ parameter }}<input v-model="parameterValues[parameter]" maxlength="4096" :placeholder="parameter"></label>
        </div>
        <p v-if="unresolvedParameters.length" class="dialog-note">{{ t('snippet.fillParameters', { names: unresolvedParameters.join(', ') }) }}</p>
        <div class="file-commands-preview">
          <small>{{ t('snippet.preview') }}</small>
          <pre class="mono">{{ snippetPreview || t('snippet.previewEmpty') }}</pre>
        </div>
        <p v-if="snippetPreviewTooLong" class="form-error" role="alert">{{ t('snippet.commandTooLong', { bytes: 10000 }) }}</p>
        <footer>
          <button
            type="button"
            class="button danger"
            :disabled="snippetPreviewTooLong || unresolvedParameters.length > 0 || sessions.activeSession?.state !== 'connected'"
            @click="sendSnippet"
          >
            <Send :size="12" />{{ t('snippet.send') }}
          </button>
        </footer>
      </div>
    </div>

    <EditorPanel v-else />

    <footer class="file-browser-footer">
      <button type="button" class="file-browser-footer-button" @click="openTaskDrawer">
        {{ t('files.transferTasks') }}
      </button>
      <span class="file-browser-panel-spacer" />
      <span class="mono">{{ t('files.transfersRunning', { count: runningTransfers }) }}</span>
    </footer>

    <PermissionDialog
      v-if="permissionTarget"
      :entry="permissionTarget"
      :host="sessionHost"
      :busy="sftp.changingMode"
      @close="permissionTarget = null"
      @submit="submitPermissionChange"
    />

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
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-move-entry-title" :aria-busy="moveBusy" @submit.prevent="submitMove">
        <header class="dialog-header"><strong id="browser-move-entry-title">{{ t(moveTargetPane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote') }}</strong></header>
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
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-copy-entry-title" :aria-busy="copyBusy" @submit.prevent="submitCopy">
        <header class="dialog-header"><strong id="browser-copy-entry-title">{{ t(copyTargetPane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote') }}</strong></header>
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
      <section class="dialog checksum-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-checksum-dialog-title" :aria-busy="checksums.loading" tabindex="-1">
        <header class="dialog-header">
          <div><ShieldCheck :size="14" /><strong id="browser-checksum-dialog-title">{{ t('inspector.checksumTitle') }}</strong></div>
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
      <section class="dialog sync-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-sync-preview-dialog-title" :aria-busy="syncPreviews.loading" tabindex="-1">
        <header class="dialog-header">
          <div><ArrowLeftRight :size="14" /><strong id="browser-sync-preview-dialog-title">{{ t('inspector.syncPreviewTitle') }}</strong></div>
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
  </section>
</template>
