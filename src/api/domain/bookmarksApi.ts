import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type { CreatePathBookmarkInput, OperationResult, PathBookmark } from '@/types/contracts';

const browserStorageKey = 'filex.path-bookmarks.v1';

function readBrowserBookmarks(): PathBookmark[] {
  try {
    const raw = localStorage.getItem(browserStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PathBookmark[]) : [];
  } catch {
    return [];
  }
}

function writeBrowserBookmarks(items: PathBookmark[]): void {
  try {
    localStorage.setItem(browserStorageKey, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors in browser preview.
  }
}

export function deriveBookmarkLabel(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  if (!cleaned) {
    return path.includes('\\') ? '\\' : '/';
  }
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  return (segments.at(-1) ?? cleaned).slice(0, 80);
}

export async function listPathBookmarks(profileId: string): Promise<OperationResult<PathBookmark[]>> {
  if (!isTauriRuntime()) {
    return success(readBrowserBookmarks().filter((item) => item.profileId === profileId));
  }
  try {
    return await invoke<OperationResult<PathBookmark[]>>('list_path_bookmarks', { profileId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'BOOKMARK_QUERY_FAILED'));
  }
}

export async function savePathBookmark(
  input: CreatePathBookmarkInput,
): Promise<OperationResult<PathBookmark>> {
  if (!isTauriRuntime()) {
    const all = readBrowserBookmarks();
    const existing = all.find(
      (item) => item.profileId === input.profileId && item.side === input.side && item.path === input.path,
    );
    const entry: PathBookmark = {
      id: existing?.id ?? crypto.randomUUID(),
      profileId: input.profileId,
      side: input.side,
      label: input.label.trim() || deriveBookmarkLabel(input.path),
      path: input.path,
      createdAtMs: Date.now(),
    };
    const filtered = all.filter(
      (item) => !(item.profileId === entry.profileId && item.side === entry.side && item.path === entry.path),
    );
    filtered.unshift(entry);
    writeBrowserBookmarks(filtered);
    return success(entry);
  }
  try {
    return await invoke<OperationResult<PathBookmark>>('save_path_bookmark', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'BOOKMARK_WRITE_FAILED'));
  }
}

export async function deletePathBookmark(
  profileId: string,
  bookmarkId: string,
): Promise<OperationResult<boolean>> {
  if (!isTauriRuntime()) {
    const all = readBrowserBookmarks();
    const next = all.filter((item) => !(item.profileId === profileId && item.id === bookmarkId));
    writeBrowserBookmarks(next);
    return success(next.length !== all.length);
  }
  try {
    return await invoke<OperationResult<boolean>>('delete_path_bookmark', { profileId, bookmarkId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'BOOKMARK_WRITE_FAILED'));
  }
}
