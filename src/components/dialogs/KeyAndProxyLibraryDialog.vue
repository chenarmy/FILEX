<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { CheckCircle2, Info, KeyRound, Play, RefreshCw, ShieldAlert, Trash2, Waypoints, X } from 'lucide-vue-next';
import { isTauriRuntime } from '@/api/common';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useKeysStore } from '@/stores/keys';
import { useProxiesStore } from '@/stores/proxies';
import { useUiStore } from '@/stores/ui';
import type { ProxyKind, ProxyProfile, SshKeyEntry, SshKeyMetadataInspection } from '@/types/contracts';

const ui = useUiStore();
const keys = useKeysStore();
const proxies = useProxiesStore();
const connections = useConnectionsStore();

const desktopRuntime = isTauriRuntime();
const activeTab = computed(() => ui.keyProxyLibraryTab);
const activeBusy = computed(() => keys.busy || proxies.busy || keys.loading || proxies.loading);

const keysTabButton = ref<HTMLButtonElement | null>(null);
const proxiesTabButton = ref<HTMLButtonElement | null>(null);
const previousFocus = ref<HTMLElement | null>(null);
const restoreFocus = ref(true);

const rotatingKeyId = ref<string | null>(null);
const inspection = ref<SshKeyMetadataInspection | null>(null);
const keyForm = reactive({
  label: '',
  keyPath: '',
  passphrase: '',
  savePassphrase: false,
});

const editingProxyId = ref<string | null>(null);
const editingProxyHasPassword = ref(false);
const proxyForm = reactive<{
  label: string;
  kind: ProxyKind;
  host: string;
  port: number;
  username: string;
  password: string;
  clearPassword: boolean;
}>({
  label: '',
  kind: 'socks5',
  host: '',
  port: 1080,
  username: '',
  password: '',
  clearPassword: false,
});

const activeErrorText = computed(() => {
  const err = activeTab.value === 'keys' ? keys.error : proxies.error;
  if (!err) return '';
  return t(err.messageKey as Parameters<typeof t>[0]);
});

const activeErrorCode = computed(() => {
  const err = activeTab.value === 'keys' ? keys.error : proxies.error;
  return err?.code ?? '';
});

function clearTransientSecrets(): void {
  keyForm.passphrase = '';
  proxyForm.password = '';
}

function resetKeyForm(): void {
  rotatingKeyId.value = null;
  inspection.value = null;
  keyForm.label = '';
  keyForm.keyPath = '';
  keyForm.passphrase = '';
  keyForm.savePassphrase = false;
  keys.clearError();
}

function resetProxyForm(): void {
  editingProxyId.value = null;
  editingProxyHasPassword.value = false;
  proxyForm.label = '';
  proxyForm.kind = 'socks5';
  proxyForm.host = '';
  proxyForm.port = 1080;
  proxyForm.username = '';
  proxyForm.password = '';
  proxyForm.clearPassword = false;
  proxies.clearError();
}

function onProxyKindChange(): void {
  if (!editingProxyId.value) {
    if (proxyForm.kind === 'socks5' && proxyForm.port === 8080) {
      proxyForm.port = 1080;
    } else if (proxyForm.kind === 'http_connect' && proxyForm.port === 1080) {
      proxyForm.port = 8080;
    }
  }
}

onMounted(async () => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  keys.clearError();
  proxies.clearError();
  await nextTick();
  if (activeTab.value === 'proxies') {
    proxiesTabButton.value?.focus();
  } else {
    keysTabButton.value?.focus();
  }
  await Promise.all([keys.refresh(), proxies.refresh()]);
});

onBeforeUnmount(() => {
  clearTransientSecrets();
  if (restoreFocus.value) previousFocus.value?.focus();
});

function switchTab(tab: 'keys' | 'proxies'): void {
  ui.keyProxyLibraryTab = tab;
  keys.clearError();
  proxies.clearError();
}

function close(): void {
  if (keys.busy || proxies.busy) return;
  clearTransientSecrets();
  ui.closeKeyProxyLibrary();
}

async function pickKeyFile(): Promise<void> {
  if (!desktopRuntime || keys.busy) return;
  const picked = await keys.pickKeyFile(t('keyProxyLibrary.chooseKeyFileTitle'));
  if (!picked) return;
  keyForm.keyPath = picked;
  if (!keyForm.label.trim()) {
    const basename = picked.split(/[\\/]/).pop()?.trim();
    if (basename) keyForm.label = basename;
  }
  const inspected = await keys.inspectFile(picked, keyForm.passphrase || null);
  if (inspected) inspection.value = inspected;
}

async function inspectKey(): Promise<void> {
  if (!desktopRuntime || keys.busy || !keyForm.keyPath.trim()) return;
  const inspected = await keys.inspectFile(keyForm.keyPath.trim(), keyForm.passphrase || null);
  if (inspected) {
    inspection.value = inspected;
    if (!keyForm.label.trim()) {
      const basename = keyForm.keyPath.trim().split(/[\\/]/).pop()?.trim();
      if (basename) keyForm.label = basename;
    }
  }
}

function startRotateKey(entry: SshKeyEntry): void {
  rotatingKeyId.value = entry.id;
  inspection.value = null;
  keyForm.label = entry.label;
  keyForm.keyPath = entry.keyPath;
  keyForm.passphrase = '';
  keyForm.savePassphrase = entry.hasPassphrase;
  keys.clearError();
}

async function submitKeyForm(): Promise<void> {
  if (!desktopRuntime || keys.busy) return;
  const label = keyForm.label.trim();
  const keyPath = keyForm.keyPath.trim();
  if (!label || !keyPath) return;

  const submittedPassphrase = keyForm.passphrase.length > 0 ? keyForm.passphrase : null;
  keyForm.passphrase = '';

  try {
    if (rotatingKeyId.value) {
      const updated = await keys.rotate({
        keyId: rotatingKeyId.value,
        label,
        newKeyPath: keyPath,
        passphrase: submittedPassphrase,
        savePassphrase: keyForm.savePassphrase,
      });
      if (updated) {
        ui.notify(t('keyProxyLibrary.keyRotatedNotice', { label: updated.label }));
        resetKeyForm();
        await connections.load();
      }
      return;
    }

    const created = await keys.register({
      label,
      keyPath,
      passphrase: submittedPassphrase,
      savePassphrase: keyForm.savePassphrase,
    });
    if (created) {
      ui.notify(t('keyProxyLibrary.keyRegisteredNotice', { label: created.label }));
      resetKeyForm();
    }
  } finally {
    keyForm.passphrase = '';
  }
}

async function deleteKeyEntry(entry: SshKeyEntry): Promise<void> {
  if (!desktopRuntime || keys.busy) return;
  const count = await keys.referenceCount(entry.id);
  const confirmed = await ui.confirm({
    title: t('keyProxyLibrary.deleteKeyConfirmTitle'),
    message: t('keyProxyLibrary.deleteKeyConfirmMessage', {
      label: entry.label,
      count,
    }),
    confirmLabel: t('keyProxyLibrary.deleteKey'),
    danger: true,
  });
  if (!confirmed) return;
  const ok = await keys.remove(entry.id);
  if (ok) {
    if (rotatingKeyId.value === entry.id) resetKeyForm();
    ui.notify(t('keyProxyLibrary.keyDeletedNotice', { label: entry.label }));
    await connections.load();
  }
}

function startEditProxy(entry: ProxyProfile): void {
  editingProxyId.value = entry.id;
  editingProxyHasPassword.value = entry.hasPassword;
  proxyForm.label = entry.label;
  proxyForm.kind = entry.kind;
  proxyForm.host = entry.host;
  proxyForm.port = entry.port;
  proxyForm.username = entry.username ?? '';
  proxyForm.password = '';
  proxyForm.clearPassword = false;
  proxies.clearError();
}

async function submitProxyForm(): Promise<void> {
  if (!desktopRuntime || proxies.busy) return;
  const label = proxyForm.label.trim();
  const host = proxyForm.host.trim();
  const port = Number(proxyForm.port);
  if (!label || !host || !Number.isInteger(port) || port < 1 || port > 65535) return;

  const submittedPassword = proxyForm.password;
  proxyForm.password = '';

  try {
    if (editingProxyId.value) {
      const updated = await proxies.update({
        id: editingProxyId.value,
        label,
        kind: proxyForm.kind,
        host,
        port,
        username: proxyForm.username.trim() || null,
        password: proxyForm.clearPassword || submittedPassword.length === 0 ? null : submittedPassword,
        savePassword: !proxyForm.clearPassword && submittedPassword.length > 0,
        clearPassword: proxyForm.clearPassword,
      });
      if (updated) {
        ui.notify(t('keyProxyLibrary.proxyUpdatedNotice', { name: updated.label }));
        resetProxyForm();
        await connections.load();
      }
      return;
    }

    const created = await proxies.create({
      label,
      kind: proxyForm.kind,
      host,
      port,
      username: proxyForm.username.trim() || null,
      password: submittedPassword.length > 0 ? submittedPassword : null,
      savePassword: submittedPassword.length > 0,
    });
    if (created) {
      ui.notify(t('keyProxyLibrary.proxyCreatedNotice', { name: created.label }));
      resetProxyForm();
    }
  } finally {
    proxyForm.password = '';
  }
}

async function deleteProxyEntry(entry: ProxyProfile): Promise<void> {
  if (!desktopRuntime || proxies.busy) return;
  const count = await proxies.referenceCount(entry.id);
  const confirmed = await ui.confirm({
    title: t('keyProxyLibrary.deleteProxyConfirmTitle'),
    message: t('keyProxyLibrary.deleteProxyConfirmMessage', {
      name: entry.label,
      count,
    }),
    confirmLabel: t('keyProxyLibrary.deleteProxy'),
    danger: true,
  });
  if (!confirmed) return;
  const ok = await proxies.remove(entry.id);
  if (ok) {
    if (editingProxyId.value === entry.id) resetProxyForm();
    ui.notify(t('keyProxyLibrary.proxyDeletedNotice', { name: entry.label }));
    await connections.load();
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <section
      class="dialog key-proxy-library-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="key-proxy-library-title"
      :aria-busy="activeBusy"
    >
      <header class="dialog-header">
        <div>
          <KeyRound :size="15" />
          <strong id="key-proxy-library-title">{{ t('keyProxyLibrary.title') }}</strong>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('keyProxyLibrary.close')"
          :disabled="keys.busy || proxies.busy"
          @click="close"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="key-proxy-tabs" role="tablist" :aria-label="t('keyProxyLibrary.tabsLabel')">
        <button
          ref="keysTabButton"
          type="button"
          role="tab"
          class="key-proxy-tab"
          :class="{ active: activeTab === 'keys' }"
          :aria-selected="activeTab === 'keys'"
          @click="switchTab('keys')"
        >
          <KeyRound :size="13" />
          <span>{{ t('keyProxyLibrary.keysTab') }}</span>
          <span class="key-proxy-count">{{ keys.entries.length }}</span>
        </button>
        <button
          ref="proxiesTabButton"
          type="button"
          role="tab"
          class="key-proxy-tab"
          :class="{ active: activeTab === 'proxies' }"
          :aria-selected="activeTab === 'proxies'"
          @click="switchTab('proxies')"
        >
          <Waypoints :size="13" />
          <span>{{ t('keyProxyLibrary.proxiesTab') }}</span>
          <span class="key-proxy-count">{{ proxies.entries.length }}</span>
        </button>
      </div>

      <div class="dialog-body key-proxy-library-body">
        <div v-if="!desktopRuntime" class="dialog-note" role="note">
          <Info :size="14" />
          <span>{{ t('keyProxyLibrary.desktopOnlyNotice') }}</span>
        </div>
        <div class="dialog-note" role="note">
          <ShieldAlert :size="14" />
          <span>{{ t('keyProxyLibrary.securityNote') }}</span>
        </div>

        <p v-if="activeErrorText" class="form-error" role="alert">
          {{ activeErrorText }}
          <span v-if="activeErrorCode" class="key-proxy-error-code">({{ activeErrorCode }})</span>
        </p>

        <div v-if="activeTab === 'keys'" class="key-proxy-pane" role="tabpanel">
          <div v-if="keys.entries.length === 0" class="key-proxy-empty">
            {{ t('keyProxyLibrary.keysEmpty') }}
          </div>
          <ul v-else class="key-proxy-list">
            <li v-for="entry in keys.entries" :key="entry.id" class="key-proxy-card">
              <div class="key-proxy-card-main">
                <div class="key-proxy-card-title-row">
                  <strong>{{ entry.label }}</strong>
                  <span class="key-proxy-badge">{{ entry.algorithm }}</span>
                  <span v-if="entry.hasPassphrase" class="key-proxy-badge key-proxy-badge-accent">
                    {{ t('keyProxyLibrary.savedPassphraseBadge') }}
                  </span>
                </div>
                <div class="key-proxy-card-meta">
                  <code class="mono">{{ entry.fingerprintSha256 }}</code>
                </div>
                <div class="key-proxy-card-path mono">{{ entry.keyPath }}</div>
              </div>
              <div class="key-proxy-card-actions">
                <button
                  type="button"
                  class="button"
                  :disabled="!desktopRuntime || keys.busy"
                  @click="startRotateKey(entry)"
                >
                  <RefreshCw :size="12" />
                  <span>{{ t('keyProxyLibrary.rotateKey') }}</span>
                </button>
                <button
                  type="button"
                  class="button danger"
                  :disabled="!desktopRuntime || keys.busy"
                  @click="deleteKeyEntry(entry)"
                >
                  <Trash2 :size="12" />
                  <span>{{ t('keyProxyLibrary.deleteKey') }}</span>
                </button>
              </div>
            </li>
          </ul>

          <form class="key-proxy-form" @submit.prevent="submitKeyForm">
            <div class="key-proxy-form-header">
              <strong>
                {{ rotatingKeyId ? t('keyProxyLibrary.saveRotation') : t('keyProxyLibrary.registerKey') }}
              </strong>
              <button
                v-if="rotatingKeyId"
                type="button"
                class="button"
                :disabled="keys.busy"
                @click="resetKeyForm"
              >
                {{ t('keyProxyLibrary.cancelEdit') }}
              </button>
            </div>

            <div class="form-grid key-proxy-form-grid">
              <label class="field full">
                <span>{{ t('keyProxyLibrary.keyLabel') }}</span>
                <input
                  v-model="keyForm.label"
                  type="text"
                  :placeholder="t('keyProxyLibrary.keyLabelPlaceholder')"
                  :disabled="!desktopRuntime || keys.busy"
                  required
                >
              </label>

              <label class="field full">
                <span>{{ t('keyProxyLibrary.keyPath') }}</span>
                <div class="key-proxy-path-row">
                  <input
                    v-model="keyForm.keyPath"
                    type="text"
                    class="mono"
                    :placeholder="t('keyProxyLibrary.keyPathPlaceholder')"
                    :disabled="!desktopRuntime || keys.busy"
                    required
                  >
                  <button
                    type="button"
                    class="button"
                    :disabled="!desktopRuntime || keys.busy"
                    @click="pickKeyFile"
                  >
                    {{ t('keyProxyLibrary.chooseKeyFile') }}
                  </button>
                  <button
                    type="button"
                    class="button"
                    :disabled="!desktopRuntime || keys.busy || !keyForm.keyPath.trim()"
                    @click="inspectKey"
                  >
                    {{ t('keyProxyLibrary.inspectKey') }}
                  </button>
                </div>
              </label>

              <div v-if="inspection" class="field full key-proxy-inspection">
                <CheckCircle2 :size="13" />
                <span>{{ inspection.algorithm }}</span>
                <code class="mono">{{ inspection.fingerprintSha256 }}</code>
                <span class="key-proxy-badge">
                  {{ inspection.encrypted ? t('keyProxyLibrary.inspectionEncrypted') : t('keyProxyLibrary.inspectionPlaintext') }}
                </span>
                <span v-if="inspection.supported" class="key-proxy-badge key-proxy-badge-accent">
                  {{ t('keyProxyLibrary.inspectionSupported') }}
                </span>
              </div>

              <label class="field full">
                <span>{{ t('keyProxyLibrary.keyPassphrase') }}</span>
                <input
                  v-model="keyForm.passphrase"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="t('keyProxyLibrary.keyPassphrasePlaceholder')"
                  :disabled="!desktopRuntime || keys.busy"
                >
              </label>

              <label class="field full key-proxy-checkbox">
                <input
                  v-model="keyForm.savePassphrase"
                  type="checkbox"
                  :disabled="!desktopRuntime || keys.busy"
                >
                <span>{{ t('keyProxyLibrary.savePassphrase') }}</span>
              </label>
            </div>

            <div class="key-proxy-form-footer">
              <button
                type="submit"
                class="button primary"
                :disabled="!desktopRuntime || keys.busy || !keyForm.label.trim() || !keyForm.keyPath.trim()"
              >
                {{ rotatingKeyId ? t('keyProxyLibrary.saveRotation') : t('keyProxyLibrary.registerKey') }}
              </button>
            </div>
          </form>
        </div>

        <div v-else class="key-proxy-pane" role="tabpanel">
          <div v-if="proxies.entries.length === 0" class="key-proxy-empty">
            {{ t('keyProxyLibrary.proxiesEmpty') }}
          </div>
          <ul v-else class="key-proxy-list">
            <li v-for="entry in proxies.entries" :key="entry.id" class="key-proxy-card">
              <div class="key-proxy-card-main">
                <div class="key-proxy-card-title-row">
                  <strong>{{ entry.label }}</strong>
                  <span class="key-proxy-badge">
                    {{ entry.kind === 'socks5' ? t('keyProxyLibrary.proxyKindSocks5') : t('keyProxyLibrary.proxyKindHttpConnect') }}
                  </span>
                  <span v-if="entry.hasPassword" class="key-proxy-badge key-proxy-badge-accent">
                    {{ t('keyProxyLibrary.savedPasswordBadge') }}
                  </span>
                </div>
                <div class="key-proxy-card-meta">
                  <code class="mono">{{ entry.username ? `${entry.username}@` : '' }}{{ entry.host }}:{{ entry.port }}</code>
                </div>
                <div
                  v-if="proxies.testResults[entry.id]"
                  class="key-proxy-test-status"
                  :class="{ reachable: proxies.testResults[entry.id]?.ok }"
                >
                  {{
                    proxies.testResults[entry.id]?.ok
                      ? t('keyProxyLibrary.proxyReachable', { latency: proxies.testResults[entry.id]?.latencyMs ?? 0 })
                      : t('keyProxyLibrary.proxyUnreachable', { code: proxies.testResults[entry.id]?.detailCode ?? '' })
                  }}
                </div>
              </div>
              <div class="key-proxy-card-actions">
                <button
                  type="button"
                  class="button"
                  :disabled="!desktopRuntime || proxies.busy || proxies.testingId === entry.id"
                  @click="proxies.runTest(entry.id)"
                >
                  <Play :size="12" />
                  <span>
                    {{ proxies.testingId === entry.id ? t('keyProxyLibrary.testingProxy') : t('keyProxyLibrary.testProxy') }}
                  </span>
                </button>
                <button
                  type="button"
                  class="button"
                  :disabled="!desktopRuntime || proxies.busy"
                  @click="startEditProxy(entry)"
                >
                  {{ t('keyProxyLibrary.editProxy') }}
                </button>
                <button
                  type="button"
                  class="button danger"
                  :disabled="!desktopRuntime || proxies.busy"
                  @click="deleteProxyEntry(entry)"
                >
                  <Trash2 :size="12" />
                  <span>{{ t('keyProxyLibrary.deleteProxy') }}</span>
                </button>
              </div>
            </li>
          </ul>

          <form class="key-proxy-form" @submit.prevent="submitProxyForm">
            <div class="key-proxy-form-header">
              <strong>
                {{ editingProxyId ? t('keyProxyLibrary.saveProxy') : t('keyProxyLibrary.createProxy') }}
              </strong>
              <button
                v-if="editingProxyId"
                type="button"
                class="button"
                :disabled="proxies.busy"
                @click="resetProxyForm"
              >
                {{ t('keyProxyLibrary.cancelEdit') }}
              </button>
            </div>

            <div class="form-grid key-proxy-form-grid">
              <label class="field">
                <span>{{ t('keyProxyLibrary.proxyName') }}</span>
                <input
                  v-model="proxyForm.label"
                  type="text"
                  :placeholder="t('keyProxyLibrary.proxyNamePlaceholder')"
                  :disabled="!desktopRuntime || proxies.busy"
                  required
                >
              </label>

              <label class="field">
                <span>{{ t('keyProxyLibrary.proxyKind') }}</span>
                <select
                  v-model="proxyForm.kind"
                  :disabled="!desktopRuntime || proxies.busy"
                  @change="onProxyKindChange"
                >
                  <option value="socks5">{{ t('keyProxyLibrary.proxyKindSocks5') }}</option>
                  <option value="http_connect">{{ t('keyProxyLibrary.proxyKindHttpConnect') }}</option>
                </select>
              </label>

              <label class="field">
                <span>{{ t('keyProxyLibrary.proxyHost') }}</span>
                <input
                  v-model="proxyForm.host"
                  type="text"
                  :placeholder="t('keyProxyLibrary.proxyHostPlaceholder')"
                  :disabled="!desktopRuntime || proxies.busy"
                  required
                >
              </label>

              <label class="field port-field">
                <span>{{ t('keyProxyLibrary.proxyPort') }}</span>
                <input
                  v-model.number="proxyForm.port"
                  type="number"
                  min="1"
                  max="65535"
                  :disabled="!desktopRuntime || proxies.busy"
                  required
                >
              </label>

              <label class="field">
                <span>{{ t('keyProxyLibrary.proxyUsername') }}</span>
                <input
                  v-model="proxyForm.username"
                  type="text"
                  autocomplete="off"
                  :placeholder="t('keyProxyLibrary.proxyUsernamePlaceholder')"
                  :disabled="!desktopRuntime || proxies.busy"
                >
              </label>

              <label class="field">
                <span>{{ t('keyProxyLibrary.proxyPassword') }}</span>
                <input
                  v-model="proxyForm.password"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="t('keyProxyLibrary.proxyPasswordPlaceholder')"
                  :disabled="!desktopRuntime || proxies.busy || proxyForm.clearPassword"
                >
              </label>

              <small v-if="editingProxyId && editingProxyHasPassword" class="field full field-hint">
                {{ t('keyProxyLibrary.proxyPasswordEditHint') }}
              </small>

              <label
                v-if="editingProxyId && editingProxyHasPassword"
                class="field full key-proxy-checkbox"
              >
                <input
                  v-model="proxyForm.clearPassword"
                  type="checkbox"
                  :disabled="!desktopRuntime || proxies.busy"
                >
                <span>{{ t('keyProxyLibrary.clearProxyPassword') }}</span>
              </label>
            </div>

            <div class="key-proxy-form-footer">
              <button
                type="submit"
                class="button primary"
                :disabled="!desktopRuntime || proxies.busy || !proxyForm.label.trim() || !proxyForm.host.trim()"
              >
                {{ editingProxyId ? t('keyProxyLibrary.saveProxy') : t('keyProxyLibrary.createProxy') }}
              </button>
            </div>
          </form>
        </div>
      </div>

      <footer class="dialog-footer">
        <button type="button" class="button" :disabled="keys.busy || proxies.busy" @click="close">
          {{ t('keyProxyLibrary.close') }}
        </button>
      </footer>
    </section>
  </div>
</template>
