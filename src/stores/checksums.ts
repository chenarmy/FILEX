import { ref } from 'vue';
import { defineStore } from 'pinia';
import { compareFileChecksums, cancelFileChecksum } from '@/api/domain/checksumsApi';
import { createRequestId } from '@/api/common';
import type { AppError, FileChecksumComparison } from '@/types/contracts';

export const useChecksumsStore = defineStore('checksums', () => {
  const result = ref<FileChecksumComparison | null>(null);
  const loading = ref(false);
  const cancelling = ref(false);
  const error = ref<AppError | null>(null);
  const operationId = ref<string | null>(null);
  let generation = 0;

  async function compare(sessionId: string, localPath: string, remotePath: string): Promise<void> {
    if (loading.value) return;
    const request = ++generation;
    const id = createRequestId();
    operationId.value = id;
    loading.value = true;
    cancelling.value = false;
    result.value = null;
    error.value = null;
    try {
      const response = await compareFileChecksums(id, sessionId, localPath, remotePath);
      if (request !== generation) return;
      if (response.ok) result.value = response.data;
      else error.value = response.error;
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
    await cancelFileChecksum(id);
  }

  function clear(): void {
    generation += 1;
    result.value = null;
    error.value = null;
    loading.value = false;
    cancelling.value = false;
    operationId.value = null;
  }

  return { result, loading, cancelling, error, operationId, compare, cancel, clear };
});
