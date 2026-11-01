<script setup lang="ts">
import { ArrowDownToLine, CircleDot, ListTree, Network, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import type { TaskTab } from '@/types/contracts';

const settings = useSettingsStore();
const tabs: { id: TaskTab; label: Parameters<typeof t>[0]; icon: typeof ArrowDownToLine }[] = [
  { id: 'transfers', label: 'tasks.transfers', icon: ArrowDownToLine },
  { id: 'tunnels', label: 'tasks.tunnels', icon: Network },
  { id: 'events', label: 'tasks.events', icon: ListTree },
];
</script>

<template>
  <section class="task-drawer">
    <header class="task-header">
      <div class="task-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="settings.value.taskTab === tab.id"
          @click="settings.value.taskTab = tab.id"
        >
          <component :is="tab.icon" :size="12" />{{ t(tab.label) }}
        </button>
      </div>
      <button type="button" class="icon-button" aria-label="Close task drawer" @click="settings.value.taskDrawerOpen = false">
        <X :size="13" />
      </button>
    </header>
    <div v-if="settings.value.taskTab === 'transfers'" class="task-empty">{{ t('tasks.noTransfers') }}</div>
    <div v-else-if="settings.value.taskTab === 'tunnels'" class="task-empty">{{ t('tasks.noTunnels') }}</div>
    <div v-else class="event-list">
      <div class="event-row"><CircleDot :size="11" /><time>08:57:16</time><span>{{ t('tasks.foundationEvent') }}</span></div>
    </div>
  </section>
</template>
