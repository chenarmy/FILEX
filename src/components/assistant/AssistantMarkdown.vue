<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import MarkdownInline from '@/components/ui/MarkdownInline.vue';
import { t } from '@/i18n';
import {
  parseAssistantMarkdown,
  type AssistantMarkdownBlock,
  type AssistantTableAlignment,
} from '@/domain/assistantMarkdown';

const props = defineProps<{ content: string }>();
const emit = defineEmits<{ copyFailed: [] }>();
const blocks = computed(() => parseAssistantMarkdown(props.content));
const copiedBlock = ref<number | null>(null);
let copiedTimer: number | null = null;

function alignmentStyle(alignment: AssistantTableAlignment | undefined): Record<string, string> | undefined {
  if (!alignment) return undefined;
  return { textAlign: alignment };
}

function listItemClass(depths: number[] | undefined, itemIndex: number): string | undefined {
  const depth = depths?.[itemIndex] ?? 0;
  return depth > 0 ? `markdown-list-depth-${depth}` : undefined;
}

async function copyCode(block: Extract<AssistantMarkdownBlock, { kind: 'code' }>, index: number): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(block.text);
    copiedBlock.value = index;
    if (copiedTimer !== null) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copiedBlock.value = null;
      copiedTimer = null;
    }, 1_800);
  } catch {
    emit('copyFailed');
  }
}

onBeforeUnmount(() => {
  if (copiedTimer !== null) window.clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="assistant-markdown">
    <template v-for="(block, index) in blocks" :key="`${block.kind}-${index}`">
      <h3 v-if="block.kind === 'heading'" :class="`assistant-markdown-heading level-${block.level}`">
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
      <hr v-else-if="block.kind === 'hr'" class="assistant-markdown-hr">
      <div v-else-if="block.kind === 'table'" class="assistant-markdown-table-wrap">
        <table class="assistant-markdown-table">
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
      <section v-else class="assistant-markdown-code">
        <header>
          <span>{{ block.language || t('assistant.code') }}</span>
          <button type="button" :aria-label="t('assistant.copyCode')" :title="t('assistant.copyCode')" @click="copyCode(block, index)">
            <Check v-if="copiedBlock === index" :size="12" />
            <Copy v-else :size="12" />
            <span>{{ copiedBlock === index ? t('assistant.copied') : t('assistant.copy') }}</span>
          </button>
        </header>
        <pre><code>{{ block.text }}</code></pre>
      </section>
    </template>
  </div>
</template>
