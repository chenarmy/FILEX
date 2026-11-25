<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  ArrowLeftRight,
  Bookmark,
  CheckSquare,
  ChevronDown,
  Columns2,
  ChevronRight,
  ChevronUp,
  Copy,
  Edit3,
  FileCode2,
  FolderInput,
  FolderPlus,
  HelpCircle,
  Package,
  PanelBottom,
  PanelRight,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Upload,
  Download,
  RefreshCw,
  Search,
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
import { useBookmarksStore } from '@/stores/bookmarks';
import { useEditorStore } from '@/stores/editor';
import { useExternalEditorsStore } from '@/stores/externalEditors';
import { formatRemainingTtl, usePrivilegeStore } from '@/stores/privilege';
import { isTauriRuntime } from '@/api/common';
import { getDefaultDownloadDirectory, openLocalFileExternally } from '@/api/domain/localFilesApi';
import { selectLocalDirectory, selectUploadPaths } from '@/api/domain/filePickerApi';
import { useFilePaneKeyboard } from '@/composables/useFilePaneKeyboard';
import { useFileUploadQueue } from '@/composables/useFileUploadQueue';
import VirtualList from '@/components/ui/VirtualList.vue';
import PermissionDialog from '@/components/dialogs/PermissionDialog.vue';
import EditorPanel from '@/components/editor/EditorPanel.vue';
import FileContextMenu from '@/components/files/FileContextMenu.vue';
import DirectoryTree from '@/components/files/DirectoryTree.vue';
import FileEntryIcon from '@/components/files/FileEntryIcon.vue';
import { ownerLabel } from '@/domain/permissions';
import { isSafeTransferName } from '@/domain/fileClipboard';
import {
  buildDefaultArchiveName,
  isSameOrDescendantPath,
  resolveRenameStemRange,
  resolveUniqueCopyName,
} from '@/domain/fileSelection';
import { formatTransferSpeed } from '@/domain/transferSpeed';
import { hasCapability, isLocalSession } from '@/domain/sessionCapabilities';
import { directoryAncestors, directoryRoot, missingAncestorDirectories } from '@/domain/directoryNavigation';
import {
  completedTransferAffectsLocalListing,
  completedTransferAffectsRemoteListing,
} from '@/domain/transferRefresh';
import type {
  AppError,
  CommandSnippet,
  CreateTransferInput,
  DirectorySyncChangeKind,
  DirectorySyncEntryKind,
  LocalFileEntry,
  RemotePermissionScope,
  RemoteFileEntry,
  ResolvedLinkTarget,
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
const bookmarks = useBookmarksStore();
const editor = useEditorStore();
const externalEditors = useExternalEditorsStore();
const privilege = usePrivilegeStore();

const view = ref<'files' | 'commands' | 'editor'>('files');
const dualPaneEnabled = computed(() => settings.value.dualPaneSftp);
const fileBrowserRight = computed(() => settings.value.fileBrowserPosition === 'right');

function toggleDockPosition(): void {
  settings.value.fileBrowserPosition = fileBrowserRight.value ? 'bottom' : 'right';
}
const activePane = ref<'local' | 'remote'>('remote');
const remoteDropElement = ref<HTMLElement | null>(null);
const nativeDropActive = ref(false);
const localDropActive = ref(false);
let unlistenNativeDrop: UnlistenFn | null = null;
let panelUnmounted = false;
const panelOpen = computed(() => settings.value.fileBrowserOpen && !settings.value.focusMode);
const {
  uploadBusy,
  queueLocalPathsForUpload,
  copyLocalEntryForUpload,
  pasteUploadFromClipboard,
} = useFileUploadQueue();

const quickSession = computed(() => sessions.isQuickProfile(sessions.activeSession?.profileId));
const remoteReady = computed(() => {
  const session = sessions.activeSession;
  return session !== null && session.state === 'connected' && sftp.sessionId === session.id;
});
const selectedLocalEntry = computed(() => localFiles.listing?.entries.find((entry) => entry.path === localFiles.selectedPath) ?? null);
const selectedLocalEntries = computed<LocalFileEntry[]>(() => {
  const entries = localFiles.listing?.entries ?? [];
  const pathSet = new Set(localFiles.selectedPaths);
  if (pathSet.size === 0 && localFiles.selectedPath) pathSet.add(localFiles.selectedPath);
  return entries.filter((entry) => pathSet.has(entry.path));
});
const selectedRemoteEntry = computed(() => sftp.entries.find((entry) => entry.path === sftp.selectedPath) ?? null);
const selectedRemoteEntries = computed<RemoteFileEntry[]>(() => {
  const pathSet = new Set(sftp.selectedPaths);
  if (pathSet.size === 0 && sftp.selectedPath) pathSet.add(sftp.selectedPath);
  return sftp.entries.filter((entry) => pathSet.has(entry.path));
});
const downloadableRemoteEntries = computed(() => selectedRemoteEntries.value.filter((entry) => isSafeTransferName(entry.name)));
const permissionRemoteEntries = computed(() => selectedRemoteEntries.value.filter((entry) => !entry.isSymlink));
const activePaneSelectedCount = computed(() => (
  activePane.value === 'remote' ? selectedRemoteEntries.value.length : selectedLocalEntries.value.length
));
const activeMultiSelectMode = computed(() => (
  activePane.value === 'remote' ? sftp.multiSelectMode : localFiles.multiSelectMode
));
const remoteDirectoryUsageSummary = computed(() => {
  if (!remoteReady.value) return null;
  if (sftp.directoryUsageLoading) {
    return {
      text: t('files.calculatingDirectorySize'),
      title: t('files.recalculateDirectorySizeHint'),
      partial: false,
      loading: true,
    };
  }
  const usage = sftp.directoryUsage;
  if (usage && usage.path === sftp.path) {
    return {
      text: t('files.currentDirectorySize', { size: usage.totalSizeLabel }),
      title: usage.partial
        ? t('files.directorySizePartialHint')
        : t('files.recalculateDirectorySizeHint'),
      partial: usage.partial,
      loading: false,
    };
  }
  if (sftp.directoryUsageError) {
    return {
      text: t('files.directorySizeRetry'),
      title: t(sftp.directoryUsageError.messageKey as Parameters<typeof t>[0]),
      partial: true,
      loading: false,
    };
  }
  return null;
});
const cachedDefaultDownloadDir = ref<string | null>(null);
const archiveBusy = ref(false);
const runningTransferSpeedLabel = computed(() => (
  runningTransfers.value > 0 && transfers.aggregateSpeedBytesPerSecond > 0
    ? formatTransferSpeed(transfers.aggregateSpeedBytesPerSecond)
    : ''
));
const sessionHost = computed(() => {
  const session = sessions.activeSession;
  return session ? `${session.username}@${session.host} (${session.port})` : '';
});
const activeSshSessionId = computed(() => (sessions.activeSession && sessions.activeSession.sessionKind === 'ssh'
  ? sessions.activeSession.id
  : null));
const elevatedLease = computed(() => privilege.getLease(activeSshSessionId.value));
const elevatedRemaining = computed(() => (elevatedLease.value
  ? formatRemainingTtl(privilege.remainingSeconds(elevatedLease.value.sessionId))
  : ''));

function openElevatedAccess(): void {
  if (!activeSshSessionId.value || !remoteReady.value) return;
  ui.openElevatedAccessDialog(activeSshSessionId.value);
}

async function revokeElevation(): Promise<void> {
  if (!elevatedLease.value) return;
  if (await privilege.revoke(elevatedLease.value.sessionId)) {
    ui.notify(t('elevated.revokedNotice'));
  }
}

watch(
  () => [activeSshSessionId.value, Boolean(elevatedLease.value)] as const,
  ([sessionId, elevated], previous) => {
    if (
      previous
      && previous[0] === sessionId
      && previous[1] !== elevated
      && sessionId
      && remoteReady.value
    ) {
      void sftp.load(sessionId, sftp.path);
    }
  },
);

const runningTransfers = computed(() => transfers.tasks.filter((task) => task.state === 'running' || task.state === 'queued').length);
const transferRefreshBaseline = Date.now();
const refreshedCompletedTransfers = new Set<string>();
const pendingLocalTransferRefreshPaths = new Set<string>();
let transferRefreshTimer: number | null = null;
let pendingRemoteTransferRefresh = false;

const followTerminal = computed({
  get: () => settings.value.followTerminalCwd,
  set: (value: boolean) => { settings.value.followTerminalCwd = value; },
});
const terminalCwd = computed(() => sessions.sessionCwd(sessions.activeSessionId));
const followHelpOpen = ref(false);
const pathDrafts = reactive<Record<'local' | 'remote', string>>({ local: '', remote: '.' });
const expandedLocalTreePaths = ref<string[]>([]);
const paneBySession = new Map<string, 'local' | 'remote'>();
const viewBySession = new Map<string, 'files' | 'commands' | 'editor'>();

function expandedPathsFor(pane: 'local' | 'remote'): string[] {
  return pane === 'local' ? expandedLocalTreePaths.value : sftp.expandedTreePaths;
}

function setExpandedPathsFor(pane: 'local' | 'remote', paths: string[]): void {
  if (pane === 'local') expandedLocalTreePaths.value = paths;
  else sftp.setExpandedTreePaths(paths);
}

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
  const localOnly = isLocalSession(sessions.activeSession);
  if (localOnly && !dualPaneEnabled.value) {
    return [
      {
        id: 'local',
        label: 'inspector.localPane',
        entries: localFiles.listing?.entries ?? [],
        path: localFiles.listing?.path ?? '',
        loading: localFiles.loading,
        selectedPath: localFiles.selectedPath,
        error: localFiles.error,
        truncated: localFiles.listing?.truncated ?? false,
      },
    ];
  }
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

function expandTreePath(pane: 'local' | 'remote', path: string): void {
  const next = new Set(expandedPathsFor(pane));
  directoryAncestors(path).forEach((ancestor) => next.add(ancestor));
  setExpandedPathsFor(pane, [...next]);
}

async function syncTreePath(pane: 'local' | 'remote', path: string): Promise<void> {
  if (!path) return;
  if (pane === 'remote' && (!sftp.sessionId || path === '.')) return;
  expandTreePath(pane, path);
  const missing = pane === 'local'
    ? missingAncestorDirectories(
      path,
      localFiles.directoryChildren,
      localFiles.directoryLoadingPaths,
      localFiles.directoryErrorPaths,
    )
    : missingAncestorDirectories(
      path,
      sftp.directoryChildren,
      sftp.directoryLoadingPaths,
      sftp.directoryErrorPaths,
    );
  if (missing.length === 0) return;
  for (const ancestor of missing) {
    if (pane === 'local') {
      await localFiles.loadTreeDirectory(ancestor);
    } else {
      if (!sftp.sessionId) break;
      await sftp.loadTreeDirectory(ancestor);
    }
  }
}

async function loadRemotePath(
  sessionId: string,
  path: string,
  options?: { preserveOnError?: boolean },
): Promise<boolean> {
  const loaded = await sftp.load(sessionId, path, options);
  if (loaded && !sessions.sessionCwd(sessionId) && sftp.path.startsWith('/')) {
    sessions.setSessionCwd(sessionId, sftp.path);
  }
  return loaded;
}

const bookmarkMenuPane = ref<'local' | 'remote' | null>(null);

function paneBookmarks(pane: 'local' | 'remote') {
  return bookmarks.listFor(sessions.activeSession?.profileId, pane);
}

function isPaneBookmarked(pane: 'local' | 'remote', currentPath: string): boolean {
  return bookmarks.findByPath(sessions.activeSession?.profileId, pane, currentPath) !== null;
}

async function togglePaneBookmark(pane: 'local' | 'remote', currentPath: string): Promise<void> {
  const profileId = sessions.activeSession?.profileId;
  const existing = bookmarks.findByPath(profileId, pane, currentPath);
  if (existing) {
    await bookmarks.remove(profileId, existing.id);
    ui.notify(t('files.bookmarkRemoved'));
    return;
  }
  const saved = await bookmarks.save(profileId, pane, currentPath);
  if (saved) ui.notify(t('files.bookmarkSaved', { label: saved.label }));
}

function toggleBookmarkMenu(pane: 'local' | 'remote'): void {
  bookmarkMenuPane.value = bookmarkMenuPane.value === pane ? null : pane;
}

async function openBookmarkPath(pane: 'local' | 'remote', targetPath: string): Promise<void> {
  bookmarkMenuPane.value = null;
  await navigatePanePath(pane, targetPath);
}

async function navigatePanePath(pane: 'local' | 'remote', requestedPath = pathDrafts[pane]): Promise<void> {
  const target = requestedPath.trim();
  if (!target || target.length > 4_096 || target.includes('\0')) return;
  const loaded = pane === 'local'
    ? await localFiles.load(target)
    : sessions.activeSessionId
      ? await loadRemotePath(sessions.activeSessionId, target)
      : false;
  if (!loaded) return;
  const resolved = pane === 'local' ? localFiles.listing?.path : sftp.path;
  if (resolved) void syncTreePath(pane, resolved);
}

function resetPathDraft(pane: 'local' | 'remote'): void {
  pathDrafts[pane] = pane === 'local' ? localFiles.listing?.path ?? '' : sftp.path;
}

async function toggleTreePath(pane: 'local' | 'remote', treePath: string): Promise<void> {
  const current = expandedPathsFor(pane);
  if (current.includes(treePath)) {
    setExpandedPathsFor(pane, current.filter((path) => path !== treePath));
    return;
  }
  setExpandedPathsFor(pane, [...current, treePath]);
  const children = pane === 'local' ? localFiles.directoryChildren : sftp.directoryChildren;
  if (Object.prototype.hasOwnProperty.call(children, treePath)) return;
  if (pane === 'local') await localFiles.loadTreeDirectory(treePath);
  else await sftp.loadTreeDirectory(treePath);
}

watch(
  () => [localFiles.listing?.path ?? '', sftp.path, sftp.sessionId] as const,
  ([localPath, remotePath, remoteSessionId]) => {
    pathDrafts.local = localPath;
    pathDrafts.remote = remotePath;
    if (localPath) void syncTreePath('local', localPath);
    if (remoteSessionId && remotePath && remotePath !== '.') void syncTreePath('remote', remotePath);
  },
  { immediate: true },
);

watch(
  () => sessions.activeSession?.profileId ?? null,
  (profileId) => {
    bookmarkMenuPane.value = null;
    if (profileId) void bookmarks.load(profileId);
  },
  { immediate: true },
);

// Inline-dialog state is declared before the immediate watchers below so their
// first synchronous run cannot hit a temporal dead zone.
const checksumDialogOpen = ref(false);
const checksumTarget = ref<{ sessionId: string; host: string; localName: string; remoteName: string } | null>(null);
const syncPreviewDialogOpen = ref(false);
const syncPreviewTarget = ref<{ sessionId: string; host: string; localRoot: string; remoteRoot: string } | null>(null);
const createDirectoryOpen = ref(false);
const createFileOpen = ref(false);
const directoryTargetPane = ref<'local' | 'remote'>('remote');
const newDirectoryName = ref('');
const newFileName = ref('');
const createDirectoryInputRef = ref<HTMLInputElement | null>(null);
const createFileInputRef = ref<HTMLInputElement | null>(null);
const renameDialogOpen = ref(false);
const renameTargetPane = ref<'local' | 'remote'>('remote');
const renameName = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
const inlineRename = ref<{
  pane: 'local' | 'remote';
  entry: LocalFileEntry | RemoteFileEntry;
  draft: string;
  submitting: boolean;
} | null>(null);
const inlineRenameInput = ref<HTMLInputElement | null>(null);
const moveDialogOpen = ref(false);
const moveTargetPane = ref<'local' | 'remote'>('remote');
const moveSourceEntry = ref<LocalFileEntry | RemoteFileEntry | null>(null);
const moveSourceEntries = ref<Array<LocalFileEntry | RemoteFileEntry>>([]);
const moveSourceSessionId = ref<string | null>(null);
const moveDestinationDirectory = ref('');
const activeInternalDrag = ref<{
  pane: 'local' | 'remote';
  sessionId: string | null;
  entries: Array<LocalFileEntry | RemoteFileEntry>;
} | null>(null);
const dropTargetFolderPath = ref<string | null>(null);
const treeDropTargetPath = ref<string | null>(null);
let pendingPointerDrag: {
  pane: 'local' | 'remote';
  sessionId: string | null;
  entries: Array<LocalFileEntry | RemoteFileEntry>;
  startX: number;
  startY: number;
  pointerId: number;
} | null = null;
let suppressTrailingClick = false;
let suppressTrailingClickTimer: number | null = null;
const POINTER_DRAG_THRESHOLD_PX = 6;
const paneClipboard = ref<{
  mode: 'copy' | 'cut';
  pane: 'local' | 'remote';
  sessionId: string | null;
  sourceDirectory: string;
  entries: Array<LocalFileEntry | RemoteFileEntry>;
} | null>(null);
const checkboxSweepState = ref<{
  pane: 'local' | 'remote';
  selected: boolean;
} | null>(null);
const copyDialogOpen = ref(false);
const copyTargetPane = ref<'local' | 'remote'>('remote');
const copySourceEntry = ref<LocalFileEntry | RemoteFileEntry | null>(null);
const copySourceSessionId = ref<string | null>(null);
const copyDestinationDirectory = ref('');
const copyTargetName = ref('');
const copyOperationId = ref<string | null>(null);
const copyCancelling = ref(false);
const permissionTarget = ref<RemoteFileEntry | null>(null);
const permissionTargets = ref<RemoteFileEntry[]>([]);
const fileMenu = ref<{
  entry: LocalFileEntry | RemoteFileEntry | null;
  pane: 'local' | 'remote';
  position: { x: number; y: number };
} | null>(null);
const fileMenuTrigger = ref<HTMLElement | null>(null);

const filePaneKeyboard = useFilePaneKeyboard<LocalFileEntry | RemoteFileEntry>({
  getEntries: (pane) => (pane === 'local' ? (localFiles.listing?.entries ?? []) : sftp.entries),
  getSelectedPath: (pane) => (pane === 'local' ? localFiles.selectedPath : sftp.selectedPath),
  selectEntry: (entry, pane) => selectPaneEntry(entry, pane),
  isBlocked: () => !panelOpen.value
    || view.value !== 'files'
    || inlineRename.value !== null
    || createDirectoryOpen.value
    || createFileOpen.value
    || renameDialogOpen.value
    || moveDialogOpen.value
    || copyDialogOpen.value
    || permissionTarget.value !== null
    || checksumDialogOpen.value
    || syncPreviewDialogOpen.value
    || fileMenu.value !== null
    || bookmarkMenuPane.value !== null
    || ui.settingsOpen
    || ui.commandPaletteOpen
    || ui.confirmation !== null,
  onCopyLocal: () => copyLocalEntryForUpload(selectedLocalEntry.value),
  onPasteUpload: (pane, event) => pasteUploadFromClipboard({
    event,
    pane,
    dualPaneEnabled: dualPaneEnabled.value,
    remoteReady: remoteReady.value,
    quickSession: quickSession.value,
  }),
  onRename: (pane) => startInlineRename(pane),
  onSelectAll: (pane) => {
    if (pane === 'remote' && remoteReady.value) {
      activePane.value = 'remote';
      sftp.selectAll();
    } else if (pane === 'local' && localFiles.listing) {
      activePane.value = 'local';
      localFiles.selectAll();
    }
  },
  onClearSelection: (pane) => {
    if (pane === 'remote') {
      const hadMulti = sftp.multiSelectMode || sftp.checkboxSticky || sftp.selectedPaths.length > 0;
      if (!hadMulti) return false;
      sftp.clearSelection();
      return true;
    }
    const hadMulti = localFiles.multiSelectMode || localFiles.checkboxSticky || localFiles.selectedPaths.length > 0;
    if (!hadMulti) return false;
    localFiles.clearSelection();
    return true;
  },
});
const { typeaheadIndicator } = filePaneKeyboard;

function handlePaneMousedown(pane: 'local' | 'remote', event: MouseEvent): void {
  activePane.value = pane;
  if (event.button !== 0) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target && !target.closest('button, input, select, textarea, a, [tabindex], .path-bookmarks-popover')) {
    filePaneKeyboard.focusListContainer(pane);
  }
}

watch(
  () => [localFiles.loading, sftp.loading] as const,
  ([localLoading, remoteLoading], [prevLocalLoading, prevRemoteLoading]) => {
    if (!panelOpen.value || view.value !== 'files') return;
    const localDone = prevLocalLoading && !localLoading && activePane.value === 'local';
    const remoteDone = prevRemoteLoading && !remoteLoading && activePane.value === 'remote';
    if ((localDone || remoteDone) && document.activeElement === document.body) {
      const paneToFocus = activePane.value;
      void nextTick(() => {
        if (document.activeElement === document.body && panelOpen.value && view.value === 'files') {
          filePaneKeyboard.focusListContainer(paneToFocus);
        }
      });
    }
  },
);

watch(
  () => [localFiles.listing?.path ?? '', sftp.path, activePane.value, view.value, panelOpen.value] as const,
  () => filePaneKeyboard.clearTypeahead(),
);

watch(
  () => [sessions.activeSessionId, sessions.activeSession?.state, panelOpen.value] as const,
  ([sessionId, state, open], previous) => {
    const previousSessionId = previous?.[0];
    const sessionChanged = Boolean(previous) && previousSessionId !== sessionId;
    if (previousSessionId && sessionChanged) {
      viewBySession.set(previousSessionId, view.value);
      paneBySession.set(previousSessionId, activePane.value);
      void externalEditors.stopForSession(previousSessionId);
    }
    if (sessionChanged) {
      view.value = (sessionId && viewBySession.get(sessionId)) || 'files';
    }
    if (sessionId && state !== 'connected') {
      void externalEditors.stopForSession(sessionId);
    }
    fileMenu.value = null;
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
    const canSftp = hasCapability(sessions.activeSession, 'sftp');
    if (sessionId && state === 'connected' && open && canSftp) {
      const restored = sftp.activateSession(sessionId);
      if (sessionChanged) {
        activePane.value = paneBySession.get(sessionId) ?? 'remote';
      }
      const reconnectedSameSession = Boolean(
        previous
        && previous[0] === sessionId
        && previous[1] !== undefined
        && previous[1] !== 'connected',
      );
      if (!restored || reconnectedSameSession) {
        void loadRemotePath(sessionId, terminalCwd.value && followTerminal.value ? terminalCwd.value : '.');
      }
    } else if (!sessionId || state !== 'connected' || !canSftp) {
      sftp.activateSession(null);
      closeInlineDialogs();
      activePane.value = isLocalSession(sessions.activeSession)
        ? 'local'
        : (sessionId ? (paneBySession.get(sessionId) ?? 'remote') : 'remote');
      if (isLocalSession(sessions.activeSession) && open && !localFiles.listing && !localFiles.loading) {
        void localFiles.load(terminalCwd.value ?? undefined);
      }
    }
  },
  { immediate: true },
);

watch(dualPaneEnabled, (enabled) => {
  if (enabled) {
    if (!localFiles.listing && !localFiles.loading) void localFiles.load();
  } else {
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
  async ([sessionId, cwd, follow, open], previous) => {
    if (!sessionId || !follow || !open || !cwd) return;
    const session = sessions.activeSession;
    if (!session || session.id !== sessionId || session.state !== 'connected' || !hasCapability(session, 'sftp')) return;
    if (sftp.sessionId === sessionId && sftp.path === cwd) return;
    if (previous?.[0] !== sessionId && sftp.hasSessionState(sessionId)) return;
    const preserveExisting = sftp.sessionId === sessionId;
    const loaded = await loadRemotePath(sessionId, cwd, { preserveOnError: preserveExisting });
    if (!loaded && sftp.sessionId === sessionId && sftp.path.startsWith('/') && sessions.sessionCwd(sessionId) === cwd) {
      sessions.setSessionCwd(sessionId, sftp.path);
    }
  },
);

watch(
  () => transfers.tasks.map((task) => ({
    id: task.id,
    state: task.state,
    updatedAtMs: task.updatedAtMs,
    sessionId: task.sessionId,
    profileId: task.profileId,
    direction: task.direction,
    localPath: task.localPath,
    remotePath: task.remotePath,
  })),
  (tasks) => {
    for (const task of tasks) {
      if (task.state !== 'completed' || task.updatedAtMs < transferRefreshBaseline) continue;
      const key = `${task.id}:${task.updatedAtMs}`;
      if (refreshedCompletedTransfers.has(key)) continue;
      refreshedCompletedTransfers.add(key);
      if (refreshedCompletedTransfers.size > 500) {
        const oldest = refreshedCompletedTransfers.values().next().value;
        if (oldest) refreshedCompletedTransfers.delete(oldest);
      }
      const activeSession = sessions.activeSession;
      if (activeSession?.state === 'connected'
        && task.profileId === activeSession.profileId
        && (task.sessionId === null || task.sessionId === activeSession.id)
        && completedTransferAffectsRemoteListing(task, sftp.path)) {
        pendingRemoteTransferRefresh = true;
      }
      const localPath = localFiles.listing?.path;
      if (dualPaneEnabled.value && localPath && completedTransferAffectsLocalListing(task, localPath)) {
        pendingLocalTransferRefreshPaths.add(localPath);
      }
      if (pendingRemoteTransferRefresh || pendingLocalTransferRefreshPaths.size > 0) {
        if (transferRefreshTimer !== null) window.clearTimeout(transferRefreshTimer);
        transferRefreshTimer = window.setTimeout(() => void flushCompletedTransferRefresh(), 150);
      }
    }
  },
  { flush: 'post' },
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
      nativeDropActive.value = isTarget && !uploadBusy.value;
    });
    if (panelUnmounted) void unlisten();
    else unlistenNativeDrop = unlisten;
  } catch {
    nativeDropActive.value = false;
  }
});

onBeforeUnmount(() => {
  panelUnmounted = true;
  endPaneEntryDrag();
  filePaneKeyboard.dispose();
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerup', endCheckboxSweep);
  }
  if (transferRefreshTimer !== null) window.clearTimeout(transferRefreshTimer);
  if (copyOperationId.value) void requestCopyCancellation();
  if (unlistenNativeDrop) {
    void unlistenNativeDrop();
    unlistenNativeDrop = null;
  }
  void closeChecksumDialog();
  void closeSyncPreviewDialog();
});

function closeInlineDialogs(): void {
  endPaneEntryDrag();
  inlineRename.value = null;
  createDirectoryOpen.value = false;
  createFileOpen.value = false;
  renameDialogOpen.value = false;
  moveDialogOpen.value = false;
  moveSourceEntry.value = null;
  moveSourceEntries.value = [];
  copyDialogOpen.value = false;
  copySourceEntry.value = null;
  permissionTarget.value = null;
  permissionTargets.value = [];
  fileMenu.value = null;
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

function formatPaneEntrySize(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): string {
  if (pane === 'remote' && entry.isDirectory) {
    if (sftp.directoryUsage && sftp.directoryUsage.path === sftp.path) {
      const label = sftp.directoryUsage.entrySizeLabels[entry.name];
      if (label) return label;
    }
    return sftp.directoryUsageLoading ? '…' : '—';
  }
  return formatSize(entry.size);
}

// ---- row interactions ----------------------------------------------------

function isPaneEntrySelected(pane: 'local' | 'remote', entryPath: string): boolean {
  return pane === 'remote' ? sftp.isSelected(entryPath) : localFiles.isSelected(entryPath);
}

function selectedEntriesForPane(pane: 'local' | 'remote'): Array<LocalFileEntry | RemoteFileEntry> {
  return pane === 'remote' ? selectedRemoteEntries.value : selectedLocalEntries.value;
}

function hasStickyMultiSelection(pane: 'local' | 'remote'): boolean {
  return pane === 'remote'
    ? (sftp.multiSelectMode || sftp.checkboxSticky || selectedRemoteEntries.value.length > 1)
    : (localFiles.multiSelectMode || localFiles.checkboxSticky || selectedLocalEntries.value.length > 1);
}

function selectPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  activePane.value = pane;
  if (pane === 'local') localFiles.select(entry);
  else sftp.select(entry);
}

function setPaneEntrySelected(pane: 'local' | 'remote', entry: LocalFileEntry | RemoteFileEntry, selected: boolean): void {
  activePane.value = pane;
  if (pane === 'local') localFiles.setEntrySelected(entry, selected);
  else sftp.setEntrySelected(entry, selected);
}

function endCheckboxSweep(): void {
  checkboxSweepState.value = null;
}

function beginCheckboxSweep(
  entry: LocalFileEntry | RemoteFileEntry,
  pane: 'local' | 'remote',
  event: PointerEvent,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const nextSelected = !isPaneEntrySelected(pane, entry.path);
  setPaneEntrySelected(pane, entry, nextSelected);
  checkboxSweepState.value = { pane, selected: nextSelected };
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerup', endCheckboxSweep);
    window.addEventListener('pointerup', endCheckboxSweep, { once: true });
  }
}

function continueCheckboxSweep(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  if (!checkboxSweepState.value || checkboxSweepState.value.pane !== pane) return;
  setPaneEntrySelected(pane, entry, checkboxSweepState.value.selected);
}

function isAllPaneEntriesSelected(pane: 'local' | 'remote'): boolean {
  const entries = pane === 'local' ? (localFiles.listing?.entries ?? []) : sftp.entries;
  if (entries.length === 0) return false;
  const selected = pane === 'local' ? localFiles.selectedPaths : sftp.selectedPaths;
  return selected.length >= entries.length;
}

function isSomePaneEntriesSelected(pane: 'local' | 'remote'): boolean {
  const entries = pane === 'local' ? (localFiles.listing?.entries ?? []) : sftp.entries;
  if (entries.length === 0) return false;
  const selected = pane === 'local' ? localFiles.selectedPaths : sftp.selectedPaths;
  return selected.length > 0 && selected.length < entries.length;
}

function toggleSelectAllPane(pane: 'local' | 'remote'): void {
  activePane.value = pane;
  if (isAllPaneEntriesSelected(pane)) {
    if (pane === 'local') localFiles.clearSelection();
    else sftp.clearSelection();
    return;
  }
  if (pane === 'local') localFiles.selectAll();
  else sftp.selectAll();
}

function toggleActiveMultiSelectMode(): void {
  if (activePane.value === 'remote') sftp.toggleMultiSelectMode();
  else localFiles.toggleMultiSelectMode();
}

function clearActiveSelection(): void {
  if (activePane.value === 'remote') sftp.clearSelection();
  else localFiles.clearSelection();
}

function handlePaneEntryClick(
  entry: LocalFileEntry | RemoteFileEntry,
  pane: 'local' | 'remote',
  event: MouseEvent,
): void {
  if (suppressTrailingClick) {
    suppressTrailingClick = false;
    return;
  }
  if (inlineRename.value && inlineRename.value.pane === pane && inlineRename.value.entry.path === entry.path) {
    return;
  }
  activePane.value = pane;
  const modifiers = {
    ctrlOrMeta: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
  };
  if (pane === 'remote') {
    sftp.selectWithModifiers(entry, modifiers);
    return;
  }
  localFiles.selectWithModifiers(entry, modifiers);
}

function bindInlineRenameInput(element: Element | ComponentPublicInstance | null): void {
  inlineRenameInput.value = element instanceof HTMLInputElement ? element : null;
}

function startInlineRename(pane: 'local' | 'remote'): void {
  if (pane === 'local') {
    const entry = selectedLocalEntry.value;
    if (!entry || localFiles.mutating) return;
    activePane.value = 'local';
    localFiles.error = null;
    inlineRename.value = { pane: 'local', entry, draft: entry.name, submitting: false };
  } else {
    if (!remoteReady.value || sftp.renaming || selectedRemoteEntries.value.length > 1) return;
    const entry = selectedRemoteEntry.value;
    if (!entry) return;
    activePane.value = 'remote';
    sftp.error = null;
    inlineRename.value = { pane: 'remote', entry, draft: entry.name, submitting: false };
  }
  void nextTick(() => {
    const input = inlineRenameInput.value;
    const state = inlineRename.value;
    if (!input || !state) return;
    input.focus();
    const { start, end } = resolveRenameStemRange(state.entry.name, state.entry.isDirectory);
    input.setSelectionRange(start, end);
  });
}

function cancelInlineRename(): void {
  const pane = inlineRename.value?.pane;
  inlineRename.value = null;
  if (pane) void nextTick(() => filePaneKeyboard.focusListContainer(pane));
}

async function commitInlineRename(): Promise<void> {
  const state = inlineRename.value;
  if (!state || state.submitting) return;
  const nextName = state.draft.trim();
  if (!nextName || nextName === state.entry.name) {
    cancelInlineRename();
    return;
  }
  state.submitting = true;
  try {
    if (state.pane === 'local') {
      if (await localFiles.rename(state.entry, nextName)) {
        inlineRename.value = null;
        ui.notify(t('inspector.localRenamed'));
      } else if (localFiles.error) {
        ui.notify(t(localFiles.error.messageKey as Parameters<typeof t>[0]));
      }
      return;
    }
    if (await sftp.rename(state.entry, nextName)) {
      inlineRename.value = null;
      ui.notify(t('inspector.remoteRenamed'));
    } else if (sftp.error) {
      ui.notify(t(sftp.error.messageKey as Parameters<typeof t>[0]));
    }
  } finally {
    if (inlineRename.value === state) state.submitting = false;
  }
}

async function resolvePaneSymlinkTarget(
  entry: LocalFileEntry | RemoteFileEntry,
  pane: 'local' | 'remote',
): Promise<ResolvedLinkTarget | null> {
  const resolved = pane === 'local'
    ? await localFiles.resolveLink(entry.path)
    : await sftp.resolveLink(entry.path);
  if (!resolved) {
    const key = pane === 'local' ? localFiles.error?.messageKey : sftp.error?.messageKey;
    ui.notify(t((key ?? 'errors.symlinkTargetUnavailable') as Parameters<typeof t>[0]));
    return null;
  }
  return resolved;
}

async function revealResolvedTargetFile(
  targetPath: string,
  parentDirectory: string,
  pane: 'local' | 'remote',
): Promise<void> {
  const sessionId = sessions.activeSessionId;
  if (pane === 'local') {
    if (localFiles.listing?.path !== parentDirectory) {
      await localFiles.load(parentDirectory);
    }
    const targetEntry = localFiles.listing?.entries.find((item) => item.path === targetPath);
    if (targetEntry) localFiles.select(targetEntry);
    void syncTreePath('local', parentDirectory);
    return;
  }
  if (!sessionId) return;
  if (sftp.path !== parentDirectory) {
    await loadRemotePath(sessionId, parentDirectory);
  }
  const targetEntry = sftp.entries.find((item) => item.path === targetPath);
  if (targetEntry) sftp.select(targetEntry);
  void syncTreePath('remote', parentDirectory);
}

function handlePaneEntryDblClick(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): void {
  if (hasStickyMultiSelection(pane)) return;
  void openPaneEntry(entry, pane);
}

async function openPaneEntry(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): Promise<void> {
  selectPaneEntry(entry, pane);
  if (entry.isDirectory) {
    if (pane === 'local') await localFiles.open(entry);
    else await sftp.open(entry);
    return;
  }
  if (entry.isSymlink) {
    const resolved = await resolvePaneSymlinkTarget(entry, pane);
    if (!resolved) return;
    if (resolved.targetKind === 'directory') {
      if (pane === 'local') await localFiles.load(resolved.targetPath);
      else if (sessions.activeSessionId) await loadRemotePath(sessions.activeSessionId, resolved.targetPath);
      void syncTreePath(pane, resolved.targetPath);
      return;
    }
    if (resolved.targetKind === 'file' && resolved.parentPath) {
      await revealResolvedTargetFile(resolved.targetPath, resolved.parentPath, pane);
      return;
    }
    ui.notify(t('errors.symlinkTargetUnavailable'));
    return;
  }
  if (settings.value.textEditorPreference === 'external') {
    if (pane === 'remote') {
      await externalEditors.openRemote(
        sessions.activeSessionId as string,
        entry.path,
        'preference',
      );
    } else {
      const result = await openLocalFileExternally(entry.path, settings.value.externalEditorPath);
      if (!result.ok) ui.notify(t(result.error.messageKey as Parameters<typeof t>[0]));
    }
    return;
  }
  await openEntryInEditor(entry, pane);
}

async function openEntryInEditor(entry: LocalFileEntry | RemoteFileEntry, pane: 'local' | 'remote'): Promise<void> {
  if (entry.isDirectory) return;
  let targetPath = entry.path;
  if (entry.isSymlink) {
    const resolved = await resolvePaneSymlinkTarget(entry, pane);
    if (!resolved) return;
    if (resolved.targetKind === 'directory') {
      if (pane === 'local') await localFiles.load(resolved.targetPath);
      else if (sessions.activeSessionId) await loadRemotePath(sessions.activeSessionId, resolved.targetPath);
      return;
    }
    if (resolved.targetKind !== 'file') {
      ui.notify(t('errors.symlinkTargetUnavailable'));
      return;
    }
    targetPath = resolved.targetPath;
  }
  view.value = 'editor';
  await editor.open(pane, targetPath);
}

function openContextMenu(
  entry: LocalFileEntry | RemoteFileEntry | null,
  pane: 'local' | 'remote',
  event: MouseEvent,
): void {
  event.preventDefault();
  event.stopPropagation();
  activePane.value = pane;
  if (entry) {
    const currentSelected = selectedEntriesForPane(pane);
    if (isPaneEntrySelected(pane, entry.path) && currentSelected.length > 1) {
      // Preserve multi-selection when opening context menu on an already-selected item.
    } else {
      selectPaneEntry(entry, pane);
    }
  }
  fileMenuTrigger.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  fileMenu.value = {
    entry,
    pane,
    position: { x: event.clientX, y: event.clientY },
  };
}

function openContextMenuFromKeyboard(
  entry: LocalFileEntry | RemoteFileEntry,
  pane: 'local' | 'remote',
  event: KeyboardEvent,
): void {
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const bounds = trigger?.getBoundingClientRect();
  selectPaneEntry(entry, pane);
  fileMenuTrigger.value = trigger;
  fileMenu.value = {
    entry,
    pane,
    position: {
      x: bounds?.left ?? 12,
      y: bounds?.bottom ?? 12,
    },
  };
}

function hasOpenModalDialog(): boolean {
  return inlineRename.value !== null
    || createDirectoryOpen.value
    || createFileOpen.value
    || renameDialogOpen.value
    || moveDialogOpen.value
    || copyDialogOpen.value
    || permissionTarget.value !== null
    || checksumDialogOpen.value
    || syncPreviewDialogOpen.value
    || ui.confirmation !== null
    || ui.transferDialog !== null;
}

function closeContextMenu(): void {
  const trigger = fileMenuTrigger.value;
  fileMenu.value = null;
  fileMenuTrigger.value = null;
  if (!trigger || hasOpenModalDialog()) return;
  void nextTick(() => {
    if (!hasOpenModalDialog()) trigger.focus();
  });
}

async function copyContextPath(): Promise<void> {
  const target = fileMenu.value;
  if (target?.pane === 'remote' && selectedRemoteEntries.value.length > 1) {
    const joined = selectedRemoteEntries.value.map((entry) => entry.path).join('\n');
    try {
      await navigator.clipboard.writeText(joined);
      ui.notify(t('fileMenu.pathCopied'));
    } catch {
      ui.notify(t('fileMenu.pathCopyFailed'));
    }
    return;
  }
  const entry = target?.entry;
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.path);
    ui.notify(t('fileMenu.pathCopied'));
  } catch {
    ui.notify(t('fileMenu.pathCopyFailed'));
  }
}

async function openContextWithSystemAssociation(): Promise<void> {
  const target = fileMenu.value;
  if (!target?.entry || target.entry.isDirectory) return;
  let targetPath = target.entry.path;
  if (target.entry.isSymlink) {
    const resolved = await resolvePaneSymlinkTarget(target.entry, target.pane);
    if (!resolved || resolved.targetKind !== 'file') {
      if (resolved) ui.notify(t('errors.symlinkTargetUnavailable'));
      return;
    }
    targetPath = resolved.targetPath;
  }
  if (target.pane === 'remote' && sessions.activeSessionId) {
    await externalEditors.openRemote(sessions.activeSessionId, targetPath, 'system');
    return;
  }
  const result = await openLocalFileExternally(targetPath, null);
  ui.notify(t(result.ok ? 'externalEditor.systemOpened' : result.error.messageKey as Parameters<typeof t>[0]));
}

async function queueNativeUpload(
  kind: 'files' | 'folders',
  destinationDirectory = sftp.path,
): Promise<void> {
  const session = sessions.activeSession;
  if (!session || !remoteReady.value) {
    return;
  }
  const selected = await selectUploadPaths(
    kind,
    t(kind === 'files' ? 'fileMenu.pickFilesTitle' : 'fileMenu.pickFoldersTitle'),
  );
  if (!selected.ok) {
    ui.notify(t(selected.error.messageKey as Parameters<typeof t>[0]));
    return;
  }
  await queueLocalPathsForUpload(selected.data, {
    source: 'picker',
    remoteDirectory: destinationDirectory,
    remoteReady: remoteReady.value,
    quickSession: quickSession.value,
  });
}

async function runFileMenuAction(action: string): Promise<void> {
  const target = fileMenu.value;
  if (!target) return;
  switch (action) {
    case 'refresh':
      await refreshActivePane();
      return;
    case 'open':
      if (target.entry) await openPaneEntry(target.entry, target.pane);
      return;
    case 'openTextEditor':
      if (target.entry) await openEntryInEditor(target.entry, target.pane);
      return;
    case 'openSystem':
      await openContextWithSystemAssociation();
      return;
    case 'selectInternal':
      await externalEditors.setPreference('internal');
      return;
    case 'selectExternal':
      await externalEditors.setPreference('external');
      return;
    case 'configureExternal':
      await externalEditors.configureExternalEditor();
      return;
    case 'copyPath':
      await copyContextPath();
      return;
    case 'copyForUpload':
      if (target.pane === 'local' && target.entry) {
        await copyLocalEntryForUpload(target.entry);
      }
      return;
    case 'download':
      if (target.pane === 'remote') {
        if (selectedRemoteEntries.value.length > 1) {
          await downloadRemoteEntries(selectedRemoteEntries.value);
        } else if (target.entry) {
          await openDownloadEntry(target.entry);
        }
      }
      return;
    case 'downloadArchive':
      if (target.pane === 'remote') {
        const entriesToPack = selectedRemoteEntries.value.length > 0
          ? selectedRemoteEntries.value
          : (target.entry ? [target.entry] : []);
        await downloadRemoteArchiveSelection(entriesToPack);
      }
      return;
    case 'remoteRelay':
      if (target.pane === 'remote' && target.entry) openRemoteRelayEntry(target.entry);
      return;
    case 'uploadFiles':
      await queueNativeUpload(
        'files',
        target.pane === 'remote' && target.entry?.isDirectory ? target.entry.path : sftp.path,
      );
      return;
    case 'uploadFolders':
      await queueNativeUpload(
        'folders',
        target.pane === 'remote' && target.entry?.isDirectory ? target.entry.path : sftp.path,
      );
      return;
    case 'pasteUpload':
      await pasteUploadFromClipboard({
        pane: 'remote',
        dualPaneEnabled: dualPaneEnabled.value,
        remoteReady: remoteReady.value,
        quickSession: quickSession.value,
        remoteDirectory: target.pane === 'remote' && target.entry?.isDirectory ? target.entry.path : sftp.path,
      });
      return;
    case 'createFile':
      openCreateFile();
      return;
    case 'createFolder':
      openCreateDirectory();
      return;
    case 'rename':
      openRenameDialog();
      return;
    case 'clipboardCopy': {
      const selected = selectedEntriesForPane(target.pane);
      const entries = selected.length > 0 ? selected : (target.entry ? [target.entry] : []);
      stagePaneClipboard('copy', target.pane, entries);
      return;
    }
    case 'clipboardCut': {
      const selected = selectedEntriesForPane(target.pane);
      const entries = selected.length > 0 ? selected : (target.entry ? [target.entry] : []);
      stagePaneClipboard('cut', target.pane, entries);
      return;
    }
    case 'clipboardPaste': {
      const destination = target.entry?.isDirectory
        ? target.entry.path
        : (target.pane === 'local' ? (localFiles.listing?.path ?? '') : sftp.path);
      await pastePaneClipboard(target.pane, destination);
      return;
    }
    case 'duplicate': {
      const selected = selectedEntriesForPane(target.pane);
      const entries = selected.length > 0 ? selected : (target.entry ? [target.entry] : []);
      await duplicatePaneEntries(target.pane, entries);
      return;
    }
    case 'move':
      openMoveDialog();
      return;
    case 'copyTo':
      openCopyDialog();
      return;
    case 'delete':
      await deleteActiveEntry();
      return;
    case 'quickDelete':
      if (target.entry && target.pane === 'remote') await quickDeleteRemote(target.entry);
      return;
    case 'permissions':
      if (target.entry && target.pane === 'remote') openPermissionDialog(target.entry);
  }
}

async function refreshActivePane(): Promise<void> {
  if (activePane.value === 'local') await localFiles.load(localFiles.listing?.path);
  else if (sessions.activeSessionId) await sftp.load(sessions.activeSessionId, sftp.path);
}

function remoteJoin(directory: string, name: string): string {
  const parent = directory.replace(/\/+$/, '');
  return parent ? `${parent}/${name}` : `/${name}`;
}

async function flushCompletedTransferRefresh(): Promise<void> {
  transferRefreshTimer = null;
  const refreshRemote = pendingRemoteTransferRefresh;
  const localPaths = [...pendingLocalTransferRefreshPaths];
  pendingRemoteTransferRefresh = false;
  pendingLocalTransferRefreshPaths.clear();

  if (refreshRemote) {
    const activeSession = sessions.activeSession;
    if (activeSession?.state === 'connected' && sftp.sessionId === activeSession.id) {
      await sftp.load(activeSession.id, sftp.path);
    }
  }
  if (!dualPaneEnabled.value) return;
  const currentLocalPath = localFiles.listing?.path;
  if (currentLocalPath && localPaths.includes(currentLocalPath)) {
    await localFiles.load(currentLocalPath);
  }
}

function localJoin(directory: string, name: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const parent = directory.replace(/[\\/]+$/, '');
  return parent ? `${parent}${separator}${name}` : `${separator}${name}`;
}

function bindPaneListElement(
  pane: 'local' | 'remote',
  element: Element | ComponentPublicInstance | null,
): void {
  const resolved = filePaneKeyboard.bindListElement(pane, element);
  if (pane === 'remote') remoteDropElement.value = resolved;
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

async function queueDroppedLocalPaths(paths: string[]): Promise<void> {
  if (!panelOpen.value) return;
  await queueLocalPathsForUpload(paths, {
    source: 'drop',
    remoteReady: remoteReady.value,
    quickSession: quickSession.value,
    onBeforeStart: () => {
      nativeDropActive.value = false;
    },
  });
}

function paneParentDirectory(entryPath: string, pane: 'local' | 'remote'): string {
  if (pane === 'remote') {
    const idx = entryPath.lastIndexOf('/');
    if (idx <= 0) return '/';
    return entryPath.slice(0, idx);
  }
  const normalized = entryPath.replace(/[\\/]+$/, '');
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slash < 0) return '';
  if (slash === 2 && normalized[1] === ':') return normalized.slice(0, 3);
  if (slash === 0) return normalized[0] ?? '/';
  return normalized.slice(0, slash);
}

function canDropOnDirectory(targetDirectory: string, pane: 'local' | 'remote'): boolean {
  const drag = activeInternalDrag.value;
  if (!drag || drag.pane !== pane || !targetDirectory || drag.entries.length === 0) return false;
  if (pane === 'remote' && (drag.sessionId !== sessions.activeSessionId || !remoteReady.value)) {
    return false;
  }
  const normalizedTarget = targetDirectory.length > 1 ? targetDirectory.replace(/[\\/]+$/, '') : targetDirectory;
  return drag.entries.every((entry) => {
    if (isSameOrDescendantPath(targetDirectory, entry.path)) return false;
    const parent = paneParentDirectory(entry.path, pane);
    const normalizedParent = parent.length > 1 ? parent.replace(/[\\/]+$/, '') : parent;
    return normalizedParent !== normalizedTarget;
  });
}

async function executeDragMoveToDirectory(
  pane: 'local' | 'remote',
  entries: Array<LocalFileEntry | RemoteFileEntry>,
  targetDirectory: string,
): Promise<void> {
  if (entries.length === 0 || !targetDirectory) return;
  const movedCount = pane === 'local'
    ? (entries.length === 1
      ? ((await localFiles.move(entries[0]!, targetDirectory)) ? 1 : 0)
      : await localFiles.moveMany(entries, targetDirectory))
    : (entries.length === 1
      ? ((await sftp.move(entries[0]!, targetDirectory)) ? 1 : 0)
      : await sftp.moveMany(entries, targetDirectory));
  if (movedCount > 0) {
    ui.notify(t('files.movedToDirectory', { count: movedCount, target: targetDirectory }));
  }
}

function detachRowPointerDragListeners(): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointermove', handleRowPointerMove);
  window.removeEventListener('pointerup', handleRowPointerUp);
  window.removeEventListener('pointercancel', endPaneEntryDrag);
  window.removeEventListener('blur', endPaneEntryDrag);
  window.removeEventListener('keydown', handleRowDragKeydown);
}

function endPaneEntryDrag(): void {
  pendingPointerDrag = null;
  activeInternalDrag.value = null;
  dropTargetFolderPath.value = null;
  treeDropTargetPath.value = null;
  localDropActive.value = false;
  if (suppressTrailingClickTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(suppressTrailingClickTimer);
    suppressTrailingClickTimer = null;
  }
  suppressTrailingClick = false;
  detachRowPointerDragListeners();
}

function handleRowDragKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') endPaneEntryDrag();
}

function updatePointerDropTarget(clientX: number, clientY: number): void {
  const drag = activeInternalDrag.value;
  dropTargetFolderPath.value = null;
  treeDropTargetPath.value = null;
  localDropActive.value = false;
  if (!drag || typeof document === 'undefined') return;
  const hit = document.elementFromPoint(clientX, clientY);
  if (!(hit instanceof HTMLElement)) return;

  const treeRow = hit.closest<HTMLElement>('[data-tree-drop-path]');
  if (
    treeRow
    && treeRow.dataset.treeDropPane === drag.pane
    && treeRow.dataset.treeDropPath
    && canDropOnDirectory(treeRow.dataset.treeDropPath, drag.pane)
  ) {
    treeDropTargetPath.value = treeRow.dataset.treeDropPath;
    return;
  }

  const fileRow = hit.closest<HTMLElement>('.file-row[data-entry-path]');
  const rowPane = fileRow?.closest<HTMLElement>('.file-list[data-pane]')?.dataset.pane;
  if (fileRow && rowPane === drag.pane && fileRow.dataset.entryPath) {
    const entries = drag.pane === 'local' ? (localFiles.listing?.entries ?? []) : sftp.entries;
    const targetEntry = entries.find((candidate) => candidate.path === fileRow.dataset.entryPath);
    if (targetEntry?.isDirectory && canDropOnDirectory(targetEntry.path, drag.pane)) {
      dropTargetFolderPath.value = targetEntry.path;
      return;
    }
  }

  if (drag.pane === 'remote' && dualPaneEnabled.value && hit.closest('.file-list[data-pane="local"]')) {
    localDropActive.value = true;
  }
}

async function queueRemoteEntriesDownload(
  entries: RemoteFileEntry[],
  sourceSessionId: string | null,
): Promise<void> {
  const session = sessions.activeSession;
  const listing = localFiles.listing;
  if (!session || session.id !== sourceSessionId || !remoteReady.value || !listing || entries.length === 0) return;
  const queuedIds: string[] = [];
  for (const entry of entries) {
    const input: CreateTransferInput = {
      profileId: session.profileId,
      direction: 'download',
      localPath: localJoin(listing.path, entry.name),
      remotePath: entry.path,
      conflictPolicy: 'ask',
      totalBytes: entry.isDirectory ? null : entry.size,
    };
    const task = await transfers.enqueueTask(input, session.id);
    if (task) queuedIds.push(task.id);
  }
  if (queuedIds.length > 0) {
    transfers.trackDownloadBatch(listing.path, queuedIds);
    settings.value.taskTab = 'transfers';
    ui.notify(entries.length === 1
      ? t('inspector.dropDownloadQueued', { name: entries[0]!.name })
      : t('files.downloadBatchQueued', { count: queuedIds.length, folder: listing.path }));
  }
}

function handleRowPointerMove(event: PointerEvent): void {
  const pending = pendingPointerDrag;
  if (!pending || event.pointerId !== pending.pointerId) return;
  if (pending.pane === 'remote') {
    if (sftp.loading || sessions.activeSession?.id !== pending.sessionId || !remoteReady.value) {
      endPaneEntryDrag();
      return;
    }
  } else if (localFiles.loading) {
    endPaneEntryDrag();
    return;
  }
  if (!activeInternalDrag.value) {
    if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < POINTER_DRAG_THRESHOLD_PX) {
      return;
    }
    activeInternalDrag.value = {
      pane: pending.pane,
      sessionId: pending.sessionId,
      entries: pending.entries,
    };
  }
  updatePointerDropTarget(event.clientX, event.clientY);
}

function handleRowPointerUp(event: PointerEvent): void {
  const pending = pendingPointerDrag;
  if (!pending || event.pointerId !== pending.pointerId) return;
  const drag = activeInternalDrag.value;
  if (!drag) {
    endPaneEntryDrag();
    return;
  }
  updatePointerDropTarget(event.clientX, event.clientY);
  const targetFolder = dropTargetFolderPath.value ?? treeDropTargetPath.value;
  const canMoveToFolder = Boolean(targetFolder && canDropOnDirectory(targetFolder, drag.pane));
  const dropToLocal = !canMoveToFolder && localDropActive.value && drag.pane === 'remote';
  endPaneEntryDrag();
  suppressTrailingClick = true;
  if (typeof window !== 'undefined') {
    suppressTrailingClickTimer = window.setTimeout(() => {
      suppressTrailingClick = false;
      suppressTrailingClickTimer = null;
    }, 0);
  }
  if (canMoveToFolder && targetFolder) {
    void executeDragMoveToDirectory(drag.pane, [...drag.entries], targetFolder);
  } else if (dropToLocal) {
    void queueRemoteEntriesDownload(
      drag.entries.filter((item): item is RemoteFileEntry => !item.isSymlink && isSafeTransferName(item.name)),
      drag.sessionId,
    );
  }
}

function beginRowPointerDrag(
  entry: LocalFileEntry | RemoteFileEntry,
  pane: 'local' | 'remote',
  event: PointerEvent,
): void {
  if (event.button !== 0 || typeof window === 'undefined') return;
  if (inlineRename.value && inlineRename.value.pane === pane && inlineRename.value.entry.path === entry.path) return;
  if (event.target instanceof HTMLElement && event.target.closest('.file-row-check-hit, input')) return;
  const session = sessions.activeSession;
  if (pane === 'remote' && (!session || !remoteReady.value || sftp.loading)) return;
  if (pane === 'local' && localFiles.loading) return;
  const currentSelected = selectedEntriesForPane(pane);
  const draggedEntries = isPaneEntrySelected(pane, entry.path) && currentSelected.length > 1
    ? [...currentSelected]
    : [entry];
  endPaneEntryDrag();
  pendingPointerDrag = {
    pane,
    sessionId: pane === 'remote' ? (session?.id ?? null) : null,
    entries: draggedEntries,
    startX: event.clientX,
    startY: event.clientY,
    pointerId: event.pointerId,
  };
  window.addEventListener('pointermove', handleRowPointerMove);
  window.addEventListener('pointerup', handleRowPointerUp);
  window.addEventListener('pointercancel', endPaneEntryDrag);
  window.addEventListener('blur', endPaneEntryDrag);
  window.addEventListener('keydown', handleRowDragKeydown);
}

// ---- toolbar actions -----------------------------------------------------

async function resolveDownloadDirectory(): Promise<string | null> {
  if (settings.value.defaultDownloadDirectory) {
    return settings.value.defaultDownloadDirectory;
  }
  if (cachedDefaultDownloadDir.value) {
    return cachedDefaultDownloadDir.value;
  }
  if (isTauriRuntime()) {
    const result = await getDefaultDownloadDirectory();
    if (result.ok && result.data) {
      cachedDefaultDownloadDir.value = result.data;
      return result.data;
    }
  }
  if (!localFiles.listing) await localFiles.load();
  if (localFiles.listing?.path) return localFiles.listing.path;
  if (isTauriRuntime()) {
    const picked = await selectLocalDirectory(t('transfer.chooseDownloadFolderTitle'));
    if (picked.ok && picked.data) return picked.data;
  }
  return null;
}

async function openUpload(): Promise<void> {
  await queueNativeUpload('files');
}

async function openDownloadEntry(source: RemoteFileEntry): Promise<void> {
  if (!remoteReady.value || !isSafeTransferName(source.name)) return;
  const directory = await resolveDownloadDirectory();
  ui.openTransfer('download', source.path, directory ? localJoin(directory, source.name) : undefined, sessions.activeSession?.profileId);
}

async function downloadRemoteEntries(targets: readonly RemoteFileEntry[]): Promise<void> {
  const session = sessions.activeSession;
  if (!session || !remoteReady.value) return;
  const validTargets = targets.filter((entry) => isSafeTransferName(entry.name));
  if (validTargets.length === 0) return;
  if (validTargets.length === 1 && validTargets[0]) {
    await openDownloadEntry(validTargets[0]);
    return;
  }
  const downloadDir = await resolveDownloadDirectory();
  if (!downloadDir) {
    ui.notify(t('errors.localDirectoryFailed'));
    return;
  }
  const queuedIds: string[] = [];
  for (const entry of validTargets) {
    const task = await transfers.enqueueTask({
      profileId: session.profileId,
      direction: 'download',
      localPath: localJoin(downloadDir, entry.name),
      remotePath: entry.path,
      conflictPolicy: 'rename',
      totalBytes: entry.isDirectory || entry.isSymlink ? null : entry.size,
    }, session.id);
    if (!task) {
      if (queuedIds.length === 0 && transfers.error) {
        ui.notify(t(transfers.error.messageKey as Parameters<typeof t>[0]));
      }
      break;
    }
    queuedIds.push(task.id);
  }
  if (queuedIds.length > 0) {
    transfers.trackDownloadBatch(downloadDir, queuedIds);
    settings.value.taskTab = 'transfers';
    ui.notify(t('files.downloadBatchQueued', { count: queuedIds.length, folder: downloadDir }));
  }
}

async function downloadRemoteArchiveSelection(targets: readonly RemoteFileEntry[] = downloadableRemoteEntries.value): Promise<void> {
  const session = sessions.activeSession;
  if (!session || !remoteReady.value || archiveBusy.value) return;
  const validTargets = targets.filter((entry) => isSafeTransferName(entry.name));
  if (validTargets.length === 0) return;
  const downloadDir = await resolveDownloadDirectory();
  if (!downloadDir) {
    ui.notify(t('errors.localDirectoryFailed'));
    return;
  }
  archiveBusy.value = true;
  try {
    const archiveName = buildDefaultArchiveName(sftp.path, validTargets.map((entry) => entry.name));
    const task = await transfers.downloadArchive({
      sessionId: session.id,
      remoteDirectory: sftp.path,
      entryNames: validTargets.map((entry) => entry.name),
      localDirectory: downloadDir,
      archiveName,
      conflictPolicy: 'rename',
    });
    if (task) {
      settings.value.taskTab = 'transfers';
      ui.notify(t('files.archiveDownloadQueued', { name: archiveName, count: validTargets.length }));
    } else if (transfers.error) {
      ui.notify(t(transfers.error.messageKey as Parameters<typeof t>[0]));
    }
  } finally {
    archiveBusy.value = false;
  }
}

async function openDownload(): Promise<void> {
  if (selectedRemoteEntries.value.length > 1) {
    await downloadRemoteEntries(selectedRemoteEntries.value);
    return;
  }
  const source = selectedRemoteEntry.value;
  if (source) await openDownloadEntry(source);
}

function openRemoteRelayEntry(source: RemoteFileEntry): void {
  if (!remoteReady.value || source.isSymlink) return;
  const sourceProfileId = sessions.activeSession?.profileId;
  const otherConnected = sessions.summaries.find((item) => (
    item.sessionKind === 'ssh'
    && item.state === 'connected'
    && item.profileId !== sourceProfileId
  ));
  const destProfileId = otherConnected?.profileId ?? sourceProfileId;
  const destPath = otherConnected
    ? remoteJoin(sessions.sessionCwd(otherConnected.id) || '/tmp', source.name)
    : `${source.path.replace(/\/+$/, '')}.relay`;
  ui.openTransfer('remote_to_remote', source.path, undefined, sourceProfileId, destProfileId, destPath);
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
    const targets = selectedLocalEntries.value.length > 0
      ? selectedLocalEntries.value
      : (selectedLocalEntry.value ? [selectedLocalEntry.value] : []);
    const sourceDirectory = localFiles.listing?.path;
    if (targets.length === 0 || !sourceDirectory) return;
    const firstTarget = targets[0]!;
    const accepted = await ui.confirm({
      title: t('inspector.deleteLocal'),
      message: targets.length > 1
        ? t('files.deleteLocalBatchConfirm', {
          count: targets.length,
          names: targets.slice(0, 5).map((item) => item.name).join(', '),
        })
        : t('inspector.deleteLocalConfirm', { name: firstTarget.name, path: firstTarget.path }),
      confirmLabel: t('inspector.deleteLocal'),
      danger: true,
    });
    if (!accepted || localFiles.listing?.path !== sourceDirectory) return;
    if (targets.length > 1) {
      const deleted = await localFiles.removeMany(targets);
      if (deleted > 0) ui.notify(t('files.localBatchDeleted', { count: deleted }));
      return;
    }
    if (!localFiles.listing.entries.some((candidate) => candidate.path === firstTarget.path)) return;
    if (await localFiles.remove(firstTarget)) ui.notify(t('inspector.localDeleted'));
    return;
  }
  const targets = selectedRemoteEntries.value.length > 0
    ? selectedRemoteEntries.value
    : (selectedRemoteEntry.value ? [selectedRemoteEntry.value] : []);
  const sourceSession = sessions.activeSession;
  const sourceSessionId = sourceSession?.id;
  const sourceDirectory = sftp.path;
  if (targets.length === 0 || !sourceSession || !sourceSessionId || sftp.sessionId !== sourceSessionId || !remoteReady.value) return;
  const firstTarget = targets[0]!;
  const accepted = await ui.confirm({
    title: t('inspector.deleteRemote'),
    message: targets.length > 1
      ? t('files.deleteRemoteBatchConfirm', {
        count: targets.length,
        names: targets.slice(0, 5).map((item) => item.name).join(', '),
        host: sessionHost.value,
      })
      : t('inspector.deleteRemoteConfirm', {
        name: firstTarget.name,
        path: firstTarget.path,
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
    || !remoteReady.value) return;
  if (targets.length > 1) {
    const deleted = await sftp.removeMany(targets, false);
    if (deleted > 0) ui.notify(t('files.remoteBatchDeleted', { count: deleted }));
    return;
  }
  if (!sftp.entries.some((candidate) => candidate.path === firstTarget.path)) return;
  if (await sftp.remove(firstTarget)) ui.notify(t('inspector.remoteDeleted'));
}

function openCreateDirectory(): void {
  newDirectoryName.value = '';
  directoryTargetPane.value = activePane.value;
  if (activePane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  createDirectoryOpen.value = true;
  void nextTick(() => {
    createDirectoryInputRef.value?.focus();
  });
}

function openCreateFile(): void {
  newFileName.value = '';
  directoryTargetPane.value = activePane.value;
  if (activePane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  createFileOpen.value = true;
  void nextTick(() => {
    createFileInputRef.value?.focus();
  });
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

async function submitCreateFile(): Promise<void> {
  if (!newFileName.value.trim()) return;
  if (directoryTargetPane.value === 'local') {
    if (await localFiles.createFile(newFileName.value)) {
      createFileOpen.value = false;
      ui.notify(t('inspector.localFileCreated'));
    }
    return;
  }
  if (await sftp.createFile(newFileName.value)) {
    createFileOpen.value = false;
    ui.notify(t('inspector.remoteFileCreated'));
  }
}

function openRenameDialog(): void {
  const entry = activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value;
  if (!entry) return;
  if (activePaneSelectedCount.value > 1) return;
  renameTargetPane.value = activePane.value;
  renameName.value = entry.name;
  if (renameTargetPane.value === 'local') localFiles.error = null;
  else sftp.error = null;
  renameDialogOpen.value = true;
  void nextTick(() => {
    const input = renameInputRef.value;
    if (!input) return;
    input.focus();
    const { start, end } = resolveRenameStemRange(entry.name, entry.isDirectory);
    input.setSelectionRange(start, end);
  });
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
  const selected = selectedEntriesForPane(activePane.value);
  if (selected.length > 1) {
    moveTargetPane.value = activePane.value;
    moveSourceEntries.value = [...selected];
    moveSourceEntry.value = selected[0] ?? null;
    moveSourceSessionId.value = activePane.value === 'remote' ? sessions.activeSessionId : null;
    moveDestinationDirectory.value = '';
    if (activePane.value === 'local') localFiles.error = null;
    else sftp.error = null;
    moveDialogOpen.value = true;
    return;
  }
  const entry = selected[0] ?? (activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value);
  if (!entry) return;
  moveTargetPane.value = activePane.value;
  moveSourceEntry.value = entry;
  moveSourceEntries.value = [entry];
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
  moveSourceEntries.value = [];
}

async function submitMove(): Promise<void> {
  const source = moveSourceEntry.value;
  const destinationDirectory = moveDestinationDirectory.value.trim();
  if (!source || !destinationDirectory) return;
  if (moveTargetPane.value === 'local') {
    if (moveSourceEntries.value.length > 1) {
      const moved = await localFiles.moveMany(moveSourceEntries.value, destinationDirectory);
      if (moved > 0) {
        closeMoveDialog();
        ui.notify(t('files.localBatchMoved', { count: moved }));
      }
      return;
    }
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
  if (moveSourceEntries.value.length > 1) {
    const moved = await sftp.moveMany(moveSourceEntries.value, destinationDirectory);
    if (moved > 0) {
      closeMoveDialog();
      ui.notify(t('files.remoteBatchMoved', { count: moved }));
    }
    return;
  }
  if (await sftp.move(source, destinationDirectory)) {
    closeMoveDialog();
    ui.notify(t('inspector.remoteMoved'));
  }
}

function existingNamesForPane(pane: 'local' | 'remote', targetDirectory: string): string[] {
  if (pane === 'local') {
    if (localFiles.listing?.path === targetDirectory) {
      return localFiles.listing.entries.map((item) => item.name);
    }
    return [];
  }
  if (sftp.path === targetDirectory) {
    return sftp.entries.map((item) => item.name);
  }
  return [];
}

function defaultCopyName(
  name: string,
  isDirectory: boolean,
  existingNames: readonly string[] = [],
): string {
  return resolveUniqueCopyName(name, isDirectory, new Set(existingNames), t('inspector.copyNameSuffix'));
}

function stagePaneClipboard(
  mode: 'copy' | 'cut',
  pane: 'local' | 'remote',
  entries: Array<LocalFileEntry | RemoteFileEntry>,
): void {
  const eligible = mode === 'copy'
    ? entries.filter((entry) => !entry.isSymlink)
    : entries;
  if (eligible.length === 0) {
    if (mode === 'copy' && entries.some((entry) => entry.isSymlink)) {
      ui.notify(t('files.copyUploadUnsupported'));
    }
    return;
  }
  const sourceDirectory = pane === 'local' ? (localFiles.listing?.path ?? '') : sftp.path;
  paneClipboard.value = {
    mode,
    pane,
    sessionId: pane === 'remote' ? (sessions.activeSessionId ?? null) : null,
    sourceDirectory,
    entries: eligible,
  };
  ui.notify(t(mode === 'copy' ? 'files.clipboardCopied' : 'files.clipboardCut', { count: eligible.length }));
}

function isCutPending(pane: 'local' | 'remote', entryPath: string): boolean {
  const clip = paneClipboard.value;
  if (!clip || clip.mode !== 'cut' || clip.pane !== pane) return false;
  if (pane === 'remote' && clip.sessionId !== sessions.activeSessionId) return false;
  return clip.entries.some((entry) => entry.path === entryPath);
}

function canPasteFromPaneClipboard(pane: 'local' | 'remote'): boolean {
  const clip = paneClipboard.value;
  if (!clip || clip.pane !== pane || clip.entries.length === 0) return false;
  if (pane === 'remote') {
    return remoteReady.value && clip.sessionId === sessions.activeSessionId;
  }
  return Boolean(localFiles.listing);
}

async function duplicatePaneEntries(
  pane: 'local' | 'remote',
  entries: Array<LocalFileEntry | RemoteFileEntry>,
): Promise<void> {
  const targetDirectory = pane === 'local' ? (localFiles.listing?.path ?? '') : sftp.path;
  if (!targetDirectory) return;
  const copySuffix = t('inspector.copyNameSuffix');
  const created = pane === 'local'
    ? await localFiles.duplicateMany(entries, targetDirectory, copySuffix)
    : await sftp.duplicateMany(entries, targetDirectory, copySuffix);
  if (created.length === 1 && created[0]) {
    ui.notify(t('files.copiedAsName', { name: created[0] }));
  } else if (created.length > 1) {
    ui.notify(t('files.batchCopied', { count: created.length }));
  }
}

async function pastePaneClipboard(pane: 'local' | 'remote', destinationDirectory: string): Promise<void> {
  const clip = paneClipboard.value;
  if (!clip || !canPasteFromPaneClipboard(pane) || !destinationDirectory) return;
  if (clip.mode === 'cut') {
    const validToMove = clip.entries.filter((entry) => !isSameOrDescendantPath(destinationDirectory, entry.path));
    if (validToMove.length === 0) return;
    await executeDragMoveToDirectory(pane, validToMove, destinationDirectory);
    paneClipboard.value = null;
    return;
  }
  const copySuffix = t('inspector.copyNameSuffix');
  const createdNames: string[] = [];
  for (const entry of clip.entries) {
    if (entry.isSymlink) continue;
    const operationId = crypto.randomUUID();
    const created = pane === 'local'
      ? await localFiles.copy(entry, destinationDirectory, entry.name, operationId, {
        autoRename: true,
        copySuffix,
      })
      : await sftp.copy(entry, destinationDirectory, entry.name, operationId, {
        autoRename: true,
        copySuffix,
      });
    if (!created) break;
    createdNames.push(created);
  }
  if (createdNames.length === 1 && createdNames[0]) {
    ui.notify(t('files.copiedAsName', { name: createdNames[0] }));
  } else if (createdNames.length > 1) {
    ui.notify(t('files.batchCopied', { count: createdNames.length }));
  }
}

function openCopyDialog(): void {
  const entry = activePane.value === 'local' ? selectedLocalEntry.value : selectedRemoteEntry.value;
  if (!entry || entry.isSymlink) return;
  copyTargetPane.value = activePane.value;
  copySourceEntry.value = entry;
  copySourceSessionId.value = activePane.value === 'remote' ? sessions.activeSessionId : null;
  const destinationDir = activePane.value === 'local'
    ? localFiles.listing?.path ?? ''
    : sftp.path;
  copyDestinationDirectory.value = destinationDir;
  copyTargetName.value = defaultCopyName(
    entry.name,
    entry.isDirectory,
    existingNamesForPane(activePane.value, destinationDir),
  );
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
  const copySuffix = t('inspector.copyNameSuffix');
  copyOperationId.value = operationId;
  copyCancelling.value = false;
  try {
    if (copyTargetPane.value === 'local') {
      const copiedName = await localFiles.copy(
        source,
        destinationDirectory,
        targetName,
        operationId,
        { autoRename: true, copySuffix },
      );
      if (copiedName) {
        closeCopyDialog();
        ui.notify(copiedName === targetName
          ? t('inspector.localCopied')
          : t('files.copiedAsName', { name: copiedName }));
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
    const copiedName = await sftp.copy(
      source,
      destinationDirectory,
      targetName,
      operationId,
      { autoRename: true, copySuffix },
    );
    if (copiedName) {
      closeCopyDialog();
      ui.notify(copiedName === targetName
        ? t('inspector.remoteCopied')
        : t('files.copiedAsName', { name: copiedName }));
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

function openPermissionDialog(target: RemoteFileEntry | null = selectedRemoteEntry.value): void {
  if (!remoteReady.value) return;
  const nonSymlinks = selectedRemoteEntries.value.filter((item) => !item.isSymlink);
  if (nonSymlinks.length > 1) {
    permissionTargets.value = nonSymlinks;
    permissionTarget.value = nonSymlinks[0] ?? null;
    return;
  }
  const entry = target;
  if (!entry || entry.isSymlink) return;
  permissionTargets.value = [entry];
  permissionTarget.value = entry;
}

async function submitPermissionChange(input: {
  mode: number;
  recursive: boolean;
  scope: RemotePermissionScope;
}): Promise<void> {
  const entry = permissionTarget.value;
  if (!entry || !remoteReady.value) return;
  const targets = permissionTargets.value.length > 0 ? permissionTargets.value : [entry];
  if (input.recursive) {
    const accepted = await ui.confirm({
      title: t('permissions.recursiveConfirmTitle'),
      message: t('permissions.recursiveConfirmMessage', {
        host: sessionHost.value,
        path: targets.length > 1 ? `${sftp.path} (${targets.length})` : entry.path,
        scope: t(`permissions.scope.${input.scope}` as Parameters<typeof t>[0]),
      }),
      confirmLabel: t('permissions.apply'),
      danger: true,
    });
    if (!accepted) return;
  }
  const result = targets.length > 1
    ? await sftp.changePermissionsMany(targets, input)
    : await sftp.changePermissions(entry, input);
  if (result) {
    permissionTarget.value = null;
    permissionTargets.value = [];
    ui.notify(t('permissions.updatedCount', {
      name: targets.length > 1 ? `${targets.length} items` : entry.name,
      count: result.updatedCount,
      skipped: result.skippedSymlinkCount,
    }));
  }
}

async function quickDeleteRemote(entry: RemoteFileEntry): Promise<void> {
  const session = sessions.activeSession;
  if (!session || !remoteReady.value) return;
  const batchTargets = selectedRemoteEntries.value.length > 1
    ? selectedRemoteEntries.value.filter((item) => !item.isSymlink && item.path !== '/')
    : (!entry.isSymlink && entry.path !== '/' ? [entry] : []);
  if (batchTargets.length === 0) return;
  const accepted = await ui.confirm({
    title: t('fileMenu.quickDeleteTitle'),
    message: batchTargets.length > 1
      ? t('files.quickDeleteBatchConfirm', {
        host: sessionHost.value,
        count: batchTargets.length,
        names: batchTargets.slice(0, 5).map((item) => item.name).join(', '),
      })
      : t('fileMenu.quickDeleteConfirm', {
        host: sessionHost.value,
        path: entry.path,
        name: entry.name,
      }),
    confirmLabel: t('fileMenu.quickDelete'),
    danger: true,
  });
  if (!accepted || sessions.activeSessionId !== session.id) return;
  if (batchTargets.length > 1) {
    const deletedCount = await sftp.removeMany(batchTargets, true);
    if (deletedCount > 0) ui.notify(t('fileMenu.quickDeleteDone', { count: deletedCount }));
    return;
  }
  const deletedCount = await sftp.removeRecursive(entry);
  if (deletedCount !== null) ui.notify(t('fileMenu.quickDeleteDone', { count: deletedCount }));
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
  <section class="file-browser-panel" :class="{ 'dock-right': fileBrowserRight }" :aria-label="t('files.title')">
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
        <span v-if="elevatedLease" class="elevated-badge mono" role="status">
          <ShieldAlert :size="11" />
          <span>{{ t('elevated.badgeCountdown', { remaining: elevatedRemaining }) }}</span>
          <button
            type="button"
            class="elevated-badge-revoke"
            :aria-label="t('elevated.revoke')"
            @click="revokeElevation"
          >
            {{ t('elevated.revoke') }}
          </button>
        </span>
        <button
          v-else-if="!isLocalSession(sessions.activeSession)"
          type="button"
          class="icon-button"
          :disabled="!remoteReady || !activeSshSessionId"
          :aria-label="t('elevated.enableAction')"
          :title="t('elevated.enableAction')"
          @click="openElevatedAccess"
        >
          <ShieldAlert :size="12" />
        </button>
        <button
          type="button"
          class="chip-toggle"
          :class="{ active: activeMultiSelectMode }"
          :aria-pressed="activeMultiSelectMode"
          :title="t('files.multiSelectHint')"
          @click="toggleActiveMultiSelectMode"
        >
          <CheckSquare :size="11" />
          {{ t('files.multiSelectMode') }}
        </button>
        <span v-if="activePaneSelectedCount > 1" class="file-selection-badge" role="status">
          <span>{{ t('files.selectedCount', { count: activePaneSelectedCount }) }}</span>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('files.clearSelection')"
            :title="t('files.clearSelection')"
            @click="clearActiveSelection()"
          >
            <X :size="11" />
          </button>
        </span>
        <span class="file-browser-panel-spacer" />
        <div class="file-toolbar-group">
          <button type="button" class="icon-button" :disabled="!remoteReady || sftp.loading || (dualPaneEnabled && (activePane !== 'local' || !selectedLocalEntry || selectedLocalEntry.isSymlink))" :aria-label="t('inspector.uploadFile')" :title="t('inspector.uploadFile')" @click="openUpload"><Upload :size="12" /></button>
          <button type="button" class="icon-button" :disabled="!remoteReady || sftp.loading || activePane !== 'remote' || downloadableRemoteEntries.length === 0" :aria-label="t('inspector.downloadFile')" :title="selectedRemoteEntries.length > 1 ? t('fileMenu.downloadSelected', { count: downloadableRemoteEntries.length }) : t('inspector.downloadFile')" @click="openDownload"><Download :size="12" /></button>
          <button type="button" class="icon-button" :disabled="!remoteReady || sftp.loading || archiveBusy || activePane !== 'remote' || downloadableRemoteEntries.length === 0" :aria-label="t('fileMenu.downloadArchive')" :title="t('fileMenu.downloadArchive')" @click="downloadRemoteArchiveSelection()"><Package :size="12" /></button>
        </div>
        <span class="toolbar-divider" />
        <div class="file-toolbar-group">
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (!localFiles.listing || localFiles.mutating) : (!remoteReady || sftp.creatingDirectory)" :aria-label="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" :title="t(activePane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory')" @click="openCreateDirectory"><FolderPlus :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePaneSelectedCount > 1 || (activePane === 'local' ? !selectedLocalEntry : (!remoteReady || !selectedRemoteEntry))" :aria-label="t('editor.openAction')" :title="t('editor.openAction')" @click="openSelectedInEditor"><FileCode2 :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane !== 'remote' || !remoteReady || permissionRemoteEntries.length === 0 || sftp.changingMode" :aria-label="t('permissions.title')" :title="t('permissions.title')" @click="openPermissionDialog()"><ShieldCheck :size="12" /></button>
          <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canCompareChecksums || checksums.loading" :aria-label="t('inspector.compareChecksums')" :title="t('inspector.compareChecksums')" @click="openChecksumComparison"><ShieldCheck :size="12" /></button>
          <button v-if="dualPaneEnabled" type="button" class="icon-button" :disabled="!canPreviewDirectorySync || syncPreviews.loading" :aria-label="t('inspector.previewSync')" :title="t('inspector.previewSync')" @click="openSyncPreviewDialog"><ArrowLeftRight :size="12" /></button>
        </div>
        <span class="toolbar-divider" />
        <div class="file-toolbar-group">
          <button type="button" class="icon-button" :disabled="activePaneSelectedCount > 1 || (activePane === 'local' ? (!selectedLocalEntry || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || sftp.renaming))" :aria-label="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" :title="t(activePane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote')" @click="openRenameDialog"><Edit3 :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (selectedLocalEntries.length === 0 || localFiles.mutating) : (!remoteReady || selectedRemoteEntries.length === 0 || sftp.deleting || sftp.renaming || sftp.creatingDirectory || sftp.moving)" :aria-label="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" :title="t(activePane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote')" @click="openMoveDialog"><FolderInput :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePaneSelectedCount > 1 || (activePane === 'local' ? (!selectedLocalEntry || selectedLocalEntry.isSymlink || localFiles.mutating) : (!remoteReady || !selectedRemoteEntry || selectedRemoteEntry.isSymlink || sftp.copying || sftp.moving || sftp.renaming || sftp.deleting || sftp.creatingDirectory))" :aria-label="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" :title="t(activePane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote')" @click="openCopyDialog"><Copy :size="12" /></button>
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (selectedLocalEntries.length === 0 || localFiles.mutating) : (!remoteReady || selectedRemoteEntries.length === 0 || sftp.deleting)" :aria-label="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" :title="t(activePane === 'local' ? 'inspector.deleteLocal' : 'inspector.deleteRemote')" @click="deleteActiveEntry"><Trash2 :size="12" /></button>
        </div>
        <span class="toolbar-divider" />
        <div class="file-toolbar-group">
          <button type="button" class="icon-button" :disabled="activePane === 'local' ? (localFiles.loading || localFiles.mutating) : (!sessions.activeSessionId || sftp.loading)" :aria-label="t('inspector.refreshFiles')" :title="t('inspector.refreshFiles')" @click="refreshActivePane"><RefreshCw :size="12" /></button>
          <button type="button" class="icon-button" :aria-pressed="dualPaneEnabled" :aria-label="t('inspector.toggleDualPane')" :title="t('inspector.toggleDualPane')" @click="settings.value.dualPaneSftp = !dualPaneEnabled"><Columns2 :size="12" /></button>
        </div>
      </template>
      <template v-else>
        <span class="file-browser-panel-spacer" />
      </template>
      <span v-if="view === 'files'" class="toolbar-divider" />
      <div class="file-toolbar-group file-dock-group">
        <button
          type="button"
          class="icon-button"
          data-testid="file-browser-dock-toggle"
          :aria-pressed="fileBrowserRight"
          :aria-label="t(fileBrowserRight ? 'files.dockBottom' : 'files.dockRight')"
          :title="t(fileBrowserRight ? 'files.dockBottom' : 'files.dockRight')"
          @click="toggleDockPosition"
        >
          <PanelBottom v-if="fileBrowserRight" :size="12" />
          <PanelRight v-else :size="12" />
        </button>
      </div>
    </header>

    <div v-if="followHelpOpen" class="file-browser-follow-help inline-notice" role="note">
      <HelpCircle :size="13" />
      <span>{{ t('files.followTerminalHelp') }}</span>
      <button type="button" class="icon-button" :aria-label="t('app.dismissNotice')" @click="followHelpOpen = false"><X :size="11" /></button>
    </div>

    <div v-if="view === 'files'" class="file-browser" :class="{ 'file-browser-dual': dualPaneEnabled }">
      <section
        v-for="pane in browserPanes"
        :key="pane.id"
        class="file-browser-pane"
        :class="{ active: activePane === pane.id }"
        role="region"
        :aria-label="t(pane.label)"
        @mousedown="handlePaneMousedown(pane.id, $event)"
        @keydown="filePaneKeyboard.handlePaneKeydown(pane.id, $event)"
        @paste="filePaneKeyboard.handlePanePaste(pane.id, $event)"
      >
        <header class="file-browser-pane-heading">
          <strong>{{ t(pane.label) }}</strong>
          <form class="path-breadcrumb mono" @submit.prevent="navigatePanePath(pane.id)">
            <button type="button" class="icon-button" :disabled="pane.id === 'remote' ? !sftp.sessionId : !localFiles.listing?.parentPath" :aria-label="t('inspector.parentDirectory')" @click.stop="pane.id === 'local' ? localFiles.parent() : sftp.parent()"><ChevronUp :size="11" /></button>
            <ChevronRight :size="11" />
            <input
              v-model="pathDrafts[pane.id]"
              type="text"
              maxlength="4096"
              spellcheck="false"
              :aria-label="t('files.pathInputLabel')"
              :title="t('files.pathInputHint')"
              @keydown.esc.prevent="resetPathDraft(pane.id)"
            >
          </form>
          <button
            v-if="pane.id === 'remote' && remoteDirectoryUsageSummary"
            type="button"
            class="pane-dir-usage-badge mono"
            :class="{ partial: remoteDirectoryUsageSummary.partial }"
            :disabled="remoteDirectoryUsageSummary.loading"
            :title="remoteDirectoryUsageSummary.title"
            @click="sftp.loadDirectoryUsage()"
          >
            {{ remoteDirectoryUsageSummary.text }}
          </button>
          <div class="pane-bookmark-actions" @keydown.esc.stop="bookmarkMenuPane = null">
            <button
              type="button"
              class="icon-button"
              :class="{ active: isPaneBookmarked(pane.id, pane.path) }"
              :disabled="!pane.path || (pane.id === 'remote' && !remoteReady)"
              :aria-pressed="isPaneBookmarked(pane.id, pane.path)"
              :aria-label="t(isPaneBookmarked(pane.id, pane.path) ? 'files.removeBookmark' : 'files.addBookmark')"
              :title="t(isPaneBookmarked(pane.id, pane.path) ? 'files.removeBookmark' : 'files.addBookmark')"
              @click="togglePaneBookmark(pane.id, pane.path)"
            >
              <Bookmark :size="11" />
            </button>
            <button
              type="button"
              class="icon-button"
              :disabled="pane.id === 'remote' && !remoteReady"
              :aria-expanded="bookmarkMenuPane === pane.id"
              :aria-label="t('files.bookmarksMenu')"
              :title="t('files.bookmarksMenu')"
              @click="toggleBookmarkMenu(pane.id)"
            >
              <ChevronDown :size="11" />
            </button>
            <div v-if="bookmarkMenuPane === pane.id" class="path-bookmarks-popover" role="region" :aria-label="t('files.bookmarksTitle')">
              <div class="path-bookmarks-header">
                <strong>{{ t('files.bookmarksTitle') }}</strong>
                <button type="button" class="icon-button" :aria-label="t('app.dismissNotice')" @click="bookmarkMenuPane = null"><X :size="11" /></button>
              </div>
              <p v-if="paneBookmarks(pane.id).length === 0" class="path-bookmarks-empty">{{ t('files.bookmarksEmpty') }}</p>
              <div v-for="bm in paneBookmarks(pane.id)" v-else :key="bm.id" class="path-bookmark-row">
                <button type="button" class="path-bookmark-jump" @click="openBookmarkPath(pane.id, bm.path)">
                  <strong>{{ bm.label }}</strong>
                  <small class="mono">{{ bm.path }}</small>
                </button>
                <button type="button" class="icon-button" :aria-label="t('files.deleteBookmark', { label: bm.label })" @click="bookmarks.remove(sessions.activeSession?.profileId, bm.id)">
                  <Trash2 :size="11" />
                </button>
              </div>
            </div>
          </div>
        </header>
        <div class="file-browser-pane-content">
          <DirectoryTree
            :root-path="directoryRoot(pane.path || '/')"
            :active-path="pane.path"
            :label="t('files.directoryTree')"
            :children-by-path="pane.id === 'local' ? localFiles.directoryChildren : sftp.directoryChildren"
            :expanded-paths="expandedPathsFor(pane.id)"
            :loading-paths="pane.id === 'local' ? localFiles.directoryLoadingPaths : sftp.directoryLoadingPaths"
            :error-paths="pane.id === 'local' ? localFiles.directoryErrorPaths : sftp.directoryErrorPaths"
            :pane="pane.id"
            :drop-target-path="activeInternalDrag?.pane === pane.id ? treeDropTargetPath : null"
            @navigate="navigatePanePath(pane.id, $event)"
            @toggle="toggleTreePath(pane.id, $event)"
          />
          <div
            :ref="(el) => bindPaneListElement(pane.id, el)"
            tabindex="-1"
            class="file-list file-table"
            :data-pane="pane.id"
            :class="{ 'file-list-drop-target': (pane.id === 'remote' && nativeDropActive) || (pane.id === 'local' && localDropActive) }"
            @contextmenu.prevent="openContextMenu(null, pane.id, $event)"
          >
            <div class="file-table-header mono" aria-hidden="true">
              <span class="file-cell file-cell-name">
                <label
                  class="file-header-check-hit"
                  :title="t('files.selectAllEntries')"
                  @mousedown.stop
                  @click.stop
                >
                  <input
                    type="checkbox"
                    class="file-row-checkbox"
                    :checked="isAllPaneEntriesSelected(pane.id)"
                    :indeterminate.prop="isSomePaneEntriesSelected(pane.id)"
                    :aria-label="t('files.selectAllEntries')"
                    tabindex="-1"
                    @change="toggleSelectAllPane(pane.id)"
                  >
                </label>
                <span>{{ t('files.columnName') }}</span>
              </span>
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
              <VirtualList
                v-if="pane.entries.length > VIRTUALIZE_THRESHOLD"
                :ref="(el) => filePaneKeyboard.bindVirtualList(pane.id, el)"
                :items="pane.entries"
                :row-height="26"
                class="file-table-body"
              >
                <template #default="{ item }">
                  <button
                    type="button"
                    class="file-row file-table-row"
                    :class="{
                      selected: isPaneEntrySelected(pane.id, item.path),
                      'file-row-drop-target': item.isDirectory && dropTargetFolderPath === item.path,
                      'cut-pending': isCutPending(pane.id, item.path),
                    }"
                    :data-entry-path="item.path"
                    @pointerdown="beginRowPointerDrag(item, pane.id, $event)"
                    @click="handlePaneEntryClick(item, pane.id, $event)"
                    @dblclick="handlePaneEntryDblClick(item, pane.id)"
                    @contextmenu.prevent.stop="openContextMenu(item, pane.id, $event)"
                    @keydown.enter.prevent="inlineRename?.entry.path === item.path ? undefined : openPaneEntry(item, pane.id)"
                    @keydown.shift.f10.prevent="openContextMenuFromKeyboard(item, pane.id, $event)"
                  >
                    <span class="file-cell file-cell-name">
                      <label
                        class="file-row-check-hit"
                        @pointerdown.stop="beginCheckboxSweep(item, pane.id, $event)"
                        @pointerenter="continueCheckboxSweep(item, pane.id)"
                        @click.stop.prevent
                        @dblclick.stop.prevent
                      >
                        <input
                          type="checkbox"
                          class="file-row-checkbox"
                          :checked="isPaneEntrySelected(pane.id, item.path)"
                          :aria-label="item.name"
                          tabindex="-1"
                        >
                      </label>
                      <FileEntryIcon :name="item.name" :is-directory="item.isDirectory" :is-symlink="item.isSymlink" :size="14" />
                      <input
                        v-if="inlineRename && inlineRename.pane === pane.id && inlineRename.entry.path === item.path"
                        :ref="bindInlineRenameInput"
                        v-model="inlineRename.draft"
                        type="text"
                        class="file-inline-rename-input mono"
                        maxlength="255"
                        autocomplete="off"
                        spellcheck="false"
                        @click.stop
                        @dblclick.stop
                        @keydown.stop
                        @keydown.enter.prevent.stop="commitInlineRename"
                        @keydown.esc.prevent.stop="cancelInlineRename"
                        @blur="commitInlineRename"
                      >
                      <template v-else>
                        <span class="mono" :title="item.symlinkTarget ? `${item.name} -> ${item.symlinkTarget}` : item.name">{{ item.name }}</span>
                        <span v-if="item.symlinkTarget" class="file-symlink-target mono">-&gt; {{ item.symlinkTarget }}</span>
                      </template>
                    </span>
                    <span class="file-cell mono">{{ formatPaneEntrySize(item, pane.id) }}</span>
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
                  :class="{
                    selected: isPaneEntrySelected(pane.id, entry.path),
                    'file-row-drop-target': entry.isDirectory && dropTargetFolderPath === entry.path,
                    'cut-pending': isCutPending(pane.id, entry.path),
                  }"
                  :data-entry-path="entry.path"
                  @pointerdown="beginRowPointerDrag(entry, pane.id, $event)"
                  @click="handlePaneEntryClick(entry, pane.id, $event)"
                  @dblclick="handlePaneEntryDblClick(entry, pane.id)"
                  @contextmenu.prevent.stop="openContextMenu(entry, pane.id, $event)"
                  @keydown.enter.prevent="inlineRename?.entry.path === entry.path ? undefined : openPaneEntry(entry, pane.id)"
                  @keydown.shift.f10.prevent="openContextMenuFromKeyboard(entry, pane.id, $event)"
                >
                  <span class="file-cell file-cell-name">
                    <label
                      class="file-row-check-hit"
                      @pointerdown.stop="beginCheckboxSweep(entry, pane.id, $event)"
                      @pointerenter="continueCheckboxSweep(entry, pane.id)"
                      @click.stop.prevent
                      @dblclick.stop.prevent
                    >
                      <input
                        type="checkbox"
                        class="file-row-checkbox"
                        :checked="isPaneEntrySelected(pane.id, entry.path)"
                        :aria-label="entry.name"
                        tabindex="-1"
                      >
                    </label>
                    <FileEntryIcon :name="entry.name" :is-directory="entry.isDirectory" :is-symlink="entry.isSymlink" :size="14" />
                    <input
                      v-if="inlineRename && inlineRename.pane === pane.id && inlineRename.entry.path === entry.path"
                      :ref="bindInlineRenameInput"
                      v-model="inlineRename.draft"
                      type="text"
                      class="file-inline-rename-input mono"
                      maxlength="255"
                      autocomplete="off"
                      spellcheck="false"
                      @click.stop
                      @dblclick.stop
                      @keydown.stop
                      @keydown.enter.prevent.stop="commitInlineRename"
                      @keydown.esc.prevent.stop="cancelInlineRename"
                      @blur="commitInlineRename"
                    >
                    <template v-else>
                      <span class="mono" :title="entry.symlinkTarget ? `${entry.name} -> ${entry.symlinkTarget}` : entry.name">{{ entry.name }}</span>
                      <span v-if="entry.symlinkTarget" class="file-symlink-target mono">-&gt; {{ entry.symlinkTarget }}</span>
                    </template>
                  </span>
                  <span class="file-cell mono">{{ formatPaneEntrySize(entry, pane.id) }}</span>
                  <span class="file-cell">{{ entryTypeLabel(entry) }}</span>
                  <span class="file-cell mono">{{ formatTimestamp(entry.modifiedAtMs) }}</span>
                  <span class="file-cell mono file-permissions" :title="formatPermissionMode(entry.permissionsMode)">{{ formatPermissionMode(entry.permissionsMode) }}</span>
                  <span class="file-cell mono">{{ ownerLabel(entry) }}</span>
                </button>
              </div>
            </template>
            <div
              v-if="typeaheadIndicator && typeaheadIndicator.pane === pane.id"
              class="file-typeahead-pill mono"
              :class="{ unmatched: !typeaheadIndicator.matched }"
              role="status"
              aria-live="polite"
            >
              <Search :size="11" aria-hidden="true" />
              <span>{{ t(typeaheadIndicator.matched ? 'files.typeaheadMatch' : 'files.typeaheadNoMatch', { query: typeaheadIndicator.query }) }}</span>
            </div>
            <div v-if="pane.id === 'remote' && nativeDropActive" class="file-drop-hint">{{ t('inspector.dropUploadHint') }}</div>
            <div v-if="pane.id === 'local' && localDropActive" class="file-drop-hint">{{ t('inspector.dropDownloadHint') }}</div>
          </div>
        </div>
      </section>
    </div>

    <div v-else-if="view === 'commands'" class="file-commands" :class="{ 'has-send': selectedSnippet }">
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
      <span v-if="externalEditors.sessions.length" class="external-editor-status" role="status">
        {{ t('externalEditor.active', { count: externalEditors.sessions.length }) }}
      </span>
      <button type="button" class="file-browser-footer-button" @click="openTaskDrawer">
        {{ t('files.transferTasks') }}
      </button>
      <span v-if="remoteReady && sftp.directoryUsage && sftp.directoryUsage.path === sftp.path" class="mono">
        {{ t('files.currentDirectorySize', { size: sftp.directoryUsage.totalSizeLabel }) }}
      </span>
      <span class="file-browser-panel-spacer" />
      <span class="mono">{{ t('files.transfersRunning', { count: runningTransfers }) }}<template v-if="runningTransferSpeedLabel"> · {{ runningTransferSpeedLabel }}</template></span>
    </footer>

    <FileContextMenu
      v-if="fileMenu"
      :entry="fileMenu.entry"
      :pane="fileMenu.pane"
      :position="fileMenu.position"
      :editor-preference="settings.value.textEditorPreference"
      :remote-ready="remoteReady"
      :quick-session="quickSession"
      :selected-count="selectedEntriesForPane(fileMenu.pane).length || (fileMenu.entry ? 1 : 0)"
      :can-open="Boolean(fileMenu.entry) && (fileMenu.pane === 'local' ? selectedLocalEntries.length <= 1 && !localFiles.loading : selectedRemoteEntries.length <= 1 && remoteReady)"
      :can-edit="fileMenu.entry ? (fileMenu.pane === 'local' ? selectedLocalEntries.length <= 1 : (remoteReady && selectedRemoteEntries.length <= 1)) : true"
      :can-download="fileMenu.pane === 'remote' && downloadableRemoteEntries.length > 0 && remoteReady"
      :can-download-archive="fileMenu.pane === 'remote' && downloadableRemoteEntries.length > 0 && remoteReady && !archiveBusy"
      :can-remote-relay="fileMenu.pane === 'remote' && Boolean(fileMenu.entry) && selectedRemoteEntries.length <= 1 && !fileMenu.entry?.isSymlink && remoteReady"
      :can-permissions="fileMenu.pane === 'remote' && permissionRemoteEntries.length > 0 && remoteReady"
      :can-quick-delete="fileMenu.pane === 'remote' && selectedRemoteEntries.some((item) => item.path !== '/' && !item.isSymlink) && remoteReady"
      :can-create="fileMenu.pane === 'local' ? Boolean(localFiles.listing) : remoteReady"
      :can-upload="remoteReady"
      :can-rename="fileMenu.pane === 'local' ? Boolean(fileMenu.entry) && selectedLocalEntries.length <= 1 && !localFiles.mutating : Boolean(fileMenu.entry) && selectedRemoteEntries.length <= 1 && remoteReady && !sftp.renaming"
      :can-move="fileMenu.pane === 'local' ? selectedLocalEntries.length > 0 && !localFiles.mutating : selectedRemoteEntries.length > 0 && remoteReady && !sftp.moving && !sftp.deleting"
      :can-copy-entry="fileMenu.pane === 'local' ? selectedLocalEntries.some((item) => !item.isSymlink) && !localFiles.mutating : selectedRemoteEntries.some((item) => !item.isSymlink) && remoteReady && !sftp.copying"
      :can-paste-entry="canPasteFromPaneClipboard(fileMenu.pane)"
      :paste-label="fileMenu.entry?.isDirectory ? t('fileMenu.pasteInto', { name: fileMenu.entry.name }) : t('fileMenu.pasteEntry')"
      :can-delete="fileMenu.pane === 'local' ? selectedLocalEntries.length > 0 && !localFiles.mutating : selectedRemoteEntries.length > 0 && remoteReady && !sftp.deleting"
      @action="runFileMenuAction"
      @close="closeContextMenu"
    />

    <PermissionDialog
      v-if="permissionTarget"
      :entry="permissionTarget"
      :host="sessionHost"
      :busy="sftp.changingMode"
      @close="permissionTarget = null"
      @submit="submitPermissionChange"
    />

    <div v-if="createDirectoryOpen" class="dialog-layer" @mousedown.self="createDirectoryOpen = false" @keydown.esc="createDirectoryOpen = false">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-create-directory-title" @submit.prevent="submitCreateDirectory">
        <header class="dialog-header">
          <div><FolderPlus :size="15" /><strong id="browser-create-directory-title">{{ t(directoryTargetPane === 'local' ? 'inspector.createLocalDirectory' : 'inspector.createDirectory') }}</strong></div>
          <button type="button" class="icon-button" :aria-label="t('settings.cancel')" @click="createDirectoryOpen = false"><X :size="14" /></button>
        </header>
        <div class="dialog-content">
          <label class="field">
            {{ t('inspector.directoryName') }}
            <input ref="createDirectoryInputRef" v-model="newDirectoryName" autofocus maxlength="255" autocomplete="off" :placeholder="t('inspector.directoryName')">
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

    <div v-if="createFileOpen" class="dialog-layer" @mousedown.self="createFileOpen = false" @keydown.esc="createFileOpen = false">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-create-file-title" @submit.prevent="submitCreateFile">
        <header class="dialog-header">
          <div><FileCode2 :size="15" /><strong id="browser-create-file-title">{{ t(directoryTargetPane === 'local' ? 'inspector.createLocalFile' : 'inspector.createFile') }}</strong></div>
          <button type="button" class="icon-button" :aria-label="t('settings.cancel')" @click="createFileOpen = false"><X :size="14" /></button>
        </header>
        <div class="dialog-content">
          <label class="field">
            {{ t('inspector.fileName') }}
            <input ref="createFileInputRef" v-model="newFileName" autofocus maxlength="255" autocomplete="off" :placeholder="t('inspector.fileName')">
          </label>
          <p v-if="directoryError" class="form-error">{{ t(directoryError.messageKey as Parameters<typeof t>[0]) }}</p>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button" @click="createFileOpen = false">{{ t('settings.cancel') }}</button>
          <button type="submit" class="button primary" :disabled="!newFileName.trim() || (directoryTargetPane === 'local' ? localFiles.mutating : sftp.creatingFile)">
            {{ (directoryTargetPane === 'local' ? localFiles.mutating : sftp.creatingFile) ? t('inspector.fileCreating') : t(directoryTargetPane === 'local' ? 'inspector.createLocalFile' : 'inspector.createFile') }}
          </button>
        </footer>
      </form>
    </div>

    <div v-if="renameDialogOpen" class="dialog-layer" @mousedown.self="renameDialogOpen = false" @keydown.esc="renameDialogOpen = false">
      <form class="dialog remote-directory-dialog" role="dialog" aria-modal="true" @submit.prevent="submitRename">
        <header class="dialog-header">
          <div><Edit3 :size="15" /><strong>{{ t(renameTargetPane === 'local' ? 'inspector.renameLocal' : 'inspector.renameRemote') }}</strong></div>
          <button type="button" class="icon-button" :aria-label="t('settings.cancel')" @click="renameDialogOpen = false"><X :size="14" /></button>
        </header>
        <div class="dialog-content">
          <label class="field">
            {{ t('inspector.newName') }}
            <input ref="renameInputRef" v-model="renameName" autofocus maxlength="255" autocomplete="off" :placeholder="t('inspector.newName')">
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
        <header class="dialog-header">
          <div><FolderInput :size="15" /><strong id="browser-move-entry-title">{{ t(moveTargetPane === 'local' ? 'inspector.moveLocal' : 'inspector.moveRemote') }}</strong></div>
          <button type="button" class="icon-button" :disabled="moveBusy" :aria-label="t('settings.cancel')" @click="closeMoveDialog"><X :size="14" /></button>
        </header>
        <div class="dialog-content">
          <dl class="move-target-list">
            <div>
              <dt>{{ t('inspector.moveSource') }}</dt>
              <dd class="mono">
                {{ moveSourceEntries.length > 1 ? t('files.selectedCount', { count: moveSourceEntries.length }) : moveSourceEntry.path }}
              </dd>
            </div>
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
        <header class="dialog-header">
          <div><Copy :size="15" /><strong id="browser-copy-entry-title">{{ t(copyTargetPane === 'local' ? 'inspector.copyLocal' : 'inspector.copyRemote') }}</strong></div>
          <button type="button" class="icon-button" :disabled="copyBusy" :aria-label="t('settings.cancel')" @click="closeCopyDialog"><X :size="14" /></button>
        </header>
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
