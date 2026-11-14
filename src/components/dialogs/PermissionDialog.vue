<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ShieldCheck, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import {
  formatOctalMode,
  formatSymbolicMode,
  matrixFromMode,
  modeFromMatrix,
  parseOctalMode,
  type PermissionMatrix, type PermissionTriple,
} from '@/domain/permissions';
import type { RemoteFileEntry, RemotePermissionScope } from '@/types/contracts';
import type { MessageKey } from '@/i18n/locales/zh-CN';

const props = defineProps<{
  entry: RemoteFileEntry;
  host: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [input: { mode: number; recursive: boolean; scope: RemotePermissionScope }];
}>();

const octalInput = ref('');
const matrix = ref<PermissionMatrix>(matrixFromMode(props.entry.permissionsMode ?? 0));
const recursive = ref(false);
const scope = ref<RemotePermissionScope>('all');

watch(
  () => props.entry,
  (entry) => {
    const mode = entry.permissionsMode ?? 0;
    octalInput.value = formatOctalMode(mode);
    matrix.value = matrixFromMode(mode);
    recursive.value = false;
    scope.value = 'all';
  },
  { immediate: true },
);

const ownerLabel = computed(() => {
  const uid = props.entry.uid ?? null;
  const gid = props.entry.gid ?? null;
  if (uid === null && gid === null) return '—';
  if (gid === null) return String(uid);
  if (uid === null) return `—/${gid}`;
  return `${uid}/${gid}`;
});

const octalInvalid = computed(() => octalInput.value.trim() !== '' && parseOctalMode(octalInput.value) === null);
const effectiveMode = computed(() => parseOctalMode(octalInput.value) ?? modeFromMatrix(matrix.value));
const valid = computed(() => !octalInvalid.value && !props.busy);
const recursiveAvailable = computed(() => props.entry.isDirectory && !props.entry.isSymlink);

function submit(): void {
  if (!valid.value) return;
  emit('submit', {
    mode: effectiveMode.value,
    recursive: recursiveAvailable.value && recursive.value,
    scope: scope.value,
  });
}

watch(octalInput, (value) => {
  const parsed = parseOctalMode(value);
  if (parsed !== null) matrix.value = matrixFromMode(parsed);
});

function toggleDigit(
  section: 'owner' | 'group' | 'other',
  bit: keyof PermissionTriple,
): void {
  matrix.value = {
    ...matrix.value,
    [section]: { ...matrix.value[section], [bit]: !matrix.value[section][bit] },
  };
  octalInput.value = formatOctalMode(modeFromMatrix(matrix.value));
}

function toggleSpecial(bit: 'setuid' | 'setgid' | 'sticky'): void {
  matrix.value = { ...matrix.value, [bit]: !matrix.value[bit] };
  octalInput.value = formatOctalMode(modeFromMatrix(matrix.value));
}

const bitLabels: Record<keyof PermissionTriple, MessageKey> = {
  read: 'permissions.read',
  write: 'permissions.write',
  execute: 'permissions.execute',
};
const triples: Array<{ section: 'owner' | 'group' | 'other'; label: MessageKey }> = [
  { section: 'owner', label: 'permissions.owner' },
  { section: 'group', label: 'permissions.group' },
  { section: 'other', label: 'permissions.other' },
];
const scopeOptions: RemotePermissionScope[] = ['all', 'files', 'directories'];
</script>

<template>
  <div class="dialog-layer" @mousedown.self="!busy && emit('close')" @keydown.esc.stop.prevent="!busy && emit('close')">
    <form
      class="dialog permission-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-dialog-title"
      :aria-busy="busy"
      @submit.prevent="submit"
    >
      <header class="dialog-header">
        <div><ShieldCheck :size="15" /><strong id="permission-dialog-title">{{ t('permissions.title') }}</strong></div>
        <button type="button" class="icon-button" :disabled="busy" :aria-label="t('settings.close')" @click="emit('close')"><X :size="14" /></button>
      </header>
      <div class="dialog-body">
        <dl class="move-target-list">
          <div><dt>{{ t('permissions.path') }}</dt><dd class="mono">{{ entry.path }}</dd></div>
          <div><dt>{{ t('permissions.host') }}</dt><dd class="mono">{{ host }}</dd></div>
          <div><dt>{{ t('permissions.ownerColumn') }}</dt><dd class="mono">{{ ownerLabel }}</dd></div>
          <div>
            <dt>{{ t('permissions.currentMode') }}</dt>
            <dd class="mono">{{ entry.permissionsMode === null ? '—' : formatSymbolicMode(entry.permissionsMode) }}</dd>
          </div>
        </dl>

        <table class="permission-matrix">
          <thead>
            <tr>
              <th scope="col">{{ t('permissions.who') }}</th>
              <th scope="col">{{ t('permissions.read') }}</th>
              <th scope="col">{{ t('permissions.write') }}</th>
              <th scope="col">{{ t('permissions.execute') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="triple in triples" :key="triple.section">
              <th scope="row">{{ t(triple.label) }}</th>
              <td v-for="(label, bit) in bitLabels" :key="bit">
                <input
                  type="checkbox"
                  :checked="matrix[triple.section][bit]"
                  :aria-label="`${t(triple.label)} · ${t(label)}`"
                  @change="toggleDigit(triple.section, bit)"
                >
              </td>
            </tr>
            <tr>
              <th scope="row">{{ t('permissions.special') }}</th>
              <td><label class="permission-special"><input type="checkbox" :checked="matrix.setuid" @change="toggleSpecial('setuid')"> setuid</label></td>
              <td><label class="permission-special"><input type="checkbox" :checked="matrix.setgid" @change="toggleSpecial('setgid')"> setgid</label></td>
              <td><label class="permission-special"><input type="checkbox" :checked="matrix.sticky" @change="toggleSpecial('sticky')"> sticky</label></td>
            </tr>
          </tbody>
        </table>

        <fieldset class="permission-recursion" :disabled="!recursiveAvailable">
          <legend>{{ t('permissions.recursion') }}</legend>
          <label class="permission-recursive-toggle">
            <input v-model="recursive" type="checkbox">
            <span>{{ t('permissions.recursiveChildren') }}</span>
          </label>
          <div class="permission-scope" role="radiogroup" :aria-label="t('permissions.scope')">
            <label v-for="option in scopeOptions" :key="option">
              <input v-model="scope" type="radio" name="permission-scope" :value="option">
              <span>{{ t(`permissions.scope.${option}` as Parameters<typeof t>[0]) }}</span>
            </label>
          </div>
          <p class="dialog-note">{{ t('permissions.recursionHelp') }}</p>
        </fieldset>

        <label class="field">
          {{ t('permissions.octal') }}
          <input
            v-model="octalInput"
            class="mono"
            maxlength="4"
            autocomplete="off"
            spellcheck="false"
            :placeholder="formatOctalMode(entry.permissionsMode ?? 0)"
          >
        </label>
        <p class="dialog-note mono">{{ t('permissions.preview', { mode: formatSymbolicMode(effectiveMode), octal: formatOctalMode(effectiveMode) }) }}</p>
        <p v-if="octalInvalid" class="form-error" role="alert">{{ t('permissions.invalidOctal') }}</p>
        <p class="dialog-note">{{ t('permissions.help') }}</p>
      </div>
      <footer class="dialog-footer">
        <button type="button" class="button" :disabled="busy" @click="emit('close')">{{ t('settings.cancel') }}</button>
        <button type="submit" class="button primary" :disabled="!valid">
          {{ busy ? t('permissions.applying') : t('permissions.apply') }}
        </button>
      </footer>
    </form>
  </div>
</template>
