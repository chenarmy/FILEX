import { reactive } from 'vue';
import { defineStore } from 'pinia';
import { defaultSafeSettings, readSafeSettings, writeSafeSettings } from '@/runtime/safeSettingsRepository';
import { setLocale } from '@/i18n';
import type { SafeSettings } from '@/types/contracts';

export const useSettingsStore = defineStore('settings', () => {
  const value = reactive<SafeSettings>(readSafeSettings());

  function apply(): void {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (value.theme !== 'system') root.classList.add(value.theme);
    root.style.fontSize = `${value.uiFontSize}px`;
    root.style.fontFamily = value.uiFontFamily;
    root.dataset.reduceMotion = String(value.reduceMotion);
    setLocale(value.locale);
  }

  function save(next: SafeSettings): void {
    Object.assign(value, next);
    writeSafeSettings(value);
    apply();
  }

  function reset(): SafeSettings {
    return { ...defaultSafeSettings };
  }

  apply();
  return { value, apply, save, reset };
});
