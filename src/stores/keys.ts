import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  countSshKeyReferences,
  deleteSshKey,
  inspectSshKeyFile,
  listSshKeys,
  registerSshKey,
  rotateSshKey,
  selectLibraryKeyFile,
} from '@/api/domain/keysApi';
import type {
  AppError,
  RegisterSshKeyInput,
  RotateSshKeyInput,
  SshKeyEntry,
  SshKeyMetadataInspection,
} from '@/types/contracts';

export const useKeysStore = defineStore('keys', () => {
  const entries = ref<SshKeyEntry[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref<AppError | null>(null);

  async function refresh(): Promise<void> {
    loading.value = true;
    const result = await listSshKeys();
    loading.value = false;
    if (result.ok) {
      entries.value = result.data;
    } else {
      error.value = result.error;
    }
  }

  async function pickKeyFile(title: string): Promise<string | null> {
    error.value = null;
    const result = await selectLibraryKeyFile(title);
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    return result.data;
  }

  async function inspectFile(
    keyPath: string,
    passphrase: string | null = null,
  ): Promise<SshKeyMetadataInspection | null> {
    error.value = null;
    busy.value = true;
    const result = await inspectSshKeyFile(keyPath, passphrase);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    return result.data;
  }

  async function register(input: RegisterSshKeyInput): Promise<SshKeyEntry | null> {
    error.value = null;
    busy.value = true;
    const result = await registerSshKey(input);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    await refresh();
    return result.data;
  }

  async function rotate(input: RotateSshKeyInput): Promise<SshKeyEntry | null> {
    error.value = null;
    busy.value = true;
    const result = await rotateSshKey(input);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return null;
    }
    await refresh();
    return result.data;
  }

  async function referenceCount(keyId: string): Promise<number> {
    const result = await countSshKeyReferences(keyId);
    if (!result.ok) {
      error.value = result.error;
      return 0;
    }
    return result.data;
  }

  async function remove(keyId: string): Promise<boolean> {
    error.value = null;
    busy.value = true;
    const result = await deleteSshKey(keyId);
    busy.value = false;
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    entries.value = entries.value.filter((item) => item.id !== keyId);
    return true;
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    entries,
    loading,
    busy,
    error,
    refresh,
    pickKeyFile,
    inspectFile,
    register,
    rotate,
    referenceCount,
    remove,
    clearError,
  };
});
