<script setup lang="ts">
import { computed } from 'vue';
import { CircleDot, Database, ShieldCheck } from 'lucide-vue-next';
import { isTauriRuntime } from '@/api/common';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';

const connections = useConnectionsStore();
const endpoint = computed(() => connections.activeProfile
  ? `${connections.activeProfile.username}@${connections.activeProfile.host}:${connections.activeProfile.port}`
  : '—');
</script>

<template>
  <footer class="status-bar">
    <div class="status-group">
      <span><CircleDot :size="11" class="status-success" />{{ t('status.local') }}</span>
      <span><ShieldCheck :size="11" />{{ t('status.noSecrets') }}</span>
    </div>
    <div class="status-group">
      <span class="mono">{{ endpoint }}</span>
      <span><Database :size="11" />{{ isTauriRuntime() ? t('status.runtimeTauri') : t('status.runtimeBrowser') }}</span>
    </div>
  </footer>
</template>
