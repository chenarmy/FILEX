<script setup lang="ts">
import { ChevronDown, CircleAlert, LoaderCircle, Plus, Search, Server, Star } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';
import type { ConnectionProfile } from '@/types/contracts';

const connections = useConnectionsStore();
const ui = useUiStore();

function stateLabel(profile: ConnectionProfile): string {
  switch (profile.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting';
    case 'degraded': return 'Degraded';
    case 'failed': return 'Failed';
    default: return 'Idle';
  }
}
</script>

<template>
  <aside class="connections-pane" aria-label="Connections">
    <div class="pane-title-row">
      <strong>{{ t('nav.connections') }}</strong>
      <button type="button" class="icon-button" :aria-label="t('app.addConnection')" :title="t('app.addConnection')" @click="ui.openAddProfile">
        <Plus :size="14" />
      </button>
    </div>
    <label class="pane-search">
      <Search :size="12" />
      <span class="sr-only">{{ t('nav.filter') }}</span>
      <input v-model="connections.query" type="search" :placeholder="t('nav.filter')">
    </label>

    <div class="nav-mode" role="tablist" aria-label="Navigation mode">
      <button type="button" aria-selected="true">{{ t('nav.connections') }}</button>
      <button type="button" aria-selected="false">{{ t('nav.recent') }}</button>
      <button type="button" aria-selected="false">{{ t('nav.tunnels') }}</button>
      <button type="button" aria-selected="false">{{ t('nav.snippets') }}</button>
    </div>

    <div class="connection-tree">
      <div v-if="connections.loading" class="pane-state">
        <LoaderCircle :size="16" class="spin" />
      </div>
      <div v-else-if="connections.error" class="pane-state error">
        <CircleAlert :size="16" />
        <span>{{ t(connections.error.messageKey as Parameters<typeof t>[0]) }}</span>
      </div>
      <div v-else-if="connections.filteredProfiles.length === 0" class="pane-state">
        {{ t('nav.empty') }}
      </div>
      <template v-else>
        <section v-for="[group, profiles] in connections.groupedProfiles" :key="group" class="connection-group">
          <h2>
            <ChevronDown :size="12" />
            <span>{{ group }}</span>
            <small>{{ profiles.length }}</small>
          </h2>
          <button
            v-for="profile in profiles"
            :key="profile.id"
            type="button"
            class="connection-row"
            :class="{ selected: profile.id === connections.activeProfileId }"
            :aria-pressed="profile.id === connections.activeProfileId"
            @click="connections.select(profile.id)"
          >
            <span class="state-dot" :class="profile.state" :title="stateLabel(profile)" />
            <span class="connection-copy">
              <strong>{{ profile.name }}</strong>
              <small class="mono">{{ profile.username }}@{{ profile.host }}</small>
            </span>
            <Star v-if="profile.favorite" :size="11" class="favorite" aria-label="Favorite" />
            <Server v-else :size="11" class="row-muted" aria-hidden="true" />
          </button>
        </section>
      </template>
    </div>
  </aside>
</template>
