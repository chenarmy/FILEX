<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { FolderOpen, ShieldCheck, Terminal, X } from 'lucide-vue-next';
import { isTauriRuntime } from '@/api/common';
import { selectLocalDirectory } from '@/api/domain/filePickerApi';
import { t } from '@/i18n';
import { useSessionsStore } from '@/stores/sessions';
import { useUiStore } from '@/stores/ui';
import type { LocalShellKind } from '@/types/contracts';

const sessions = useSessionsStore();
const ui = useUiStore();

const shellSelect = ref<HTMLSelectElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const selectedShellKind = ref<LocalShellKind | ''>('');
const workingDirectory = ref('');
const loadingShells = ref(false);
const previousFocus = ref<HTMLElement | null>(null);
const restoreFocus = ref(true);

const desktopAvailable = computed(() => isTauriRuntime());
const shellOptions = computed(() => sessions.localShellOptions);
const errorMessage = computed(() => (sessions.error
  ? t(sessions.error.messageKey as Parameters<typeof t>[0])
  : ''));

onMounted(async () => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  sessions.clearError();
  if (desktopAvailable.value) {
    loadingShells.value = true;
    try {
      const options = await sessions.loadLocalShellOptions();
      const defaultOption = options.find((item) => item.isDefault) ?? options[0];
      selectedShellKind.value = defaultOption?.kind ?? '';
    } finally {
      loadingShells.value = false;
    }
  }
  await nextTick();
  if (desktopAvailable.value && shellOptions.value.length > 0) {
    shellSelect.value?.focus();
  } else {
    cancelButton.value?.focus();
  }
});

onBeforeUnmount(() => {
  if (restoreFocus.value) previousFocus.value?.focus();
});

function close(): void {
  if (sessions.busy) return;
  sessions.clearError();
  ui.closeLocalTerminalDialog();
}

async function browseWorkingDirectory(): Promise<void> {
  if (!desktopAvailable.value || sessions.busy) return;
  const result = await selectLocalDirectory(t('localTerminal.chooseDirectory'));
  if (result.ok && result.data) {
    workingDirectory.value = result.data;
    sessions.clearError();
  }
}

async function submit(): Promise<void> {
  if (sessions.busy || !desktopAvailable.value) return;
  restoreFocus.value = false;
  const opened = await sessions.openLocalSession({
    shellKind: selectedShellKind.value || null,
    workingDirectory: workingDirectory.value.trim() || null,
    columns: 120,
    rows: 32,
  });
  if (opened) {
    ui.closeLocalTerminalDialog();
  } else {
    restoreFocus.value = true;
  }
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form
      class="dialog local-terminal-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-terminal-title"
      :aria-busy="sessions.busy || loadingShells"
      @submit.prevent="submit"
    >
      <header class="dialog-header">
        <div>
          <Terminal :size="15" />
          <strong id="local-terminal-title">{{ t('localTerminal.title') }}</strong>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('localTerminal.close')"
          :disabled="sessions.busy"
          @click="close"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="dialog-body">
        <div class="dialog-note">
          <ShieldCheck :size="15" />
          <span>{{ t('localTerminal.scopeNotice') }}</span>
        </div>

        <p v-if="!desktopAvailable" class="form-error" role="status">
          {{ t('localTerminal.desktopOnlyNotice') }}
        </p>

        <div class="form-grid">
          <label class="field full">
            <span>{{ t('localTerminal.shellLabel') }}</span>
            <select
              ref="shellSelect"
              v-model="selectedShellKind"
              :disabled="!desktopAvailable || loadingShells || shellOptions.length === 0"
              @change="sessions.clearError"
            >
              <option v-if="loadingShells" value="">{{ t('localTerminal.loadingShells') }}</option>
              <option v-else-if="shellOptions.length === 0" value="">{{ t('localTerminal.noShellsAvailable') }}</option>
              <option
                v-for="option in shellOptions"
                :key="option.kind"
                :value="option.kind"
              >
                {{ option.label }} ({{ option.executablePath }})
              </option>
            </select>
          </label>

          <label class="field full">
            <span>{{ t('localTerminal.directoryLabel') }}</span>
            <div class="local-directory-row">
              <input
                v-model="workingDirectory"
                type="text"
                :placeholder="t('localTerminal.directoryPlaceholder')"
                :disabled="!desktopAvailable || sessions.busy"
                autocomplete="off"
                spellcheck="false"
                @input="sessions.clearError"
              >
              <button
                type="button"
                class="button"
                :disabled="!desktopAvailable || sessions.busy"
                @click="browseWorkingDirectory"
              >
                <FolderOpen :size="13" />{{ t('localTerminal.browse') }}
              </button>
            </div>
          </label>
        </div>

        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
      </div>

      <footer class="dialog-footer">
        <button ref="cancelButton" type="button" class="button" :disabled="sessions.busy" @click="close">
          {{ t('profile.cancel') }}
        </button>
        <button
          type="submit"
          class="button primary"
          :disabled="!desktopAvailable || sessions.busy || loadingShells || shellOptions.length === 0"
        >
          <Terminal :size="13" />{{ t('localTerminal.open') }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.local-terminal-dialog {
  width: min(540px, calc(100vw - 32px));
}

.local-terminal-dialog select {
  width: 100%;
  min-width: 0;
}

.local-directory-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
</style>
