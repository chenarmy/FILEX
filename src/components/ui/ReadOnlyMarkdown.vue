<script setup lang="ts">
import { computed } from 'vue';
import {
  parseAssistantInline,
  parseAssistantMarkdown,
} from '@/domain/assistantMarkdown';

const props = defineProps<{ content: string }>();
const blocks = computed(() => parseAssistantMarkdown(props.content));

function inlineTokens(text: string) {
  return parseAssistantInline(text);
}
</script>

<template>
  <div class="read-only-markdown">
    <template v-for="(block, index) in blocks" :key="`${block.kind}-${index}`">
      <h3 v-if="block.kind === 'heading'" :class="`level-${block.level}`">{{ block.text }}</h3>
      <p v-else-if="block.kind === 'paragraph'">
        <template v-for="(token, tokenIndex) in inlineTokens(block.text)" :key="tokenIndex">
          <strong v-if="token.kind === 'strong'">{{ token.value }}</strong>
          <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
          <span v-else>{{ token.value }}</span>
        </template>
      </p>
      <ul v-else-if="block.kind === 'bullet-list'">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
      </ul>
      <ol v-else-if="block.kind === 'ordered-list'">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
      </ol>
      <blockquote v-else-if="block.kind === 'quote'">{{ block.text }}</blockquote>
      <pre v-else><code>{{ block.text }}</code></pre>
    </template>
  </div>
</template>
