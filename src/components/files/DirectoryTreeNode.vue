<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight, Folder, LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import type { DirectoryTreeEntry } from '@/domain/directoryNavigation';

const props = defineProps<{
  node: DirectoryTreeEntry;
  level: number;
  activePath: string;
  childrenByPath: Record<string, DirectoryTreeEntry[]>;
  expandedPaths: string[];
  loadingPaths: string[];
  errorPaths: string[];
}>();

const emit = defineEmits<{
  navigate: [path: string];
  toggle: [path: string];
}>();

const expanded = computed(() => props.expandedPaths.includes(props.node.path));
const loading = computed(() => props.loadingPaths.includes(props.node.path));
const failed = computed(() => props.errorPaths.includes(props.node.path));
const children = computed(() => props.childrenByPath[props.node.path] ?? []);
</script>

<template>
  <li
    class="directory-tree-node"
    role="treeitem"
    :aria-level="level"
    :aria-expanded="expanded"
    :aria-selected="activePath === node.path"
  >
    <div class="directory-tree-row" :class="{ active: activePath === node.path }" :style="{ paddingInlineStart: `${(level - 1) * 13 + 3}px` }">
      <button
        type="button"
        class="directory-tree-toggle"
        :aria-label="node.name"
        :aria-expanded="expanded"
        @click.stop="emit('toggle', node.path)"
      >
        <LoaderCircle v-if="loading" class="spin" :size="11" />
        <TriangleAlert v-else-if="failed" :size="11" />
        <ChevronRight v-else :size="11" :class="{ expanded }" />
      </button>
      <button
        type="button"
        class="directory-tree-label mono"
        :title="node.path"
        @click="emit('navigate', node.path)"
      >
        <Folder :size="12" />
        <span>{{ node.name }}</span>
      </button>
    </div>
    <ul v-if="expanded" role="group">
      <DirectoryTreeNode
        v-for="child in children"
        :key="child.path"
        :node="child"
        :level="level + 1"
        :active-path="activePath"
        :children-by-path="childrenByPath"
        :expanded-paths="expandedPaths"
        :loading-paths="loadingPaths"
        :error-paths="errorPaths"
        @navigate="emit('navigate', $event)"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </li>
</template>
