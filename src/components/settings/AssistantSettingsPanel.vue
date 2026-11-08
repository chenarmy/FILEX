<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Bot, ExternalLink, KeyRound, ShieldCheck } from 'lucide-vue-next';
import { t } from '@/i18n';
import {
  assistantEndpointAllowsKeyless,
  assistantProviderPresetById,
  assistantProviderPresets,
  assistantSuggestedModels,
  matchAssistantProviderPreset,
  normalizeAssistantEndpoint,
  type AssistantProviderPresetId,
} from '@/domain/assistantProviders';
import { useAssistantStore } from '@/stores/assistant';

const assistant = useAssistantStore();
const providerPresetId = ref<AssistantProviderPresetId>('openai');
const endpoint = ref('');
const model = ref('');
const apiKey = ref('');
const saving = ref(false);
const consentSaving = ref(false);
const error = ref<Parameters<typeof t>[0] | null>(null);
const dirty = ref(false);

const selectedPreset = computed(() => assistantProviderPresetById(providerPresetId.value));
const suggestedModels = computed(() => assistantSuggestedModels(providerPresetId.value, model.value));
const keyOptional = computed(() => assistantEndpointAllowsKeyless(endpoint.value));
const endpointChanged = computed(() => normalizeAssistantEndpoint(endpoint.value) !== assistant.provider.endpoint);
const canKeepCredential = computed(() => assistant.provider.configured && !endpointChanged.value);
const providerLabel = computed(() => matchAssistantProviderPreset(assistant.provider.endpoint).name);
const providerDestination = computed(() => {
  try {
    return new URL(assistant.provider.endpoint).origin;
  } catch {
    return assistant.provider.endpoint.slice(0, 160);
  }
});

function reset(): void {
  const preset = assistant.provider.endpoint
    ? matchAssistantProviderPreset(assistant.provider.endpoint)
    : assistantProviderPresetById('openai');
  providerPresetId.value = preset.id;
  endpoint.value = assistant.provider.endpoint || preset.endpoint;
  model.value = assistant.provider.model || preset.defaultModel;
  apiKey.value = '';
  error.value = null;
  dirty.value = false;
}

function selectPreset(event: Event): void {
  const next = (event.currentTarget as HTMLSelectElement).value as AssistantProviderPresetId;
  providerPresetId.value = next;
  const preset = assistantProviderPresetById(next);
  endpoint.value = preset.endpoint;
  model.value = preset.defaultModel;
  apiKey.value = '';
  error.value = null;
  dirty.value = true;
}

async function save(): Promise<boolean> {
  if (saving.value) return false;
  if (!dirty.value) {
    error.value = null;
    return true;
  }
  const normalizedEndpoint = normalizeAssistantEndpoint(endpoint.value);
  const normalizedModel = model.value.trim();
  if (!normalizedEndpoint || !normalizedModel || normalizedModel.length > 120) {
    error.value = 'errors.assistantConfigInvalid';
    return false;
  }

  const endpointChangedNow = normalizedEndpoint !== assistant.provider.endpoint;
  const modelChangedNow = normalizedModel !== assistant.provider.model;
  const hasNewCredential = apiKey.value.trim().length > 0;
  if (!hasNewCredential && !keyOptional.value && (!assistant.provider.configured || endpointChangedNow)) {
    error.value = 'settings.assistantCredentialRequired';
    return false;
  }
  if (!endpointChangedNow && !modelChangedNow && !hasNewCredential) {
    error.value = null;
    return true;
  }

  saving.value = true;
  error.value = null;
  try {
    const saved = endpointChangedNow || hasNewCredential || !assistant.provider.configured
      ? await assistant.configure({
        endpoint: normalizedEndpoint,
        model: normalizedModel,
        apiKey: apiKey.value,
      })
      : await assistant.setModel(normalizedModel);
    if (!saved) {
      error.value = (assistant.error as Parameters<typeof t>[0] | null) ?? 'errors.assistantConfigSaveFailed';
      return false;
    }
    apiKey.value = '';
    reset();
    return true;
  } finally {
    saving.value = false;
  }
}

async function updateConsent(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  consentSaving.value = true;
  error.value = null;
  try {
    const saved = await assistant.setProviderConsent(input.checked);
    if (!saved) {
      input.checked = assistant.provider.externalDataConsent;
      error.value = (assistant.error as Parameters<typeof t>[0] | null) ?? 'errors.assistantConfigSaveFailed';
    }
  } finally {
    consentSaving.value = false;
  }
}

function markDirty(): void {
  dirty.value = true;
}

onMounted(async () => {
  await assistant.initialize();
  reset();
  if (assistant.error) error.value = assistant.error as Parameters<typeof t>[0];
});

defineExpose({ save, reset });
</script>

<template>
  <section class="assistant-settings-panel">
    <header class="assistant-settings-heading">
      <div>
        <span class="assistant-settings-icon"><Bot :size="15" /></span>
        <div>
          <h2>{{ t('settings.assistant') }}</h2>
          <p>{{ t('settings.assistantHelp') }}</p>
        </div>
      </div>
      <span class="status-pill" :class="{ available: assistant.provider.configured, pending: !assistant.provider.configured }">
        {{ assistant.provider.configured ? t('settings.assistantConfigured') : t('settings.assistantNotConfigured') }}
      </span>
    </header>

    <div v-if="assistant.provider.configured" class="assistant-settings-current">
      <div><span>{{ t('settings.assistantActiveProvider') }}</span><strong>{{ providerLabel }}</strong></div>
      <div><span>{{ t('settings.assistantActiveModel') }}</span><strong class="mono">{{ assistant.provider.model }}</strong></div>
      <div><span>{{ t('settings.assistantDestination') }}</span><strong class="mono">{{ providerDestination }}</strong></div>
    </div>

    <div class="assistant-settings-fields">
      <label class="field">
        <span>{{ t('settings.assistantProvider') }}</span>
        <select data-testid="assistant-provider-select" :value="providerPresetId" @change="selectPreset">
          <option v-for="preset in assistantProviderPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </select>
        <small>{{ t('settings.assistantProviderHelp') }}</small>
      </label>
      <label class="field">
        <span>{{ t('assistant.endpoint') }}</span>
        <input v-model="endpoint" type="url" spellcheck="false" placeholder="https://api.example.com/v1" @input="markDirty">
        <small>{{ t('settings.assistantEndpointHelp') }}</small>
      </label>
      <label class="field">
        <span>{{ t('assistant.model') }}</span>
        <input
          v-model="model"
          list="assistant-model-suggestions"
          autocomplete="off"
          spellcheck="false"
          maxlength="120"
          :placeholder="selectedPreset.defaultModel || 'model-id'"
          @input="markDirty"
        >
        <datalist id="assistant-model-suggestions">
          <option v-for="suggestion in suggestedModels" :key="suggestion" :value="suggestion" />
        </datalist>
        <small>{{ t('settings.assistantModelHelp') }}</small>
      </label>
      <label class="field">
        <span>{{ t('assistant.apiKey') }}</span>
        <input
          v-model="apiKey"
          type="password"
          autocomplete="new-password"
          :placeholder="keyOptional
            ? t('settings.assistantNoKeyNeeded')
            : canKeepCredential
              ? t('settings.assistantKeepCredential')
              : t('assistant.keyOnlyInKeyring')"
          @input="markDirty"
        >
        <small>{{ t('assistant.keyringNotice') }}</small>
      </label>
    </div>

    <div class="assistant-settings-notice">
      <KeyRound :size="14" />
      <div>
        <strong>{{ t('settings.assistantCredentialPolicy') }}</strong>
        <p>{{ keyOptional ? t('settings.assistantLoopbackPolicy') : t('settings.assistantRemotePolicy') }}</p>
      </div>
    </div>

    <div class="setting-row assistant-settings-consent">
      <div>
        <strong>{{ t('settings.assistantConsent') }}</strong>
        <small>{{ t('assistant.providerRecipient', { endpoint: providerDestination || t('settings.assistantNotConfigured') }) }}</small>
        <small>{{ t('assistant.providerPrivacyNotice') }}</small>
      </div>
      <label class="switch" :class="{ disabled: !assistant.provider.configured || consentSaving || saving }">
        <input
          type="checkbox"
          :checked="assistant.provider.externalDataConsent"
          :disabled="!assistant.provider.configured || consentSaving || saving"
          @change="updateConsent"
        >
        <span />
      </label>
    </div>

    <p class="assistant-settings-disclosure">
      <ExternalLink :size="13" />
      <span>{{ assistant.provider.configured && assistant.provider.externalDataConsent
        ? t('settings.assistantConsentGranted')
        : t('settings.assistantConsentRequired') }}</span>
    </p>
    <p v-if="error" class="form-error assistant-settings-error" role="alert">{{ t(error) }}</p>
    <p class="assistant-settings-footnote"><ShieldCheck :size="13" />{{ t('settings.assistantHistoryBackupNote') }}</p>
  </section>
</template>
