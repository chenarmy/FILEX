import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { TransferDirection } from '@/types/contracts';

export type SettingsSection =
  | 'appearance'
  | 'assistant'
  | 'terminal'
  | 'connections'
  | 'security'
  | 'storage'
  | 'updates'
  | 'shortcuts';

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false);
  const settingsSection = ref<SettingsSection>('appearance');
  const quickConnectOpen = ref(false);
  const addProfileOpen = ref(false);
  const editingProfileId = ref<string | null>(null);
  const sshImportOpen = ref(false);
  const transferDialog = ref<{
    direction: TransferDirection;
    remotePath: string;
    localPath?: string;
    profileId?: string;
  } | null>(null);
  const tunnelDialogOpen = ref(false);
  const tunnelDialogRuleId = ref<string | null>(null);
  const assistantOpen = ref(false);
  const commandPaletteOpen = ref(false);
  const assistantTerminalSelection = ref<{ host: string; text: string; truncated: boolean } | null>(null);
  const toast = ref<string | null>(null);
  const confirmation = ref<{
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
  } | null>(null);
  let toastTimer: number | null = null;
  let confirmationResolver: ((accepted: boolean) => void) | null = null;

  function notify(message: string): void {
    toast.value = message;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.value = null;
      toastTimer = null;
    }, 3200);
  }

  function openSettings(section: SettingsSection = 'appearance'): void {
    settingsSection.value = section;
    settingsOpen.value = true;
  }

  function openCommandPalette(): void {
    commandPaletteOpen.value = true;
  }

  function closeCommandPalette(): void {
    commandPaletteOpen.value = false;
  }

  function closeSettings(): void {
    settingsOpen.value = false;
  }

  function openQuickConnect(): void {
    quickConnectOpen.value = true;
  }

  function closeQuickConnect(): void {
    quickConnectOpen.value = false;
  }

  function openAddProfile(): void {
    editingProfileId.value = null;
    addProfileOpen.value = true;
  }

  function openEditProfile(id: string): void {
    editingProfileId.value = id;
    addProfileOpen.value = true;
  }

  function closeAddProfile(): void {
    addProfileOpen.value = false;
    editingProfileId.value = null;
  }

  function openSshImport(): void {
    sshImportOpen.value = true;
  }

  function closeSshImport(): void {
    sshImportOpen.value = false;
  }

  function openTransfer(direction: TransferDirection, remotePath: string, localPath?: string, profileId?: string): void {
    transferDialog.value = {
      direction,
      remotePath,
      ...(localPath === undefined ? {} : { localPath }),
      ...(profileId === undefined ? {} : { profileId }),
    };
  }

  function closeTransfer(): void {
    transferDialog.value = null;
  }

  function openTunnel(ruleId?: string): void {
    tunnelDialogRuleId.value = ruleId ?? null;
    tunnelDialogOpen.value = true;
  }

  function closeTunnel(): void {
    tunnelDialogOpen.value = false;
    tunnelDialogRuleId.value = null;
  }

  function confirm(options: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
    if (confirmationResolver) confirmationResolver(false);
    confirmation.value = { ...options, danger: options.danger === true };
    return new Promise<boolean>((resolve) => {
      confirmationResolver = resolve;
    });
  }

  function resolveConfirmation(accepted: boolean): void {
    confirmationResolver?.(accepted);
    confirmationResolver = null;
    confirmation.value = null;
  }

  function toggleAssistant(): void {
    assistantOpen.value = !assistantOpen.value;
  }

  function attachTerminalSelection(host: string, selectedText: string): void {
    const text = selectedText.trim();
    if (!text) return;
    const characters = Array.from(text);
    assistantTerminalSelection.value = {
      host,
      text: characters.slice(-4_000).join(''),
      truncated: characters.length > 4_000,
    };
    assistantOpen.value = true;
  }

  function clearTerminalSelection(): void {
    assistantTerminalSelection.value = null;
  }

  return {
    settingsOpen,
    settingsSection,
    quickConnectOpen,
    addProfileOpen,
    editingProfileId,
    sshImportOpen,
    transferDialog,
    tunnelDialogOpen,
    tunnelDialogRuleId,
    assistantOpen,
    commandPaletteOpen,
    assistantTerminalSelection,
    toast,
    confirmation,
    notify,
    openSettings,
    openCommandPalette,
    closeCommandPalette,
    closeSettings,
    openQuickConnect,
    closeQuickConnect,
    openAddProfile,
    openEditProfile,
    closeAddProfile,
    openSshImport,
    closeSshImport,
    openTransfer,
    closeTransfer,
    openTunnel,
    closeTunnel,
    confirm,
    resolveConfirmation,
    toggleAssistant,
    attachTerminalSelection,
    clearTerminalSelection,
  };
});
