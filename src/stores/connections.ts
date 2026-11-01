import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { createConnectionProfile, listConnectionProfiles } from '@/api/domain/connectionsApi';
import { filterProfiles, groupProfiles } from '@/domain/connections';
import type { AppError, ConnectionProfile, CreateConnectionProfileInput } from '@/types/contracts';

export const useConnectionsStore = defineStore('connections', () => {
  const profiles = ref<ConnectionProfile[]>([]);
  const activeProfileId = ref<string | null>(null);
  const query = ref('');
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<AppError | null>(null);

  const filteredProfiles = computed(() => filterProfiles(profiles.value, query.value));
  const groupedProfiles = computed(() => groupProfiles(filteredProfiles.value));
  const activeProfile = computed(() => profiles.value.find((profile) => profile.id === activeProfileId.value) ?? null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listConnectionProfiles();
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      profiles.value = result.data;
      activeProfileId.value ??= result.data[0]?.id ?? null;
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
      profiles.value.push(result.data);
      activeProfileId.value = result.data.id;
      return true;
    } finally {
      saving.value = false;
    }
  }

  function select(id: string): void {
    activeProfileId.value = id;
  }

  return {
    profiles,
    activeProfileId,
    activeProfile,
    query,
    loading,
    saving,
    error,
    filteredProfiles,
    groupedProfiles,
    load,
    create,
    select,
  };
});
