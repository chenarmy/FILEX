<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Check,
  ChevronRight,
  Clipboard,
  Download,
  Edit3,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  MoveUpRight,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import type {
  LocalFileEntry,
  RemoteFileEntry,
  TextEditorPreference,
} from '@/types/contracts';

type EditorSubmenu = 'openWith' | 'editor' | 'new';
type FileContextMenuAction =
  | 'refresh'
  | 'open'
  | 'openTextEditor'
  | 'openSystem'
  | 'selectInternal'
  | 'selectExternal'
  | 'configureExternal'
  | 'copyPath'
  | 'download'
  | 'uploadFiles'
  | 'uploadFolders'
  | 'createFile'
  | 'createFolder'
  | 'rename'
  | 'delete'
  | 'quickDelete'
  | 'permissions';

const props = defineProps<{
  entry: LocalFileEntry | RemoteFileEntry | null;
  pane: 'local' | 'remote';
  position: { x: number; y: number };
  editorPreference: TextEditorPreference;
  remoteReady: boolean;
  quickSession: boolean;
  canEdit: boolean;
  canDownload: boolean;
  canPermissions: boolean;
  canQuickDelete: boolean;
  canCreate: boolean;
  canUpload: boolean;
  canRename: boolean;
  canDelete: boolean;
}>();

const emit = defineEmits<{
  close: [];
  action: [action: FileContextMenuAction];
}>();

const menu = ref<HTMLElement | null>(null);
const position = ref({ x: props.position.x, y: props.position.y });
const submenu = ref<EditorSubmenu | null>(null);
const submenuOnLeft = ref(false);
const submenuTop = ref(22);
let submenuOpener: HTMLElement | null = null;

const isDirectory = () => props.entry?.isDirectory === true;
const isFile = () => Boolean(props.entry && !props.entry.isDirectory && !props.entry.isSymlink);

function clampPosition(): void {
  const element = menu.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  position.value = {
    x: Math.max(6, Math.min(props.position.x, window.innerWidth - rect.width - 6)),
    y: Math.max(6, Math.min(props.position.y, window.innerHeight - rect.height - 6)),
  };
}

function closeSubmenu(): void {
  submenu.value = null;
}

function openSubmenu(name: EditorSubmenu, opener: EventTarget | null, focusFirst = true): void {
  submenu.value = name;
  submenuOpener = opener instanceof HTMLElement ? opener : null;
  const rect = menu.value?.getBoundingClientRect();
  submenuOnLeft.value = Boolean(rect && rect.right + 214 > window.innerWidth);
  submenuTop.value = opener instanceof HTMLElement ? opener.offsetTop : 22;
  if (!focusFirst) return;
  void nextTick(() => {
    const items = menu.value?.querySelectorAll<HTMLElement>(
      `.file-context-submenu[data-submenu="${name}"] `
      + '[role="menuitem"]:not(:disabled), '
      + `.file-context-submenu[data-submenu="${name}"] [role="menuitemradio"]:not(:disabled)`,
    );
    items?.[0]?.focus();
  });
}

function run(action: FileContextMenuAction): void {
  emit('action', action);
  emit('close');
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!menu.value?.contains(event.target as Node)) emit('close');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (submenu.value) {
      closeSubmenu();
      submenuOpener?.focus();
    } else {
      emit('close');
    }
    return;
  }
  if (event.key === 'ArrowLeft' && submenu.value) {
    event.preventDefault();
    closeSubmenu();
    submenuOpener?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const scope = (event.target as HTMLElement).closest('.file-context-submenu')
    ?? menu.value;
    const items = [...(scope?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    ) ?? [])];
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const target = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : event.key === 'ArrowDown'
        ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  items[target]?.focus();
}

onMounted(() => {
  void nextTick(() => {
    clampPosition();
    menu.value?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
    )?.focus();
  });
  window.addEventListener('pointerdown', handleDocumentPointerDown, true);
  window.addEventListener('resize', clampPosition);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  window.removeEventListener('resize', clampPosition);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="file-context-menu"
      role="menu"
      :aria-label="t('fileMenu.label')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @contextmenu.prevent
      @keydown="handleKeydown"
      @pointerdown.stop
    >
      <button type="button" role="menuitem" @click="run('refresh')">
        <RefreshCw :size="13" />{{ t('fileMenu.refresh') }}
      </button>
      <button type="button" role="menuitem" :disabled="!entry || !canEdit" @click="run('open')">
        <FolderOpen :size="13" />{{ t('fileMenu.open') }}
      </button>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="submenu === 'openWith'"
        :disabled="!isFile()"
        @mouseenter="isFile() && openSubmenu('openWith', $event.currentTarget, false)"
        @click="openSubmenu('openWith', $event.currentTarget)"
        @keydown.right.prevent="openSubmenu('openWith', $event.currentTarget)"
      >
        <ExternalLink :size="13" />{{ t('fileMenu.openWith') }}<ChevronRight :size="12" />
      </button>
      <div v-if="submenu === 'openWith'" class="file-context-submenu" :class="{ left: submenuOnLeft }" :style="{ top: `${submenuTop}px` }" data-submenu="openWith" role="menu">
        <button type="button" role="menuitem" @click="run('openTextEditor')">
          <FileCode2 :size="13" />{{ t('fileMenu.textEditor') }}
        </button>
        <button type="button" role="menuitem" @click="run('openSystem')">
          <Sparkles :size="13" />{{ t('fileMenu.systemAssociation') }}
        </button>
      </div>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="submenu === 'editor'"
        :disabled="!isFile()"
        @mouseenter="isFile() && openSubmenu('editor', $event.currentTarget, false)"
        @click="openSubmenu('editor', $event.currentTarget)"
        @keydown.right.prevent="openSubmenu('editor', $event.currentTarget)"
      >
        <Edit3 :size="13" />{{ t('fileMenu.chooseEditor') }}<ChevronRight :size="12" />
      </button>
      <div v-if="submenu === 'editor'" class="file-context-submenu" :class="{ left: submenuOnLeft }" :style="{ top: `${submenuTop}px` }" data-submenu="editor" role="menu">
        <button type="button" role="menuitemradio" :aria-checked="editorPreference === 'internal'" @click="run('selectInternal')">
          <FileCode2 :size="13" /><span>{{ t('fileMenu.internalEditor') }}</span>
          <Check v-if="editorPreference === 'internal'" class="menu-check-icon" :size="12" />
        </button>
        <button type="button" role="menuitemradio" :aria-checked="editorPreference === 'external'" @click="run('selectExternal')">
          <ExternalLink :size="13" /><span>{{ t('fileMenu.externalEditor') }}</span>
          <Check v-if="editorPreference === 'external'" class="menu-check-icon" :size="12" />
        </button>
        <div class="file-context-separator" />
        <button type="button" role="menuitem" @click="run('configureExternal')">
          <Edit3 :size="13" /><span>{{ t('fileMenu.configureExternal') }}</span>
        </button>
      </div>
      <button type="button" role="menuitem" :disabled="!entry" @click="run('copyPath')">
        <Clipboard :size="13" />{{ t('fileMenu.copyPath') }}
      </button>

      <div class="file-context-separator" />
      <button type="button" role="menuitem" :disabled="!canDownload" @click="run('download')">
        <Download :size="13" />{{ t('fileMenu.download') }}
      </button>
      <button type="button" role="menuitem" :disabled="!canUpload" @click="run('uploadFiles')">
        <Upload :size="13" />{{ t('fileMenu.uploadFiles') }}
      </button>
      <button type="button" role="menuitem" :disabled="!canUpload" @click="run('uploadFolders')">
        <MoveUpRight :size="13" />{{ t('fileMenu.uploadFolders') }}
      </button>

      <div class="file-context-separator" />
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="submenu === 'new'"
        :disabled="!canCreate"
        @mouseenter="canCreate && openSubmenu('new', $event.currentTarget, false)"
        @click="openSubmenu('new', $event.currentTarget)"
        @keydown.right.prevent="openSubmenu('new', $event.currentTarget)"
      >
        <FolderPlus :size="13" />{{ t('fileMenu.new') }}<ChevronRight :size="12" />
      </button>
      <div v-if="submenu === 'new'" class="file-context-submenu" :class="{ left: submenuOnLeft }" :style="{ top: `${submenuTop}px` }" data-submenu="new" role="menu">
        <button type="button" role="menuitem" @click="run('createFolder')">
          <FolderPlus :size="13" />{{ t('fileMenu.newFolder') }}
        </button>
        <button type="button" role="menuitem" @click="run('createFile')">
          <FilePlus2 :size="13" />{{ t('fileMenu.newFile') }}
        </button>
      </div>
      <button type="button" role="menuitem" :disabled="!canRename" @click="run('rename')">
        <Edit3 :size="13" />{{ t('fileMenu.rename') }}
      </button>
      <button type="button" role="menuitem" class="danger" :disabled="!canDelete" @click="run('delete')">
        <Trash2 :size="13" />{{ t('fileMenu.delete') }}
      </button>
      <button type="button" role="menuitem" class="danger" :disabled="!canQuickDelete" @click="run('quickDelete')">
        <Trash2 :size="13" />{{ t('fileMenu.quickDelete') }}
      </button>
      <div class="file-context-separator" />
      <button type="button" role="menuitem" :disabled="!canPermissions" @click="run('permissions')">
        <ShieldCheck :size="13" />{{ t('fileMenu.permissions') }}
      </button>
      <div v-if="isDirectory()" class="file-context-note">{{ t('fileMenu.folderActions') }}</div>
    </div>
  </Teleport>
</template>
