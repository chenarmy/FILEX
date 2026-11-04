import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { failure, normalizeUnknownError } from '@/api/common';
import {
  createConnectionProfile,
  deleteConnectionProfile,
  duplicateConnectionProfile,
  exportConnectionProfiles,
  importDefaultSshConfig,
  listConnectionProfiles,
  previewDefaultSshConfig,
  updateConnectionProfile,
} from '@/api/domain/connectionsApi';
import { filterProfiles, groupProfiles } from '@/domain/connections';
import type {
  AppError,
  ConnectionProfile,
  CreateConnectionProfileInput,
  MaintenanceArtifact,
  OperationResult,
  SshConfigImportPreview,
  UpdateConnectionProfileInput,
} from '@/types/contracts';

export const useConnectionsStore = defineStore('connections', () => {
  const profiles = ref<ConnectionProfile[]>([]);
  const activeProfileId = ref<string | null>(null);
  const query = ref('');
  const loading = ref(false);
  const saving = ref(false);
  const exporting = ref(false);
  const error = ref<AppError | null>(null);
  const sshImportPreview = ref<SshConfigImportPreview | null>(null);

  const filteredProfiles = computed(() => filterProfiles(profiles.value, query.value));
  const groupedProfiles = computed(() => groupProfiles(filteredProfiles.value));
  const filteredFavoriteProfiles = computed(() => filterProfiles(
    profiles.value.filter((profile) => profile.favorite),
    query.value,
  ));
  const favoriteGroupedProfiles = computed(() => groupProfiles(filteredFavoriteProfiles.value));
  const lastUsedTimestamp = (value: string | null): number => {
    if (!value) return 0;
    return /^\d+$/.test(value) ? Number(value) : Date.parse(value) || 0;
  };
  const recentProfiles = computed(() => profiles.value
    .filter((profile) => profile.lastUsedAt)
    .sort((left, right) => lastUsedTimestamp(right.lastUsedAt) - lastUsedTimestamp(left.lastUsedAt))
    .slice(0, 20));
  const activeProfile = computed(() => profiles.value.find((profile) => profile.id === activeProfileId.value) ?? null);

  function orderProfiles(items: ConnectionProfile[]): ConnectionProfile[] {
    return [...items].sort((left, right) => Number(right.favorite) - Number(left.favorite)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listConnectionProfiles();
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      profiles.value = orderProfiles(result.data);
      activeProfileId.value ??= profiles.value[0]?.id ?? null;
    } finally {
      loading.value = false;
    }
  }

  async function create(input: CreateConnectionProfileInput): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const result = await createConnectionProfile(input);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      profiles.value = orderProfiles([...profiles.value, result.data]);
      activeProfileId.value = result.data.id;
      return true;
    } finally {
      saving.value = false;
    }
  }

  async function update(id: string, input: UpdateConnectionProfileInput): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const result = await updateConnectionProfile(id, input);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      if (profiles.value.some((profile) => profile.id === id)) {
        profiles.value = orderProfiles(profiles.value.map((profile) => profile.id === id ? result.data : profile));
      }
      return true;
    } finally {
      saving.value = false;
    }
  }

  async function toggleFavorite(id: string): Promise<boolean> {
    if (saving.value) return false;
    const profile = profiles.value.find((item) => item.id === id);
    if (!profile) return false;
    return update(id, {
      name: profile.name,
      group: profile.group,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      environment: profile.environment,
      favorite: !profile.favorite,
      tags: [...profile.tags],
      authenticationMethod: profile.authenticationMethod,
      identityFile: profile.identityFile,
      proxyJump: profile.proxyJump,
      proxyJumpProfileIds: [...profile.proxyJumpProfileIds],
    });
  }

  async function duplicate(id: string): Promise<boolean> {
    const result = await duplicateConnectionProfile(id);
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    profiles.value = orderProfiles([...profiles.value, result.data]);
    activeProfileId.value = result.data.id;
    return true;
  }

  async function remove(id: string): Promise<boolean> {
    const result = await deleteConnectionProfile(id);
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    profiles.value = profiles.value.filter((profile) => profile.id !== id);
    if (activeProfileId.value === id) activeProfileId.value = profiles.value[0]?.id ?? null;
    return true;
  }

  async function exportProfiles(): Promise<OperationResult<MaintenanceArtifact | null>> {
    exporting.value = true;
    try {
      return await exportConnectionProfiles();
    } catch (cause: unknown) {
      return failure(normalizeUnknownError(cause, 'PROFILE_EXPORT_FAILED'));
    } finally {
      exporting.value = false;
    }
  }

  async function previewSshConfig(): Promise<boolean> {
    error.value = null;
    const result = await previewDefaultSshConfig();
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    sshImportPreview.value = result.data;
    return true;
  }

  async function importSshConfig(aliases: string[]): Promise<number> {
    error.value = null;
    const result = await importDefaultSshConfig(aliases);
    if (!result.ok) {
      error.value = result.error;
      return 0;
    }
    profiles.value = orderProfiles([...profiles.value, ...result.data]);
    activeProfileId.value = result.data[0]?.id ?? activeProfileId.value;
    sshImportPreview.value = null;
    return result.data.length;
  }

  function select(id: string): void {
    activeProfileId.value = id;
  }

  function replaceProfile(profile: ConnectionProfile): void {
    const index = profiles.value.findIndex((candidate) => candidate.id === profile.id);
    if (index >= 0) profiles.value[index] = profile;
  }

  return {
    profiles,
    activeProfileId,
    activeProfile,
    query,
    loading,
    saving,
    exporting,
    error,
    sshImportPreview,
    filteredProfiles,
    groupedProfiles,
    filteredFavoriteProfiles,
    favoriteGroupedProfiles,
    recentProfiles,
    load,
    create,
    update,
    toggleFavorite,
    duplicate,
    remove,
    exportProfiles,
    previewSshConfig,
    importSshConfig,
    select,
    replaceProfile,
  };
});
