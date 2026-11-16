<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Activity,
  LayoutDashboard,
  ListChecks,
  Network,
  Play,
  Plus,
  Server,
  Shield,
  Terminal,
  X,
  Zap,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useRemoteJobsStore } from '@/stores/remoteJobs';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTransfersStore } from '@/stores/transfers';
import { useTunnelsStore } from '@/stores/tunnels';
import { useUiStore } from '@/stores/ui';
import type { ConnectionProfile } from '@/types/contracts';

const ui = useUiStore();
const connections = useConnectionsStore();
const sessions = useSessionsStore();
const transfers = useTransfersStore();
const tunnels = useTunnelsStore();
const remoteJobs = useRemoteJobsStore();
const settings = useSettingsStore();

const closeButton = ref<HTMLButtonElement | null>(null);
const previousFocus = ref<HTMLElement | null>(null);

const connectedSessions = computed(() => (
  sessions.summaries.filter((item) => item.state === 'connected')
));
const activeTunnels = computed(() => (
  tunnels.tunnels.filter((item) => item.state === 'starting' || item.state === 'listening' || item.state === 'stopping')
));
const activeActivityCount = computed(() => (
  transfers.activeTasks.length + activeTunnels.value.length + remoteJobs.activeJobs.length
));
const recentConnections = computed(() => connections.recentProfiles.slice(0, 6));

function isProfileConnected(profileId: string): boolean {
  return connectedSessions.value.some((session) => session.profileId === profileId);
}

function close(): void {
  ui.closeOverview();
}

function openQuickConnect(): void {
  close();
  ui.openQuickConnect();
}

function openAddProfile(): void {
  close();
  ui.openAddProfile();
}

function openLocalTerminal(): void {
  close();
  ui.openLocalTerminalDialog();
}

function openKeysProxies(): void {
  close();
  ui.openKeyProxyLibrary();
}

function openActivity(): void {
  settings.value.taskTab = 'all';
  settings.value.taskDrawerOpen = true;
  close();
}

async function connectRecent(profile: ConnectionProfile): Promise<void> {
  connections.select(profile.id);
  close();
  await sessions.begin(profile);
}

function focusSession(sessionId: string): void {
  sessions.selectSession(sessionId);
  close();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}

onMounted(() => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener('keydown', handleKeydown, true);
  closeButton.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true);
  previousFocus.value?.focus();
});
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close">
    <section
      class="dialog overview-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="overview-dialog-title"
    >
      <header class="dialog-header">
        <div>
          <LayoutDashboard :size="15" />
          <strong id="overview-dialog-title">{{ t('overview.title') }}</strong>
        </div>
        <button
          ref="closeButton"
          type="button"
          class="icon-button"
          :aria-label="t('settings.close')"
          @click="close"
        >
          <X :size="15" />
        </button>
      </header>
      <div class="dialog-body overview-body">
        <p class="dialog-note">{{ t('overview.subtitle') }}</p>

        <div class="overview-kpi-grid">
          <div class="overview-kpi-card">
            <Server :size="15" />
            <div>
              <strong>{{ connections.profiles.length }}</strong>
              <small>{{ t('overview.savedProfiles') }}</small>
            </div>
          </div>
          <div class="overview-kpi-card">
            <Activity :size="15" />
            <div>
              <strong>{{ connectedSessions.length }}</strong>
              <small>{{ t('overview.connectedSessions') }}</small>
            </div>
          </div>
          <button type="button" class="overview-kpi-card clickable" @click="openActivity">
            <ListChecks :size="15" />
            <div>
              <strong>{{ activeActivityCount }}</strong>
              <small>{{ t('overview.activeActivities') }}</small>
            </div>
          </button>
          <div class="overview-kpi-card">
            <Network :size="15" />
            <div>
              <strong>{{ tunnels.rules.length }}</strong>
              <small>{{ t('overview.savedTunnels') }}</small>
            </div>
          </div>
        </div>

        <div class="overview-section">
          <h3>{{ t('overview.quickActions') }}</h3>
          <div class="overview-actions-row">
            <button type="button" class="button primary" :disabled="sessions.busy" @click="openQuickConnect">
              <Zap :size="13" />{{ t('app.quickConnect') }}
            </button>
            <button type="button" class="button" @click="openAddProfile">
              <Plus :size="13" />{{ t('app.addConnection') }}
            </button>
            <button type="button" class="button" :disabled="sessions.busy" @click="openLocalTerminal">
              <Terminal :size="13" />{{ t('localTerminal.title') }}
            </button>
            <button type="button" class="button" @click="openKeysProxies">
              <Shield :size="13" />{{ t('keyProxyLibrary.openButton') }}
            </button>
            <button type="button" class="button" @click="openActivity">
              <ListChecks :size="13" />{{ t('overview.openActivity') }}
            </button>
          </div>
        </div>

        <div class="overview-columns">
          <div class="overview-section">
            <h3>{{ t('overview.recentConnections') }}</h3>
            <p v-if="recentConnections.length === 0" class="overview-empty">{{ t('overview.noRecent') }}</p>
            <ul v-else class="overview-list">
              <li v-for="profile in recentConnections" :key="profile.id" class="overview-list-item">
                <div class="overview-item-main">
                  <span class="overview-item-title">
                    <span class="status-dot" :class="{ online: isProfileConnected(profile.id) }" />
                    <strong>{{ profile.name }}</strong>
                  </span>
                  <small class="mono">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</small>
                </div>
                <button
                  type="button"
                  class="button"
                  :disabled="sessions.busy"
                  @click="connectRecent(profile)"
                >
                  <Play :size="12" />{{ t('overview.connectAction') }}
                </button>
              </li>
            </ul>
            <small class="overview-hint">{{ t('overview.allConnectionsHint') }}</small>
          </div>

          <div class="overview-section">
            <h3>{{ t('overview.activeSessions') }}</h3>
            <p v-if="sessions.summaries.length === 0" class="overview-empty">{{ t('overview.noSessions') }}</p>
            <ul v-else class="overview-list">
              <li v-for="session in sessions.summaries" :key="session.id" class="overview-list-item">
                <div class="overview-item-main">
                  <span class="overview-item-title">
                    <span class="status-dot" :class="{ online: session.state === 'connected' }" />
                    <strong>{{ session.sessionKind === 'local' ? t('localTerminal.title') : `${session.username}@${session.host}` }}</strong>
                  </span>
                  <small class="mono">{{ session.state }} · {{ session.port > 0 ? `${session.host}:${session.port}` : session.id.slice(0, 8) }}</small>
                </div>
                <button
                  type="button"
                  class="button"
                  :disabled="sessions.activeSessionId === session.id"
                  @click="focusSession(session.id)"
                >
                  {{ t('overview.focusAction') }}
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
