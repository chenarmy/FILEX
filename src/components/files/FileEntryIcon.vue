<script setup lang="ts">
import { computed, type Component } from 'vue';
import {
  Database,
  File,
  FileArchive,
  FileAudio2,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideo2,
  Folder,
  FolderOpen,
  Link2,
} from 'lucide-vue-next';
import { fileVisualKind } from '@/domain/fileVisualKind';

const props = withDefaults(defineProps<{
  name: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  expanded?: boolean;
  size?: number;
}>(), {
  isSymlink: false,
  expanded: false,
  size: 14,
});

const kind = computed(() => fileVisualKind(props.name, props.isDirectory, props.isSymlink));
const icon = computed<Component>(() => {
  switch (kind.value) {
    case 'folder': return props.expanded ? FolderOpen : Folder;
    case 'symlink': return Link2;
    case 'code': return FileCode2;
    case 'data': return FileJson2;
    case 'config': return FileCog;
    case 'archive': return FileArchive;
    case 'image': return FileImage;
    case 'audio': return FileAudio2;
    case 'video': return FileVideo2;
    case 'document': return FileText;
    case 'spreadsheet': return FileSpreadsheet;
    case 'database': return Database;
    case 'key': return FileKey2;
    case 'executable': return FileTerminal;
    default: return File;
  }
});
</script>

<template>
  <component
    :is="icon"
    class="file-entry-icon"
    :class="`file-entry-icon--${kind}`"
    :size="size"
    :stroke-width="1.8"
    aria-hidden="true"
  />
</template>
