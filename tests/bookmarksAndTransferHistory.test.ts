import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBookmarksStore } from '@/stores/bookmarks';
import { useConnectionsStore } from '@/stores/connections';
import { useTransfersStore } from '@/stores/transfers';
import type { ConnectionProfile, PathBookmark, TransferTask } from '@/types/contracts';

const bookmarkMocks = vi.hoisted(() => ({
  listPathBookmarks: vi.fn(),
  savePathBookmark: vi.fn(),
  deletePathBookmark: vi.fn(),
}));

const transferMocks = vi.hoisted(() => ({
  listTransfers: vi.fn(),
  enqueueTransfer: vi.fn(),
  resumeTransfer: vi.fn(),
  pauseTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  retryTransfer: vi.fn(),
  clearCompletedTransfers: vi.fn(),
}));

vi.mock('@/api/domain/bookmarksApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/bookmarksApi');
  return {
    ...actual,
    listPathBookmarks: bookmarkMocks.listPathBookmarks,
    savePathBookmark: bookmarkMocks.savePathBookmark,
    deletePathBookmark: bookmarkMocks.deletePathBookmark,
  };
});

vi.mock('@/api/domain/transfersApi', () => transferMocks);

function savedProfile(id: string): ConnectionProfile {
  return {
    id,
    name: 'Prod Web',
    group: 'Ops',
    host: '10.0.0.10',
    port: 22,
    username: 'deploy',
    environment: 'production',
    tags: [],
    authenticationMethod: 'agent',
    identityFile: null,
    keyId: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
    proxyProfileId: null,
    favorite: false,
    lastUsedAt: null,
    credentialRef: null,
    state: 'idle',
    latencyMs: null,
  };
}

function makeTask(id: string, state: TransferTask['state']): TransferTask {
  return {
    id,
    profileId: 'prof-1',
    sessionId: state === 'running' ? 'sess-1' : null,
    direction: 'download',
    localPath: `C:\\tmp\\${id}.log`,
    remotePath: `/var/log/${id}.log`,
    destinationProfileId: null,
    destinationSessionId: null,
    destinationRemotePath: null,
    state,
    bytesTransferred: state === 'completed' ? 100 : 25,
    totalBytes: 100,
    conflictPolicy: 'ask',
    remoteSizeBytes: 100,
    remoteMtimeMs: 1_700_000_000_000,
    stagingPath: state === 'paused' ? `C:\\tmp\\.filex-part-${id}` : null,
    resumeState: state === 'paused' ? 'safe_to_resume' : 'not_applicable',
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

describe('bookmarks store and transfer history cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('persists saved-profile path bookmarks while scoping unsaved sessions in memory', async () => {
    const connections = useConnectionsStore();
    connections.profiles = [savedProfile('prof-saved')];
    const bookmarks = useBookmarksStore();

    const stored: PathBookmark = {
      id: 'bm-1',
      profileId: 'prof-saved',
      side: 'remote',
      label: 'nginx',
      path: '/var/log/nginx',
      createdAtMs: 1234,
    };
    bookmarkMocks.listPathBookmarks.mockResolvedValueOnce({ ok: true, data: [] });
    bookmarkMocks.savePathBookmark.mockResolvedValueOnce({ ok: true, data: stored });
    bookmarkMocks.deletePathBookmark.mockResolvedValueOnce({ ok: true, data: true });

    await bookmarks.load('prof-saved');
    const saved = await bookmarks.save('prof-saved', 'remote', '/var/log/nginx');
    expect(saved?.id).toBe('bm-1');
    expect(bookmarks.listFor('prof-saved', 'remote')).toHaveLength(1);
    expect(bookmarks.findByPath('prof-saved', 'remote', '/var/log/nginx')?.id).toBe('bm-1');

    // Quick-connect ephemeral profiles do not invoke SQLite-backed IPC
    const ephemeral = await bookmarks.save('quick-temp-id', 'remote', '/etc/app');
    expect(ephemeral?.label).toBe('app');
    expect(bookmarkMocks.savePathBookmark).toHaveBeenCalledTimes(1);

    await bookmarks.remove('prof-saved', 'bm-1');
    expect(bookmarks.listFor('prof-saved')).toHaveLength(0);
  });

  it('separates active/resumable queue tasks from terminal history and clears history safely', async () => {
    const store = useTransfersStore();
    const paused = makeTask('t-paused', 'paused');
    const running = makeTask('t-running', 'running');
    const done = makeTask('t-done', 'completed');
    const failed = makeTask('t-failed', 'failed');
    store.tasks = [paused, running, done, failed];

    expect(store.activeTasks.map((item) => item.id)).toEqual(['t-paused', 't-running']);
    expect(store.historyTasks.map((item) => item.id)).toEqual(['t-done', 't-failed']);

    transferMocks.clearCompletedTransfers.mockResolvedValueOnce({
      ok: true,
      data: [paused, running],
    });
    const cleared = await store.clearCompleted();
    expect(cleared).toBe(true);
    expect(store.tasks.map((item) => item.id)).toEqual(['t-paused', 't-running']);
    expect(store.historyTasks).toHaveLength(0);
  });
});
