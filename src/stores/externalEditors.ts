import { onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  closeExternalEditor,
  openRemoteFileInEditor,
  syncExternalEditor,
} from '@/api/domain/externalEditorApi';
import { selectExternalEditorExecutable } from '@/api/domain/filePickerApi';
import { inspectLocalEntry } from '@/api/domain/localFilesApi';
import { t } from '@/i18n';
import { useEventsStore } from '@/stores/events';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import type { AppError, ExternalEditorSession, TextEditorPreference } from '@/types/contracts';

const POLL_INTERVAL_MS = 700;

export const useExternalEditorsStore = defineStore('external-editors', () => {
  const settings = useSettingsStore();
  const ui = useUiStore();
  const events = useEventsStore();
  const sessions = ref<ExternalEditorSession[]>([]);
  const syncingIds = ref<string[]>([]);
  const error = ref<AppError | null>(null);
  const reportedFailureIds = new Set<string>();
  const observedLocalFiles = new Map<string, { modifiedAtMs: number | null; size: number | null }>();
  let pollTimer: number | null = null;
  let disposed = false;

  function ensurePolling(): void {
    if (disposed || pollTimer !== null || sessions.value.length === 0) return;
    pollTimer = window.setInterval(() => void syncAll(), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function upsert(session: ExternalEditorSession): void {
    const index = sessions.value.findIndex((candidate) => candidate.id === session.id);
    if (index >= 0) sessions.value[index] = session;
    else sessions.value = [...sessions.value, session];
    if (session.state === 'synced' || session.state === 'watching') reportedFailureIds.delete(session.id);
  }

  async function observeLocal(session: ExternalEditorSession): Promise<boolean> {
    const inspected = await inspectLocalEntry(session.localPath);
    if (!inspected.ok) return false;
    const previous = observedLocalFiles.get(session.id);
    const current = {
      modifiedAtMs: inspected.data.modifiedAtMs,
      size: inspected.data.size,
    };
    observedLocalFiles.set(session.id, current);
    return previous !== undefined
      && previous.modifiedAtMs === current.modifiedAtMs
      && previous.size === current.size;
  }

  async function openRemote(
    sessionId: string,
    remotePath: string,
    mode: 'preference' | 'external' | 'system' = 'preference',
  ): Promise<boolean> {
    error.value = null;
    const existing = sessions.value.find(
      (session) => session.sessionId === sessionId && session.remotePath === remotePath,
    );
    if (existing) {
      if (existing.state === 'watching' || existing.state === 'synced') return true;
      await close(existing.id);
    }
    let editorPath: string | null = null;
    if (mode === 'preference') {
      if (settings.value.textEditorPreference === 'external') {
        editorPath = settings.value.externalEditorPath;
        if (!editorPath) {
          if (!await configureExternalEditor()) return false;
          editorPath = settings.value.externalEditorPath;
        }
      } else {
        return false;
      }
    } else if (mode === 'external') {
      editorPath = settings.value.externalEditorPath;
      if (!editorPath && !await configureExternalEditor()) return false;
      editorPath = settings.value.externalEditorPath;
    }
    const result = await openRemoteFileInEditor(sessionId, remotePath, editorPath);
    if (!result.ok) {
      error.value = result.error;
      ui.notify(t(result.error.messageKey as Parameters<typeof t>[0]));
      return false;
    }
    upsert(result.data);
    await observeLocal(result.data);
    ensurePolling();
    events.record('system', 'EXTERNAL_EDITOR_OPENED', 'info', {
      sessionId,
      remotePath,
      editor: editorPath ? 'external' : 'system',
    });
    ui.notify(t('externalEditor.opened', { name: result.data.remotePath.split('/').pop() || result.data.remotePath }));
    return true;
  }

  async function setPreference(preference: TextEditorPreference): Promise<boolean> {
    if (preference === 'external' && !settings.value.externalEditorPath) {
      return configureExternalEditor();
    }
    const saved = await settings.save({
      ...settings.value,
      textEditorPreference: preference,
      shortcuts: { ...settings.value.shortcuts },
    });
    if (saved) ui.notify(t(preference === 'external' ? 'externalEditor.preferenceExternal' : 'externalEditor.preferenceInternal'));
    return saved;
  }

  async function configureExternalEditor(): Promise<boolean> {
    const selected = await selectExternalEditorExecutable(t('externalEditor.chooseTitle'));
    if (!selected.ok) {
      error.value = selected.error;
      ui.notify(t(selected.error.messageKey as Parameters<typeof t>[0]));
      return false;
    }
    if (!selected.data) return false;
    const saved = await settings.save({
      ...settings.value,
      textEditorPreference: 'external',
      externalEditorPath: selected.data,
      shortcuts: { ...settings.value.shortcuts },
    });
    if (saved) ui.notify(t('externalEditor.configured'));
    return saved;
  }

  async function syncOne(session: ExternalEditorSession): Promise<void> {
    if (syncingIds.value.includes(session.id)) return;
    if (await observeLocal(session)) return;
    syncingIds.value = [...syncingIds.value, session.id];
    try {
      const result = await syncExternalEditor(session.id);
      if (!result.ok) {
        if (result.error.code === 'EXTERNAL_EDIT_LOCAL_CHANGING') return;
        const current = sessions.value.find((candidate) => candidate.id === session.id);
        if (current) {
          current.state = result.error.code === 'EXTERNAL_EDIT_REMOTE_CHANGED' ? 'conflict' : 'failed';
          current.error = result.error;
        }
        if (!reportedFailureIds.has(session.id)) {
          reportedFailureIds.add(session.id);
          ui.notify(t(result.error.messageKey as Parameters<typeof t>[0]));
          events.record('system', 'EXTERNAL_EDITOR_SYNC_FAILED', 'error', {
            sessionId: session.sessionId,
            errorCode: result.error.code,
          });
        }
        return;
      }
      upsert(result.data.session);
      await observeLocal(result.data.session);
      if (result.data.uploaded) {
        ui.notify(t('externalEditor.uploaded', {
          name: result.data.session.remotePath.split('/').pop() || result.data.session.remotePath,
        }));
        events.record('system', 'EXTERNAL_EDITOR_SAVED', 'success', {
          sessionId: result.data.session.sessionId,
          bytes: result.data.session.bytes,
        });
      }
    } finally {
      syncingIds.value = syncingIds.value.filter((id) => id !== session.id);
    }
  }

  async function syncAll(): Promise<void> {
    const candidates = sessions.value.filter(
      (session) => session.state === 'watching' || session.state === 'synced',
    );
    await Promise.all(candidates.map((session) => syncOne(session)));
    if (sessions.value.length === 0) stopPolling();
  }

  async function close(id: string): Promise<void> {
    const result = await closeExternalEditor(id);
    if (!result.ok) error.value = result.error;
    sessions.value = sessions.value.filter((session) => session.id !== id);
    reportedFailureIds.delete(id);
    observedLocalFiles.delete(id);
    if (sessions.value.length === 0) stopPolling();
  }

  async function stopForSession(sessionId: string): Promise<void> {
    const attached = sessions.value.filter((session) => session.sessionId === sessionId);
    await Promise.all(attached.map((session) => close(session.id)));
  }

  function clear(): void {
    stopPolling();
    sessions.value = [];
    syncingIds.value = [];
    error.value = null;
    reportedFailureIds.clear();
    observedLocalFiles.clear();
  }

  onScopeDispose(() => {
    disposed = true;
    stopPolling();
  });

  return {
    sessions,
    syncingIds,
    error,
    openRemote,
    setPreference,
    configureExternalEditor,
    syncAll,
    close,
    stopForSession,
    clear,
  };
});
