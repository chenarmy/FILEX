import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false);
  const addProfileOpen = ref(false);
  const toast = ref<string | null>(null);
  let toastTimer: number | null = null;

  function notify(message: string): void {
    toast.value = message;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.value = null;
      toastTimer = null;
    }, 3200);
  }

  function openSettings(): void {
    settingsOpen.value = true;
  }

  function closeSettings(): void {
    settingsOpen.value = false;
  }

  function openAddProfile(): void {
    addProfileOpen.value = true;
  }

  function closeAddProfile(): void {
    addProfileOpen.value = false;
  }

  return {
    settingsOpen,
    addProfileOpen,
    toast,
    notify,
    openSettings,
    closeSettings,
    openAddProfile,
    closeAddProfile,
  };
});
