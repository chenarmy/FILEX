import { onMounted, onUnmounted } from 'vue';
import {
  INITIAL_UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  isUpdateCheckDue,
} from '@/domain/updatePolicy';
import { useUpdatesStore } from '@/stores/updates';

export function useUpdateScheduling(): void {
  const updates = useUpdatesStore();
  let initialTimer: number | null = null;
  let periodicTimer: number | null = null;

  function checkInBackground(): void {
    void updates.check(false);
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState !== 'visible') return;
    if (isUpdateCheckDue(updates.lastCheckAt, Date.now())) checkInBackground();
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void updates.initialize();
    initialTimer = window.setTimeout(() => {
      checkInBackground();
    }, INITIAL_UPDATE_CHECK_DELAY_MS);
    periodicTimer = window.setInterval(() => {
      checkInBackground();
    }, UPDATE_CHECK_INTERVAL_MS);
  });

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (initialTimer !== null) window.clearTimeout(initialTimer);
    if (periodicTimer !== null) window.clearInterval(periodicTimer);
  });
}
