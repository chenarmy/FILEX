import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  readClipboardFilePaths,
  writeClipboardFilePaths,
} from '@/api/domain/clipboardFilesApi';
import type { AppError } from '@/types/contracts';

export type ResolveClipboardPathsResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: AppError };

function sameStringArray(left: readonly string[] | null, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export const useFileClipboardStore = defineStore('file-clipboard', () => {
  const localPaths = ref<string[]>([]);
  const copiedSequence = ref<number | null>(null);
  const osSnapshotPaths = ref<string[] | null>(null);

  async function copyLocalPaths(paths: string[]): Promise<void> {
    const distinct = [
      ...new Set(
        paths.filter((path) => Boolean(path) && path.length <= 4_096 && !path.includes('\0')),
      ),
    ];
    localPaths.value = distinct;
    copiedSequence.value = null;
    osSnapshotPaths.value = null;
    if (distinct.length === 0) return;

    const writeResult = await writeClipboardFilePaths(distinct);
    if (
      writeResult.ok
      && writeResult.data.written
      && writeResult.data.sequence !== undefined
      && writeResult.data.sequence !== null
    ) {
      copiedSequence.value = writeResult.data.sequence;
      return;
    }

    const snapshotResult = await readClipboardFilePaths();
    if (snapshotResult.ok) {
      copiedSequence.value = snapshotResult.data.sequence ?? null;
      osSnapshotPaths.value = snapshotResult.data.supported ? snapshotResult.data.paths : null;
    }
  }

  async function resolvePathsForPaste(
    fallbackEventPaths: readonly string[] = [],
  ): Promise<ResolveClipboardPathsResult> {
    const readResult = await readClipboardFilePaths();
    if (!readResult.ok) {
      if (localPaths.value.length > 0) {
        return { ok: true, paths: [...localPaths.value] };
      }
      return { ok: false, error: readResult.error };
    }

    const snapshot = readResult.data;
    const sequence = snapshot.sequence ?? null;

    if (sequence !== null) {
      if (copiedSequence.value !== null && sequence === copiedSequence.value && localPaths.value.length > 0) {
        return {
          ok: true,
          paths: snapshot.paths.length > 0 ? snapshot.paths : [...localPaths.value],
        };
      }
      if (copiedSequence.value !== null && sequence !== copiedSequence.value) {
        clear();
      }
      if (snapshot.paths.length > 0) return { ok: true, paths: snapshot.paths };
      return { ok: true, paths: [...fallbackEventPaths] };
    }

    if (snapshot.supported) {
      if (osSnapshotPaths.value !== null && !sameStringArray(osSnapshotPaths.value, snapshot.paths)) {
        clear();
        return { ok: true, paths: snapshot.paths };
      }
      if (localPaths.value.length > 0) {
        return { ok: true, paths: [...localPaths.value] };
      }
      if (snapshot.paths.length > 0) return { ok: true, paths: snapshot.paths };
      return { ok: true, paths: [...fallbackEventPaths] };
    }

    if (fallbackEventPaths.length > 0) {
      return { ok: true, paths: [...fallbackEventPaths] };
    }
    return { ok: true, paths: [...localPaths.value] };
  }

  function clear(): void {
    localPaths.value = [];
    copiedSequence.value = null;
    osSnapshotPaths.value = null;
  }

  return {
    localPaths,
    copiedSequence,
    osSnapshotPaths,
    copyLocalPaths,
    resolvePathsForPaste,
    clear,
  };
});
