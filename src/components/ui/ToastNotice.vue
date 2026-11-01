<script setup lang="ts">
import { CheckCircle2 } from 'lucide-vue-next';

defineProps<{ message: string }>();
</script>

<template>
  <div class="toast" role="status" aria-live="polite">
    <CheckCircle2 :size="16" />
    <span>{{ message }}</span>
  </div>
</template>
