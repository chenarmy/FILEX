<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CornerDownLeft, Search } from 'lucide-vue-next';
import { t } from '@/i18n';
import type { CommandPaletteCommand, CommandPaletteCommandId } from '@/types/commandPalette';
import { formatKeyboardShortcut } from '@/utils/keyboardShortcuts';

const props = defineProps<{
  commands: CommandPaletteCommand[];
}>();

const emit = defineEmits<{
  select: [commandId: CommandPaletteCommandId];
  close: [];
}>();

const input = ref<HTMLInputElement | null>(null);
const query = ref('');
const activeIndex = ref(0);
const previousFocus = ref<HTMLElement | null>(null);
const restoreFocus = ref(true);

const filteredCommands = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  if (!search) return props.commands;
  return props.commands.filter((command) => `${command.label} ${command.keywords ?? ''}`
    .toLocaleLowerCase()
    .includes(search));
});

const activeCommand = computed(() => {
  const current = filteredCommands.value[activeIndex.value];
  if (current && !current.disabled) return current;
  return filteredCommands.value.find((command) => !command.disabled) ?? null;
});

watch(filteredCommands, () => {
  const firstEnabled = filteredCommands.value.findIndex((command) => !command.disabled);
  activeIndex.value = firstEnabled < 0 ? 0 : firstEnabled;
});

function optionId(commandId: CommandPaletteCommandId): string {
  return `command-option-${commandId}`;
}

function activate(index: number): void {
  const command = filteredCommands.value[index];
  if (command && !command.disabled) activeIndex.value = index;
}

function moveActive(direction: 1 | -1): void {
  const commands = filteredCommands.value;
  if (!commands.some((command) => !command.disabled)) return;
  let index = activeIndex.value;
  for (let attempt = 0; attempt < commands.length; attempt += 1) {
    index = (index + direction + commands.length) % commands.length;
    if (!commands[index]?.disabled) {
      activeIndex.value = index;
      return;
    }
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    activate(filteredCommands.value.findIndex((command) => !command.disabled));
  } else if (event.key === 'End') {
    event.preventDefault();
    let lastEnabled = -1;
    for (let index = filteredCommands.value.length - 1; index >= 0; index -= 1) {
      if (!filteredCommands.value[index]?.disabled) {
        lastEnabled = index;
        break;
      }
    }
    activate(lastEnabled);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (activeCommand.value) run(activeCommand.value);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    input.value?.focus();
  }
}

function run(command: CommandPaletteCommand): void {
  if (command.disabled) return;
  restoreFocus.value = false;
  emit('select', command.id);
  emit('close');
}

function close(): void {
  emit('close');
}

onMounted(() => {
  previousFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => input.value?.focus());
});

onBeforeUnmount(() => {
  if (restoreFocus.value) previousFocus.value?.focus();
});
</script>

<template>
  <div class="dialog-layer command-palette-layer" @mousedown.self="close">
    <section class="dialog command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
      <h2 id="command-palette-title" class="sr-only">{{ t('commands.title') }}</h2>
      <label class="command-palette-search">
        <Search :size="15" aria-hidden="true" />
        <span class="sr-only">{{ t('commands.searchPlaceholder') }}</span>
        <input
          ref="input"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="t('commands.searchPlaceholder')"
          aria-controls="command-palette-listbox"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          :aria-activedescendant="activeCommand ? optionId(activeCommand.id) : undefined"
          @keydown="handleKeydown"
        >
      </label>
      <div id="command-palette-listbox" class="command-palette-results" role="listbox" :aria-label="t('commands.title')">
        <p v-if="filteredCommands.length === 0" class="command-palette-empty">{{ t('commands.empty') }}</p>
        <button
          v-for="(command, index) in filteredCommands"
          :id="optionId(command.id)"
          :key="command.id"
          type="button"
          class="command-palette-option"
          role="option"
          tabindex="-1"
          :aria-selected="activeIndex === index"
          :disabled="command.disabled"
          @mousedown.prevent
          @mouseenter="activate(index)"
          @click="run(command)"
        >
          <span>{{ command.label }}</span>
          <kbd v-if="command.shortcut">{{ formatKeyboardShortcut(command.shortcut) }}</kbd>
        </button>
      </div>
      <footer class="command-palette-footer">
        <span>{{ t('commands.keyboardHint') }}</span>
        <span><CornerDownLeft :size="12" aria-hidden="true" />{{ t('commands.runHint') }}</span>
      </footer>
    </section>
  </div>
</template>
