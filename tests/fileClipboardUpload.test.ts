import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  isSafeTransferName,
  joinRemoteUploadPath,
  parseClipboardFileUriList,
} from '@/domain/fileClipboard';
import { useFileClipboardStore } from '@/stores/fileClipboard';
import { useFileUploadQueue } from '@/composables/useFileUploadQueue';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSftpStore } from '@/stores/sftp';
import { useUiStore } from '@/stores/ui';
import type { LocalFileEntry, TransferTask } from '@/types/contracts';

const clipboardMocks = vi.hoisted(() => ({
  readClipboardFilePaths: vi.fn(),
  writeClipboardFilePaths: vi.fn(),
}));

const localFilesMocks = vi.hoisted(() => ({
  inspectLocalEntry: vi.fn(),
}));

const transferMocks = vi.hoisted(() => ({
  listTransfers: vi.fn(),
  enqueueTransfer: vi.fn(),
  resumeTransfer: vi.fn(),
  pauseTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  retryTransfer: vi.fn(),
  resetTransferStaging: vi.fn(),
  clearCompletedTransfers: vi.fn(),
}));

vi.mock('@/api/domain/clipboardFilesApi', () => clipboardMocks);
vi.mock('@/api/domain/localFilesApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/localFilesApi');
  return {
    ...actual,
    inspectLocalEntry: localFilesMocks.inspectLocalEntry,
  };
});
vi.mock('@/api/domain/transfersApi', () => transferMocks);

function makeTask(id: string, localPath: string, remotePath: string): TransferTask {
  return {
    id,
    profileId: 'prof-1',
    sessionId: 'sess-1',
    direction: 'upload',
    localPath,
    remotePath,
    destinationProfileId: null,
    destinationSessionId: null,
    destinationRemotePath: null,
    state: 'queued',
    bytesTransferred: 0,
    totalBytes: 256,
    conflictPolicy: 'ask',
    remoteSizeBytes: null,
    remoteMtimeMs: null,
    stagingPath: null,
    resumeState: 'not_applicable',
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function makeLocalEntry(overrides: Partial<LocalFileEntry> = {}): LocalFileEntry {
  return {
    name: 'release.tar.gz',
    path: 'C:\\deploy\\release.tar.gz',
    isDirectory: false,
    isSymlink: false,
    size: 256,
    modifiedAtMs: 1_700_000_000_000,
    permissionsMode: null,
    ...overrides,
  };
}

describe('clipboard upload store, queue, and URI parser', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('parses file:// URI lists safely and rejects unsafe paths/names', () => {
    const parsed = parseClipboardFileUriList(
      '# comment\r\nfile:///tmp/my%20folder\r\nhttps://example.com/nope\r\nfile:///C:/deploy/app%201.zip\r\nfile:///tmp/bad%00name\r\n',
    );
    expect(parsed).toEqual(['/tmp/my folder', 'C:\\deploy\\app 1.zip']);
    expect(isSafeTransferName('app.tar.gz')).toBe(true);
    expect(isSafeTransferName('..')).toBe(false);
    expect(isSafeTransferName('dir/file')).toBe(false);
    expect(joinRemoteUploadPath('/srv/www/', 'index.html')).toBe('/srv/www/index.html');
  });

  it('prefers newer OS clipboard copies over earlier in-app local copies', async () => {
    const clipboard = useFileClipboardStore();

    clipboardMocks.writeClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { written: true, sequence: 10 },
    });
    await clipboard.copyLocalPaths(['C:\\local\\from-app.txt']);

    // Sequence unchanged -> uses in-app / matching OS clipboard entry
    clipboardMocks.readClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { paths: ['C:\\local\\from-app.txt'], sequence: 10, supported: true },
    });
    expect(await clipboard.resolvePathsForPaste()).toEqual({
      ok: true,
      paths: ['C:\\local\\from-app.txt'],
    });

    // External app copied a different file (sequence advanced to 11)
    clipboardMocks.readClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { paths: ['D:\\explorer\\external.zip'], sequence: 11, supported: true },
    });
    expect(await clipboard.resolvePathsForPaste()).toEqual({
      ok: true,
      paths: ['D:\\explorer\\external.zip'],
    });
    expect(clipboard.localPaths).toEqual([]);

    // External app copied plain text (sequence advanced to 12, no file paths)
    clipboardMocks.readClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { paths: [], sequence: 12, supported: true },
    });
    expect(await clipboard.resolvePathsForPaste()).toEqual({ ok: true, paths: [] });
  });

  it('queues pasted files and folders for upload while blocking symlinks and unsafe contexts', async () => {
    const sessions = useSessionsStore();
    const settings = useSettingsStore();
    const sftp = useSftpStore();
    const ui = useUiStore();

    sessions.summaries = [{
      id: 'sess-1',
      generation: 1,
      profileId: 'prof-1',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit'],
      state: 'connected',
      host: '10.0.0.5',
      port: 22,
      username: 'ops',
      lastError: null,
    }];
    sessions.activeSessionId = 'sess-1';
    sftp.sessionId = 'sess-1';
    sftp.path = '/srv/releases';

    const queue = useFileUploadQueue();

    // Symlink local copy is rejected
    expect(await queue.copyLocalEntryForUpload(makeLocalEntry({ isSymlink: true }))).toBe(false);
    expect(ui.toast).toContain('符号链接');

    // Copying a valid local directory sets clipboard and notifies user
    clipboardMocks.writeClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { written: false, sequence: null },
    });
    clipboardMocks.readClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: { paths: [], sequence: null, supported: false },
    });
    expect(await queue.copyLocalEntryForUpload(makeLocalEntry({
      name: 'dist',
      path: 'C:\\deploy\\dist',
      isDirectory: true,
      size: null,
    }))).toBe(true);
    expect(ui.toast).toContain('Ctrl+V');

    // Pasting while still on local pane in dual-pane mode prompts user to focus remote pane
    expect(await queue.pasteUploadFromClipboard({
      pane: 'local',
      dualPaneEnabled: true,
      remoteReady: true,
      quickSession: false,
    })).toBe(0);
    expect(ui.toast).toContain('远端目录窗格');

    // Pasting in remote pane inspects and enqueues both files and folders
    clipboardMocks.readClipboardFilePaths.mockResolvedValueOnce({
      ok: true,
      data: {
        paths: ['C:\\deploy\\dist', 'C:\\deploy\\app.env'],
        sequence: 25,
        supported: true,
      },
    });
    localFilesMocks.inspectLocalEntry
      .mockResolvedValueOnce({
        ok: true,
        data: makeLocalEntry({ name: 'dist', path: 'C:\\deploy\\dist', isDirectory: true, size: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: makeLocalEntry({ name: 'app.env', path: 'C:\\deploy\\app.env', isDirectory: false, size: 128 }),
      });
    transferMocks.enqueueTransfer
      .mockResolvedValueOnce({ ok: true, data: makeTask('t-1', 'C:\\deploy\\dist', '/srv/releases/dist') })
      .mockResolvedValueOnce({ ok: true, data: makeTask('t-2', 'C:\\deploy\\app.env', '/srv/releases/app.env') });

    const queued = await queue.pasteUploadFromClipboard({
      pane: 'remote',
      dualPaneEnabled: true,
      remoteReady: true,
      quickSession: false,
    });
    expect(queued).toBe(2);
    expect(transferMocks.enqueueTransfer).toHaveBeenCalledTimes(2);
    expect(transferMocks.enqueueTransfer).toHaveBeenNthCalledWith(
      1,
      {
        profileId: 'prof-1',
        direction: 'upload',
        localPath: 'C:\\deploy\\dist',
        remotePath: '/srv/releases/dist',
        conflictPolicy: 'ask',
        totalBytes: null,
      },
      'sess-1',
    );
    expect(settings.value.taskTab).toBe('transfers');
    expect(settings.value.taskDrawerOpen).toBe(true);
  });
});
