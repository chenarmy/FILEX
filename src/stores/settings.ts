import { nextTick, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { loadSafeSettings, saveSafeSettings } from '@/api/domain/settingsApi';
import { defaultSafeSettings, readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';
import { setLocale } from '@/i18n';
import type { SafeSettings } from '@/types/contracts';

export const useSettingsStore = defineStore('settings', () => {
  const value = reactive<SafeSettings>(readSafeSettings());
  const loaded = ref(false);
  const error = ref<string | null>(null);
  let persistenceTimer: number | null = null;
  let suppressAutoPersist = false;

  function apply(): void {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (value.theme !== 'system') root.classList.add(value.theme);
    root.style.fontSize = `${value.uiFontSize}px`;
    root.style.fontFamily = value.uiFontFamily;
    root.dataset.reduceMotion = String(value.reduceMotion);
    root.style.setProperty('--connections-pane-width', `${value.connectionsPaneWidth}px`);
    const inspectorWidth = value.dualPaneSftp ? Math.max(540, value.inspectorPaneWidth) : value.inspectorPaneWidth;
    root.style.setProperty('--inspector-pane-width', `${inspectorWidth}px`);
    root.style.setProperty('--assistant-pane-width', `${value.assistantPaneWidth}px`);
    root.style.setProperty('--host-panel-width', `${value.hostPanelWidth}px`);
    root.style.setProperty('--task-drawer-height', `${value.taskDrawerHeight}px`);
    setLocale(value.locale);
  }

  async function initialize(): Promise<void> {
    const result = await loadSafeSettings();
    if (result.ok) {
      writeSafeSettings(result.data);
      Object.assign(value, readSafeSettings());
      error.value = null;
    } else {
      error.value = result.error.messageKey;
    }
    loaded.value = true;
    apply();
  }

  async function save(next: SafeSettings): Promise<boolean> {
    const result = await saveSafeSettings({ ...next, shortcuts: { ...next.shortcuts } });
    if (!result.ok) {
      error.value = result.error.messageKey;
      return false;
    }
    if (persistenceTimer !== null) {
      window.clearTimeout(persistenceTimer);
      persistenceTimer = null;
    }
    suppressAutoPersist = true;
    Object.assign(value, result.data);
    writeSafeSettings(value);
    apply();
    error.value = null;
    await nextTick();
    suppressAutoPersist = false;
    return true;
  }

  function reset(): SafeSettings {
    return { ...defaultSafeSettings, shortcuts: { ...defaultSafeSettings.shortcuts } };
  }

  async function persistCurrent(): Promise<void> {
    const result = await saveSafeSettings({ ...value });
    error.value = result.ok ? null : result.error.messageKey;
    persistenceTimer = null;
  }

  watch(value, () => {
    writeSafeSettings(value);
    apply();
    if (!loaded.value || suppressAutoPersist) return;
    if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
    persistenceTimer = window.setTimeout(() => void persistCurrent(), 350);
  }, { deep: true });

  apply();
  return { value, loaded, error, initialize, apply, save, reset };
});
