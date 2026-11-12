<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Download, ShieldCheck, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import ReadOnlyMarkdown from '@/components/ui/ReadOnlyMarkdown.vue';
import { useUpdatesStore } from '@/stores/updates';

const updates = useUpdatesStore();
const dialogRoot = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const previousFocus = typeof document === 'undefined' ? null : document.activeElement;
const titleId = 'update-available-title';
const notes = computed(() => updates.releaseNotes?.trim() || t('updates.noReleaseNotes'));
const busy = computed(() => updates.isBusy);

onMounted(() => {
  void nextTick(() => closeButton.value?.focus());
});

onBeforeUnmount(restoreFocus);

function dismiss(): void {
  if (!busy.value) updates.dismiss();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    dismiss();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(dialogRoot.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [tabindex="0"]',
  ) ?? []).filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function restoreFocus(): void {
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
}
</script>

<template>
  <div class="dialog-layer update-dialog-layer" @mousedown.self="dismiss">
    <section
      ref="dialogRoot"
      class="dialog update-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      @keydown="handleKeydown"
    >
      <header class="dialog-header update-dialog-header">
        <div class="update-dialog-title">
          <strong :id="titleId">{{ t('updates.title') }}</strong>
          <span class="update-verified-badge"><ShieldCheck :size="10" />{{ t('updates.verified') }}</span>
        </div>
        <button ref="closeButton" type="button" class="icon-button" :disabled="busy" :aria-label="t('updates.close')" :title="t('updates.close')" @click="dismiss">
          <X :size="14" />
        </button>
      </header>

      <div class="update-dialog-body">
        <div class="update-version-summary">
          <span class="update-version-icon"><Download :size="16" aria-hidden="true" /></span>
          <div>
            <strong>{{ t('updates.summary', { latest: updates.availableVersion ?? '—', current: updates.currentVersion }) }}</strong>
            <small>{{ t('updates.securityNote') }}</small>
          </div>
        </div>

        <section class="update-notes" :aria-label="t('updates.releaseNotes')">
          <header class="update-section-heading">
            <strong>{{ t('updates.releaseNotes') }}</strong>
            <span v-if="updates.availableVersion" class="mono">v{{ updates.availableVersion }}</span>
          </header>
          <div class="update-notes-scroll">
            <ReadOnlyMarkdown :content="notes" />
          </div>
        </section>

        <div v-if="updates.phase === 'downloading'" class="update-progress" aria-live="polite">
          <div>
            <span>{{ updates.progressPercent === null ? t('settings.updateDownloading') : t('settings.updateDownloadProgress', { percent: updates.progressPercent }) }}</span>
            <span v-if="updates.progressPercent !== null" class="mono">{{ updates.progressPercent }}%</span>
          </div>
          <progress v-if="updates.progressPercent !== null" :value="updates.progressPercent" max="100" />
          <progress v-else />
        </div>
        <p v-else-if="updates.phase === 'installing'" class="update-installing" role="status">{{ t('settings.updateInstalling') }}</p>

        <div v-if="updates.errorMessage" class="inline-notice error" role="alert">{{ updates.errorMessage }}</div>
        <p class="update-dismiss-note">{{ t('updates.dismissNote') }}</p>
      </div>

      <footer class="dialog-footer update-dialog-footer">
        <div class="update-footer-secondary">
          <button type="button" class="button update-secondary-button" :disabled="busy" @click="dismiss">{{ t('updates.cancel') }}</button>
          <button type="button" class="button update-secondary-button" :disabled="busy || !updates.availableVersion" @click="updates.skipAvailableVersion">{{ t('updates.skip') }}</button>
        </div>
        <div class="update-footer-primary">
          <button v-if="updates.phase === 'downloading'" type="button" class="button danger" :disabled="updates.cancelling" @click="updates.cancelDownload">
            {{ updates.cancelling ? t('settings.updateCancelling') : t('settings.cancelUpdateDownload') }}
          </button>
          <button v-else type="button" class="button primary" :disabled="busy || !updates.availableVersion" @click="updates.install">
            <Download :size="13" />
            {{ updates.phase === 'installing' ? t('settings.updateInstallingShort') : t('updates.downloadAndInstall') }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.update-dialog-layer {
  z-index: 200;
}

.update-dialog {
  grid-template-rows: 48px minmax(0, 1fr) auto;
  width: min(720px, calc(100vw - 32px));
  max-height: min(720px, calc(100vh - 32px));
}

.update-dialog-header {
  gap: 16px;
  padding-inline: 18px 12px;
}

.update-dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.update-verified-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  color: hsl(var(--success));
  background: hsl(var(--success) / 0.08);
  border: 1px solid hsl(var(--success) / 0.24);
  border-radius: 999px;
  font-size: 0.6667rem;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.update-dialog-body {
  display: grid;
  align-content: start;
  gap: 16px;
  min-height: 0;
  overflow: auto;
  padding: 18px;
  scrollbar-gutter: stable;
}

.update-version-summary {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 14px;
  background: hsl(var(--primary) / 0.055);
  border: 1px solid hsl(var(--primary) / 0.24);
  border-radius: 6px;
}

.update-version-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.11);
  border: 1px solid hsl(var(--primary) / 0.18);
  border-radius: 6px;
}

.update-version-summary div {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.update-version-summary strong {
  font-size: 0.8333rem;
  line-height: 1.45;
}

.update-version-summary small {
  color: hsl(var(--muted-foreground));
  font-size: 0.7083rem;
  line-height: 1.6;
}

.update-notes {
  display: grid;
  gap: 8px;
  min-height: 0;
}

.update-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 18px;
}

.update-section-heading strong {
  color: hsl(var(--foreground));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.045em;
}

.update-section-heading span {
  color: hsl(var(--muted-foreground));
  font-size: 0.6667rem;
}

.update-notes-scroll {
  max-height: clamp(180px, 38vh, 320px);
  overflow: auto;
  padding: 14px 16px;
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
  border-radius: 5px;
  scrollbar-gutter: stable;
}

.update-notes-scroll :deep(.read-only-markdown) {
  color: hsl(var(--foreground));
  font-size: 0.75rem;
  line-height: 1.65;
}

.update-notes-scroll :deep(.read-only-markdown h3) {
  margin: 12px 0 6px;
  font-size: 0.75rem;
  font-weight: 700;
}

.update-notes-scroll :deep(.read-only-markdown h3:first-child) {
  margin-top: 0;
}

.update-notes-scroll :deep(.read-only-markdown p),
.update-notes-scroll :deep(.read-only-markdown ul),
.update-notes-scroll :deep(.read-only-markdown ol),
.update-notes-scroll :deep(.read-only-markdown blockquote),
.update-notes-scroll :deep(.read-only-markdown pre) {
  margin: 6px 0;
}

.update-notes-scroll :deep(.read-only-markdown ul),
.update-notes-scroll :deep(.read-only-markdown ol) {
  padding-inline-start: 20px;
}

.update-notes-scroll :deep(.read-only-markdown code) {
  padding: 1px 3px;
  background: hsl(var(--muted));
  border-radius: 3px;
  font-family: var(--font-mono);
}

.update-progress {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  background: hsl(var(--secondary) / 0.45);
  border: 1px solid hsl(var(--border));
  border-radius: 5px;
}

.update-progress > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: hsl(var(--muted-foreground));
  font-size: 0.75rem;
}

.update-progress progress {
  width: 100%;
  height: 6px;
  accent-color: hsl(var(--primary));
}

.update-installing {
  margin: 0;
  padding: 12px 14px;
  color: hsl(var(--primary));
  background: hsl(var(--primary) / 0.06);
  border: 1px solid hsl(var(--primary) / 0.2);
  border-radius: 5px;
}

.update-dismiss-note {
  margin: 0;
  color: hsl(var(--muted-foreground));
  font-size: 0.7083rem;
  line-height: 1.5;
}

.update-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 58px;
  padding: 10px 18px;
  background: hsl(var(--secondary) / 0.28);
  flex-wrap: wrap;
}

.update-footer-secondary,
.update-footer-primary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-footer-secondary {
  gap: 4px;
}

.update-footer-secondary .button {
  min-height: 30px;
}

.update-secondary-button {
  color: hsl(var(--muted-foreground));
  background: transparent;
  border-color: transparent;
}

.update-footer-primary .button {
  min-height: 30px;
  padding-inline: 12px;
}

@media (max-width: 620px) {
  .update-dialog-footer,
  .update-footer-secondary,
  .update-footer-primary {
    width: 100%;
  }

  .update-footer-primary {
    justify-content: flex-end;
  }
}

</style>
