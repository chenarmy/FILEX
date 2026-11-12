import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  createRemoteDirectory,
  createRemoteFile,
  copyRemoteEntry,
  deleteRemoteEntry,
  deleteRemoteEntryRecursive,
  listRemoteDirectory,
  moveRemoteEntry,
  previewRemoteText,
  renameRemoteEntry,
  saveRemoteText,
  updateRemoteEntryMode,
  updateRemotePermissions,
} from '@/api/domain/sftpApi';
import { cancelCopyOperation } from '@/api/domain/fileOperationsApi';
import { directoryEntries, type DirectoryTreeEntry } from '@/domain/directoryNavigation';
import { useExternalEditorsStore } from '@/stores/externalEditors';
import type {
  AppError,
  RemoteFileEntry,
  RemotePermissionUpdateResult,
  RemoteTextPreview,
  UpdateRemotePermissionsInput,
} from '@/types/contracts';

export const useSftpStore = defineStore('sftp', () => {
  const externalEditors = useExternalEditorsStore();
  const entries = ref<RemoteFileEntry[]>([]);
  const path = ref('.');
  const sessionId = ref<string | null>(null);
  const loading = ref(false);
  const selectedPath = ref<string | null>(null);
  const error = ref<AppError | null>(null);
  const preview = ref<RemoteTextPreview | null>(null);
  const previewPath = ref<string | null>(null);
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
  let requestGeneration = 0;
  let previewGeneration = 0;
  let saveGeneration = 0;
  let moveGeneration = 0;
  let copyGeneration = 0;
  const treeGenerations = new Map<string, number>();

  function cacheDirectory(listingPath: string, listingEntries: RemoteFileEntry[]): void {
    directoryChildren.value = {
      ...directoryChildren.value,
      [listingPath]: directoryEntries(listingEntries),
    };
  }

  async function load(nextSessionId: string, nextPath = path.value): Promise<boolean> {
    const generation = ++requestGeneration;
    loading.value = true;
    error.value = null;
    try {
      const result = await listRemoteDirectory(nextSessionId, nextPath);
      if (generation !== requestGeneration) return false;
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      sessionId.value = nextSessionId;
      path.value = result.data.path;
      entries.value = result.data.entries;
      cacheDirectory(result.data.path, result.data.entries);
      selectedPath.value = null;
      return true;
    } finally {
      if (generation === requestGeneration) loading.value = false;
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
      const result = await listRemoteDirectory(targetSessionId, treePath);
      if (treeGenerations.get(treePath) !== request || sessionId.value !== targetSessionId) return;
      if (!result.ok) {
        directoryErrorPaths.value = [...directoryErrorPaths.value, treePath];
        return;
      }
      cacheDirectory(result.data.path, result.data.entries);
    } finally {
      if (treeGenerations.get(treePath) === request) {
        directoryLoadingPaths.value = directoryLoadingPaths.value.filter((item) => item !== treePath);
      }
    }
  }
  async function open(entry: RemoteFileEntry): Promise<void> {
    if (entry.isDirectory && sessionId.value) {
      await load(sessionId.value, entry.path);
    } else if (!entry.isSymlink && sessionId.value) {
      await previewFile(entry.path);
    }
  }

  async function previewFile(filePath: string): Promise<void> {
    if (!sessionId.value) return;
    const generation = ++previewGeneration;
    const targetSessionId = sessionId.value;
    previewPath.value = filePath;
    preview.value = null;
    previewError.value = null;
    previewLoading.value = true;
    try {
      const result = await previewRemoteText(targetSessionId, filePath);
      if (generation !== previewGeneration || targetSessionId !== sessionId.value) return;
      if (!result.ok) {
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
      const result = await deleteRemoteEntry(targetSessionId, entry.path);
      if (!result.ok) {
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
      const result = await deleteRemoteEntryRecursive(targetSessionId, entry.path);
      if (!result.ok) {
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
      const result = await createRemoteDirectory(targetSessionId, currentPath, name);
      if (!result.ok) {
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
      const result = await createRemoteFile(targetSessionId, currentPath, name);
      if (!result.ok) {
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
      const result = await renameRemoteEntry(targetSessionId, entry.path, targetName);
      if (!result.ok) {
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
      const result = await moveRemoteEntry(targetSessionId, entry.path, targetDirectory);
      if (!result.ok) {
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
  ): Promise<boolean> {
    if (!sessionId.value || copying.value) return false;
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
      const result = await copyRemoteEntry(targetSessionId, entry.path, targetDirectory, targetName, operationId);
      if (!result.ok) {
        if (isCurrentListing() && result.error.code !== 'TRANSFER_CANCELLED') error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(targetSessionId, currentPath);
      return true;
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
      const result = await updateRemoteEntryMode(targetSessionId, entry.path, mode);
      if (!result.ok) {
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
      const result = await saveRemoteText(
        targetSessionId,
        currentPreview.path,
        content,
        currentPreview.revision,
      );
      if (targetSessionId !== sessionId.value || preview.value?.path !== currentPreview.path) return false;
      if (!result.ok) {
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
    requestGeneration += 1;
    moveGeneration += 1;
    copyGeneration += 1;
    closePreview();
    entries.value = [];
    path.value = '.';
    sessionId.value = null;
    error.value = null;
    loading.value = false;
    deleting.value = false;
    creatingDirectory.value = false;
    creatingFile.value = false;
    renaming.value = false;
    moving.value = false;
    copying.value = false;
    changingMode.value = false;
    selectedPath.value = null;
    directoryChildren.value = {};
    directoryLoadingPaths.value = [];
    directoryErrorPaths.value = [];
    treeGenerations.clear();
  }

  function select(entry: RemoteFileEntry): void {
    selectedPath.value = entry.path;
  }

  return {
    entries, path, sessionId, selectedPath, loading, error,
    directoryChildren, directoryLoadingPaths, directoryErrorPaths,
    preview, previewPath, previewLoading, previewError, externalOpening, deleting, creatingDirectory, creatingFile, renaming, moving, copying,
    changingMode, savingPreview, recoveryCopyPath,
    load, loadTreeDirectory, open, parent, clear, select, previewFile, closePreview,
    remove, removeRecursive, createDirectory, createFile, rename, move, copy, cancelCopy, changeMode, changePermissions, savePreview,
    openPreviewExternally,
  };
});
