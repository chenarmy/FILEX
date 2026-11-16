import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DockerSnapshot,
  OperationResult,
  OpsSnapshot,
  RemoteDirectoryListing,
  SystemMonitorSnapshot,
} from '@/types/contracts';

const mocks = vi.hoisted(() => ({
  listRemoteDirectory: vi.fn(),
  elevatedListDirectory: vi.fn(),
  collectSystemMonitor: vi.fn(),
  collectDockerSnapshot: vi.fn(),
  collectOpsSnapshot: vi.fn(),
  listPathBookmarks: vi.fn(),
}));

vi.mock('@/api/domain/sftpApi', () => ({
  listRemoteDirectory: mocks.listRemoteDirectory,
  previewRemoteText: vi.fn(),
  saveRemoteText: vi.fn(),
  deleteRemoteEntry: vi.fn(),
  deleteRemoteEntryRecursive: vi.fn(),
  createRemoteDirectory: vi.fn(),
  createRemoteFile: vi.fn(),
  renameRemoteEntry: vi.fn(),
  moveRemoteEntry: vi.fn(),
  copyRemoteEntry: vi.fn(),
  updateRemoteEntryMode: vi.fn(),
  updateRemotePermissions: vi.fn(),
}));

vi.mock('@/api/domain/privilegeApi', () => ({
  elevatedListDirectory: mocks.elevatedListDirectory,
  elevatedPreviewText: vi.fn(),
  elevatedSaveText: vi.fn(),
  elevatedDeleteEntry: vi.fn(),
  elevatedCreateDirectory: vi.fn(),
  elevatedCreateFile: vi.fn(),
  elevatedRenameEntry: vi.fn(),
  elevatedChmodEntry: vi.fn(),
}));

vi.mock('@/api/domain/fileOperationsApi', () => ({
  cancelCopyOperation: vi.fn(),
}));

vi.mock('@/api/domain/externalEditorApi', () => ({
  openRemoteFileInEditor: vi.fn(),
  stopExternalEditorWatchersForSession: vi.fn(),
  listActiveExternalEditors: vi.fn().mockResolvedValue({ ok: true, requestId: 'ext-1', data: [] }),
}));

vi.mock('@/api/domain/monitorApi', () => ({
  collectSystemMonitor: mocks.collectSystemMonitor,
}));

vi.mock('@/api/domain/dockerApi', () => ({
  collectDockerSnapshot: mocks.collectDockerSnapshot,
  collectDockerLogs: vi.fn(),
  runDockerContainerAction: vi.fn(),
}));

vi.mock('@/api/domain/opsApi', () => ({
  collectOpsSnapshot: mocks.collectOpsSnapshot,
}));

vi.mock('@/api/domain/bookmarksApi', () => ({
  listPathBookmarks: mocks.listPathBookmarks,
  savePathBookmark: vi.fn(),
  deletePathBookmark: vi.fn(),
  deriveBookmarkLabel: (p: string) => p.split('/').filter(Boolean).pop() ?? p,
}));

import { createSessionStateCache } from '@/domain/sessionStateCache';
import { useDockerStore } from '@/stores/docker';
import { useMonitorStore } from '@/stores/monitor';
import { useOpsStore } from '@/stores/ops';
import { useSftpStore } from '@/stores/sftp';

function sftpOk(path: string, fileName: string): OperationResult<RemoteDirectoryListing> {
  return {
    ok: true,
    requestId: `req-${path}`,
    data: {
      path,
      entries: [
        {
          name: fileName,
          path: `${path}/${fileName}`,
          isDirectory: false,
          isSymlink: false,
          size: 512,
          modifiedAtMs: 1_700_000_000_000,
          permissionsMode: 0o644,
          uid: 0,
          gid: 0,
        },
      ],
    },
  };
}

function monitorOk(hostname: string): OperationResult<SystemMonitorSnapshot> {
  return {
    ok: true,
    requestId: `mon-${hostname}`,
    data: {
      state: 'live',
      collectedAtMs: 1_700_000_000_000,
      hostname,
      osName: 'Linux',
      uptimeSeconds: 1000,
      loadOne: 0.25,
      cpuPercent: 12,
      memoryTotalKib: 4096,
      memoryAvailableKib: 2048,
      swapTotalKib: 1024,
      swapUsedKib: 0,
      rootTotalKib: 10000,
      rootAvailableKib: 5000,
      networkReceiveBytesPerSecond: 100,
      networkTransmitBytesPerSecond: 50,
    },
  };
}

describe('per-session state persistence across session switches', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('bounds LRU session state cache and updates recency on read', () => {
    const cache = createSessionStateCache<string>(2);
    cache.set('s1', 'one');
    cache.set('s2', 'two');
    expect(cache.get('s1')).toBe('one');

    cache.set('s3', 'three');
    expect(cache.has('s2')).toBe(false);
    expect(cache.get('s1')).toBe('one');
    expect(cache.get('s3')).toBe('three');

    cache.delete('s1');
    expect(cache.has('s1')).toBe(false);
  });

  it('preserves SFTP directory, selection, and expanded tree across session switches without reloading', async () => {
    mocks.listRemoteDirectory
      .mockResolvedValueOnce(sftpOk('/var/log/nginx', 'access.log'))
      .mockResolvedValueOnce(sftpOk('/home/ops', 'notes.txt'));

    const sftp = useSftpStore();
    expect(await sftp.load('sess-a', '/var/log/nginx')).toBe(true);
    sftp.select(sftp.entries[0]!);
    sftp.setExpandedTreePaths(['/', '/var', '/var/log', '/var/log/nginx']);

    expect(sftp.activateSession('sess-b')).toBe(false);
    expect(sftp.sessionId).toBeNull();
    expect(sftp.path).toBe('.');
    expect(sftp.entries).toEqual([]);

    expect(await sftp.load('sess-b', '.')).toBe(true);
    expect(sftp.path).toBe('/home/ops');

    expect(sftp.activateSession('sess-a')).toBe(true);
    expect(sftp.sessionId).toBe('sess-a');
    expect(sftp.path).toBe('/var/log/nginx');
    expect(sftp.selectedPath).toBe('/var/log/nginx/access.log');
    expect(sftp.expandedTreePaths).toEqual(['/', '/var', '/var/log', '/var/log/nginx']);
    expect(sftp.entries[0]?.name).toBe('access.log');
    expect(mocks.listRemoteDirectory).toHaveBeenCalledTimes(2);

    expect(sftp.activateSession(null)).toBe(false);
    expect(sftp.activateSession('sess-b')).toBe(true);
    expect(sftp.path).toBe('/home/ops');

    sftp.dropSession('sess-a');
    expect(sftp.hasSessionState('sess-a')).toBe(false);
  });

  it('stores background SFTP loads without overwriting another active session', async () => {
    let resolveSlow!: (value: OperationResult<RemoteDirectoryListing>) => void;
    const slowPromise = new Promise<OperationResult<RemoteDirectoryListing>>((resolve) => {
      resolveSlow = resolve;
    });
    mocks.listRemoteDirectory
      .mockImplementationOnce(() => slowPromise)
      .mockResolvedValueOnce(sftpOk('/srv/b', 'b.txt'));

    const sftp = useSftpStore();
    const loadA = sftp.load('sess-a', '/srv/a');

    expect(sftp.activateSession('sess-b')).toBe(false);
    expect(await sftp.load('sess-b', '/srv/b')).toBe(true);
    expect(sftp.path).toBe('/srv/b');

    resolveSlow(sftpOk('/srv/a', 'a.txt'));
    expect(await loadA).toBe(true);
    expect(sftp.path).toBe('/srv/b');

    expect(sftp.activateSession('sess-a')).toBe(true);
    expect(sftp.path).toBe('/srv/a');
    expect(sftp.entries[0]?.name).toBe('a.txt');
  });

  it('restores monitor, docker, and ops snapshots per session without cross-session leakage', async () => {
    mocks.collectSystemMonitor.mockResolvedValueOnce(monitorOk('host-alpha'));
    mocks.collectDockerSnapshot.mockResolvedValueOnce({
      ok: true,
      requestId: 'd1',
      data: {
        availability: 'available',
        collectedAtMs: 1,
        serverVersion: '26.1',
        containers: [],
        images: [],
        truncated: false,
      } satisfies DockerSnapshot,
    });
    mocks.collectOpsSnapshot.mockResolvedValueOnce({
      ok: true,
      requestId: 'o1',
      data: {
        state: 'live',
        collectedAtMs: 1,
        category: 'ports',
        hostname: 'host-alpha',
        osRelease: 'Ubuntu',
        sections: [],
      } satisfies OpsSnapshot,
    });

    const monitor = useMonitorStore();
    const docker = useDockerStore();
    const ops = useOpsStore();

    await monitor.collect('sess-a');
    await docker.collect('sess-a');
    await ops.collect('sess-a', 'ports');

    expect(monitor.activateSession('sess-b')).toBe(false);
    expect(monitor.snapshot).toBeNull();
    expect(monitor.history).toEqual([]);
    expect(docker.activateSession('sess-b')).toBe(false);
    expect(docker.snapshot).toBeNull();
    expect(ops.activateSession('sess-b')).toBe(false);
    expect(ops.snapshots).toEqual({});

    expect(monitor.activateSession('sess-a')).toBe(true);
    expect(monitor.snapshot?.hostname).toBe('host-alpha');
    expect(monitor.history).toHaveLength(1);
    expect(docker.activateSession('sess-a')).toBe(true);
    expect(docker.snapshot?.serverVersion).toBe('26.1');
    expect(ops.activateSession('sess-a')).toBe(true);
    expect(ops.snapshots.ports?.hostname).toBe('host-alpha');
  });
});
