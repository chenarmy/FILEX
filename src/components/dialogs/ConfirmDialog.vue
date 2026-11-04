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
        <strong id="confirm-title"><AlertTriangle :size="15" />{{ ui.confirmation?.title }}</strong>
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
#confirm-message { max-height: min(50vh, 420px); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
