import { onBeforeUnmount, ref, watch } from 'vue';
import { useMonitorStore } from '@/stores/monitor';
import { useProcessesStore } from '@/stores/processes';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

interface MonitorPollingOptions {
  /** Polling only runs while this returns true. */
  enabled: () => boolean;
  /** Also collect the process list (used by views that show processes). */
  withProcesses: () => boolean;
}

/**
 * Bounded monitor/process polling shared by the host panel and the legacy
 * monitor inspector: immediate collect on activation, interval polling with
 * exponential backoff, automatic suspension when backgrounded, and cleanup
 * when the owning component unmounts.
 */
export function useMonitorPolling(options: MonitorPollingOptions): void {
  const sessions = useSessionsStore();
  const settings = useSettingsStore();
  const monitor = useMonitorStore();
  const processes = useProcessesStore();
  const appForeground = ref(document.visibilityState === 'visible' && document.hasFocus());

  function updateAppForeground(): void {
    appForeground.value = document.visibilityState === 'visible' && document.hasFocus();
  }

  document.addEventListener('visibilitychange', updateAppForeground);
  window.addEventListener('focus', updateAppForeground);
  window.addEventListener('blur', updateAppForeground);
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', updateAppForeground);
    window.removeEventListener('focus', updateAppForeground);
    window.removeEventListener('blur', updateAppForeground);
  });

  watch(
    [
      () => sessions.activeSessionId,
      () => sessions.activeSession?.state,
      () => options.enabled(),
    ] as const,
    ([sessionId, state, enabled], _previous, onCleanup) => {
      monitor.clear();
      processes.clear();
      onCleanup(() => {
        monitor.clear();
        processes.clear();
      });
      if (sessionId && state === 'connected' && enabled && appForeground.value) {
        void monitor.collect(sessionId);
        if (options.withProcesses()) void processes.collect(sessionId);
      }
    },
    { immediate: true },
  );

  watch(
    [
      () => sessions.activeSessionId,
      () => sessions.activeSession?.state,
      () => options.enabled(),
      () => monitor.snapshot?.state,
      () => settings.value.monitorIntervalSeconds,
      appForeground,
      () => monitor.consecutiveFailures,
    ] as const,
    ([sessionId, state, enabled, monitorState, intervalSeconds, foreground, consecutiveFailures], _previous, onCleanup) => {
      if (!sessionId || state !== 'connected' || !enabled || !foreground) return;
      if (monitorState === 'unsupported' || monitorState === 'permission_denied') return;
      const backoffFactor = 2 ** Math.min(consecutiveFailures, 4);
      const pollIntervalMs = Math.min(300_000, intervalSeconds * backoffFactor * 1_000);
      const timer = window.setInterval(() => void monitor.collect(sessionId), pollIntervalMs);
      onCleanup(() => window.clearInterval(timer));
    },
    { immediate: true },
  );

  watch(
    [appForeground, () => options.enabled()] as const,
    ([foreground, enabled]) => {
      const session = sessions.activeSession;
      if (foreground && enabled && session?.state === 'connected') {
        void monitor.collect(session.id);
      }
    },
  );

  watch(
    [() => options.enabled(), () => options.withProcesses()] as const,
    ([enabled, withProcesses]) => {
      const session = sessions.activeSession;
      if (enabled && withProcesses && session?.state === 'connected') {
        void processes.collect(session.id);
      }
    },
  );
}
