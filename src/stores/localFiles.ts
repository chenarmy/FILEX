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
} from '@/api/domain/localFilesApi';
import { cancelCopyOperation } from '@/api/domain/fileOperationsApi';
import { directoryEntries, type DirectoryTreeEntry } from '@/domain/directoryNavigation';
import type { AppError, LocalDirectoryListing, LocalFileEntry } from '@/types/contracts';

export const useLocalFilesStore = defineStore('local-files', () => {
  const listing = ref<LocalDirectoryListing | null>(null);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const selectedPath = ref<string | null>(null);
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
  }

  async function open(entry: LocalFileEntry): Promise<void> {
    if (entry.isDirectory && !entry.isSymlink) await load(entry.path);
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

  async function copy(
    entry: LocalFileEntry,
    targetDirectory: string,
    targetName: string,
    operationId: string,
  ): Promise<boolean> {
    if (!listing.value || mutating.value) return false;
    const parentPath = listing.value.path;
    const listingGeneration = generation;
    const isCurrentListing = () => generation === listingGeneration && listing.value?.path === parentPath;
    const mutation = ++mutationGeneration;
    mutating.value = true;
    error.value = null;
    try {
      const result = await copyLocalEntry(entry.path, targetDirectory, targetName, operationId);
      if (!result.ok) {
        if (isCurrentListing() && result.error.code !== 'TRANSFER_CANCELLED') error.value = result.error;
        return false;
      }
      if (isCurrentListing()) await load(parentPath);
      return true;
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

  function clear(): void {
    generation += 1;
    mutationGeneration += 1;
    listing.value = null;
    loading.value = false;
    mutating.value = false;
    error.value = null;
    selectedPath.value = null;
    directoryChildren.value = {};
    directoryLoadingPaths.value = [];
    directoryErrorPaths.value = [];
    treeGenerations.clear();
  }

  return {
    listing, loading, error, selectedPath, mutating,
    directoryChildren, directoryLoadingPaths, directoryErrorPaths,
    load, loadTreeDirectory, select, open, parent, createDirectory, createFile, rename, move, copy, cancelCopy, remove, clear,
  };
});
