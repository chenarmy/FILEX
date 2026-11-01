<script setup lang="ts">
import { computed } from 'vue';
import {
  Activity,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Info,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldQuestion,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSettingsStore } from '@/stores/settings';
import type { InspectorTab } from '@/types/contracts';

const connections = useConnectionsStore();
const settings = useSettingsStore();
const profile = computed(() => connections.activeProfile);

const tabs: { id: InspectorTab; label: Parameters<typeof t>[0]; icon: typeof FolderOpen }[] = [
  { id: 'files', label: 'inspector.files', icon: FolderOpen },
  { id: 'monitor', label: 'inspector.monitor', icon: Activity },
  { id: 'session', label: 'inspector.session', icon: Info },
];
</script>

<template>
  <aside class="inspector-pane">
    <div class="inspector-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="settings.value.inspectorTab === tab.id"
        @click="settings.value.inspectorTab = tab.id"
      >
        <component :is="tab.icon" :size="12" />
        {{ t(tab.label) }}
      </button>
    </div>

    <section v-if="settings.value.inspectorTab === 'files'" class="inspector-content">
      <div class="inspector-toolbar">
        <strong>{{ t('inspector.path') }}</strong>
        <button type="button" class="icon-button" disabled aria-label="Refresh remote files"><RefreshCw :size="12" /></button>
      </div>
      <div class="path-breadcrumb mono"><span>/</span><ChevronRight :size="11" /><span>home</span><ChevronRight :size="11" /><span>{{ profile?.username ?? 'user' }}</span></div>
      <div class="file-list" aria-disabled="true">
        <div class="file-row muted"><Folder :size="13" /><span>projects</span><small>—</small></div>
        <div class="file-row muted"><Folder :size="13" /><span>logs</span><small>—</small></div>
        <div class="file-row muted"><File :size="13" /><span>.profile</span><small>—</small></div>
      </div>
      <div class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.filePending') }}</span></div>
    </section>

    <section v-else-if="settings.value.inspectorTab === 'monitor'" class="inspector-content monitor-content">
      <div class="metric-heading"><strong>{{ t('inspector.monitor') }}</strong><span class="status-pill pending">UNPROBED</span></div>
      <div class="metric-row"><Server :size="14" /><span>System</span><strong>Unavailable</strong></div>
      <div class="metric-row"><Activity :size="14" /><span>CPU / Load</span><strong>—</strong></div>
      <div class="metric-row"><MemoryStick :size="14" /><span>Memory</span><strong>—</strong></div>
      <div class="metric-row"><HardDrive :size="14" /><span>Disk</span><strong>—</strong></div>
      <div class="inline-notice"><ShieldQuestion :size="14" /><span>{{ t('inspector.monitorPending') }}</span></div>
    </section>

    <section v-else class="inspector-content session-content">
      <dl>
        <div><dt>{{ t('inspector.host') }}</dt><dd class="mono">{{ profile?.host ?? '—' }}:{{ profile?.port ?? 22 }}</dd></div>
        <div><dt>{{ t('inspector.user') }}</dt><dd>{{ profile?.username ?? '—' }}</dd></div>
        <div><dt>{{ t('inspector.trust') }}</dt><dd class="warning-text">{{ t('inspector.trustUnknown') }}</dd></div>
        <div><dt>{{ t('inspector.credential') }}</dt><dd>{{ t('inspector.credentialNone') }}</dd></div>
      </dl>
    </section>
  </aside>
</template>
