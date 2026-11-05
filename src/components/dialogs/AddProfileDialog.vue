<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { ChevronDown, ChevronUp, KeyRound, Plus, Server, ShieldCheck, Trash2, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { selectPrivateKeyFile } from '@/api/domain/connectionsApi';
import { useConnectionsStore } from '@/stores/connections';
import { useUiStore } from '@/stores/ui';
import type { AppError, AuthenticationMethod, CreateConnectionProfileInput, EnvironmentKind } from '@/types/contracts';

const connections = useConnectionsStore();
const ui = useUiStore();
const firstField = ref<HTMLInputElement | null>(null);
const filePickerError = ref<AppError | null>(null);
const privateKeyPathMissing = ref(false);
const editingProfile = computed(() => connections.profiles.find((profile) => profile.id === ui.editingProfileId) ?? null);
const privateKeyPathConfirmed = ref(editingProfile.value?.authenticationMethod === 'private_key');
const eligibleJumpProfiles = computed(() => connections.profiles.filter((profile) =>
  profile.id !== editingProfile.value?.id
  && profile.proxyJumpProfileIds.length === 0
  && !profile.proxyJump?.trim(),
));
const editingProfileUsedAsJump = computed(() => editingProfile.value
  ? connections.profiles.some((profile) => profile.proxyJumpProfileIds.includes(editingProfile.value!.id))
  : false);
const form = reactive<{
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentKind;
  tags: string;
  authenticationMethod: AuthenticationMethod;
  identityFile: string;
  proxyJump: string;
  proxyJumpProfileIds: string[];
}>({
  name: editingProfile.value?.name ?? '',
  group: editingProfile.value?.group ?? '未分组',
  host: editingProfile.value?.host ?? '',
  port: editingProfile.value?.port ?? 22,
  username: editingProfile.value?.username ?? '',
  environment: editingProfile.value?.environment ?? 'development',
  tags: editingProfile.value?.tags.join(', ') ?? '',
  authenticationMethod: editingProfile.value?.authenticationMethod ?? 'password',
  identityFile: editingProfile.value?.identityFile ?? '',
  proxyJump: editingProfile.value?.proxyJump ?? '',
  proxyJumpProfileIds: [...(editingProfile.value?.proxyJumpProfileIds ?? [])],
});

const fieldError = computed(() => connections.error?.field ?? null);
const errorMessage = computed(() => connections.error
  ? t(connections.error.messageKey as Parameters<typeof t>[0])
  : '');
const filePickerErrorMessage = computed(() => filePickerError.value
  ? t(filePickerError.value.messageKey as Parameters<typeof t>[0])
  : '');

onMounted(async () => {
  await nextTick();
  firstField.value?.focus();
});

function close(): void {
  if (!connections.saving) ui.closeAddProfile();
}

async function choosePrivateKeyFile(): Promise<void> {
  filePickerError.value = null;
  const selected = await selectPrivateKeyFile(t('profile.keyFilePickerTitle'));
  if (!selected.ok) {
    filePickerError.value = selected.error;
    return;
  }
  if (selected.data) {
    form.identityFile = selected.data;
    privateKeyPathConfirmed.value = true;
    privateKeyPathMissing.value = false;
  }
}

function addJumpProfile(): void {
  if (editingProfileUsedAsJump.value || form.proxyJumpProfileIds.length >= 4) return;
  const available = eligibleJumpProfiles.value.find((profile) => !form.proxyJumpProfileIds.includes(profile.id));
  if (available) form.proxyJumpProfileIds.push(available.id);
}

function removeJumpProfile(index: number): void {
  form.proxyJumpProfileIds.splice(index, 1);
}

function moveJumpProfile(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= form.proxyJumpProfileIds.length) return;
  const [profileId] = form.proxyJumpProfileIds.splice(index, 1);
  if (profileId) form.proxyJumpProfileIds.splice(target, 0, profileId);
}

async function submit(): Promise<void> {
  if (form.authenticationMethod === 'private_key' && (!form.identityFile.trim() || !privateKeyPathConfirmed.value)) {
    privateKeyPathMissing.value = true;
    return;
  }
  privateKeyPathMissing.value = false;
  const input: CreateConnectionProfileInput = {
    name: form.name,
    group: form.group,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    environment: form.environment,
    tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    authenticationMethod: form.authenticationMethod,
    identityFile: form.identityFile.trim() || null,
    proxyJump: form.proxyJump.trim() || null,
    proxyJumpProfileIds: [...form.proxyJumpProfileIds],
  };
  const saved = editingProfile.value
    ? await connections.update(editingProfile.value.id, { ...input, favorite: editingProfile.value.favorite })
    : await connections.create(input);
  if (saved) {
    ui.closeAddProfile();
    ui.notify(t('profile.saved'));
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title" @submit.prevent="submit">
      <header class="dialog-header">
        <div><Server :size="15" /><strong id="profile-dialog-title">{{ editingProfile ? t('profile.editDialogTitle') : t('profile.dialogTitle') }}</strong></div>
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
          <label class="field">
            <span>{{ t('profile.authentication') }}</span>
            <select v-model="form.authenticationMethod">
              <option value="password">{{ t('profile.authPassword') }}</option>
              <option value="private_key">{{ t('profile.authPrivateKey') }}</option>
              <option value="agent">{{ t('profile.authAgent') }}</option>
            </select>
            <small class="field-hint">{{ t('profile.authMethodsHint') }}</small>
          </label>
          <label v-if="form.authenticationMethod === 'private_key'" class="field full">
            <span>{{ t('profile.identityFile') }}</span>
            <div class="field-with-action">
              <input v-model="form.identityFile" :aria-invalid="fieldError === 'identityFile' || privateKeyPathMissing" readonly autocomplete="off" spellcheck="false">
              <button type="button" class="button" :disabled="connections.saving" @click="choosePrivateKeyFile">
                <KeyRound :size="13" />{{ t('profile.chooseKeyFile') }}
              </button>
            </div>
            <small class="field-hint">{{ t('profile.identityFileHint') }}</small>
            <small v-if="privateKeyPathMissing" class="form-error" role="alert">{{ t('profile.privateKeyPathRequired') }}</small>
          </label>
          <label v-else-if="form.identityFile" class="field full">
            <span>{{ t('profile.identityFileIgnored') }}</span>
            <input v-model="form.identityFile" readonly autocomplete="off" spellcheck="false">
            <small class="warning-text">{{ t('profile.identityFileIgnoredHint') }}</small>
          </label>
          <div class="field full jump-route-field">
            <label class="field-label" for="profile-proxy-jump-source">{{ t('profile.proxyJump') }}</label>
            <input id="profile-proxy-jump-source" v-model="form.proxyJump" autocomplete="off" spellcheck="false" placeholder="bastion or user@host:22">
            <small class="field-hint">{{ t('profile.proxyJumpSourceHint') }}</small>
            <small v-if="form.proxyJump.trim() && form.proxyJumpProfileIds.length === 0" class="warning-text">
              {{ t('profile.proxyJumpMapRequired') }}
            </small>
            <small v-if="editingProfileUsedAsJump" class="warning-text">{{ t('profile.proxyJumpUsedAsJumpHint') }}</small>
            <div v-if="form.proxyJumpProfileIds.length" class="jump-route-list">
              <div v-for="(profileId, index) in form.proxyJumpProfileIds" :key="`${profileId}-${index}`" class="jump-route-row">
                <span class="jump-route-index">{{ index + 1 }}</span>
                <select v-model="form.proxyJumpProfileIds[index]" :aria-label="t('profile.jumpHostNumber', { index: index + 1 })">
                  <option value="" disabled>{{ t('profile.selectJumpProfile') }}</option>
                  <option
                    v-for="profile in eligibleJumpProfiles"
                    :key="profile.id"
                    :value="profile.id"
                    :disabled="profile.id !== profileId && form.proxyJumpProfileIds.includes(profile.id)"
                  >
                    {{ profile.name }} — {{ profile.username }}@{{ profile.host }}:{{ profile.port }}
                  </option>
                </select>
                <button type="button" class="icon-button" :aria-label="t('profile.moveJumpHostUp')" :disabled="index === 0" @click="moveJumpProfile(index, -1)">
                  <ChevronUp :size="13" />
                </button>
                <button type="button" class="icon-button" :aria-label="t('profile.moveJumpHostDown')" :disabled="index === form.proxyJumpProfileIds.length - 1" @click="moveJumpProfile(index, 1)">
                  <ChevronDown :size="13" />
                </button>
                <button type="button" class="icon-button danger" :aria-label="t('profile.removeJumpHost')" @click="removeJumpProfile(index)">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
            <button type="button" class="button jump-route-add" :disabled="editingProfileUsedAsJump || form.proxyJumpProfileIds.length >= 4 || eligibleJumpProfiles.length <= form.proxyJumpProfileIds.length" @click="addJumpProfile">
              <Plus :size="13" />{{ t('profile.addJumpHost') }}
            </button>
          </div>
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
        <p v-if="filePickerError" class="form-error" role="alert">{{ filePickerErrorMessage }}</p>
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
