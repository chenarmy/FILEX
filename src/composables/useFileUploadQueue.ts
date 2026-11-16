import { ref } from 'vue';
import { t } from '@/i18n';
import { inspectLocalEntry } from '@/api/domain/localFilesApi';
import {
  extractClipboardPathsFromEvent,
  isSafeTransferName,
  joinRemoteUploadPath,
  MAX_UPLOAD_BATCH_ITEMS,
} from '@/domain/fileClipboard';
import { useFileClipboardStore } from '@/stores/fileClipboard';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSftpStore } from '@/stores/sftp';
import { useTransfersStore } from '@/stores/transfers';
import { useUiStore } from '@/stores/ui';
import type { CreateTransferInput, LocalFileEntry } from '@/types/contracts';

export type UploadBatchSource = 'drop' | 'paste' | 'picker';

export function useFileUploadQueue() {
  const sessions = useSessionsStore();
  const settings = useSettingsStore();
  const sftp = useSftpStore();
  const transfers = useTransfersStore();
  const ui = useUiStore();
  const fileClipboard = useFileClipboardStore();
  const uploadBusy = ref(false);

  function notifyQueued(source: UploadBatchSource, count: number): void {
    if (source === 'paste') ui.notify(t('files.pasteUploadQueued', { count }));
    else if (source === 'picker') ui.notify(t('fileMenu.uploadQueued', { count }));
    else ui.notify(t('inspector.dropUploadQueued', { count }));
  }

  async function queueLocalPathsForUpload(
    paths: readonly string[],
    options: {
      source: UploadBatchSource;
      remoteDirectory?: string;
      remoteReady: boolean;
      quickSession: boolean;
      onBeforeStart?: () => void;
    },
  ): Promise<number> {
    if (uploadBusy.value) return 0;
    const session = sessions.activeSession;
    if (!session || !options.remoteReady) {
      if (options.source === 'paste') ui.notify(t('files.pasteUploadRequiresSession'));
      return 0;
    }
    if (options.quickSession) {
      ui.notify(t('quick.savedHint'));
      return 0;
    }

    const distinctPaths = [...new Set(paths)];
    if (distinctPaths.length === 0) return 0;

    uploadBusy.value = true;
    options.onBeforeStart?.();

    const sessionId = session.id;
    const profileId = session.profileId;
    const remoteRoot = options.remoteDirectory ?? sftp.path;
    let unsupported = Math.max(0, distinctPaths.length - MAX_UPLOAD_BATCH_ITEMS);
    let queued = 0;

    try {
      for (const path of distinctPaths.slice(0, MAX_UPLOAD_BATCH_ITEMS)) {
        if (!path || path.length > 4_096 || path.includes('\0')) {
          unsupported += 1;
          continue;
        }
        const inspected = await inspectLocalEntry(path);
        if (!inspected.ok) {
          transfers.error = inspected.error;
          if (queued === 0) ui.notify(t(inspected.error.messageKey as Parameters<typeof t>[0]));
          break;
        }
        const entry = inspected.data;
        if (!isSafeTransferName(entry.name)
          || entry.isSymlink
          || (!entry.isDirectory && entry.size === null)) {
          unsupported += 1;
          continue;
        }
        const input: CreateTransferInput = {
          profileId,
          direction: 'upload',
          localPath: entry.path,
          remotePath: joinRemoteUploadPath(remoteRoot, entry.name),
          conflictPolicy: 'ask',
          totalBytes: entry.isDirectory ? null : entry.size,
        };
        if (!await transfers.enqueue(input, sessionId)) {
          if (queued === 0 && transfers.error) {
            ui.notify(t(transfers.error.messageKey as Parameters<typeof t>[0]));
          }
          break;
        }
        queued += 1;
      }

      if (queued > 0) {
        settings.value.taskTab = 'transfers';
        settings.value.taskDrawerOpen = true;
        notifyQueued(options.source, queued);
      }
      if (unsupported > 0) {
        ui.notify(t('inspector.dropUnsupportedItems', { count: unsupported }));
      }
      return queued;
    } catch {
      ui.notify(t(options.source === 'paste' ? 'files.pasteUploadFailed' : 'inspector.dropFailed'));
      return queued;
    } finally {
      uploadBusy.value = false;
    }
  }

  async function copyLocalEntryForUpload(entry: LocalFileEntry | null): Promise<boolean> {
    if (!entry) return false;
    if (entry.isSymlink || (!entry.isDirectory && entry.size === null) || !isSafeTransferName(entry.name)) {
      ui.notify(t('files.copyUploadUnsupported'));
      return false;
    }
    await fileClipboard.copyLocalPaths([entry.path]);
    ui.notify(t('files.copiedForUpload', { name: entry.name }));
    return true;
  }

  async function pasteUploadFromClipboard(options: {
    event?: ClipboardEvent | undefined;
    pane: 'local' | 'remote';
    dualPaneEnabled: boolean;
    remoteReady: boolean;
    quickSession: boolean;
    remoteDirectory?: string | undefined;
  }): Promise<number> {
    if (options.pane !== 'remote') {
      if (options.dualPaneEnabled && options.remoteReady && fileClipboard.localPaths.length > 0) {
        ui.notify(t('files.pasteUploadFocusRemote'));
      }
      return 0;
    }
    if (!options.remoteReady) {
      ui.notify(t('files.pasteUploadRequiresSession'));
      return 0;
    }
    if (options.quickSession) {
      ui.notify(t('quick.savedHint'));
      return 0;
    }

    const eventPaths = options.event ? extractClipboardPathsFromEvent(options.event) : [];
    const resolved = await fileClipboard.resolvePathsForPaste(eventPaths);
    if (!resolved.ok) {
      ui.notify(t(resolved.error.messageKey as Parameters<typeof t>[0]));
      return 0;
    }
    if (resolved.paths.length === 0) {
      ui.notify(t('files.pasteUploadEmpty'));
      return 0;
    }
    return queueLocalPathsForUpload(resolved.paths, {
      source: 'paste',
      remoteReady: options.remoteReady,
      quickSession: options.quickSession,
      ...(options.remoteDirectory !== undefined ? { remoteDirectory: options.remoteDirectory } : {}),
    });
  }

  return {
    uploadBusy,
    queueLocalPathsForUpload,
    copyLocalEntryForUpload,
    pasteUploadFromClipboard,
  };
}
