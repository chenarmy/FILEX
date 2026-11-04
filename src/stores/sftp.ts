import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  createRemoteDirectory,
  copyRemoteEntry,
  deleteRemoteEntry,
  listRemoteDirectory,
  moveRemoteEntry,
  openRemoteFileExternally,
  previewRemoteText,
  renameRemoteEntry,
  saveRemoteText,
} from '@/api/domain/sftpApi';
import { cancelCopyOperation } from '@/api/domain/fileOperationsApi';
import type { AppError, RemoteFileEntry, RemoteTextPreview } from '@/types/contracts';

export const useSftpStore = defineStore('sftp', () => {
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
  const renaming = ref(false);
  const moving = ref(false);
  const copying = ref(false);
  const savingPreview = ref(false);
  const recoveryCopyPath = ref<string | null>(null);
  let requestGeneration = 0;
  let previewGeneration = 0;
  let saveGeneration = 0;
  let moveGeneration = 0;
  let copyGeneration = 0;

  async function load(nextSessionId: string, nextPath = path.value): Promise<void> {
    const generation = ++requestGeneration;
    loading.value = true;
    error.value = null;
    try {
      const result = await listRemoteDirectory(nextSessionId, nextPath);
      if (generation !== requestGeneration) return;
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      sessionId.value = nextSessionId;
      path.value = nextPath;
      entries.value = result.data;
      selectedPath.value = null;
    } finally {
      if (generation === requestGeneration) loading.value = false;
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
      const result = await openRemoteFileExternally(targetSessionId, targetPath);
      if (targetSessionId !== sessionId.value || targetPath !== previewPath.value) return false;
      if (!result.ok) {
        previewError.value = result.error;
        return false;
      }
      return true;
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
    renaming.value = false;
    moving.value = false;
    copying.value = false;
    selectedPath.value = null;
  }

  function select(entry: RemoteFileEntry): void {
    selectedPath.value = entry.path;
  }

  return {
    entries, path, sessionId, selectedPath, loading, error,
    preview, previewPath, previewLoading, previewError, externalOpening, deleting, creatingDirectory, renaming, moving, copying,
    savingPreview, recoveryCopyPath,
    load, open, parent, clear, select, previewFile, closePreview,
    remove, createDirectory, rename, move, copy, cancelCopy, savePreview,
    openPreviewExternally,
  };
});
