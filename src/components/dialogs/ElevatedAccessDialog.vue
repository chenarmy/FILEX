<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ShieldAlert, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { usePrivilegeStore } from '@/stores/privilege';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore();
const sessions = useSessionsStore();
const privilege = usePrivilegeStore();

const ttlSeconds = ref(300);
const password = ref('');
const passwordInput = ref<HTMLInputElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const previousFocus = ref<HTMLElement | null>(null);
const restoreFocus = ref(true);

const targetSession = computed(() =>
  sessions.summaries.find((item) => item.id === ui.elevatedAccessSessionId) ?? null,
);
const targetLabel = computed(() => (targetSession.value
  ? `${targetSession.value.username}@${targetSession.value.host}:${targetSession.value.port}`
  : ''));
const errorMessage = computed(() => (privilege.error
  ? t(privilege.error.messageKey as Parameters<typeof t>[0])
  : ''));

onMounted(async () => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  privilege.clearError();
  await nextTick();
  if (passwordInput.value && !passwordInput.value.disabled) {
    passwordInput.value.focus();
  } else {
    cancelButton.value?.focus();
  }
});

onBeforeUnmount(() => {
  password.value = '';
  if (restoreFocus.value) previousFocus.value?.focus();
});

function close(): void {
  if (privilege.busy) return;
  password.value = '';
  privilege.clearError();
  ui.closeElevatedAccessDialog();
}

async function submit(): Promise<void> {
  if (privilege.busy || !targetSession.value) return;
  restoreFocus.value = false;
  const submittedPassword = password.value;
  password.value = '';
  try {
    const lease = await privilege.acquire({
      sessionId: targetSession.value.id,
      password: submittedPassword.length > 0 ? submittedPassword : null,
      ttlSeconds: ttlSeconds.value,
    });
    if (lease) {
      ui.notify(t('elevated.acquiredNotice', { target: targetLabel.value }));
      ui.closeElevatedAccessDialog();
    } else {
      restoreFocus.value = true;
    }
  } finally {
    password.value = '';
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form
      class="dialog elevated-access-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="elevated-access-title"
      :aria-busy="privilege.busy"
      @submit.prevent="submit"
    >
      <header class="dialog-header">
        <div>
          <ShieldAlert :size="15" />
          <strong id="elevated-access-title">{{ t('elevated.dialogTitle') }}</strong>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('elevated.close')"
          :disabled="privilege.busy"
          @click="close"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="dialog-body">
        <div class="dialog-note warning-note" role="note">
          <ShieldAlert :size="15" />
          <span>{{ t('elevated.scopeWarning') }}</span>
        </div>

        <div class="form-grid">
          <label class="field full">
            <span>{{ t('elevated.targetHost') }}</span>
            <input type="text" class="mono" :value="targetLabel" readonly tabindex="-1">
          </label>

          <label class="field full">
            <span>{{ t('elevated.ttlLabel') }}</span>
            <select v-model.number="ttlSeconds" :disabled="privilege.busy">
              <option :value="300">{{ t('elevated.ttl5m') }}</option>
              <option :value="900">{{ t('elevated.ttl15m') }}</option>
              <option :value="1800">{{ t('elevated.ttl30m') }}</option>
            </select>
          </label>

          <label class="field full">
            <span>{{ t('elevated.passwordLabel') }}</span>
            <input
              ref="passwordInput"
              v-model="password"
              type="password"
              :placeholder="t('elevated.passwordPlaceholder')"
              :disabled="privilege.busy"
              autocomplete="off"
              @input="privilege.clearError"
            >
            <small class="field-hint">{{ t('elevated.passwordOptionalHint') }}</small>
          </label>
        </div>

        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
      </div>

      <footer class="dialog-footer">
        <button ref="cancelButton" type="button" class="button" :disabled="privilege.busy" @click="close">
          {{ t('profile.cancel') }}
        </button>
        <button type="submit" class="button primary" :disabled="privilege.busy || !targetSession">
          <ShieldAlert :size="13" />{{ t('elevated.enableAction') }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.elevated-access-dialog {
  width: min(460px, calc(100vw - 24px));
}

.warning-note {
  border: 1px solid hsl(var(--warning) / 0.38);
  background: hsl(var(--warning) / 0.1);
  color: hsl(var(--warning));
}

.field-hint {
  font-size: 0.72rem;
  color: hsl(var(--muted-foreground));
}
</style>
