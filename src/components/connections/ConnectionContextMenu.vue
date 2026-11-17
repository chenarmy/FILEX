<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FolderInput,
  FolderPlus,
  Play,
  Plus,
  Star,
  Trash2,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { DEFAULT_CONNECTION_GROUP } from '@/stores/connections';
import type { ConnectionProfile } from '@/types/contracts';

export type ConnectionContextTarget =
  | { kind: 'profile'; profile: ConnectionProfile }
  | { kind: 'quickProfile'; profile: ConnectionProfile }
  | { kind: 'group'; group: string; count: number; collapsed: boolean }
  | { kind: 'empty' };

export type ConnectionContextAction =
  | { type: 'open'; profile: ConnectionProfile }
  | { type: 'newProfile'; group?: string }
  | { type: 'edit'; profile: ConnectionProfile }
  | { type: 'duplicate'; profile: ConnectionProfile }
  | { type: 'toggleFavorite'; profile: ConnectionProfile }
  | { type: 'moveToGroup'; profile: ConnectionProfile; group: string }
  | { type: 'newGroupAndMove'; profile: ConnectionProfile }
  | { type: 'deleteProfile'; profile: ConnectionProfile }
  | { type: 'createGroup' }
  | { type: 'renameGroup'; group: string }
  | { type: 'deleteGroup'; group: string; count: number }
  | { type: 'toggleCollapse'; group: string }
  | { type: 'expandAll' }
  | { type: 'collapseAll' };

const props = defineProps<{
  target: ConnectionContextTarget;
  position: { x: number; y: number };
  groups: string[];
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: ConnectionContextAction];
}>();

const menu = ref<HTMLElement | null>(null);
const position = ref({ x: props.position.x, y: props.position.y });
const moveSubmenuOpen = ref(false);
const submenuOnLeft = ref(false);
const submenuTop = ref(22);
let submenuOpener: HTMLElement | null = null;

function clampPosition(): void {
  const element = menu.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  position.value = {
    x: Math.max(6, Math.min(props.position.x, window.innerWidth - rect.width - 6)),
    y: Math.max(6, Math.min(props.position.y, window.innerHeight - rect.height - 6)),
  };
}

function openMoveSubmenu(opener: EventTarget | null, focusFirst = true): void {
  moveSubmenuOpen.value = true;
  submenuOpener = opener instanceof HTMLElement ? opener : null;
  const rect = menu.value?.getBoundingClientRect();
  submenuOnLeft.value = Boolean(rect && rect.right + 214 > window.innerWidth);
  submenuTop.value = opener instanceof HTMLElement ? opener.offsetTop : 22;
  if (!focusFirst) return;
  void nextTick(() => {
    const items = menu.value?.querySelectorAll<HTMLElement>(
      '.file-context-submenu [role="menuitem"]:not(:disabled), .file-context-submenu [role="menuitemradio"]:not(:disabled)',
    );
    items?.[0]?.focus();
  });
}

function closeSubmenu(): void {
  moveSubmenuOpen.value = false;
}

function run(action: ConnectionContextAction): void {
  emit('action', action);
  emit('close');
}

function focusItems(container: HTMLElement | null, selector: string): HTMLElement[] {
  if (!container) return [];
  return [...container.querySelectorAll<HTMLElement>(selector)];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (moveSubmenuOpen.value) {
      closeSubmenu();
      submenuOpener?.focus();
    } else {
      emit('close');
    }
    return;
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inSubmenu = Boolean(active?.closest('.file-context-submenu'));
  if (inSubmenu && event.key === 'ArrowLeft') {
    event.preventDefault();
    closeSubmenu();
    submenuOpener?.focus();
    return;
  }
  if (!inSubmenu && event.key === 'ArrowRight' && active?.dataset.submenu === 'moveToGroup') {
    event.preventDefault();
    openMoveSubmenu(active, true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const scope = inSubmenu ? active?.closest<HTMLElement>('.file-context-submenu') ?? null : menu.value;
  const items = focusItems(
    scope,
    inSubmenu
      ? '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
      : ':scope > [role="menuitem"]:not(:disabled)',
  );
  if (items.length === 0) return;
  const currentIndex = active ? items.indexOf(active) : -1;
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowDown'
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex]?.focus();
}

function onPointerDown(event: PointerEvent): void {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return;
  emit('close');
}

function onWindowBlur(): void {
  emit('close');
}

onMounted(() => {
  void nextTick(() => {
    clampPosition();
    const first = menu.value?.querySelector<HTMLElement>(':scope > [role="menuitem"]:not(:disabled)');
    first?.focus();
  });
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', onWindowBlur);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onWindowBlur);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="file-context-menu"
      role="menu"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <template v-if="target.kind === 'profile'">
        <button type="button" role="menuitem" :disabled="busy" @click="run({ type: 'open', profile: target.profile })">
          <Play :size="13" /><span>{{ t('nav.contextOpen') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="busy" @click="run({ type: 'edit', profile: target.profile })">
          <Edit3 :size="13" /><span>{{ t('nav.contextEdit') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="busy" @click="run({ type: 'duplicate', profile: target.profile })">
          <Copy :size="13" /><span>{{ t('nav.contextDuplicate') }}</span>
        </button>
        <button type="button" role="menuitem" :disabled="busy" @click="run({ type: 'toggleFavorite', profile: target.profile })">
          <Star :size="13" :class="target.profile.favorite ? 'favorite' : ''" />
          <span>{{ target.profile.favorite ? t('profile.removeFavorite', { name: target.profile.name }).replace(` (${target.profile.name})`, '') : t('profile.addFavorite', { name: target.profile.name }).replace(` (${target.profile.name})`, '') }}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          data-submenu="moveToGroup"
          aria-haspopup="menu"
          :aria-expanded="moveSubmenuOpen"
          :disabled="busy"
          @mouseenter="openMoveSubmenu($event.currentTarget, false)"
          @click="openMoveSubmenu($event.currentTarget, true)"
        >
          <FolderInput :size="13" /><span>{{ t('nav.contextMoveToGroup') }}</span><ChevronRight :size="12" />
        </button>

        <div class="file-context-separator" role="separator" />
        <button type="button" role="menuitem" class="danger" :disabled="busy" @click="run({ type: 'deleteProfile', profile: target.profile })">
          <Trash2 :size="13" /><span>{{ t('nav.contextDelete') }}</span>
        </button>

        <div
          v-if="moveSubmenuOpen"
          class="file-context-submenu"
          :class="{ left: submenuOnLeft }"
          role="menu"
          :style="{ top: `${submenuTop}px` }"
        >
          <button
            v-for="groupName in groups"
            :key="groupName"
            type="button"
            role="menuitemradio"
            :aria-checked="target.profile.group === groupName"
            @click="run({ type: 'moveToGroup', profile: target.profile, group: groupName })"
          >
            <span class="truncate">{{ groupName }}</span>
            <Check v-if="target.profile.group === groupName" :size="13" class="menu-check-icon" />
          </button>
          <div class="file-context-separator" role="separator" />
          <button type="button" role="menuitem" @click="run({ type: 'newGroupAndMove', profile: target.profile })">
            <FolderPlus :size="13" /><span>{{ t('nav.groupNewAndMove') }}</span>
          </button>
        </div>
      </template>

      <template v-else-if="target.kind === 'quickProfile'">
        <button type="button" role="menuitem" :disabled="busy" @click="run({ type: 'open', profile: target.profile })">
          <Play :size="13" /><span>{{ t('nav.contextOpen') }}</span>
        </button>
      </template>

      <template v-else-if="target.kind === 'group'">
        <button type="button" role="menuitem" @click="run({ type: 'newProfile', group: target.group })">
          <Plus :size="13" /><span>{{ t('nav.contextNewInGroup') }}</span>
        </button>
        <button type="button" role="menuitem" @click="run({ type: 'createGroup' })">
          <FolderPlus :size="13" /><span>{{ t('nav.groupNew') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="busy || target.group === DEFAULT_CONNECTION_GROUP"
          @click="run({ type: 'renameGroup', group: target.group })"
        >
          <Edit3 :size="13" /><span>{{ t('nav.groupRename') }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          :disabled="busy || target.group === DEFAULT_CONNECTION_GROUP"
          @click="run({ type: 'deleteGroup', group: target.group, count: target.count })"
        >
          <Trash2 :size="13" /><span>{{ t('nav.groupDelete') }}</span>
        </button>
        <div class="file-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="run({ type: 'toggleCollapse', group: target.group })">
          <ChevronDown :size="13" /><span>{{ target.collapsed ? t('nav.groupExpand') : t('nav.groupCollapse') }}</span>
        </button>
      </template>

      <template v-else>
        <button type="button" role="menuitem" @click="run({ type: 'newProfile' })">
          <Plus :size="13" /><span>{{ t('app.addConnection') }}</span>
        </button>
        <button type="button" role="menuitem" @click="run({ type: 'createGroup' })">
          <FolderPlus :size="13" /><span>{{ t('nav.groupNew') }}</span>
        </button>
        <div class="file-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="run({ type: 'expandAll' })">
          <ChevronDown :size="13" /><span>{{ t('nav.groupExpandAll') }}</span>
        </button>
        <button type="button" role="menuitem" @click="run({ type: 'collapseAll' })">
          <ChevronRight :size="13" /><span>{{ t('nav.groupCollapseAll') }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
