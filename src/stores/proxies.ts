import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  countProxyReferences,
  createProxyProfile,
  deleteProxyProfile,
  listProxyProfiles,
  testProxyProfile,
  updateProxyProfile,
} from '@/api/domain/proxiesApi';
import type {
  AppError,
  CreateProxyProfileInput,
  ProxyPreflightResult,
  ProxyProfile,
  UpdateProxyProfileInput,
} from '@/types/contracts';

export const useProxiesStore = defineStore('proxies', () => {
  const entries = ref<ProxyProfile[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  const testingId = ref<string | null>(null);
  const testResults = ref<Record<string, ProxyPreflightResult>>({});
  const error = ref<AppError | null>(null);

  async function refresh(): Promise<void> {
    loading.value = true;
    const result = await listProxyProfiles();
    loading.value = false;
    if (result.ok) {
      entries.value = result.data;
    } else {
      error.value = result.error;
    }
  }

  async function create(input: CreateProxyProfileInput): Promise<ProxyProfile | null> {
    error.value = null;
    busy.value = true;
    const result = await createProxyProfile(input);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    await refresh();
    return result.data;
  }

  async function update(input: UpdateProxyProfileInput): Promise<ProxyProfile | null> {
    error.value = null;
    busy.value = true;
    const result = await updateProxyProfile(input);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    await refresh();
    return result.data;
  }

  async function referenceCount(proxyId: string): Promise<number> {
    const result = await countProxyReferences(proxyId);
    if (!result.ok) {
      error.value = result.error;
      return 0;
    }
    return result.data;
  }

  async function remove(proxyId: string): Promise<boolean> {
    error.value = null;
    busy.value = true;
    const result = await deleteProxyProfile(proxyId);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    entries.value = entries.value.filter((item) => item.id !== proxyId);
    const nextTests = { ...testResults.value };
    delete nextTests[proxyId];
    testResults.value = nextTests;
    return true;
  }

  async function runTest(proxyId: string): Promise<ProxyPreflightResult | null> {
    error.value = null;
    testingId.value = proxyId;
    const result = await testProxyProfile(proxyId);
    testingId.value = null;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    testResults.value = {
      ...testResults.value,
      [proxyId]: result.data,
    };
    return result.data;
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    entries,
    loading,
    busy,
    testingId,
    testResults,
    error,
    refresh,
    create,
    update,
    referenceCount,
    remove,
    runTest,
    clearError,
  };
});
