<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { FolderPlus, X } from 'lucide-vue-next';
import { t } from '@/i18n';

const props = defineProps<{
  title: string;
  confirmLabel: string;
  initialValue?: string | undefined;
  errorMessage?: string | undefined;
  busy?: boolean | undefined;
}>();

const emit = defineEmits<{
  close: [];
  submit: [name: string];
}>();

const name = ref(props.initialValue ?? '');
const inputRef = ref<HTMLInputElement | null>(null);
const previousFocus = ref<HTMLElement | null>(null);
const canSubmit = computed(() => !props.busy && name.value.trim().length > 0);

onMounted(async () => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
});

onBeforeUnmount(() => {
  previousFocus.value?.focus();
});

function close(): void {
  if (props.busy) return;
  emit('close');
}

function submit(): void {
  if (!canSubmit.value) return;
  emit('submit', name.value.trim());
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc.stop="close">
    <form
      class="dialog group-name-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-name-dialog-title"
      :aria-busy="Boolean(busy)"
      @submit.prevent="submit"
    >
      <header class="dialog-header">
        <div>
          <FolderPlus :size="15" />
          <strong id="group-name-dialog-title">{{ title }}</strong>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('profile.cancel')"
          :disabled="Boolean(busy)"
          @click="close"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="dialog-body group-name-dialog-body">
        <label class="field full">
          <span>{{ t('nav.groupNameLabel') }}</span>
          <input
            ref="inputRef"
            v-model="name"
            type="text"
            :placeholder="t('nav.groupNamePlaceholder')"
            :disabled="Boolean(busy)"
            autocomplete="off"
          >
        </label>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
      </div>

      <footer class="dialog-footer">
        <button type="button" class="button" :disabled="Boolean(busy)" @click="close">
          {{ t('profile.cancel') }}
        </button>
        <button type="submit" class="button primary" :disabled="!canSubmit">
          {{ confirmLabel }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.group-name-dialog {
  width: min(400px, calc(100vw - 32px));
}

.group-name-dialog-body {
  display: grid;
  gap: 10px;
  padding: 16px 20px;
}
</style>
