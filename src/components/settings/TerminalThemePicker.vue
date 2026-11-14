<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Check } from 'lucide-vue-next';
import {
  normalizeTerminalTheme,
  resolveTerminalPalette,
  terminalThemes,
  type TerminalThemeDefinition,
} from '@/domain/terminalThemes';
import { t } from '@/i18n';
import type { TerminalThemePreference, ThemePreference } from '@/types/contracts';

const props = defineProps<{
  modelValue: TerminalThemePreference;
  appTheme: ThemePreference;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: TerminalThemePreference];
}>();

const systemAppearance = ref<'dark' | 'light'>(
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
);
const optionElements = ref<(HTMLButtonElement | null)[]>([]);
let systemThemeMedia: MediaQueryList | null = null;
const defaultTerminalTheme = terminalThemes[0];
if (!defaultTerminalTheme) throw new Error('Terminal theme catalog must not be empty.');

const selectedValue = computed(() => normalizeTerminalTheme(props.modelValue));
const selectedTheme = computed(() => terminalThemes.find((theme) => theme.id === selectedValue.value)
  ?? defaultTerminalTheme);
const selectedPalette = computed(() => resolveTerminalPalette(
  selectedValue.value,
  props.appTheme,
  systemAppearance.value,
));
const previewStyle = computed(() => ({
  '--terminal-theme-background': selectedPalette.value.background,
  '--terminal-theme-foreground': selectedPalette.value.foreground,
  '--terminal-theme-cursor': selectedPalette.value.cursor,
}));
const previewItems = computed(() => terminalThemes.map((theme) => ({
  theme,
  palette: resolveTerminalPalette(theme.id, props.appTheme, systemAppearance.value),
})));
const ansiColors = computed(() => {
  const palette = selectedPalette.value;
  return [
    palette.black,
    palette.red,
    palette.green,
    palette.yellow,
    palette.blue,
    palette.magenta,
    palette.cyan,
    palette.white,
    palette.brightBlack,
    palette.brightRed,
    palette.brightGreen,
    palette.brightYellow,
    palette.brightBlue,
    palette.brightMagenta,
    palette.brightCyan,
    palette.brightWhite,
  ];
});

function appearanceLabel(theme: TerminalThemeDefinition): string {
  if (theme.appearance === 'adaptive') return t('settings.terminalThemeAdaptive');
  return t(theme.appearance === 'light' ? 'settings.terminalThemeLight' : 'settings.terminalThemeDark');
}

function selectTheme(theme: TerminalThemePreference, focus = false): void {
  emit('update:modelValue', theme);
  if (!focus) return;
  void nextTick(() => {
    const index = terminalThemes.findIndex((candidate) => candidate.id === theme);
    optionElements.value[index]?.focus();
  });
}

function setOptionElement(element: unknown, index: number): void {
  optionElements.value[index] = element instanceof HTMLButtonElement ? element : null;
}

function handleOptionKeydown(event: KeyboardEvent, index: number): void {
  let nextIndex: number | null = null;
  if (event.key === 'ArrowDown') nextIndex = (index + 1) % terminalThemes.length;
  else if (event.key === 'ArrowUp') nextIndex = (index - 1 + terminalThemes.length) % terminalThemes.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = terminalThemes.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const nextTheme = terminalThemes[nextIndex];
  if (nextTheme) selectTheme(nextTheme.id, true);
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemAppearance.value = event.matches ? 'light' : 'dark';
}

onMounted(() => {
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)');
  systemAppearance.value = systemThemeMedia.matches ? 'light' : 'dark';
  systemThemeMedia.addEventListener('change', handleSystemThemeChange);
});

onBeforeUnmount(() => {
  systemThemeMedia?.removeEventListener('change', handleSystemThemeChange);
});
</script>

<template>
  <section class="terminal-theme-picker">
    <header class="theme-picker-heading">
      <div>
        <strong>{{ t('settings.terminalTheme') }}</strong>
        <small>{{ t('settings.terminalThemeCount', { count: terminalThemes.length }) }}</small>
      </div>
      <span class="theme-current-name">{{ selectedTheme.name }}</span>
    </header>

    <div class="theme-picker-layout">
      <div
        class="theme-option-list"
        role="listbox"
        :aria-label="t('settings.terminalThemeListLabel')"
      >
        <button
          v-for="(item, index) in previewItems"
          :key="item.theme.id"
          :ref="(element) => setOptionElement(element, index)"
          type="button"
          class="theme-option"
          :class="{ selected: item.theme.id === selectedValue }"
          role="option"
          :aria-selected="item.theme.id === selectedValue"
          :tabindex="item.theme.id === selectedValue ? 0 : -1"
          @click="selectTheme(item.theme.id)"
          @keydown="handleOptionKeydown($event, index)"
        >
          <span class="theme-option-copy">
            <span class="theme-option-name">{{ item.theme.name }}</span>
            <span class="theme-swatches" aria-hidden="true">
              <i
                v-for="color in [
                  item.palette.red,
                  item.palette.green,
                  item.palette.yellow,
                  item.palette.blue,
                  item.palette.magenta,
                  item.palette.cyan,
                ]"
                :key="color"
                :style="{ backgroundColor: color }"
              />
            </span>
          </span>
          <span class="theme-option-meta">
            <small>{{ appearanceLabel(item.theme) }}</small>
            <Check v-if="item.theme.id === selectedValue" :size="12" :aria-hidden="true" />
          </span>
        </button>
      </div>

      <section
        class="terminal-theme-preview"
        role="group"
        :aria-label="t('settings.terminalThemePreviewLabel', { theme: selectedTheme.name })"
      >
        <div class="theme-preview-screen" :style="previewStyle">
          <div class="theme-preview-line">
            <span :style="{ color: selectedPalette.brightGreen }">root@edge-01</span>
            <span :style="{ color: selectedPalette.foreground }">:</span>
            <span :style="{ color: selectedPalette.brightBlue }">~</span>
            <span># systemctl --failed</span>
            <span class="theme-preview-cursor" />
          </div>
          <div class="theme-preview-line" :style="{ color: selectedPalette.brightBlack }">0 loaded units listed.</div>
          <div class="theme-preview-line">
            <span :style="{ color: selectedPalette.green }">✓</span>
            <span>ssh.service</span>
            <span :style="{ color: selectedPalette.brightBlack }">active (running)</span>
          </div>
          <div class="theme-preview-line">
            <span :style="{ color: selectedPalette.yellow }">●</span>
            <span :style="{ color: selectedPalette.foreground }">network.target</span>
            <span :style="{ color: selectedPalette.yellow }">degraded</span>
          </div>
          <div class="theme-preview-line">
            <span :style="{ color: selectedPalette.red }">error:</span>
            <span :style="{ color: selectedPalette.foreground }">permission denied</span>
          </div>
          <div class="theme-preview-line">
            <span
              class="theme-preview-selection"
              :style="{
                color: selectedPalette.selectionForeground,
                backgroundColor: selectedPalette.selectionBackground,
              }"
            >selected log output</span>
          </div>
          <div class="theme-ansi-strip" aria-hidden="true">
            <span
              v-for="color in ansiColors"
              :key="color"
              :style="{ backgroundColor: color }"
            />
          </div>
          <div class="theme-preview-line">
            <span :style="{ color: selectedPalette.brightGreen }">root@edge-01</span>
            <span>:</span>
            <span :style="{ color: selectedPalette.brightBlue }">~</span>
            <span># </span>
            <span class="theme-preview-cursor" />
          </div>
        </div>
        <footer class="theme-preview-footer">
          <span>{{ t('settings.terminalThemePreviewNote') }}</span>
          <span>{{ appearanceLabel(selectedTheme) }}</span>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.terminal-theme-picker {
  display: grid;
  gap: 10px;
  margin-block: 8px 4px;
  padding: 12px;
  border: 1px solid hsl(var(--border-subtle));
  border-radius: var(--radius-panel);
  background: hsl(var(--surface-inset));
}

.theme-picker-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.theme-picker-heading > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.theme-picker-heading strong {
  font-size: 0.8571rem;
  font-weight: 600;
}

.theme-picker-heading small,
.theme-preview-footer {
  color: hsl(var(--muted-foreground));
  font-size: 0.75rem;
}

.theme-current-name {
  overflow: hidden;
  color: hsl(var(--primary));
  font-size: 0.75rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-picker-layout {
  display: grid;
  grid-template-columns: minmax(178px, 0.78fr) minmax(250px, 1.22fr);
  min-height: 250px;
  gap: 10px;
}

.theme-option-list {
  min-width: 0;
  height: 250px;
  overflow: auto;
  border: 1px solid hsl(var(--border-subtle));
  border-radius: var(--radius-control);
  background: hsl(var(--background));
  scrollbar-width: thin;
}

.theme-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  width: 100%;
  min-width: 0;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-bottom: 1px solid hsl(var(--border-subtle));
  border-radius: 0;
  color: hsl(var(--foreground));
  background: transparent;
  text-align: start;
  transition: background var(--duration-micro) var(--ease-arco),
    color var(--duration-micro) var(--ease-arco);
}

.theme-option:last-child {
  border-bottom: 0;
}

.theme-option:hover {
  background: hsl(var(--fill-subtle));
}

.theme-option.selected {
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.12);
  box-shadow: inset 3px 0 hsl(var(--primary));
}

.theme-option:focus-visible {
  position: relative;
  z-index: 1;
  outline: 1px solid hsl(var(--primary));
  outline-offset: -1px;
}

.theme-option-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.theme-option-name {
  overflow: hidden;
  font-size: 0.8571rem;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-swatches {
  display: flex;
  gap: 3px;
}

.theme-swatches i {
  width: 10px;
  height: 4px;
  border-radius: 1px;
}

.theme-option-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  color: hsl(var(--muted-foreground));
}

.theme-option-meta small {
  font-size: 0.7143rem;
  white-space: nowrap;
}

.theme-option.selected .theme-option-meta {
  color: hsl(var(--primary));
}

.terminal-theme-preview {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 28px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid hsl(var(--border-subtle));
  border-radius: var(--radius-control);
  background: hsl(var(--background));
}

.theme-preview-screen {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  overflow: hidden;
  color: var(--terminal-theme-foreground);
  background: var(--terminal-theme-background);
  font-family: var(--terminal-font-family, ui-monospace, monospace);
  font-size: clamp(11px, 0.78rem, 16px);
  line-height: 1.35;
}

.theme-preview-line {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-preview-line > span + span {
  margin-inline-start: 4px;
}

.theme-preview-selection {
  display: inline-block;
  max-width: 100%;
  padding-inline: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.theme-preview-cursor {
  display: inline-block;
  width: 0.58em;
  height: 1.05em;
  background: var(--terminal-theme-cursor);
  vertical-align: text-bottom;
}

.theme-ansi-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-block: auto 2px;
  padding-block: 7px;
  border-block: 1px solid color-mix(in srgb, var(--terminal-theme-foreground) 18%, transparent);
}

.theme-ansi-strip span {
  width: 11px;
  height: 8px;
  border-radius: 1px;
}

.theme-preview-footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-inline: 8px;
  border-top: 1px solid hsl(var(--border));
  background: hsl(var(--card));
}

.theme-preview-footer span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-preview-footer span:last-child {
  flex: 0 0 auto;
}
</style>
