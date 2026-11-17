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

export const DEFAULT_CONNECTION_GROUP = '未分组';
const GROUPS_STORAGE_KEY = 'filex.connectionGroups.v1';

function loadCustomGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== DEFAULT_CONNECTION_GROUP),
    )];
  } catch {
    return [];
  }
}

function persistCustomGroups(groups: string[]): void {
  try {
    window.localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Ignore storage quota or private-mode failures.
  }
}

export const useConnectionsStore = defineStore('connections', () => {
  const profiles = ref<ConnectionProfile[]>([]);
  const customGroups = ref<string[]>(loadCustomGroups());
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
  const allGroupNames = computed(() => {
    const others = new Set<string>(customGroups.value);
    for (const profile of profiles.value) {
      const normalized = profile.group.trim() || DEFAULT_CONNECTION_GROUP;
      if (normalized !== DEFAULT_CONNECTION_GROUP) others.add(normalized);
    }
    return [
      DEFAULT_CONNECTION_GROUP,
      ...[...others].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
    ];
  });

  function toUpdateInput(
    profile: ConnectionProfile,
    overrides: Partial<UpdateConnectionProfileInput> = {},
  ): UpdateConnectionProfileInput {
    return {
      name: profile.name,
      group: profile.group,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      environment: profile.environment,
      favorite: profile.favorite,
      tags: [...profile.tags],
      authenticationMethod: profile.authenticationMethod,
      identityFile: profile.identityFile,
      keyId: profile.keyId ?? null,
      proxyProfileId: profile.proxyProfileId ?? null,
      proxyJump: profile.proxyJump,
      proxyJumpProfileIds: [...profile.proxyJumpProfileIds],
      ...overrides,
    };
  }

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
    return update(id, toUpdateInput(profile, { favorite: !profile.favorite }));
  }

  function ensureCustomGroup(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === DEFAULT_CONNECTION_GROUP) return;
    if (!customGroups.value.includes(trimmed)) {
      customGroups.value = [...customGroups.value, trimmed];
      persistCustomGroups(customGroups.value);
    }
  }

  function createGroup(name: string): { ok: boolean; reason?: 'empty' | 'reserved' | 'duplicate' } {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if (trimmed === DEFAULT_CONNECTION_GROUP) return { ok: false, reason: 'reserved' };
    if (allGroupNames.value.some((group) => group.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
      return { ok: false, reason: 'duplicate' };
    }
    ensureCustomGroup(trimmed);
    return { ok: true };
  }

  async function moveToGroup(profileId: string, targetGroup: string): Promise<boolean> {
    if (saving.value) return false;
    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) return false;
    const normalized = targetGroup.trim() || DEFAULT_CONNECTION_GROUP;
    if (profile.group === normalized) return true;
    ensureCustomGroup(normalized);
    return update(profileId, toUpdateInput(profile, { group: normalized }));
  }

  async function renameGroup(
    oldName: string,
    newName: string,
  ): Promise<{ ok: boolean; reason?: 'empty' | 'reserved' | 'duplicate' | 'failed' }> {
    const source = oldName.trim();
    const target = newName.trim();
    if (!target) return { ok: false, reason: 'empty' };
    if (!source || source === DEFAULT_CONNECTION_GROUP || target === DEFAULT_CONNECTION_GROUP) {
      return { ok: false, reason: 'reserved' };
    }
    if (source === target) return { ok: true };
    if (allGroupNames.value.some((group) => group !== source && group.toLocaleLowerCase() === target.toLocaleLowerCase())) {
      return { ok: false, reason: 'duplicate' };
    }

    const affected = profiles.value.filter((profile) => profile.group === source);
    for (const profile of affected) {
      const updated = await update(profile.id, toUpdateInput(profile, { group: target }));
      if (!updated) return { ok: false, reason: 'failed' };
    }
    const nextGroups = customGroups.value.filter((group) => group !== source);
    if (!nextGroups.includes(target)) nextGroups.push(target);
    customGroups.value = nextGroups;
    persistCustomGroups(customGroups.value);
    return { ok: true };
  }

  async function deleteGroup(name: string): Promise<boolean> {
    const source = name.trim();
    if (!source || source === DEFAULT_CONNECTION_GROUP) return false;
    const affected = profiles.value.filter((profile) => profile.group === source);
    for (const profile of affected) {
      const updated = await update(profile.id, toUpdateInput(profile, { group: DEFAULT_CONNECTION_GROUP }));
      if (!updated) return false;
    }
    customGroups.value = customGroups.value.filter((group) => group !== source);
    persistCustomGroups(customGroups.value);
    return true;
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
    customGroups,
    allGroupNames,
    load,
    create,
    update,
    toggleFavorite,
    createGroup,
    renameGroup,
    deleteGroup,
    moveToGroup,
    duplicate,
    remove,
    exportProfiles,
    previewSshConfig,
    importSshConfig,
    select,
    replaceProfile,
  };
});
