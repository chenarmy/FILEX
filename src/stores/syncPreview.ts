import { ref } from 'vue';
import { defineStore } from 'pinia';
import { createRequestId, normalizeUnknownError } from '@/api/common';
import { cancelDirectorySyncPreview, previewDirectorySync } from '@/api/domain/syncPreviewApi';
import type { AppError, DirectorySyncPreview } from '@/types/contracts';

export const useSyncPreviewStore = defineStore('sync-preview', () => {
  const preview = ref<DirectorySyncPreview | null>(null);
  const loading = ref(false);
  const cancelling = ref(false);
  const error = ref<AppError | null>(null);
  const operationId = ref<string | null>(null);
  let generation = 0;

  async function run(sessionId: string, localRoot: string, remoteRoot: string): Promise<void> {
    if (loading.value) return;
    const request = ++generation;
    const id = createRequestId();
    operationId.value = id;
    loading.value = true;
    cancelling.value = false;
    preview.value = null;
    error.value = null;
    try {
      const response = await previewDirectorySync(id, sessionId, localRoot, remoteRoot);
      if (request !== generation) return;
      if (response.ok) preview.value = response.data;
      else error.value = response.error;
    } catch (cause: unknown) {
      if (request === generation) error.value = normalizeUnknownError(cause, 'SYNC_PREVIEW_FAILED');
    } finally {
      if (request === generation) {
        loading.value = false;
        cancelling.value = false;
        operationId.value = null;
      }
    }
  }

  async function cancel(): Promise<void> {
    const id = operationId.value;
    if (!id || !loading.value || cancelling.value) return;
    cancelling.value = true;
    await cancelDirectorySyncPreview(id);
  }

  function clear(): void {
    generation += 1;
    preview.value = null;
    error.value = null;
    loading.value = false;
    cancelling.value = false;
    operationId.value = null;
  }

  return { preview, loading, cancelling, error, operationId, run, cancel, clear };
});
