<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { ShieldCheck, X, Zap } from 'lucide-vue-next';
import { t } from '@/i18n';
import { validateConnectionProfile } from '@/domain/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { AppError } from '@/types/contracts';

const sessions = useSessionsStore();
const ui = useUiStore();
const hostInput = ref<HTMLInputElement | null>(null);
const validationError = ref<AppError | null>(null);
const form = reactive({
  host: '',
  port: 22,
  username: '',
});
const error = computed(() => validationError.value ?? sessions.error);
const errorMessage = computed(() => error.value
  ? t(error.value.messageKey as Parameters<typeof t>[0])
  : '');

onMounted(async () => {
  sessions.clearError();
  await nextTick();
  hostInput.value?.focus();
});

function clearError(): void {
  validationError.value = null;
  sessions.clearError();
}

function close(): void {
  if (sessions.busy) return;
  clearError();
  ui.closeQuickConnect();
}

async function submit(): Promise<void> {
  if (sessions.busy) return;
  validationError.value = validateConnectionProfile({
    name: `${form.username.trim()}@${form.host.trim()}`,
    group: '',
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
    environment: 'development',
    tags: [],
    authenticationMethod: 'password',
    identityFile: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
  });
  if (validationError.value) return;
  const started = await sessions.beginQuick({
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
  });
  if (started) ui.closeQuickConnect();
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form
      class="dialog quick-connect-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-connect-title"
      :aria-busy="sessions.busy"
      @submit.prevent="submit"
    >
      <header class="dialog-header">
        <div><Zap :size="15" /><strong id="quick-connect-title">{{ t('quick.title') }}</strong></div>
        <button type="button" class="icon-button" aria-label="Close" :disabled="sessions.busy" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <div class="dialog-note"><ShieldCheck :size="15" /><span>{{ t('quick.transientNotice') }}</span></div>
        <p class="quick-connect-description">{{ t('quick.description') }}</p>
        <div class="form-grid">
          <label class="field full">
            <span>{{ t('quick.host') }}</span>
            <input
              ref="hostInput"
              v-model="form.host"
              :aria-invalid="error?.field === 'host'"
              autocomplete="off"
              spellcheck="false"
              @input="clearError"
            >
          </label>
          <label class="field port-field">
            <span>{{ t('quick.port') }}</span>
            <input
              v-model.number="form.port"
              type="number"
              min="1"
              max="65535"
              :aria-invalid="error?.field === 'port'"
              @input="clearError"
            >
          </label>
          <label class="field">
            <span>{{ t('quick.username') }}</span>
            <input
              v-model="form.username"
              :aria-invalid="error?.field === 'username'"
              autocomplete="username"
              spellcheck="false"
              @input="clearError"
            >
          </label>
        </div>
        <p class="quick-connect-hint">{{ t('quick.savedHint') }}</p>
        <p v-if="error" class="form-error" role="alert">{{ errorMessage }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" :disabled="sessions.busy" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="sessions.busy || !form.host.trim() || !form.username.trim()">
          <Zap :size="13" />{{ t('quick.connect') }}
        </button>
      </footer>
    </form>
  </div>
</template>
