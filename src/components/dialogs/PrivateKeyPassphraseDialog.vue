<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { KeyRound, ShieldCheck, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';

const sessions = useSessionsStore();
const connections = useConnectionsStore();
const passphrase = ref('');
const passphraseInput = ref<HTMLInputElement | null>(null);
const profile = computed(() => connections.profiles.find(
  (item) => item.id === sessions.privateKeyPassphraseProfileId,
) ?? null);

onMounted(async () => {
  await nextTick();
  passphraseInput.value?.focus();
});

function close(): void {
  passphrase.value = '';
  if (!sessions.busy) sessions.dismissPrivateKeyPassphrase();
}

async function submit(): Promise<void> {
  if (!sessions.privateKeyPassphraseProfileId || sessions.busy) return;
  const transient = passphrase.value;
  passphrase.value = '';
  await sessions.savePrivateKeyPassphrase(transient);
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="key-passphrase-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div><KeyRound :size="15" /><strong id="key-passphrase-title">{{ t('ssh.privateKeyPassphraseTitle') }}</strong></div>
        <button type="button" class="icon-button" :aria-label="t('profile.cancel')" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <div class="dialog-note"><ShieldCheck :size="15" /><span>{{ t('ssh.privateKeyPassphraseDescription') }}</span></div>
        <dl v-if="profile" class="host-key-details">
          <div><dt>{{ t('ssh.endpoint') }}</dt><dd class="mono">{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</dd></div>
          <div><dt>{{ t('profile.name') }}</dt><dd>{{ profile.name }}</dd></div>
        </dl>
        <label class="field password-field">
          <span>{{ t('ssh.privateKeyPassphrase') }}</span>
          <input ref="passphraseInput" v-model="passphrase" type="password" autocomplete="off">
        </label>
        <p v-if="sessions.error" class="form-error" role="alert">{{ t(sessions.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="sessions.busy">
          {{ sessions.busy ? t('profile.saving') : t('ssh.connect') }}
        </button>
      </footer>
    </form>
  </div>
</template>
