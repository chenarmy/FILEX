<script setup lang="ts">
import { onMounted } from 'vue';
import WorkbenchShell from '@/components/layout/WorkbenchShell.vue';
import AddProfileDialog from '@/components/dialogs/AddProfileDialog.vue';
import QuickConnectDialog from '@/components/dialogs/QuickConnectDialog.vue';
import SshImportDialog from '@/components/dialogs/SshImportDialog.vue';
import HostKeyDialog from '@/components/dialogs/HostKeyDialog.vue';
import PasswordDialog from '@/components/dialogs/PasswordDialog.vue';
import PrivateKeyPassphraseDialog from '@/components/dialogs/PrivateKeyPassphraseDialog.vue';
import TransferDialog from '@/components/dialogs/TransferDialog.vue';
import TunnelDialog from '@/components/dialogs/TunnelDialog.vue';
import LocalTerminalDialog from '@/components/dialogs/LocalTerminalDialog.vue';
import OverviewDialog from '@/components/dialogs/OverviewDialog.vue';
import ElevatedAccessDialog from '@/components/dialogs/ElevatedAccessDialog.vue';
import KeyAndProxyLibraryDialog from '@/components/dialogs/KeyAndProxyLibraryDialog.vue';
import ConfirmDialog from '@/components/dialogs/ConfirmDialog.vue';
import RemoteTextPreviewDialog from '@/components/dialogs/RemoteTextPreviewDialog.vue';
import UpdateAvailableDialog from '@/components/dialogs/UpdateAvailableDialog.vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import ToastNotice from '@/components/ui/ToastNotice.vue';
import { useUpdateScheduling } from '@/composables/useUpdateScheduling';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';
import { useSessionsStore } from '@/stores/sessions';
import { useRemoteJobsStore } from '@/stores/remoteJobs';
import { useTransfersStore } from '@/stores/transfers';
import { useTunnelsStore } from '@/stores/tunnels';
import { useSettingsStore } from '@/stores/settings';
import { useSftpStore } from '@/stores/sftp';
import { useTerminalLogsStore } from '@/stores/terminalLogs';
import { useUpdatesStore } from '@/stores/updates';

const connections = useConnectionsStore();
const ui = useUiStore();
const sessions = useSessionsStore();
const remoteJobs = useRemoteJobsStore();
const transfers = useTransfersStore();
const tunnels = useTunnelsStore();
const settings = useSettingsStore();
const sftp = useSftpStore();
const terminalLogs = useTerminalLogsStore();
const updates = useUpdatesStore();

useUpdateScheduling();

onMounted(async () => {
  await settings.initialize();
  await sessions.initializeTerminalEvents();
  await terminalLogs.initializeEvents();
  await transfers.initializeEvents();
  await remoteJobs.initializeEvents();
  await connections.load();
  await transfers.load();
  await tunnels.load();
  await remoteJobs.load();
  await sessions.initializeExternalLaunchEvents();
});
</script>

<template>
  <WorkbenchShell />
  <OverviewDialog v-if="ui.overviewOpen" />
  <QuickConnectDialog v-if="ui.quickConnectOpen" />
  <LocalTerminalDialog v-if="ui.localTerminalDialogOpen" />
  <ElevatedAccessDialog v-if="ui.elevatedAccessSessionId" />
  <KeyAndProxyLibraryDialog v-if="ui.keyProxyLibraryOpen" />
  <AddProfileDialog v-if="ui.addProfileOpen" />
  <SshImportDialog v-if="ui.sshImportOpen" />
  <HostKeyDialog v-if="sessions.challenge && sessions.challenge.trust !== 'trusted'" />
  <PasswordDialog v-if="sessions.passwordProfileId" />
  <PrivateKeyPassphraseDialog v-if="sessions.privateKeyPassphraseProfileId" />
  <TransferDialog v-if="ui.transferDialog" />
  <TunnelDialog v-if="ui.tunnelDialogOpen" />
  <ConfirmDialog v-if="ui.confirmation" />
  <RemoteTextPreviewDialog v-if="sftp.previewLoading || sftp.preview || sftp.previewError" />
  <SettingsDialog v-if="ui.settingsOpen" />
  <UpdateAvailableDialog v-if="updates.dialogOpen" />
  <ToastNotice v-if="ui.toast" :message="ui.toast" />
</template>
