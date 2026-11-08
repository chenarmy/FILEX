<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Check, Copy } from 'lucide-vue-next';
import { t } from '@/i18n';
import {
  parseAssistantInline,
  parseAssistantMarkdown,
  type AssistantMarkdownBlock,
} from '@/domain/assistantMarkdown';

const props = defineProps<{ content: string }>();
const emit = defineEmits<{ copyFailed: [] }>();
const blocks = computed(() => parseAssistantMarkdown(props.content));
const copiedBlock = ref<number | null>(null);
let copiedTimer: number | null = null;

function inlineTokens(text: string) {
  return parseAssistantInline(text);
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
        <template v-for="(token, tokenIndex) in inlineTokens(block.text)" :key="tokenIndex">
          <strong v-if="token.kind === 'strong'">{{ token.value }}</strong>
          <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
          <span v-else>{{ token.value }}</span>
        </template>
      </h3>
      <p v-else-if="block.kind === 'paragraph'">
        <template v-for="(token, tokenIndex) in inlineTokens(block.text)" :key="tokenIndex">
          <strong v-if="token.kind === 'strong'">{{ token.value }}</strong>
          <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
          <span v-else>{{ token.value }}</span>
        </template>
      </p>
      <ul v-else-if="block.kind === 'bullet-list'">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <template v-for="(token, tokenIndex) in inlineTokens(item)" :key="tokenIndex">
            <strong v-if="token.kind === 'strong'">{{ token.value }}</strong>
            <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
            <span v-else>{{ token.value }}</span>
          </template>
        </li>
      </ul>
      <ol v-else-if="block.kind === 'ordered-list'">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
          <template v-for="(token, tokenIndex) in inlineTokens(item)" :key="tokenIndex">
            <strong v-if="token.kind === 'strong'">{{ token.value }}</strong>
            <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
            <span v-else>{{ token.value }}</span>
          </template>
        </li>
      </ol>
      <blockquote v-else-if="block.kind === 'quote'">{{ block.text }}</blockquote>
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
