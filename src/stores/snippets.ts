import { ref } from 'vue';
import { defineStore } from 'pinia';
import { deleteCommandSnippet, listCommandSnippets, saveCommandSnippet } from '@/api/domain/snippetsApi';
import type { AppError, CommandSnippet, SaveCommandSnippetInput } from '@/types/contracts';

export const useSnippetsStore = defineStore('snippets', () => {
  const items = ref<CommandSnippet[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<AppError | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listCommandSnippets();
      if (!result.ok) { error.value = result.error; return; }
      items.value = result.data;
    } finally { loading.value = false; }
  }

  async function save(input: SaveCommandSnippetInput): Promise<boolean> {
    saving.value = true;
    error.value = null;
    try {
      const result = await saveCommandSnippet(input);
      if (!result.ok) { error.value = result.error; return false; }
      const index = items.value.findIndex((item) => item.id === result.data.id);
      if (index < 0) items.value.unshift(result.data);
      else items.value[index] = result.data;
      return true;
    } finally { saving.value = false; }
  }

  async function remove(id: string): Promise<boolean> {
    error.value = null;
    const result = await deleteCommandSnippet(id);
    if (!result.ok) { error.value = result.error; return false; }
    items.value = items.value.filter((item) => item.id !== id);
    return true;
  }

  return { items, loading, saving, error, load, save, remove };
});
