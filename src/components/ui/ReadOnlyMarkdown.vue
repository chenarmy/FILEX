<script setup lang="ts">
import { computed } from 'vue';
import MarkdownInline from '@/components/ui/MarkdownInline.vue';
import {
  parseAssistantMarkdown,
  type AssistantTableAlignment,
} from '@/domain/assistantMarkdown';

const props = defineProps<{ content: string }>();
const blocks = computed(() => parseAssistantMarkdown(props.content));

function alignmentStyle(alignment: AssistantTableAlignment | undefined): Record<string, string> | undefined {
  if (!alignment) return undefined;
  return { textAlign: alignment };
}

function listItemClass(depths: number[] | undefined, itemIndex: number): string | undefined {
  const depth = depths?.[itemIndex] ?? 0;
  return depth > 0 ? `markdown-list-depth-${depth}` : undefined;
}
</script>

<template>
  <div class="read-only-markdown">
    <template v-for="(block, index) in blocks" :key="`${block.kind}-${index}`">
      <h3 v-if="block.kind === 'heading'" :class="`level-${block.level}`">
        <MarkdownInline :text="block.text" />
      </h3>
      <p v-else-if="block.kind === 'paragraph'">
        <MarkdownInline :text="block.text" />
      </p>
      <ul v-else-if="block.kind === 'bullet-list'">
        <li
          v-for="(item, itemIndex) in block.items"
          :key="itemIndex"
          :class="listItemClass(block.itemDepths, itemIndex)"
        >
          <MarkdownInline :text="item" />
        </li>
      </ul>
      <ol v-else-if="block.kind === 'ordered-list'" :start="block.start">
        <li
          v-for="(item, itemIndex) in block.items"
          :key="itemIndex"
          :class="listItemClass(block.itemDepths, itemIndex)"
        >
          <MarkdownInline :text="item" />
        </li>
      </ol>
      <blockquote v-else-if="block.kind === 'quote'">
        <MarkdownInline :text="block.text" />
      </blockquote>
      <hr v-else-if="block.kind === 'hr'" class="read-only-markdown-hr">
      <div v-else-if="block.kind === 'table'" class="read-only-markdown-table-wrap">
        <table class="read-only-markdown-table">
          <thead>
            <tr>
              <th
                v-for="(header, colIndex) in block.headers"
                :key="colIndex"
                :style="alignmentStyle(block.alignments[colIndex])"
              >
                <MarkdownInline :text="header" />
              </th>
            </tr>
          </thead>
          <tbody v-if="block.rows.length > 0">
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <td
                v-for="(cell, colIndex) in row"
                :key="colIndex"
                :style="alignmentStyle(block.alignments[colIndex])"
              >
                <MarkdownInline :text="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <pre v-else><code>{{ block.text }}</code></pre>
    </template>
  </div>
</template>
