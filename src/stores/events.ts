import { ref } from 'vue';
import { defineStore } from 'pinia';

export type EventSeverity = 'info' | 'success' | 'warning' | 'error';

export interface ConsoleEvent {
  id: string;
  occurredAt: string;
  category: 'session' | 'security' | 'transfer' | 'tunnel' | 'system';
  severity: EventSeverity;
  code: string;
  details: Record<string, string | number | boolean>;
}

const sensitiveKey = /(password|passphrase|secret|token|private|credential|content|data)/i;

export const useEventsStore = defineStore('events', () => {
  const entries = ref<ConsoleEvent[]>([]);

  function record(
    category: ConsoleEvent['category'],
    code: string,
    severity: EventSeverity = 'info',
    details: Record<string, unknown> = {},
  ): void {
    const sanitized: ConsoleEvent['details'] = {};
    for (const [key, value] of Object.entries(details)) {
      if (sensitiveKey.test(key)) continue;
      if (typeof value === 'string') sanitized[key] = value.slice(0, 160);
      else if (typeof value === 'number' && Number.isFinite(value)) sanitized[key] = value;
      else if (typeof value === 'boolean') sanitized[key] = value;
    }
    entries.value.unshift({
      id: globalThis.crypto?.randomUUID?.() ?? `event-${Date.now()}`,
      occurredAt: new Date().toISOString(),
      category,
      severity,
      code: code.slice(0, 100),
      details: sanitized,
    });
    if (entries.value.length > 500) entries.value.length = 500;
  }

  function clear(): void {
    entries.value = [];
  }

  return { entries, record, clear };
});
