import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MonitorDetailsView, OpsCategory, TransferDirection } from '@/types/contracts';

export type SettingsSection =
  | 'appearance'
  | 'assistant'
  | 'terminal'
  | 'connections'
  | 'security'
  | 'storage'
  | 'updates'
  | 'shortcuts';

export type KeyProxyLibraryTab = 'keys' | 'proxies';

export const useUiStore = defineStore('ui', () => {
  const settingsOpen = ref(false);
  const settingsSection = ref<SettingsSection>('appearance');
  const quickConnectOpen = ref(false);
  const localTerminalDialogOpen = ref(false);
  const elevatedAccessSessionId = ref<string | null>(null);
  const keyProxyLibraryOpen = ref(false);
  const keyProxyLibraryTab = ref<KeyProxyLibraryTab>('keys');
  const addProfileOpen = ref(false);
  const editingProfileId = ref<string | null>(null);
  const defaultProfileGroup = ref<string | null>(null);
  const sshImportOpen = ref(false);
  const transferDialog = ref<{
    direction: TransferDirection;
    remotePath: string;
    localPath?: string;
    profileId?: string;
    destinationProfileId?: string;
    destinationRemotePath?: string;
  } | null>(null);
  const tunnelDialogOpen = ref(false);
  const tunnelDialogRuleId = ref<string | null>(null);
  const assistantOpen = ref(false);
  const overviewOpen = ref(false);
  const commandPaletteOpen = ref(false);
  const monitorDetailsView = ref<MonitorDetailsView | null>(null);
  const dockerDialogOpen = ref(false);
  const opsDialogCategory = ref<OpsCategory | null>(null);
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

  function openMonitorDetails(view: MonitorDetailsView = 'overview'): void {
    monitorDetailsView.value = view;
  }

  function closeMonitorDetails(): void {
    monitorDetailsView.value = null;
  }

  function openDockerDialog(): void {
    dockerDialogOpen.value = true;
  }

  function closeDockerDialog(): void {
    dockerDialogOpen.value = false;
  }

  function openOpsDialog(category: OpsCategory = 'ports'): void {
    opsDialogCategory.value = category;
  }

  function closeOpsDialog(): void {
    opsDialogCategory.value = null;
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

  function openLocalTerminalDialog(): void {
    localTerminalDialogOpen.value = true;
  }

  function closeLocalTerminalDialog(): void {
    localTerminalDialogOpen.value = false;
  }

  function openKeyProxyLibrary(tab: KeyProxyLibraryTab = 'keys'): void {
    keyProxyLibraryTab.value = tab;
    keyProxyLibraryOpen.value = true;
  }

  function closeKeyProxyLibrary(): void {
    keyProxyLibraryOpen.value = false;
  }

  function openOverview(): void {
    overviewOpen.value = true;
  }

  function closeOverview(): void {
    overviewOpen.value = false;
  }

  function openAddProfile(defaultGroup?: string): void {
    editingProfileId.value = null;
    defaultProfileGroup.value = defaultGroup ?? null;
    addProfileOpen.value = true;
  }

  function openEditProfile(id: string): void {
    editingProfileId.value = id;
    defaultProfileGroup.value = null;
    addProfileOpen.value = true;
  }

  function closeAddProfile(): void {
    addProfileOpen.value = false;
    editingProfileId.value = null;
    defaultProfileGroup.value = null;
  }

  function openSshImport(): void {
    sshImportOpen.value = true;
  }

  function closeSshImport(): void {
    sshImportOpen.value = false;
  }

  function openTransfer(
    direction: TransferDirection,
    remotePath: string,
    localPath?: string,
    profileId?: string,
    destinationProfileId?: string,
    destinationRemotePath?: string,
  ): void {
    transferDialog.value = {
      direction,
      remotePath,
      ...(localPath === undefined ? {} : { localPath }),
      ...(profileId === undefined ? {} : { profileId }),
      ...(destinationProfileId === undefined ? {} : { destinationProfileId }),
      ...(destinationRemotePath === undefined ? {} : { destinationRemotePath }),
    };
  }

  function closeTransfer(): void {
    transferDialog.value = null;
  }

  function openTunnel(ruleId?: string): void {
    tunnelDialogRuleId.value = ruleId ?? null;
    tunnelDialogOpen.value = true;
  }

  function openElevatedAccessDialog(sessionId: string): void {
    elevatedAccessSessionId.value = sessionId;
  }

  function closeElevatedAccessDialog(): void {
    elevatedAccessSessionId.value = null;
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
    localTerminalDialogOpen,
    keyProxyLibraryOpen,
    keyProxyLibraryTab,
    addProfileOpen,
    editingProfileId,
    defaultProfileGroup,
    sshImportOpen,
    transferDialog,
    tunnelDialogOpen,
    tunnelDialogRuleId,
    assistantOpen,
    overviewOpen,
    commandPaletteOpen,
    monitorDetailsView,
    dockerDialogOpen,
    opsDialogCategory,
    assistantTerminalSelection,
    toast,
    confirmation,
    notify,
    openSettings,
    openCommandPalette,
    closeCommandPalette,
    openMonitorDetails,
    closeMonitorDetails,
    openDockerDialog,
    closeDockerDialog,
    openOpsDialog,
    closeOpsDialog,
    closeSettings,
    openQuickConnect,
    closeQuickConnect,
    openLocalTerminalDialog,
    closeLocalTerminalDialog,
    openKeyProxyLibrary,
    closeKeyProxyLibrary,
    openOverview,
    closeOverview,
    elevatedAccessSessionId,
    openElevatedAccessDialog,
    closeElevatedAccessDialog,
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
