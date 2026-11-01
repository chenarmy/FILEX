<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { Server, ShieldCheck, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';
import type { CreateConnectionProfileInput, EnvironmentKind } from '@/types/contracts';

const connections = useConnectionsStore();
const ui = useUiStore();
const firstField = ref<HTMLInputElement | null>(null);
const form = reactive<{
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentKind;
  tags: string;
}>({
  name: '',
  group: '未分组',
  host: '',
  port: 22,
  username: '',
  environment: 'development',
  tags: '',
});

const fieldError = computed(() => connections.error?.field ?? null);
const errorMessage = computed(() => connections.error
  ? t(connections.error.messageKey as Parameters<typeof t>[0])
  : '');

onMounted(async () => {
  await nextTick();
  firstField.value?.focus();
});

function close(): void {
  if (!connections.saving) ui.closeAddProfile();
}

async function submit(): Promise<void> {
  const input: CreateConnectionProfileInput = {
    name: form.name,
    group: form.group,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    environment: form.environment,
    tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  if (await connections.create(input)) {
    ui.closeAddProfile();
    ui.notify(t('profile.saved'));
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div><Server :size="15" /><strong id="profile-dialog-title">{{ t('profile.dialogTitle') }}</strong></div>
        <button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <div class="dialog-note"><ShieldCheck :size="15" /><span>{{ t('profile.dialogDescription') }}</span></div>
        <div class="form-grid">
          <label class="field full">
            <span>{{ t('profile.name') }}</span>
            <input ref="firstField" v-model="form.name" :aria-invalid="fieldError === 'name'" autocomplete="off">
          </label>
          <label class="field">
            <span>{{ t('profile.host') }}</span>
            <input v-model="form.host" :aria-invalid="fieldError === 'host'" autocomplete="off" spellcheck="false">
          </label>
          <label class="field port-field">
            <span>{{ t('profile.port') }}</span>
            <input v-model.number="form.port" type="number" min="1" max="65535" :aria-invalid="fieldError === 'port'">
          </label>
          <label class="field">
            <span>{{ t('profile.username') }}</span>
            <input v-model="form.username" :aria-invalid="fieldError === 'username'" autocomplete="username">
          </label>
          <label class="field">
            <span>{{ t('profile.group') }}</span>
            <input v-model="form.group" autocomplete="off">
          </label>
          <label class="field">
            <span>{{ t('profile.environment') }}</span>
            <select v-model="form.environment">
              <option value="production">{{ t('profile.production') }}</option>
              <option value="staging">{{ t('profile.staging') }}</option>
              <option value="development">{{ t('profile.development') }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('profile.tags') }}</span>
            <input v-model="form.tags" placeholder="api, primary" autocomplete="off">
          </label>
        </div>
        <p v-if="connections.error" class="form-error" role="alert">{{ errorMessage }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="connections.saving">
          {{ connections.saving ? t('profile.saving') : t('profile.save') }}
        </button>
      </footer>
    </form>
  </div>
</template>
