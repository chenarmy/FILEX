<script setup lang="ts">
import { onMounted } from 'vue';
import WorkbenchShell from '@/components/layout/WorkbenchShell.vue';
import AddProfileDialog from '@/components/dialogs/AddProfileDialog.vue';
import SettingsDialog from '@/components/settings/SettingsDialog.vue';
import ToastNotice from '@/components/ui/ToastNotice.vue';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';

const connections = useConnectionsStore();
const ui = useUiStore();

onMounted(async () => {
  await connections.load();
});
</script>

<template>
  <WorkbenchShell />
  <AddProfileDialog v-if="ui.addProfileOpen" />
  <SettingsDialog v-if="ui.settingsOpen" />
  <ToastNotice v-if="ui.toast" :message="ui.toast" />
</template>
