<script setup lang="ts">
import { AlertTriangle, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore();
</script>

<template>
  <div class="dialog-layer confirm-layer" @mousedown.self="ui.resolveConfirmation(false)" @keydown.esc="ui.resolveConfirmation(false)">
    <section class="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <header class="dialog-header">
        <div><AlertTriangle :size="15" class="confirm-warning-icon" /><strong id="confirm-title">{{ ui.confirmation?.title }}</strong></div>
        <button type="button" class="icon-button" :aria-label="t('settings.cancel')" @click="ui.resolveConfirmation(false)"><X :size="14" /></button>
      </header>
      <div class="dialog-content"><p id="confirm-message">{{ ui.confirmation?.message }}</p></div>
      <footer class="dialog-footer">
        <button type="button" class="button" @click="ui.resolveConfirmation(false)">{{ t('settings.cancel') }}</button>
        <button autofocus type="button" class="button" :class="{ danger: ui.confirmation?.danger }" @click="ui.resolveConfirmation(true)">{{ ui.confirmation?.confirmLabel }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.confirm-warning-icon {
  color: hsl(var(--warning));
}

#confirm-message {
  max-height: min(50vh, 420px);
  margin: 0;
  overflow: auto;
  color: hsl(var(--text-secondary, var(--foreground)));
  font-size: 0.8571rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
