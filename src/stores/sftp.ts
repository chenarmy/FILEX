import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  calculateRemoteDirectoryUsage,
  createRemoteDirectory,
  createRemoteFile,
  copyRemoteEntry,
  deleteRemoteEntry,
  deleteRemoteEntryRecursive,
  listRemoteDirectory,
  moveRemoteEntry,
  previewRemoteText,
  renameRemoteEntry,
  resolveRemoteLinkTarget,
  saveRemoteText,
  updateRemoteEntryMode,
  updateRemotePermissions,
} from '@/api/domain/sftpApi';
import { cancelCopyOperation } from '@/api/domain/fileOperationsApi';
import {
  elevatedChmodEntry,
  elevatedCreateDirectory,
  elevatedCreateFile,
  elevatedDeleteEntry,
  elevatedDirectoryUsage,
  elevatedListDirectory,
  elevatedMoveEntry,
  elevatedPreviewText,
  elevatedRenameEntry,
  elevatedResolveLinkTarget,
  elevatedSaveText,
} from '@/api/domain/privilegeApi';
import { directoryEntries, type DirectoryTreeEntry } from '@/domain/directoryNavigation';
import { applyExplicitSelection, resolveMultiSelection } from '@/domain/fileSelection';
import { createSessionStateCache } from '@/domain/sessionStateCache';
import { useExternalEditorsStore } from '@/stores/externalEditors';
import { usePrivilegeStore } from '@/stores/privilege';
import type {
  AppError,
  RemoteDirectoryUsage,
  RemoteFileEntry,
  RemotePermissionUpdateResult,
  RemoteTextPreview,
  ResolvedLinkTarget,
  TerminalEncoding,
  UpdateRemotePermissionsInput,
} from '@/types/contracts';

interface SftpSessionSnapshot {
  path: string;
  entries: RemoteFileEntry[];
  selectedPath: string | null;
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  multiSelectMode: boolean;
  checkboxSticky: boolean;
  error: AppError | null;
  directoryUsage: RemoteDirectoryUsage | null;
  directoryUsageError: AppError | null;
  directoryChildren: Record<string, DirectoryTreeEntry[]>;
  directoryErrorPaths: string[];
  expandedTreePaths: string[];
  preview: RemoteTextPreview | null;
  previewPath: string | null;
  previewEncoding: TerminalEncoding;
  previewError: AppError | null;
  recoveryCopyPath: string | null;
}

export const useSftpStore = defineStore('sftp', () => {
  const externalEditors = useExternalEditorsStore();
  const privilege = usePrivilegeStore();
  const entries = ref<RemoteFileEntry[]>([]);
  const path = ref('.');
  const sessionId = ref<string | null>(null);
  const loading = ref(false);
  const selectedPath = ref<string | null>(null);
  const selectedPaths = ref<string[]>([]);
  const selectionAnchorPath = ref<string | null>(null);
  const multiSelectMode = ref(false);
  const checkboxSticky = ref(false);
  const error = ref<AppError | null>(null);
  const directoryUsage = ref<RemoteDirectoryUsage | null>(null);
  const directoryUsageLoading = ref(false);
  const directoryUsageError = ref<AppError | null>(null);
  const preview = ref<RemoteTextPreview | null>(null);
  const previewPath = ref<string | null>(null);
  const previewEncoding = ref<TerminalEncoding>('utf-8');
  const previewLoading = ref(false);
  const previewError = ref<AppError | null>(null);
  const externalOpening = ref(false);
  const deleting = ref(false);
  const creatingDirectory = ref(false);
  const creatingFile = ref(false);
  const renaming = ref(false);
  const moving = ref(false);
  const copying = ref(false);
  const changingMode = ref(false);
  const savingPreview = ref(false);
  const recoveryCopyPath = ref<string | null>(null);
  const directoryChildren = ref<Record<string, DirectoryTreeEntry[]>>({});
  const directoryLoadingPaths = ref<string[]>([]);
  const directoryErrorPaths = ref<string[]>([]);
  const expandedTreePaths = ref<string[]>(['/']);
  const sessionCaches = createSessionStateCache<SftpSessionSnapshot>();
  const loadGenerations = new Map<string, number>();
  const usageGenerations = new Map<string, number>();
  const droppedSessions = new Set<string>();
  let activeOwnerSessionId: string | null = null;
  let requestGeneration = 0;
  let previewGeneration = 0;
  let saveGeneration = 0;
  let moveGeneration = 0;
  let copyGeneration = 0;
  const treeGenerations = new Map<string, number>();

  function syncPrivilegeFailure(targetSessionId: string, err: AppError): void {
    if (err.code === 'ELEVATED_LEASE_EXPIRED' || err.code === 'ELEVATED_NOT_ACTIVE') {
      privilege.clearSession(targetSessionId);
    }
  }

  function cacheDirectory(listingPath: string, listingEntries: RemoteFileEntry[]): void {
    directoryChildren.value = {
      ...directoryChildren.value,
      [listingPath]: directoryEntries(listingEntries),
    };
  }

  function snapshotActive(): SftpSessionSnapshot {
    return {
      path: path.value,
      entries: [...entries.value],
      selectedPath: selectedPath.value,
      selectedPaths: [...selectedPaths.value],
      selectionAnchorPath: selectionAnchorPath.value,
      multiSelectMode: multiSelectMode.value,
      checkboxSticky: checkboxSticky.value,
      error: error.value,
      directoryUsage: directoryUsage.value,
      directoryUsageError: directoryUsageError.value,
      directoryChildren: { ...directoryChildren.value },
      directoryErrorPaths: [...directoryErrorPaths.value],
      expandedTreePaths: [...expandedTreePaths.value],
      preview: preview.value,
      previewPath: previewPath.value,
      previewEncoding: previewEncoding.value,
      previewError: previewError.value,
      recoveryCopyPath: recoveryCopyPath.value,
    };
  }

  function restoreSnapshot(nextSessionId: string, snapshot: SftpSessionSnapshot): void {
    sessionId.value = nextSessionId;
    path.value = snapshot.path;
    entries.value = [...snapshot.entries];
    selectedPath.value = snapshot.selectedPath;
    selectedPaths.value = snapshot.selectedPaths.length > 0
      ? [...snapshot.selectedPaths]
      : (snapshot.selectedPath ? [snapshot.selectedPath] : []);
    selectionAnchorPath.value = snapshot.selectionAnchorPath ?? snapshot.selectedPath;
    multiSelectMode.value = snapshot.multiSelectMode ?? false;
    checkboxSticky.value = snapshot.checkboxSticky ?? false;
    error.value = snapshot.error;
    directoryUsage.value = snapshot.directoryUsage ?? null;
    directoryUsageLoading.value = false;
    directoryUsageError.value = snapshot.directoryUsageError ?? null;
    loading.value = false;
    directoryChildren.value = { ...snapshot.directoryChildren };
    directoryLoadingPaths.value = [];
    directoryErrorPaths.value = [...snapshot.directoryErrorPaths];
    expandedTreePaths.value = snapshot.expandedTreePaths.length > 0 ? [...snapshot.expandedTreePaths] : ['/'];
    preview.value = snapshot.preview;
    previewPath.value = snapshot.previewPath;
    previewEncoding.value = snapshot.previewEncoding;
    previewError.value = snapshot.previewError;
    recoveryCopyPath.value = snapshot.recoveryCopyPath;
    previewLoading.value = false;
    externalOpening.value = false;
    savingPreview.value = false;
    treeGenerations.clear();
  }

  function resetActiveView(): void {
    requestGeneration += 1;
    moveGeneration += 1;
    copyGeneration += 1;
    closePreview();
    entries.value = [];
    path.value = '.';
    sessionId.value = null;
    error.value = null;
    directoryUsage.value = null;
    directoryUsageLoading.value = false;
    directoryUsageError.value = null;
    loading.value = false;
    deleting.value = false;
    creatingDirectory.value = false;
    creatingFile.value = false;
    renaming.value = false;
    moving.value = false;
    copying.value = false;
    changingMode.value = false;
    selectedPath.value = null;
    selectedPaths.value = [];
    selectionAnchorPath.value = null;
    multiSelectMode.value = false;
    checkboxSticky.value = false;
    directoryChildren.value = {};
    directoryLoadingPaths.value = [];
    directoryErrorPaths.value = [];
    expandedTreePaths.value = ['/'];
    treeGenerations.clear();
  }

  function setExpandedTreePaths(paths: string[]): void {
    expandedTreePaths.value = paths;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function hasSessionState(targetSessionId: string): boolean {
    return sessionId.value === targetSessionId || sessionCaches.has(targetSessionId);
  }

  function activateSession(nextSessionId: string | null): boolean {
    if (activeOwnerSessionId !== null && sessionId.value === activeOwnerSessionId) {
      sessionCaches.set(activeOwnerSessionId, snapshotActive());
    }
    if (nextSessionId !== null && sessionId.value === nextSessionId) {
      activeOwnerSessionId = nextSessionId;
      droppedSessions.delete(nextSessionId);
      sessionCaches.set(nextSessionId, snapshotActive());
      return true;
    }
    activeOwnerSessionId = nextSessionId;
    if (nextSessionId !== null) {
      droppedSessions.delete(nextSessionId);
      const cached = sessionCaches.get(nextSessionId);
      if (cached) {
        restoreSnapshot(nextSessionId, cached);
        return true;
      }
    }
    resetActiveView();
    return false;
  }

  function dropSession(targetSessionId: string): void {
    droppedSessions.add(targetSessionId);
    loadGenerations.delete(targetSessionId);
    usageGenerations.delete(targetSessionId);
    sessionCaches.delete(targetSessionId);
    if (activeOwnerSessionId === targetSessionId || sessionId.value === targetSessionId) {
      activeOwnerSessionId = null;
      resetActiveView();
    }
  }

  async function load(
    nextSessionId: string,
    nextPath = path.value,
    options?: { preserveOnError?: boolean },
  ): Promise<boolean> {
    droppedSessions.delete(nextSessionId);
    const generation = (loadGenerations.get(nextSessionId) ?? 0) + 1;
    loadGenerations.set(nextSessionId, generation);
    const isForeground = activeOwnerSessionId === null || activeOwnerSessionId === nextSessionId;
    if (isForeground) {
      requestGeneration += 1;
      activeOwnerSessionId = nextSessionId;
      loading.value = true;
      error.value = null;
    }
    try {
      const elevated = privilege.isElevated(nextSessionId);
      const result = elevated
        ? await elevatedListDirectory(nextSessionId, nextPath)
        : await listRemoteDirectory(nextSessionId, nextPath);
      if ((loadGenerations.get(nextSessionId) ?? 0) !== generation || droppedSessions.has(nextSessionId)) {
        return false;
      }
      const stillForeground = activeOwnerSessionId === nextSessionId;
      if (!result.ok) {
        syncPrivilegeFailure(nextSessionId, result.error);
        if (stillForeground && !(options?.preserveOnError && sessionId.value === nextSessionId)) {
          error.value = result.error;
        }
        return false;
      }
      if (stillForeground) {
        sessionId.value = nextSessionId;
        path.value = result.data.path;
        entries.value = result.data.entries;
        cacheDirectory(result.data.path, result.data.entries);
        selectedPath.value = null;
        selectedPaths.value = [];
        selectionAnchorPath.value = null;
        checkboxSticky.value = false;
        directoryUsage.value = null;
        directoryUsageError.value = null;
        sessionCaches.set(nextSessionId, snapshotActive());
        void loadDirectoryUsage(nextSessionId, result.data.path);
      } else {
        const previous = sessionCaches.get(nextSessionId);
        sessionCaches.set(nextSessionId, {
          path: result.data.path,
          entries: result.data.entries,
          selectedPath: null,
          selectedPaths: [],
          selectionAnchorPath: null,
          multiSelectMode: previous?.multiSelectMode ?? false,
          checkboxSticky: false,
          error: null,
          directoryUsage: null,
          directoryUsageError: null,
          directoryChildren: {
            ...(previous?.directoryChildren ?? {}),
            [result.data.path]: directoryEntries(result.data.entries),
          },
          directoryErrorPaths: previous?.directoryErrorPaths ?? [],
          expandedTreePaths: previous?.expandedTreePaths ?? ['/'],
          preview: previous?.preview ?? null,
          previewPath: previous?.previewPath ?? null,
          previewEncoding: previous?.previewEncoding ?? 'utf-8',
          previewError: previous?.previewError ?? null,
          recoveryCopyPath: previous?.recoveryCopyPath ?? null,
        });
      }
      return true;
    } finally {
      if (activeOwnerSessionId === nextSessionId && (loadGenerations.get(nextSessionId) ?? 0) === generation) {
        loading.value = false;
      }
    }
  }

  async function loadTreeDirectory(treePath: string): Promise<void> {
    const targetSessionId = sessionId.value;
    if (!targetSessionId || directoryLoadingPaths.value.includes(treePath)) return;
    const request = (treeGenerations.get(treePath) ?? 0) + 1;
    treeGenerations.set(treePath, request);
    directoryLoadingPaths.value = [...directoryLoadingPaths.value, treePath];
    directoryErrorPaths.value = directoryErrorPaths.value.filter((item) => item !== treePath);
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedListDirectory(targetSessionId, treePath)
        : await listRemoteDirectory(targetSessionId, treePath);
      if (droppedSessions.has(targetSessionId)) return;
      if (sessionId.value !== targetSessionId) {
        if (result.ok) {
          const cached = sessionCaches.get(targetSessionId);
          if (cached) {
            sessionCaches.set(targetSessionId, {
              ...cached,
              directoryChildren: {
                ...cached.directoryChildren,
                [result.data.path]: directoryEntries(result.data.entries),
              },
            });
          }
        }
        return;
      }
      if (treeGenerations.get(treePath) !== request) return;
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        directoryErrorPaths.value = [...directoryErrorPaths.value, treePath];
        return;
      }
      cacheDirectory(result.data.path, result.data.entries);
      sessionCaches.set(targetSessionId, snapshotActive());
    } finally {
      if (treeGenerations.get(treePath) === request) {
        directoryLoadingPaths.value = directoryLoadingPaths.value.filter((item) => item !== treePath);
      }
    }
  }
  async function loadDirectoryUsage(
    targetSessionId: string | null = sessionId.value,
    targetPath: string = path.value,
  ): Promise<RemoteDirectoryUsage | null> {
    if (!targetSessionId || !targetPath || targetPath === '.') return null;
    const generation = (usageGenerations.get(targetSessionId) ?? 0) + 1;
    usageGenerations.set(targetSessionId, generation);
    const isCurrentForeground = () => sessionId.value === targetSessionId && path.value === targetPath;
    if (isCurrentForeground()) {
      directoryUsageLoading.value = true;
      directoryUsageError.value = null;
    }
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedDirectoryUsage(targetSessionId, targetPath)
        : await calculateRemoteDirectoryUsage(targetSessionId, targetPath);
      if ((usageGenerations.get(targetSessionId) ?? 0) !== generation || droppedSessions.has(targetSessionId)) {
        return null;
      }
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (result.error.code === 'TRANSFER_CANCELLED') return null;
        if (isCurrentForeground()) {
          directoryUsageError.value = result.error;
          sessionCaches.set(targetSessionId, snapshotActive());
        }
        return null;
      }
      if (isCurrentForeground()) {
        directoryUsage.value = result.data;
        directoryUsageError.value = null;
        sessionCaches.set(targetSessionId, snapshotActive());
      } else {
        const cached = sessionCaches.get(targetSessionId);
        if (cached && cached.path === targetPath) {
          sessionCaches.set(targetSessionId, {
            ...cached,
            directoryUsage: result.data,
            directoryUsageError: null,
          });
        }
      }
      return result.data;
    } finally {
      if ((usageGenerations.get(targetSessionId) ?? 0) === generation && sessionId.value === targetSessionId) {
        directoryUsageLoading.value = false;
      }
    }
  }

  async function resolveLink(targetPath: string): Promise<ResolvedLinkTarget | null> {
    if (!sessionId.value) return null;
    const targetSessionId = sessionId.value;
    error.value = null;
    const elevated = privilege.isElevated(targetSessionId);
    const result = elevated
      ? await elevatedResolveLinkTarget(targetSessionId, targetPath)
      : await resolveRemoteLinkTarget(targetSessionId, targetPath);
    if (!result.ok) {
      syncPrivilegeFailure(targetSessionId, result.error);
      if (sessionId.value === targetSessionId) error.value = result.error;
      return null;
    }
    return result.data;
  }

  async function open(entry: RemoteFileEntry): Promise<void> {
    if (!sessionId.value) return;
    if (entry.isSymlink) {
      const resolved = await resolveLink(entry.path);
      if (!resolved || !sessionId.value) return;
      if (resolved.targetKind === 'directory') {
        await load(sessionId.value, resolved.targetPath);
        return;
      }
      if (resolved.targetKind === 'file' && resolved.parentPath) {
        if (await load(sessionId.value, resolved.parentPath)) {
          const targetEntry = entries.value.find((candidate) => candidate.path === resolved.targetPath);
          if (targetEntry) select(targetEntry);
        }
      }
      return;
    }
    if (entry.isDirectory) {
      await load(sessionId.value, entry.path);
    } else {
      await previewFile(entry.path);
    }
  }

  async function previewFile(filePath: string, encoding?: TerminalEncoding): Promise<void> {
    if (!sessionId.value) return;
    const targetEncoding = encoding ?? (previewPath.value === filePath ? previewEncoding.value : 'utf-8');
    const generation = ++previewGeneration;
    const targetSessionId = sessionId.value;
    previewPath.value = filePath;
    previewEncoding.value = targetEncoding;
    preview.value = null;
    previewError.value = null;
    previewLoading.value = true;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedPreviewText(targetSessionId, filePath, targetEncoding)
        : await previewRemoteText(targetSessionId, filePath, targetEncoding);
      if (generation !== previewGeneration || targetSessionId !== sessionId.value) return;
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        previewError.value = result.error;
        return;
      }
      preview.value = result.data;
      recoveryCopyPath.value = null;
    } finally {
      if (generation === previewGeneration) previewLoading.value = false;
    }
  }

  async function remove(entry: RemoteFileEntry): Promise<boolean> {
    if (!sessionId.value || deleting.value) return false;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    deleting.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedDeleteEntry(targetSessionId, entry.path, false)
        : await deleteRemoteEntry(targetSessionId, entry.path);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      deleting.value = false;
    }
  }

  async function removeRecursive(entry: RemoteFileEntry): Promise<number | null> {
    if (!sessionId.value || deleting.value) return null;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    deleting.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedDeleteEntry(targetSessionId, entry.path, true)
        : await deleteRemoteEntryRecursive(targetSessionId, entry.path);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return null;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return result.data;
    } finally {
      deleting.value = false;
    }
  }

  async function createDirectory(name: string): Promise<boolean> {
    if (!sessionId.value || creatingDirectory.value) return false;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    creatingDirectory.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedCreateDirectory(targetSessionId, currentPath, name)
        : await createRemoteDirectory(targetSessionId, currentPath, name);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      creatingDirectory.value = false;
    }
  }

  async function createFile(name: string): Promise<boolean> {
    if (!sessionId.value || creatingFile.value) return false;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    creatingFile.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedCreateFile(targetSessionId, currentPath, name)
        : await createRemoteFile(targetSessionId, currentPath, name);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      creatingFile.value = false;
    }
  }

  async function rename(entry: RemoteFileEntry, targetName: string): Promise<boolean> {
    if (!sessionId.value || renaming.value) return false;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    renaming.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedRenameEntry(targetSessionId, entry.path, targetName)
        : await renameRemoteEntry(targetSessionId, entry.path, targetName);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      renaming.value = false;
    }
  }

  async function move(entry: RemoteFileEntry, targetDirectory: string): Promise<boolean> {
    if (!sessionId.value || moving.value) return false;
    const generation = ++moveGeneration;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    moving.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedMoveEntry(targetSessionId, entry.path, targetDirectory)
        : await moveRemoteEntry(targetSessionId, entry.path, targetDirectory);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      if (generation === moveGeneration) moving.value = false;
    }
  }

  async function copy(
    entry: RemoteFileEntry,
    targetDirectory: string,
    targetName: string,
    operationId: string,
    options?: { autoRename?: boolean; copySuffix?: string },
  ): Promise<string | null> {
    if (!sessionId.value || copying.value) return null;
    const generation = ++copyGeneration;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    copying.value = true;
    error.value = null;
    try {
      const result = await copyRemoteEntry(
        targetSessionId,
        entry.path,
        targetDirectory,
        targetName,
        operationId,
        options,
      );
      if (!result.ok) {
        if (isCurrentListing() && result.error.code !== 'TRANSFER_CANCELLED') error.value = result.error;
        return null;
      }
      if (isCurrentListing()) {
        await load(targetSessionId, currentPath);
        if (targetDirectory.replace(/\/+$/, '') === currentPath.replace(/\/+$/, '')) {
          const created = entries.value.find((candidate) => candidate.name === result.data);
          if (created) select(created);
        }
      }
      return result.data;
    } finally {
      if (generation === copyGeneration) copying.value = false;
    }
  }

  async function duplicateMany(
    targets: readonly RemoteFileEntry[],
    targetDirectory: string,
    copySuffix: string,
  ): Promise<string[]> {
    if (!sessionId.value || copying.value || targets.length === 0) return [];
    const generation = ++copyGeneration;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    copying.value = true;
    error.value = null;
    const createdNames: string[] = [];
    try {
      for (const entry of targets) {
        if (entry.isSymlink) continue;
        const result = await copyRemoteEntry(
          targetSessionId,
          entry.path,
          targetDirectory,
          entry.name,
          crypto.randomUUID(),
          { autoRename: true, copySuffix },
        );
        if (!result.ok) {
          if (isCurrentListing() && result.error.code !== 'TRANSFER_CANCELLED') error.value = result.error;
          break;
        }
        createdNames.push(result.data);
      }
      if (createdNames.length > 0 && isCurrentListing()) {
        await load(targetSessionId, currentPath);
        if (targetDirectory.replace(/\/+$/, '') === currentPath.replace(/\/+$/, '')) {
          const nameSet = new Set(createdNames);
          const createdEntries = entries.value.filter((candidate) => nameSet.has(candidate.name));
          if (createdEntries.length > 0) {
            selectedPaths.value = createdEntries.map((item) => item.path);
            selectedPath.value = createdEntries.at(-1)?.path ?? null;
            selectionAnchorPath.value = createdEntries[0]?.path ?? null;
            checkboxSticky.value = createdEntries.length > 1;
            sessionCaches.set(targetSessionId, snapshotActive());
          }
        }
      }
      return createdNames;
    } finally {
      if (generation === copyGeneration) copying.value = false;
    }
  }

  async function cancelCopy(operationId: string): Promise<boolean> {
    const result = await cancelCopyOperation(operationId);
    if (!result.ok) error.value = result.error;
    return result.ok;
  }

  async function changeMode(entry: RemoteFileEntry, mode: number): Promise<boolean> {
    if (!sessionId.value || changingMode.value || entry.isSymlink) return false;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    changingMode.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedChmodEntry(targetSessionId, entry.path, mode)
        : await updateRemoteEntryMode(targetSessionId, entry.path, mode);
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
    } finally {
      changingMode.value = false;
    }
  }

  async function changePermissions(
    entry: RemoteFileEntry,
    input: Omit<UpdateRemotePermissionsInput, 'path'>,
  ): Promise<RemotePermissionUpdateResult | null> {
    if (!sessionId.value || changingMode.value || entry.isSymlink) return null;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    changingMode.value = true;
    error.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      if (elevated && !input.recursive) {
        const result = await elevatedChmodEntry(targetSessionId, entry.path, input.mode);
        if (!result.ok) {
          syncPrivilegeFailure(targetSessionId, result.error);
          if (isCurrentListing()) error.value = result.error;
          return null;
        }
        if (isCurrentListing()) await load(targetSessionId, currentPath);
        return { updatedCount: 1, skippedSymlinkCount: 0 };
      }
      const result = await updateRemotePermissions(targetSessionId, {
        ...input,
        path: entry.path,
      });
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return null;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return result.data;
    } finally {
      changingMode.value = false;
    }
  }

  async function savePreview(content: string): Promise<boolean> {
    const currentPreview = preview.value;
    if (!sessionId.value || !currentPreview || currentPreview.truncated || savingPreview.value) return false;
    const targetSessionId = sessionId.value;
    const generation = ++saveGeneration;
    savingPreview.value = true;
    previewError.value = null;
    recoveryCopyPath.value = null;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      const result = elevated
        ? await elevatedSaveText(
          targetSessionId,
          currentPreview.path,
          content,
          currentPreview.revision,
          previewEncoding.value,
        )
        : await saveRemoteText(
          targetSessionId,
          currentPreview.path,
          content,
          currentPreview.revision,
          previewEncoding.value,
        );
      if (targetSessionId !== sessionId.value || preview.value?.path !== currentPreview.path) return false;
      if (!result.ok) {
        syncPrivilegeFailure(targetSessionId, result.error);
        previewError.value = result.error;
        return false;
      }
      preview.value = {
        ...currentPreview,
        content,
        bytes: result.data.bytes,
        revision: result.data.revision,
      };
      recoveryCopyPath.value = result.data.recoveryCopyPath;
      return true;
    } finally {
      if (generation === saveGeneration) savingPreview.value = false;
    }
  }

  async function openPreviewExternally(): Promise<boolean> {
    if (!sessionId.value || !previewPath.value || externalOpening.value) return false;
    const targetSessionId = sessionId.value;
    const targetPath = previewPath.value;
    externalOpening.value = true;
    try {
      const opened = await externalEditors.openRemote(targetSessionId, targetPath, 'system');
      if (targetSessionId !== sessionId.value || targetPath !== previewPath.value) return false;
      return opened;
    } finally {
      externalOpening.value = false;
    }
  }

  function closePreview(): void {
    previewGeneration += 1;
    saveGeneration += 1;
    preview.value = null;
    previewPath.value = null;
    previewEncoding.value = 'utf-8';
    previewError.value = null;
    recoveryCopyPath.value = null;
    previewLoading.value = false;
    externalOpening.value = false;
    savingPreview.value = false;
  }

  async function parent(): Promise<void> {
    if (!sessionId.value) return;
    const normalized = path.value.replace(/\/+$/, '');
    const slash = normalized.lastIndexOf('/');
    const parentPath = slash <= 0 ? '/' : normalized.slice(0, slash);
    await load(sessionId.value, parentPath);
  }

  function clear(): void {
    if (activeOwnerSessionId) sessionCaches.delete(activeOwnerSessionId);
    if (sessionId.value) sessionCaches.delete(sessionId.value);
    activeOwnerSessionId = null;
    resetActiveView();
  }

  function select(entry: RemoteFileEntry): void {
    selectedPath.value = entry.path;
    selectedPaths.value = [entry.path];
    selectionAnchorPath.value = entry.path;
    checkboxSticky.value = false;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function selectWithModifiers(
    entry: RemoteFileEntry,
    modifiers: { ctrlOrMeta?: boolean; shift?: boolean } = {},
  ): void {
    const ordered = entries.value.map((item) => item.path);
    const stickyMulti = multiSelectMode.value || checkboxSticky.value || selectedPaths.value.length > 1;
    const next = resolveMultiSelection(
      ordered,
      selectedPaths.value,
      selectionAnchorPath.value,
      entry.path,
      { ...modifiers, stickyMulti },
    );
    selectedPaths.value = next.selectedPaths;
    selectedPath.value = next.primaryPath;
    selectionAnchorPath.value = next.anchorPath;
    if (next.selectedPaths.length > 1) {
      checkboxSticky.value = true;
    } else if (next.selectedPaths.length === 0) {
      checkboxSticky.value = false;
    }
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function toggleSelection(entry: RemoteFileEntry): void {
    const ordered = entries.value.map((item) => item.path);
    const next = resolveMultiSelection(
      ordered,
      selectedPaths.value,
      selectionAnchorPath.value,
      entry.path,
      { ctrlOrMeta: true },
    );
    selectedPaths.value = next.selectedPaths;
    selectedPath.value = next.primaryPath;
    selectionAnchorPath.value = next.anchorPath;
    checkboxSticky.value = next.selectedPaths.length > 0;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function setEntrySelected(entry: RemoteFileEntry, selected: boolean): void {
    const ordered = entries.value.map((item) => item.path);
    const next = applyExplicitSelection(
      ordered,
      selectedPaths.value,
      selectionAnchorPath.value,
      entry.path,
      selected,
    );
    selectedPaths.value = next.selectedPaths;
    selectedPath.value = next.primaryPath;
    selectionAnchorPath.value = next.anchorPath;
    checkboxSticky.value = next.selectedPaths.length > 0;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function selectAll(): void {
    const ordered = entries.value.map((item) => item.path);
    selectedPaths.value = ordered;
    selectedPath.value = ordered.at(-1) ?? null;
    selectionAnchorPath.value = ordered[0] ?? null;
    checkboxSticky.value = ordered.length > 0;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function clearSelection(): void {
    selectedPaths.value = [];
    selectedPath.value = null;
    selectionAnchorPath.value = null;
    checkboxSticky.value = false;
    multiSelectMode.value = false;
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function toggleMultiSelectMode(): void {
    if (multiSelectMode.value) {
      multiSelectMode.value = false;
      checkboxSticky.value = false;
    } else {
      multiSelectMode.value = true;
    }
    if (sessionId.value && activeOwnerSessionId === sessionId.value) {
      sessionCaches.set(sessionId.value, snapshotActive());
    }
  }

  function isSelected(entryPath: string): boolean {
    return selectedPaths.value.includes(entryPath) || selectedPath.value === entryPath;
  }

  async function removeMany(targets: readonly RemoteFileEntry[], recursive = false): Promise<number> {
    if (!sessionId.value || deleting.value || targets.length === 0) return 0;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    deleting.value = true;
    error.value = null;
    let deletedCount = 0;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      for (const entry of targets) {
        const result = elevated
          ? await elevatedDeleteEntry(targetSessionId, entry.path, recursive)
          : recursive
            ? await deleteRemoteEntryRecursive(targetSessionId, entry.path)
            : await deleteRemoteEntry(targetSessionId, entry.path);
        if (!result.ok) {
          syncPrivilegeFailure(targetSessionId, result.error);
          if (isCurrentListing()) error.value = result.error;
          break;
        }
        deletedCount += typeof result.data === 'number' ? result.data : 1;
      }
      if (deletedCount > 0 && isCurrentListing()) {
        await load(targetSessionId, currentPath);
      }
      return deletedCount;
    } finally {
      deleting.value = false;
    }
  }

  async function moveMany(targets: readonly RemoteFileEntry[], targetDirectory: string): Promise<number> {
    if (!sessionId.value || moving.value || targets.length === 0) return 0;
    const generation = ++moveGeneration;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    moving.value = true;
    error.value = null;
    let movedCount = 0;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      for (const entry of targets) {
        const result = elevated
          ? await elevatedMoveEntry(targetSessionId, entry.path, targetDirectory)
          : await moveRemoteEntry(targetSessionId, entry.path, targetDirectory);
        if (!result.ok) {
          syncPrivilegeFailure(targetSessionId, result.error);
          if (isCurrentListing()) error.value = result.error;
          break;
        }
        movedCount += 1;
      }
      if (movedCount > 0 && isCurrentListing()) {
        await load(targetSessionId, currentPath);
      }
      return movedCount;
    } finally {
      if (generation === moveGeneration) moving.value = false;
    }
  }

  async function changePermissionsMany(
    targets: readonly RemoteFileEntry[],
    input: Omit<UpdateRemotePermissionsInput, 'path'>,
  ): Promise<RemotePermissionUpdateResult | null> {
    if (!sessionId.value || changingMode.value || targets.length === 0) return null;
    const targetSessionId = sessionId.value;
    const currentPath = path.value;
    const listingGeneration = requestGeneration;
    const isCurrentListing = () => listingGeneration === requestGeneration
      && targetSessionId === sessionId.value
      && currentPath === path.value;
    changingMode.value = true;
    error.value = null;
    let updatedCount = 0;
    let skippedSymlinkCount = 0;
    try {
      const elevated = privilege.isElevated(targetSessionId);
      for (const entry of targets) {
        if (entry.isSymlink) {
          skippedSymlinkCount += 1;
          continue;
        }
        if (elevated && !input.recursive) {
          const result = await elevatedChmodEntry(targetSessionId, entry.path, input.mode);
          if (!result.ok) {
            syncPrivilegeFailure(targetSessionId, result.error);
            if (isCurrentListing()) error.value = result.error;
            break;
          }
          updatedCount += 1;
          continue;
        }
        const result = await updateRemotePermissions(targetSessionId, {
          ...input,
          path: entry.path,
        });
        if (!result.ok) {
          if (isCurrentListing()) error.value = result.error;
          break;
        }
        updatedCount += result.data.updatedCount;
        skippedSymlinkCount += result.data.skippedSymlinkCount;
      }
      if (updatedCount > 0 && isCurrentListing()) {
        await load(targetSessionId, currentPath);
      }
      return updatedCount > 0 || skippedSymlinkCount > 0
        ? { updatedCount, skippedSymlinkCount }
        : null;
    } finally {
      changingMode.value = false;
    }
  }

  return {
    entries, path, sessionId, selectedPath, selectedPaths, multiSelectMode, checkboxSticky, loading, error,
    directoryUsage, directoryUsageLoading, directoryUsageError,
    directoryChildren, directoryLoadingPaths, directoryErrorPaths, expandedTreePaths,
    preview, previewPath, previewEncoding, previewLoading, previewError, externalOpening, deleting, creatingDirectory, creatingFile, renaming, moving, copying,
    changingMode, savingPreview, recoveryCopyPath,
    hasSessionState, activateSession, dropSession, setExpandedTreePaths,
    load, loadTreeDirectory, loadDirectoryUsage, resolveLink, open, parent, clear, select, selectWithModifiers, toggleSelection, setEntrySelected, selectAll, clearSelection, toggleMultiSelectMode, isSelected, previewFile, closePreview,
    remove, removeRecursive, removeMany, createDirectory, createFile, rename, move, moveMany, copy, duplicateMany, cancelCopy, changeMode, changePermissions, changePermissionsMany, savePreview,
    openPreviewExternally,
  };
});
