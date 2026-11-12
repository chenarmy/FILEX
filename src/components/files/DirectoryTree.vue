<script setup lang="ts">
import { computed } from 'vue';
import DirectoryTreeNode from '@/components/files/DirectoryTreeNode.vue';
import { directoryName, type DirectoryTreeEntry } from '@/domain/directoryNavigation';

const props = defineProps<{
  rootPath: string;
  activePath: string;
  label: string;
  childrenByPath: Record<string, DirectoryTreeEntry[]>;
  expandedPaths: string[];
  loadingPaths: string[];
  errorPaths: string[];
}>();

const emit = defineEmits<{
  navigate: [path: string];
  toggle: [path: string];
}>();

const root = computed<DirectoryTreeEntry>(() => ({
  name: directoryName(props.rootPath),
  path: props.rootPath,
}));
</script>

<template>
  <nav class="directory-tree" :aria-label="label">
    <div class="directory-tree-heading">{{ label }}</div>
    <ul role="tree">
      <DirectoryTreeNode
        :node="root"
        :level="1"
        :active-path="activePath"
        :children-by-path="childrenByPath"
        :expanded-paths="expandedPaths"
        :loading-paths="loadingPaths"
        :error-paths="errorPaths"
        @navigate="emit('navigate', $event)"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </nav>
</template>
