<script setup lang="ts">
import { computed, ref } from 'vue';
import { Fingerprint, ShieldAlert, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';

const sessions = useSessionsStore();
const confirmed = ref(false);
const challenge = computed(() => sessions.challenge);
const changed = computed(() => challenge.value?.trust === 'changed');

function close(): void {
  if (!sessions.busy) sessions.dismissChallenge();
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <section class="dialog trust-dialog" role="alertdialog" aria-modal="true" aria-labelledby="host-key-title">
      <header class="dialog-header">
        <div><ShieldAlert :size="15" /><strong id="host-key-title">{{ changed ? t('ssh.hostKeyChanged') : t('ssh.hostKeyUnknown') }}</strong></div>
        <button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <div class="dialog-note" :class="{ danger: changed }">
          <Fingerprint :size="16" />
          <span>{{ changed ? t('ssh.changedWarning') : t('ssh.unknownWarning') }}</span>
        </div>
        <dl v-if="challenge" class="host-key-details">
          <div><dt>{{ t('ssh.routeHop') }}</dt><dd>{{ challenge.profileName }} ({{ challenge.hopIndex + 1 }}/{{ challenge.hopCount }})</dd></div>
          <div><dt>{{ t('ssh.endpoint') }}</dt><dd>{{ challenge.host }}:{{ challenge.port }}</dd></div>
          <div><dt>{{ t('ssh.algorithm') }}</dt><dd class="mono">{{ challenge.algorithm }}</dd></div>
          <div><dt>{{ t('ssh.fingerprint') }}</dt><dd class="mono fingerprint-value">{{ challenge.fingerprintSha256 }}</dd></div>
        </dl>
        <label class="trust-confirm">
          <input v-model="confirmed" type="checkbox">
          <span>{{ t('ssh.confirmOutOfBand') }}</span>
        </label>
        <p v-if="sessions.error" class="form-error" role="alert">{{ t(sessions.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="button" class="button primary" :disabled="!confirmed || sessions.busy" @click="sessions.acceptHostKey">
          {{ t('ssh.trustAndContinue') }}
        </button>
      </footer>
    </section>
  </div>
</template>
