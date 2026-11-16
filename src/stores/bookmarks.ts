import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  deletePathBookmark,
  deriveBookmarkLabel,
  listPathBookmarks,
  savePathBookmark,
} from '@/api/domain/bookmarksApi';
import { useConnectionsStore } from '@/stores/connections';
import type { AppError, BookmarkSide, PathBookmark } from '@/types/contracts';

export const LOCAL_WORKSPACE_BOOKMARK_PROFILE = '__local_workspace__';

export const useBookmarksStore = defineStore('bookmarks', () => {
  const persistedByProfile = ref<Record<string, PathBookmark[]>>({});
  const ephemeralByProfile = ref<Record<string, PathBookmark[]>>({});
  const loading = ref(false);
  const error = ref<AppError | null>(null);

  function isSavedProfile(profileId: string): boolean {
    if (!profileId || profileId === LOCAL_WORKSPACE_BOOKMARK_PROFILE) return false;
    return useConnectionsStore().profiles.some((profile) => profile.id === profileId);
  }

  function listFor(profileId: string | null | undefined, side?: BookmarkSide): PathBookmark[] {
    const key = profileId?.trim() || LOCAL_WORKSPACE_BOOKMARK_PROFILE;
    const items = isSavedProfile(key)
      ? (persistedByProfile.value[key] ?? [])
      : (ephemeralByProfile.value[key] ?? []);
    return side ? items.filter((item) => item.side === side) : items;
  }

  function findByPath(
    profileId: string | null | undefined,
    side: BookmarkSide,
    targetPath: string,
  ): PathBookmark | null {
    const normalized = targetPath.trim();
    if (!normalized) return null;
    return listFor(profileId, side).find((item) => item.path === normalized) ?? null;
  }

  async function load(profileId: string | null | undefined, force = false): Promise<void> {
    const key = profileId?.trim() || LOCAL_WORKSPACE_BOOKMARK_PROFILE;
    if (!isSavedProfile(key)) return;
    if (!force && Object.prototype.hasOwnProperty.call(persistedByProfile.value, key)) return;
    loading.value = true;
    error.value = null;
    try {
      const result = await listPathBookmarks(key);
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      persistedByProfile.value = {
        ...persistedByProfile.value,
        [key]: result.data,
      };
    } finally {
      loading.value = false;
    }
  }

  async function save(
    profileId: string | null | undefined,
    side: BookmarkSide,
    path: string,
    label?: string,
  ): Promise<PathBookmark | null> {
    const key = profileId?.trim() || LOCAL_WORKSPACE_BOOKMARK_PROFILE;
    const trimmedPath = path.trim();
    if (!trimmedPath) return null;
    error.value = null;
    if (!isSavedProfile(key)) {
      const current = ephemeralByProfile.value[key] ?? [];
      const existing = current.find((item) => item.side === side && item.path === trimmedPath);
      const entry: PathBookmark = {
        id: existing?.id ?? crypto.randomUUID(),
        profileId: key,
        side,
        label: label?.trim() || deriveBookmarkLabel(trimmedPath),
        path: trimmedPath,
        createdAtMs: Date.now(),
      };
      const next = [
        entry,
        ...current.filter((item) => !(item.side === side && item.path === trimmedPath)),
      ].slice(0, 100);
      ephemeralByProfile.value = {
        ...ephemeralByProfile.value,
        [key]: next,
      };
      return entry;
    }
    const result = await savePathBookmark({
      profileId: key,
      side,
      label: label?.trim() || deriveBookmarkLabel(trimmedPath),
      path: trimmedPath,
    });
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    const existing = persistedByProfile.value[key] ?? [];
    const next = [
      result.data,
      ...existing.filter((item) => item.id !== result.data.id),
    ];
    persistedByProfile.value = {
      ...persistedByProfile.value,
      [key]: next,
    };
    return result.data;
  }

  async function remove(profileId: string | null | undefined, bookmarkId: string): Promise<boolean> {
    const key = profileId?.trim() || LOCAL_WORKSPACE_BOOKMARK_PROFILE;
    error.value = null;
    if (!isSavedProfile(key)) {
      const current = ephemeralByProfile.value[key] ?? [];
      const next = current.filter((item) => item.id !== bookmarkId);
      ephemeralByProfile.value = {
        ...ephemeralByProfile.value,
        [key]: next,
      };
      return next.length !== current.length;
    }
    const result = await deletePathBookmark(key, bookmarkId);
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    persistedByProfile.value = {
      ...persistedByProfile.value,
      [key]: (persistedByProfile.value[key] ?? []).filter((item) => item.id !== bookmarkId),
    };
    return result.data;
  }

  function clearEphemeral(profileId: string): void {
    const next = { ...ephemeralByProfile.value };
    delete next[profileId];
    ephemeralByProfile.value = next;
  }

  return {
    loading,
    error,
    listFor,
    findByPath,
    load,
    save,
    remove,
    clearEphemeral,
  };
});
