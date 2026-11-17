<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDown, CircleAlert, Download, FileInput, FolderPlus, LoaderCircle, Plus, Search, Server, Star } from 'lucide-vue-next';
import { t } from '@/i18n';
import { DEFAULT_CONNECTION_GROUP, useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { ConnectionProfile } from '@/types/contracts';
import { filterProfiles } from '@/domain/connections';
import ConnectionContextMenu, { type ConnectionContextAction, type ConnectionContextTarget } from '@/components/connections/ConnectionContextMenu.vue';
import SnippetPane from '@/components/connections/SnippetPane.vue';
import TunnelsPane from '@/components/connections/TunnelsPane.vue';
import GroupNameDialog from '@/components/dialogs/GroupNameDialog.vue';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const ui = useUiStore();
const activeMode = ref<'connections' | 'recent' | 'tunnels' | 'snippets'>('connections');
const filterInput = ref<HTMLInputElement | null>(null);
const showFavoritesOnly = ref(false);
const COLLAPSED_GROUPS_KEY = 'filex.collapsedGroups.v1';

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persistCollapsedGroups(groups: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // Ignore storage failures.
  }
}

const collapsedGroups = ref<Set<string>>(loadCollapsedGroups());
const contextMenu = ref<{ target: ConnectionContextTarget; position: { x: number; y: number } } | null>(null);
const groupDialog = ref<{
  mode: 'create' | 'rename' | 'createAndMove';
  sourceGroup?: string;
  moveProfile?: ConnectionProfile;
  errorMessage?: string;
} | null>(null);

const displayedProfiles = computed(() => showFavoritesOnly.value ? connections.filteredFavoriteProfiles : connections.filteredProfiles);
const displayedGroups = computed(() => {
  const base = showFavoritesOnly.value ? connections.favoriteGroupedProfiles : connections.groupedProfiles;
  if (showFavoritesOnly.value || connections.query.trim().length > 0) return base;
  const merged = new Map<string, ConnectionProfile[]>(base);
  for (const groupName of connections.customGroups) {
    if (!merged.has(groupName)) merged.set(groupName, []);
  }
  return merged;
});
const quickConnectionProfiles = computed<ConnectionProfile[]>(() => {
  if (showFavoritesOnly.value) return [];
  return filterProfiles(
    Object.values(sessions.quickProfiles)
      .flatMap((profile) => {
        const session = [...sessions.summaries]
          .reverse()
          .find((candidate) => candidate.profileId === profile.id && candidate.state !== 'closed');
        if (!session) return [];
        return [{
          ...profile,
          state: session.state === 'connected'
            ? 'connected' as const
            : session.state === 'failed'
              ? 'failed' as const
              : session.state === 'disconnected'
                ? 'degraded' as const
                : 'connecting' as const,
        }];
      }),
    connections.query,
  );
});
const hasDisplayedProfiles = computed(() => displayedProfiles.value.length > 0
  || quickConnectionProfiles.value.length > 0
  || (!showFavoritesOnly.value && !connections.query.trim() && connections.customGroups.length > 0));
const recentEntries = computed(() => {
  const timestamp = (value: string | null): number => {
    if (!value) return 0;
    return /^\d+$/.test(value) ? Number(value) : Date.parse(value) || 0;
  };
  return [...connections.recentProfiles, ...Object.values(sessions.quickProfiles)]
    .filter((profile) => Boolean(profile.lastUsedAt))
    .sort((left, right) => timestamp(right.lastUsedAt) - timestamp(left.lastUsedAt))
    .slice(0, 20);
});
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
  const currentActive = sessions.activeSession;
  const existing = currentActive?.profileId === profile.id && currentActive.state !== 'closed'
    ? currentActive
    : [...sessions.summaries].reverse().find((session) => session.profileId === profile.id && session.state !== 'closed');
  if (existing) {
    sessions.selectSession(existing.id);
    if (existing.state === 'disconnected' || existing.state === 'failed') await sessions.reconnectActive();
    return;
  }
  await sessions.begin(profile);
}

function selectConnectionsEntry(profile: ConnectionProfile): void {
  connections.select(profile.id);
  if (!sessions.isQuickProfile(profile.id)) return;
  const session = [...sessions.summaries]
    .reverse()
    .find((candidate) => candidate.profileId === profile.id && candidate.state !== 'closed');
  if (session) sessions.selectSession(session.id);
}

watch(
  () => sessions.activeSession?.profileId,
  (profileId) => {
    if (profileId) connections.select(profileId);
  },
  { immediate: true },
);

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

function isGroupCollapsed(group: string): boolean {
  return !connections.query.trim() && collapsedGroups.value.has(group);
}

function toggleGroupCollapsed(group: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  collapsedGroups.value = next;
  persistCollapsedGroups(next);
}

function expandAllGroups(): void {
  collapsedGroups.value = new Set();
  persistCollapsedGroups(collapsedGroups.value);
}

function collapseAllGroups(): void {
  collapsedGroups.value = new Set(displayedGroups.value.keys());
  persistCollapsedGroups(collapsedGroups.value);
}

function openContextMenu(event: MouseEvent, target: ConnectionContextTarget): void {
  if (target.kind === 'profile') connections.select(target.profile.id);
  else if (target.kind === 'quickProfile') selectConnectionsEntry(target.profile);
  contextMenu.value = {
    target,
    position: { x: event.clientX, y: event.clientY },
  };
}

function openCreateGroupDialog(): void {
  groupDialog.value = { mode: 'create' };
}

function groupValidationMessage(reason: 'empty' | 'reserved' | 'duplicate' | 'failed' | undefined, name: string): string {
  if (reason === 'reserved') return t('nav.groupErrorReserved');
  if (reason === 'duplicate') return t('nav.groupErrorDuplicate', { name });
  if (reason === 'failed') return t(connections.error?.messageKey as Parameters<typeof t>[0] ?? 'errors.unknown');
  return t('nav.groupErrorEmpty');
}

async function submitGroupDialog(rawName: string): Promise<void> {
  const dialog = groupDialog.value;
  if (!dialog) return;
  const trimmed = rawName.trim();
  if (dialog.mode === 'create') {
    const result = connections.createGroup(trimmed);
    if (!result.ok) {
      dialog.errorMessage = groupValidationMessage(result.reason, trimmed);
      return;
    }
    groupDialog.value = null;
    ui.notify(t('nav.groupCreated', { name: trimmed }));
    return;
  }
  if (dialog.mode === 'createAndMove' && dialog.moveProfile) {
    const result = connections.createGroup(trimmed);
    if (!result.ok) {
      dialog.errorMessage = groupValidationMessage(result.reason, trimmed);
      return;
    }
    const targetProfile = dialog.moveProfile;
    groupDialog.value = null;
    if (await connections.moveToGroup(targetProfile.id, trimmed)) {
      ui.notify(t('nav.groupMoved', { name: targetProfile.name, group: trimmed }));
    }
    return;
  }
  if (dialog.mode === 'rename' && dialog.sourceGroup) {
    const result = await connections.renameGroup(dialog.sourceGroup, trimmed);
    if (!result.ok) {
      dialog.errorMessage = groupValidationMessage(result.reason, trimmed);
      return;
    }
    if (collapsedGroups.value.has(dialog.sourceGroup)) {
      const next = new Set(collapsedGroups.value);
      next.delete(dialog.sourceGroup);
      next.add(trimmed);
      collapsedGroups.value = next;
      persistCollapsedGroups(next);
    }
    groupDialog.value = null;
    ui.notify(t('nav.groupRenamed', { name: trimmed }));
  }
}

async function handleContextAction(action: ConnectionContextAction): Promise<void> {
  switch (action.type) {
    case 'open':
      await openProfile(action.profile);
      break;
    case 'newProfile':
      ui.openAddProfile(action.group);
      break;
    case 'edit':
      connections.select(action.profile.id);
      ui.openEditProfile(action.profile.id);
      break;
    case 'duplicate':
      if (await connections.duplicate(action.profile.id)) ui.notify(t('profile.duplicated'));
      else if (connections.error) ui.notify(t(connections.error.messageKey as Parameters<typeof t>[0]));
      break;
    case 'toggleFavorite':
      await connections.toggleFavorite(action.profile.id);
      break;
    case 'moveToGroup':
      if (await connections.moveToGroup(action.profile.id, action.group)) {
        ui.notify(t('nav.groupMoved', { name: action.profile.name, group: action.group }));
      } else if (connections.error) {
        ui.notify(t(connections.error.messageKey as Parameters<typeof t>[0]));
      }
      break;
    case 'newGroupAndMove':
      groupDialog.value = { mode: 'createAndMove', moveProfile: action.profile };
      break;
    case 'deleteProfile': {
      const accepted = await ui.confirm({
        title: t('nav.contextDelete'),
        message: t('nav.contextDeleteConfirm', { name: action.profile.name }),
        confirmLabel: t('profile.delete'),
        danger: true,
      });
      if (!accepted) return;
      if (await connections.remove(action.profile.id)) ui.notify(t('profile.deleted'));
      else if (connections.error) ui.notify(t(connections.error.messageKey as Parameters<typeof t>[0]));
      break;
    }
    case 'createGroup':
      openCreateGroupDialog();
      break;
    case 'renameGroup':
      if (action.group !== DEFAULT_CONNECTION_GROUP) {
        groupDialog.value = { mode: 'rename', sourceGroup: action.group };
      }
      break;
    case 'deleteGroup': {
      if (action.group === DEFAULT_CONNECTION_GROUP) return;
      const accepted = await ui.confirm({
        title: t('nav.groupDeleteTitle'),
        message: action.count > 0
          ? t('nav.groupDeleteConfirm', { name: action.group, count: action.count })
          : t('nav.groupDeleteEmptyConfirm', { name: action.group }),
        confirmLabel: t('nav.groupDelete'),
        danger: true,
      });
      if (!accepted) return;
      if (await connections.deleteGroup(action.group)) {
        const next = new Set(collapsedGroups.value);
        next.delete(action.group);
        collapsedGroups.value = next;
        persistCollapsedGroups(next);
        ui.notify(t('nav.groupDeleted', { name: action.group }));
      } else if (connections.error) {
        ui.notify(t(connections.error.messageKey as Parameters<typeof t>[0]));
      }
      break;
    }
    case 'toggleCollapse':
      toggleGroupCollapsed(action.group);
      break;
    case 'expandAll':
      expandAllGroups();
      break;
    case 'collapseAll':
      collapseAllGroups();
      break;
  }
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
        <button type="button" class="icon-button" :aria-label="t('nav.groupNew')" :title="t('nav.groupNew')" @click="openCreateGroupDialog">
          <FolderPlus :size="14" />
        </button>
        <button type="button" class="icon-button" :aria-label="t('app.addConnection')" :title="t('app.addConnection')" @click="ui.openAddProfile()">
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
    <div
      v-else-if="activeMode === 'connections'"
      class="connection-tree"
      @contextmenu.self.prevent="openContextMenu($event, { kind: 'empty' })"
    >
      <div v-if="connections.loading" class="pane-state">
        <LoaderCircle :size="16" class="spin" />
      </div>
      <div v-else-if="connections.error" class="pane-state error">
        <CircleAlert :size="16" />
        <span>{{ t(connections.error.messageKey as Parameters<typeof t>[0]) }}</span>
      </div>
      <div v-else-if="!hasDisplayedProfiles" class="pane-state" @contextmenu.prevent="openContextMenu($event, { kind: 'empty' })">
        {{ emptyProfileMessage }}
      </div>
      <template v-else>
        <section v-if="quickConnectionProfiles.length" class="connection-group">
          <h2>
            <ChevronDown :size="12" />
            <span>{{ t('nav.quickConnections') }}</span>
            <small>{{ quickConnectionProfiles.length }}</small>
          </h2>
          <div
            v-for="profile in quickConnectionProfiles"
            :key="profile.id"
            class="connection-row-shell"
            :class="{ selected: profile.id === connections.activeProfileId }"
            @contextmenu.prevent.stop="openContextMenu($event, { kind: 'quickProfile', profile })"
          >
            <button
              type="button"
              class="connection-row"
              :class="{ selected: profile.id === connections.activeProfileId }"
              :aria-pressed="profile.id === connections.activeProfileId"
              @click="selectConnectionsEntry(profile)"
              @dblclick.prevent="openProfile(profile)"
              @keydown.enter.prevent="openProfile(profile)"
            >
              <span class="state-dot" :class="profile.state" :title="stateLabel(profile)" />
              <span class="connection-copy">
                <strong :title="profile.name">{{ profile.name }}</strong>
                <small class="mono" :title="`${profile.username}@${profile.host}`">{{ profile.username }}@{{ profile.host }}</small>
              </span>
            </button>
            <Server :size="11" class="row-muted connection-quick-icon" />
          </div>
        </section>
        <section v-for="[group, profiles] in displayedGroups" :key="group" class="connection-group">
          <h2 @contextmenu.prevent.stop="openContextMenu($event, { kind: 'group', group, count: profiles.length, collapsed: isGroupCollapsed(group) })">
            <button
              type="button"
              class="connection-group-toggle"
              :aria-expanded="!isGroupCollapsed(group)"
              @click="toggleGroupCollapsed(group)"
            >
              <ChevronDown :size="12" class="connection-group-chevron" :class="{ collapsed: isGroupCollapsed(group) }" />
              <span class="connection-group-name">{{ group }}</span>
              <small>{{ profiles.length }}</small>
            </button>
          </h2>
          <template v-if="!isGroupCollapsed(group)">
            <div
              v-for="profile in profiles"
              :key="profile.id"
              class="connection-row-shell"
              :class="{ selected: profile.id === connections.activeProfileId }"
              @contextmenu.prevent.stop="openContextMenu($event, { kind: 'profile', profile })"
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
          </template>
        </section>
      </template>
    </div>
    <div v-else-if="activeMode === 'recent'" class="recent-list">
      <p v-if="recentEntries.length === 0" class="pane-state">{{ t('nav.recentEmpty') }}</p>
      <button v-for="profile in recentEntries" :key="profile.id" type="button" class="recent-row" :disabled="sessions.busy" @click="openProfile(profile)">
        <span class="state-dot" :class="profile.state" />
        <span class="recent-copy"><strong :title="profile.name">{{ profile.name }}</strong><small class="mono" :title="`${profile.username}@${profile.host}`">{{ profile.username }}@{{ profile.host }}</small><small>{{ t('nav.recentUsed', { time: recentDate(profile.lastUsedAt) }) }}</small></span>
        <Server :size="11" class="row-muted" />
      </button>
    </div>
    <TunnelsPane v-else-if="activeMode === 'tunnels'" />

    <ConnectionContextMenu
      v-if="contextMenu"
      :target="contextMenu.target"
      :position="contextMenu.position"
      :groups="connections.allGroupNames"
      :busy="connections.saving || sessions.busy"
      @close="contextMenu = null"
      @action="handleContextAction"
    />

    <GroupNameDialog
      v-if="groupDialog"
      :title="groupDialog.mode === 'rename'
        ? t('nav.groupRename')
        : groupDialog.mode === 'createAndMove'
          ? t('nav.groupNewAndMoveTitle')
          : t('nav.groupNew')"
      :confirm-label="groupDialog.mode === 'rename'
        ? t('nav.groupRenameAction')
        : groupDialog.mode === 'createAndMove'
          ? t('nav.groupMoveAction')
          : t('nav.groupCreateAction')"
      :initial-value="groupDialog.sourceGroup ?? ''"
      :error-message="groupDialog.errorMessage"
      :busy="connections.saving"
      @close="groupDialog = null"
      @submit="submitGroupDialog"
    />
  </aside>
</template>

<style scoped>
.connections-pane.mode-recent,
.connections-pane.mode-tunnels,
.connections-pane.mode-snippets {
  grid-template-rows: 32px 30px minmax(0, 1fr);
}
.recent-list {
  min-height: 0;
  overflow: auto;
  padding: 6px 4px;
}
.recent-row {
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 46px;
  margin: 2px 0;
  padding: 6px 8px;
  color: inherit;
  text-align: start;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  cursor: pointer;
  transition: background var(--duration-micro) var(--ease-arco);
}
.recent-row:hover,
.recent-row:focus-visible {
  background: hsl(var(--fill-subtle));
}
.recent-row:disabled {
  opacity: .55;
  cursor: wait;
}
.recent-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.recent-copy strong,
.recent-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-copy strong {
  font-size: 0.8571rem;
  font-weight: 600;
}
.recent-copy small {
  color: hsl(var(--muted-foreground));
  font-size: 0.75rem;
}
.connection-quick-icon {
  justify-self: center;
  color: hsl(var(--muted-foreground));
}
.connection-group-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 0;
  color: inherit;
  font: inherit;
  text-align: start;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.connection-group-toggle:hover,
.connection-group-toggle:focus-visible {
  color: hsl(var(--foreground));
}
.connection-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-group-chevron {
  flex: 0 0 auto;
  transition: transform var(--duration-micro) var(--ease-arco);
}
.connection-group-chevron.collapsed {
  transform: rotate(-90deg);
}
</style>
