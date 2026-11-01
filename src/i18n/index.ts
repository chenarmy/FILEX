import { computed, ref } from 'vue';
import { enUS } from './locales/en-US';
import { zhCN, type MessageKey } from './locales/zh-CN';
import type { LocaleCode } from '@/types/contracts';

const locale = ref<LocaleCode>('zh-CN');
const dictionaries = { 'zh-CN': zhCN, 'en-US': enUS } as const;

export const currentLocale = computed(() => locale.value);

export function setLocale(next: LocaleCode): void {
  locale.value = next;
  document.documentElement.lang = next;
  document.documentElement.dir = 'ltr';
}

export function t(key: MessageKey): string {
  return dictionaries[locale.value][key] ?? enUS[key] ?? key;
}
