<script setup lang="ts">
import { computed } from 'vue';
import { parseAssistantInline, type AssistantInlineToken } from '@/domain/assistantMarkdown';

defineOptions({ name: 'MarkdownInline' });

const props = defineProps<{
  text?: string;
  tokens?: AssistantInlineToken[];
}>();

const resolvedTokens = computed<AssistantInlineToken[]>(() => {
  if (props.tokens) return props.tokens;
  return parseAssistantInline(props.text ?? '');
});
</script>

<template>
  <template v-for="(token, tokenIndex) in resolvedTokens" :key="tokenIndex">
    <strong v-if="token.kind === 'strong'">
      <MarkdownInline v-if="token.children" :tokens="token.children" />
      <template v-else>{{ token.value }}</template>
    </strong>
    <em v-else-if="token.kind === 'em'">
      <MarkdownInline v-if="token.children" :tokens="token.children" />
      <template v-else>{{ token.value }}</template>
    </em>
    <del v-else-if="token.kind === 'strike'">
      <MarkdownInline v-if="token.children" :tokens="token.children" />
      <template v-else>{{ token.value }}</template>
    </del>
    <code v-else-if="token.kind === 'code'">{{ token.value }}</code>
    <span v-else-if="token.kind === 'link'" class="markdown-inline-link" :title="token.href">
      <MarkdownInline v-if="token.children" :tokens="token.children" />
      <template v-else>{{ token.value }}</template>
    </span>
    <template v-else>{{ token.value }}</template>
  </template>
</template>
