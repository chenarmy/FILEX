<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ChevronDown, CircleAlert, Download, FileInput, LoaderCircle, Plus, Search, Server, Star } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { ConnectionProfile } from '@/types/contracts';
import SnippetPane from '@/components/connections/SnippetPane.vue';
import TunnelsPane from '@/components/connections/TunnelsPane.vue';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const activeMode = ref<'connections' | 'recent' | 'tunnels' | 'snippets'>('connections');
const filterInput = ref<HTMLInputElement | null>(null);
const showFavoritesOnly = ref(false);
const displayedProfiles = computed(() => showFavoritesOnly.value ? connections.filteredFavoriteProfiles : connections.filteredProfiles);
const displayedGroups = computed(() => showFavoritesOnly.value ? connections.favoriteGroupedProfiles : connections.groupedProfiles);
const emptyProfileMessage = computed(() => {
  if (!showFavoritesOnly.value) return t('nav.empty');
  return connections.profiles.some((profile) => profile.favorite) && connections.query.trim()
    ? t('nav.favoritesNoMatches')
    : t('nav.favoritesEmpty');
});

function stateLabel(profile: ConnectionProfile): string {
  switch (profile.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting';
    case 'degraded': return 'Degraded';
    case 'failed': return 'Failed';
    default: return 'Idle';
  }
}

function recentDate(value: string | null): string {
  if (!value) return '';
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

async function openProfile(profile: ConnectionProfile): Promise<void> {
  if (sessions.busy) return;
  connections.select(profile.id);
  const existing = [...sessions.summaries].reverse().find((session) => session.profileId === profile.id && session.state !== 'closed');
  if (existing) {
    sessions.selectSession(existing.id);
    if (existing.state === 'disconnected' || existing.state === 'failed') await sessions.reconnectActive();
    return;
  }
  await sessions.begin(profile);
}

async function focusFilter(): Promise<void> {
  activeMode.value = 'connections';
  await nextTick();
  filterInput.value?.focus();
  filterInput.value?.select();
}

async function exportAllProfiles(): Promise<void> {
  if (connections.profiles.length === 0 || connections.exporting) return;
  const accepted = await ui.confirm({
    title: t('profile.exportConfirmTitle'),
    message: t('profile.exportConfirmMessage', { count: connections.profiles.length }),
    confirmLabel: t('profile.exportProfiles'),
  });
  if (!accepted) return;

  const result = await connections.exportProfiles();
  if (!result.ok) {
    ui.notify(t(result.error.messageKey as Parameters<typeof t>[0]));
    return;
  }
  if (result.data) ui.notify(`${t('profile.exported')} ${result.data.path}`);
}

defineExpose({ focusFilter });
</script>

<template>
  <aside class="connections-pane" :class="`mode-${activeMode}`" aria-label="Connections">
    <div class="pane-title-row">
      <strong>{{ activeMode === 'snippets' ? t('nav.snippets') : activeMode === 'recent' ? t('nav.recent') : activeMode === 'tunnels' ? t('nav.tunnels') : showFavoritesOnly ? t('nav.favorites') : t('nav.connections') }}</strong>
      <span v-if="activeMode === 'connections'" class="pane-title-actions">
        <button type="button" class="icon-button" :aria-label="t(showFavoritesOnly ? 'profile.showAllProfiles' : 'profile.filterFavorites')" :aria-pressed="showFavoritesOnly" :title="t(showFavoritesOnly ? 'profile.showAllProfiles' : 'profile.filterFavorites')" @click="showFavoritesOnly = !showFavoritesOnly">
          <Star :size="14" :class="showFavoritesOnly ? 'favorite' : 'row-muted'" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('profile.exportProfiles')" :title="t('profile.exportProfiles')" :disabled="connections.profiles.length === 0 || connections.exporting" @click="exportAllProfiles">
          <Download :size="14" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('profile.importSshConfig')" :title="t('profile.importSshConfig')" @click="ui.openSshImport">
          <FileInput :size="14" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('app.addConnection')" :title="t('app.addConnection')" @click="ui.openAddProfile">
          <Plus :size="14" />
        </button>
      </span>
    </div>
    <label v-if="activeMode === 'connections'" class="pane-search">
      <Search :size="12" />
      <span class="sr-only">{{ t('nav.filter') }}</span>
      <input ref="filterInput" v-model="connections.query" type="search" :placeholder="t('nav.filter')">
    </label>

    <div class="nav-mode" role="tablist" aria-label="Navigation mode">
      <button type="button" :aria-selected="activeMode === 'connections'" @click="activeMode = 'connections'">{{ t('nav.connections') }}</button>
      <button type="button" :aria-selected="activeMode === 'recent'" @click="activeMode = 'recent'">{{ t('nav.recent') }}</button>
      <button type="button" :aria-selected="activeMode === 'tunnels'" @click="activeMode = 'tunnels'">{{ t('nav.tunnels') }}</button>
      <button type="button" :aria-selected="activeMode === 'snippets'" @click="activeMode = 'snippets'">{{ t('nav.snippets') }}</button>
    </div>

    <SnippetPane v-if="activeMode === 'snippets'" />
    <div v-else-if="activeMode === 'connections'" class="connection-tree">
      <div v-if="connections.loading" class="pane-state">
        <LoaderCircle :size="16" class="spin" />
      </div>
      <div v-else-if="connections.error" class="pane-state error">
        <CircleAlert :size="16" />
        <span>{{ t(connections.error.messageKey as Parameters<typeof t>[0]) }}</span>
      </div>
      <div v-else-if="displayedProfiles.length === 0" class="pane-state">
        {{ emptyProfileMessage }}
      </div>
      <template v-else>
        <section v-for="[group, profiles] in displayedGroups" :key="group" class="connection-group">
          <h2>
            <ChevronDown :size="12" />
            <span>{{ group }}</span>
            <small>{{ profiles.length }}</small>
          </h2>
          <div
            v-for="profile in profiles"
            :key="profile.id"
            class="connection-row-shell"
            :class="{ selected: profile.id === connections.activeProfileId }"
          >
            <button
              type="button"
              class="connection-row"
              :class="{ selected: profile.id === connections.activeProfileId }"
              :aria-pressed="profile.id === connections.activeProfileId"
              @click="connections.select(profile.id)"
              @dblclick.prevent="openProfile(profile)"
              @keydown.enter.prevent="openProfile(profile)"
            >
              <span class="state-dot" :class="profile.state" :title="stateLabel(profile)" />
              <span class="connection-copy">
                <strong :title="profile.name">{{ profile.name }}</strong>
                <small class="mono" :title="`${profile.username}@${profile.host}`">{{ profile.username }}@{{ profile.host }}</small>
              </span>
            </button>
            <button
              type="button"
              class="connection-favorite-toggle"
              :aria-pressed="profile.favorite"
              :aria-label="t(profile.favorite ? 'profile.removeFavorite' : 'profile.addFavorite', { name: profile.name })"
              :title="t(profile.favorite ? 'profile.removeFavorite' : 'profile.addFavorite', { name: profile.name })"
              :disabled="connections.saving"
              @click.stop="connections.toggleFavorite(profile.id)"
            >
              <Star :size="13" :class="profile.favorite ? 'favorite' : 'row-muted'" />
            </button>
          </div>
        </section>
      </template>
    </div>
    <div v-else-if="activeMode === 'recent'" class="recent-list">
      <p v-if="connections.recentProfiles.length === 0" class="pane-state">{{ t('nav.recentEmpty') }}</p>
      <button v-for="profile in connections.recentProfiles" :key="profile.id" type="button" class="recent-row" :disabled="sessions.busy" @click="openProfile(profile)">
        <span class="state-dot" :class="profile.state" />
        <span class="recent-copy"><strong :title="profile.name">{{ profile.name }}</strong><small class="mono" :title="`${profile.username}@${profile.host}`">{{ profile.username }}@{{ profile.host }}</small><small>{{ t('nav.recentUsed', { time: recentDate(profile.lastUsedAt) }) }}</small></span>
        <Server :size="11" class="row-muted" />
      </button>
    </div>
    <TunnelsPane v-else-if="activeMode === 'tunnels'" />
  </aside>
</template>

<style scoped>
.connections-pane.mode-recent,
.connections-pane.mode-tunnels,
.connections-pane.mode-snippets { grid-template-rows: 32px 30px minmax(0, 1fr); }
.recent-list { min-height: 0; overflow: auto; padding: 5px 0; }
.recent-row { display: grid; grid-template-columns: 9px minmax(0, 1fr) 14px; align-items: center; gap: 7px; width: calc(100% - 8px); min-height: 48px; margin: 2px 4px; padding: 6px 7px; color: inherit; text-align: left; border: 0; border-radius: 3px; background: transparent; cursor: pointer; }
.recent-row:hover, .recent-row:focus-visible { background: hsl(var(--accent)); }
.recent-row:disabled { opacity: .6; cursor: wait; }
.recent-copy { display: grid; min-width: 0; gap: 2px; }
.recent-copy strong, .recent-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent-copy small { color: hsl(var(--muted-foreground)); font-size: 0.75rem; }
</style>
