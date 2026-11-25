import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  copyLocalEntry,
  createLocalFile,
  createLocalDirectory,
  deleteLocalEntry,
  listLocalDirectory,
  moveLocalEntry,
  renameLocalEntry,
  resolveLocalLinkTarget,
} from '@/api/domain/localFilesApi';
import { cancelCopyOperation } from '@/api/domain/fileOperationsApi';
import { directoryEntries, type DirectoryTreeEntry } from '@/domain/directoryNavigation';
import { applyExplicitSelection, resolveMultiSelection } from '@/domain/fileSelection';
import type { AppError, LocalDirectoryListing, LocalFileEntry, ResolvedLinkTarget } from '@/types/contracts';

export const useLocalFilesStore = defineStore('local-files', () => {
  const listing = ref<LocalDirectoryListing | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const selectedPath = ref<string | null>(null);
  const selectedPaths = ref<string[]>([]);
  const selectionAnchorPath = ref<string | null>(null);
  const multiSelectMode = ref(false);
  const checkboxSticky = ref(false);
  const mutating = ref(false);
  const directoryChildren = ref<Record<string, DirectoryTreeEntry[]>>({});
  const directoryLoadingPaths = ref<string[]>([]);
  const directoryErrorPaths = ref<string[]>([]);
  let generation = 0;
  let mutationGeneration = 0;
  const treeGenerations = new Map<string, number>();

  function cacheDirectory(nextListing: LocalDirectoryListing): void {
    directoryChildren.value = {
      ...directoryChildren.value,
      [nextListing.path]: directoryEntries(nextListing.entries),
    };
  }

  async function load(path?: string): Promise<boolean> {
    const request = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await listLocalDirectory(path);
      if (request !== generation) return false;
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      listing.value = result.data;
      cacheDirectory(result.data);
      selectedPath.value = null;
      selectedPaths.value = [];
      selectionAnchorPath.value = null;
      checkboxSticky.value = false;
      return true;
    } finally {
      if (request === generation) loading.value = false;
    }
  }

  async function loadTreeDirectory(path: string): Promise<void> {
    if (directoryLoadingPaths.value.includes(path)) return;
    const request = (treeGenerations.get(path) ?? 0) + 1;
    treeGenerations.set(path, request);
    directoryLoadingPaths.value = [...directoryLoadingPaths.value, path];
    directoryErrorPaths.value = directoryErrorPaths.value.filter((item) => item !== path);
    try {
      const result = await listLocalDirectory(path);
      if (treeGenerations.get(path) !== request) return;
      if (!result.ok) {
        directoryErrorPaths.value = [...directoryErrorPaths.value, path];
        return;
      }
      cacheDirectory(result.data);
    } finally {
      if (treeGenerations.get(path) === request) {
        directoryLoadingPaths.value = directoryLoadingPaths.value.filter((item) => item !== path);
      }
    }
  }

  function select(entry: LocalFileEntry): void {
    selectedPath.value = entry.path;
    selectedPaths.value = [entry.path];
    selectionAnchorPath.value = entry.path;
    checkboxSticky.value = false;
  }

  function selectWithModifiers(
    entry: LocalFileEntry,
    modifiers: { ctrlOrMeta?: boolean; shift?: boolean } = {},
  ): void {
    const ordered = (listing.value?.entries ?? []).map((item) => item.path);
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
  }

  function toggleSelection(entry: LocalFileEntry): void {
    const ordered = (listing.value?.entries ?? []).map((item) => item.path);
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
  }

  function setEntrySelected(entry: LocalFileEntry, selected: boolean): void {
    const ordered = (listing.value?.entries ?? []).map((item) => item.path);
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
  }

  function selectAll(): void {
    const ordered = (listing.value?.entries ?? []).map((item) => item.path);
    selectedPaths.value = ordered;
    selectedPath.value = ordered.at(-1) ?? null;
    selectionAnchorPath.value = ordered[0] ?? null;
    checkboxSticky.value = ordered.length > 0;
  }

  function clearSelection(): void {
    selectedPaths.value = [];
    selectedPath.value = null;
    selectionAnchorPath.value = null;
    checkboxSticky.value = false;
    multiSelectMode.value = false;
  }

  function toggleMultiSelectMode(): void {
    if (multiSelectMode.value) {
      multiSelectMode.value = false;
      checkboxSticky.value = false;
    } else {
      multiSelectMode.value = true;
    }
  }

  function isSelected(entryPath: string): boolean {
    return selectedPaths.value.includes(entryPath) || selectedPath.value === entryPath;
  }

  async function resolveLink(targetPath: string): Promise<ResolvedLinkTarget | null> {
    error.value = null;
    const result = await resolveLocalLinkTarget(targetPath);
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    return result.data;
  }

  async function open(entry: LocalFileEntry): Promise<void> {
    if (entry.isSymlink) {
      const resolved = await resolveLink(entry.path);
      if (!resolved) return;
      if (resolved.targetKind === 'directory') {
        await load(resolved.targetPath);
        return;
      }
      if (resolved.targetKind === 'file' && resolved.parentPath) {
        if (await load(resolved.parentPath)) {
          const targetEntry = listing.value?.entries.find((candidate) => candidate.path === resolved.targetPath);
          if (targetEntry) select(targetEntry);
        }
      }
      return;
    }
    if (entry.isDirectory) await load(entry.path);
  }

  async function parent(): Promise<void> {
    if (listing.value?.parentPath) await load(listing.value.parentPath);
  }

  async function createDirectory(name: string): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await createLocalDirectory(parentPath, name);
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function createFile(name: string): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await createLocalFile(parentPath, name);
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function rename(entry: LocalFileEntry, targetName: string): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await renameLocalEntry(entry.path, targetName);
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function move(entry: LocalFileEntry, targetDirectory: string): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await moveLocalEntry(entry.path, targetDirectory);
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function moveMany(targets: readonly LocalFileEntry[], targetDirectory: string): Promise<number> {
    if (!listing.value || mutating.value || targets.length === 0) return 0;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    let movedCount = 0;
    try {
      for (const entry of targets) {
        const result = await moveLocalEntry(entry.path, targetDirectory);
        if (!result.ok) {
          if (isCurrentListing()) error.value = result.error;
          break;
        }
        movedCount += 1;
      }
      if (movedCount > 0 && isCurrentListing()) await load(parentPath);
      return movedCount;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function copy(
    entry: LocalFileEntry,
    targetDirectory: string,
    targetName: string,
    operationId: string,
    options?: { autoRename?: boolean; copySuffix?: string },
  ): Promise<string | null> {
    if (!listing.value || mutating.value) return null;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await copyLocalEntry(entry.path, targetDirectory, targetName, operationId, options);
      if (!result.ok) {
        if (isCurrentListing() && result.error.code !== 'TRANSFER_CANCELLED') error.value = result.error;
        return null;
      }
      if (isCurrentListing()) {
        await load(parentPath);
        if (targetDirectory.replace(/[\\/]+$/, '') === parentPath.replace(/[\\/]+$/, '')) {
          const created = listing.value?.entries.find((candidate) => candidate.name === result.data);
          if (created) select(created);
        }
      }
      return result.data;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function duplicateMany(
    targets: readonly LocalFileEntry[],
    targetDirectory: string,
    copySuffix: string,
  ): Promise<string[]> {
    if (!listing.value || mutating.value || targets.length === 0) return [];
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    const createdNames: string[] = [];
    try {
      for (const entry of targets) {
        if (entry.isSymlink) continue;
        const result = await copyLocalEntry(
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
        await load(parentPath);
        if (targetDirectory.replace(/[\\/]+$/, '') === parentPath.replace(/[\\/]+$/, '')) {
          const nameSet = new Set(createdNames);
          const createdEntries = (listing.value?.entries ?? []).filter((candidate) => nameSet.has(candidate.name));
          if (createdEntries.length > 0) {
            selectedPaths.value = createdEntries.map((item) => item.path);
            selectedPath.value = createdEntries.at(-1)?.path ?? null;
            selectionAnchorPath.value = createdEntries[0]?.path ?? null;
            checkboxSticky.value = createdEntries.length > 1;
          }
        }
      }
      return createdNames;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function cancelCopy(operationId: string): Promise<boolean> {
    const result = await cancelCopyOperation(operationId);
    if (!result.ok) error.value = result.error;
    return result.ok;
  }

  async function remove(entry: LocalFileEntry): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await deleteLocalEntry(entry.path);
      if (!result.ok) {
        if (isCurrentListing()) error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  async function removeMany(targets: readonly LocalFileEntry[]): Promise<number> {
    if (!listing.value || mutating.value || targets.length === 0) return 0;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    let deletedCount = 0;
    try {
      for (const entry of targets) {
        const result = await deleteLocalEntry(entry.path);
        if (!result.ok) {
          if (isCurrentListing()) error.value = result.error;
          break;
        }
        deletedCount += 1;
      }
      if (deletedCount > 0 && isCurrentListing()) await load(parentPath);
      return deletedCount;
    } finally {
      if (mutation === mutationGeneration) mutating.value = false;
    }
  }

  function clear(): void {
    generation += 1;
    mutationGeneration += 1;
    listing.value = null;
    loading.value = false;
    mutating.value = false;
    error.value = null;
    selectedPath.value = null;
    selectedPaths.value = [];
    selectionAnchorPath.value = null;
    checkboxSticky.value = false;
    multiSelectMode.value = false;
    directoryChildren.value = {};
    directoryLoadingPaths.value = [];
    directoryErrorPaths.value = [];
    treeGenerations.clear();
  }

  return {
    listing, loading, error, selectedPath, selectedPaths, multiSelectMode, checkboxSticky, mutating,
    directoryChildren, directoryLoadingPaths, directoryErrorPaths,
    load, loadTreeDirectory, resolveLink, select, selectWithModifiers, toggleSelection, setEntrySelected, selectAll, clearSelection, toggleMultiSelectMode, isSelected, open, parent, createDirectory, createFile, rename, move, moveMany, copy, duplicateMany, cancelCopy, remove, removeMany, clear,
  };
});
