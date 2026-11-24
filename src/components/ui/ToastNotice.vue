<script setup lang="ts">
import { AlertCircle, CheckCircle2 } from 'lucide-vue-next';

withDefaults(defineProps<{
  message: string;
  tone?: 'success' | 'error';
}>(), {
  tone: 'success',
});
</script>

<template>
  <div
    class="toast"
    :class="{ error: tone === 'error' }"
    :role="tone === 'error' ? 'alert' : 'status'"
    :aria-live="tone === 'error' ? 'assertive' : 'polite'"
  >
    <AlertCircle v-if="tone === 'error'" :size="16" />
    <CheckCircle2 v-else :size="16" />
    <span>{{ message }}</span>
  </div>
</template>
