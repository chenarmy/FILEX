<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { KeyRound, ShieldCheck, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

const sessions = useSessionsStore();
const password = ref('');
const passwordInput = ref<HTMLInputElement | null>(null);
const profile = computed(() => sessions.profileForId(sessions.passwordProfileId));
const descriptionKey = computed<Parameters<typeof t>[0]>(() => sessions.isQuickProfile(profile.value?.id)
  ? 'ssh.quickPasswordDescription'
  : 'ssh.passwordDescription');

onMounted(async () => {
  await nextTick();
  passwordInput.value?.focus();
});

function close(): void {
  password.value = '';
  if (!sessions.busy) sessions.dismissPassword();
}

async function submit(): Promise<void> {
  if (!password.value) return;
  const transient = password.value;
  password.value = '';
  await sessions.savePassword(transient);
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div><KeyRound :size="15" /><strong id="password-title">{{ t('ssh.passwordTitle') }}</strong></div>
        <button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <div class="dialog-note"><ShieldCheck :size="15" /><span>{{ t(descriptionKey) }}</span></div>
        <dl v-if="profile" class="host-key-details">
          <div><dt>{{ t('ssh.endpoint') }}</dt><dd class="mono">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</dd></div>
          <div><dt>{{ t('profile.name') }}</dt><dd>{{ profile.name }}</dd></div>
        </dl>
        <label class="field password-field">
          <span>{{ t('ssh.password') }}</span>
          <input ref="passwordInput" v-model="password" type="password" autocomplete="current-password">
        </label>
        <p v-if="sessions.error" class="form-error" role="alert">{{ t(sessions.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="!password || sessions.busy">{{ t('ssh.connect') }}</button>
      </footer>
    </form>
  </div>
</template>
