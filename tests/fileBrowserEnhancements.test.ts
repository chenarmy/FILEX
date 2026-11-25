import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  applyExplicitSelection,
  isSameOrDescendantPath,
  resolveMultiSelection,
  resolveUniqueCopyName,
} from '@/domain/fileSelection';
import { useSftpStore } from '@/stores/sftp';
import { useLocalFilesStore } from '@/stores/localFiles';
import { usePrivilegeStore } from '@/stores/privilege';
import { useSessionsStore } from '@/stores/sessions';
import type { LocalFileEntry, RemoteFileEntry } from '@/types/contracts';

const sftpApiMocks = vi.hoisted(() => ({
  listRemoteDirectory: vi.fn(),
  calculateRemoteDirectoryUsage: vi.fn(),
  resolveRemoteLinkTarget: vi.fn(),
  moveRemoteEntry: vi.fn(),
  copyRemoteEntry: vi.fn(),
}));

const privilegeApiMocks = vi.hoisted(() => ({
  elevatedListDirectory: vi.fn(),
  elevatedDirectoryUsage: vi.fn(),
  elevatedResolveLinkTarget: vi.fn(),
  elevatedMoveEntry: vi.fn(),
}));

const localFilesApiMocks = vi.hoisted(() => ({
  listLocalDirectory: vi.fn(),
  resolveLocalLinkTarget: vi.fn(),
  moveLocalEntry: vi.fn(),
  copyLocalEntry: vi.fn(),
  deleteLocalEntry: vi.fn(),
}));

vi.mock('@/api/domain/sftpApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/sftpApi');
  return {
    ...actual,
    listRemoteDirectory: sftpApiMocks.listRemoteDirectory,
    calculateRemoteDirectoryUsage: sftpApiMocks.calculateRemoteDirectoryUsage,
    resolveRemoteLinkTarget: sftpApiMocks.resolveRemoteLinkTarget,
    moveRemoteEntry: sftpApiMocks.moveRemoteEntry,
    copyRemoteEntry: sftpApiMocks.copyRemoteEntry,
  };
});

vi.mock('@/api/domain/privilegeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/privilegeApi');
  return {
    ...actual,
    elevatedListDirectory: privilegeApiMocks.elevatedListDirectory,
    elevatedDirectoryUsage: privilegeApiMocks.elevatedDirectoryUsage,
    elevatedResolveLinkTarget: privilegeApiMocks.elevatedResolveLinkTarget,
    elevatedMoveEntry: privilegeApiMocks.elevatedMoveEntry,
  };
});

vi.mock('@/api/domain/localFilesApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/localFilesApi');
  return {
    ...actual,
    listLocalDirectory: localFilesApiMocks.listLocalDirectory,
    resolveLocalLinkTarget: localFilesApiMocks.resolveLocalLinkTarget,
    moveLocalEntry: localFilesApiMocks.moveLocalEntry,
    copyLocalEntry: localFilesApiMocks.copyLocalEntry,
    deleteLocalEntry: localFilesApiMocks.deleteLocalEntry,
  };
});

function makeRemoteEntry(name: string, options: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
  return {
    name,
    path: `/srv/${name}`,
    isDirectory: false,
    isSymlink: false,
    size: 1024,
    modifiedAtMs: 1_700_000_000_000,
    permissionsMode: 0o644,
    ...options,
  };
}

function makeLocalEntry(name: string, options: Partial<LocalFileEntry> = {}): LocalFileEntry {
  return {
    name,
    path: `D:\\work\\${name}`,
    isDirectory: false,
    isSymlink: false,
    size: 512,
    modifiedAtMs: 1_700_000_000_000,
    permissionsMode: null,
    ...options,
  };
}

describe('sticky multi-selection, copy naming, and path guard helpers', () => {
  const ordered = ['/a', '/b', '/c', '/d'];

  it('keeps multi-selection on plain clicks while stickyMulti is enabled and unions shift ranges', () => {
    const first = applyExplicitSelection(ordered, [], null, '/a', true);
    expect(first.selectedPaths).toEqual(['/a']);

    const toggledSecond = resolveMultiSelection(
      ordered,
      first.selectedPaths,
      first.anchorPath,
      '/c',
      { stickyMulti: true },
    );
    expect(toggledSecond.selectedPaths).toEqual(['/a', '/c']);

    const unionRange = resolveMultiSelection(
      ordered,
      toggledSecond.selectedPaths,
      '/a',
      '/b',
      { shift: true, stickyMulti: true },
    );
    expect(unionRange.selectedPaths).toEqual(['/a', '/b', '/c']);

    const sweepOff = applyExplicitSelection(ordered, unionRange.selectedPaths, unionRange.anchorPath, '/b', false);
    expect(sweepOff.selectedPaths).toEqual(['/a', '/c']);
    const sweepOffAgain = applyExplicitSelection(ordered, sweepOff.selectedPaths, sweepOff.anchorPath, '/b', false);
    expect(sweepOffAgain.selectedPaths).toEqual(['/a', '/c']);
  });

  it('computes conflict-free copy names while preserving extensions and avoiding nested tags', () => {
    expect(
      resolveUniqueCopyName('report.pdf', false, new Set(['report.pdf']), '副本'),
    ).toBe('report (副本).pdf');

    expect(
      resolveUniqueCopyName('archive.tar.gz', false, new Set(['archive.tar.gz', 'archive (副本).tar.gz']), '副本'),
    ).toBe('archive (副本 2).tar.gz');

    expect(
      resolveUniqueCopyName('report (副本).pdf', false, new Set(['report.pdf', 'report (副本).pdf']), '副本'),
    ).toBe('report (副本 2).pdf');

    expect(
      resolveUniqueCopyName('src.v2', true, new Set(['src.v2']), 'copy'),
    ).toBe('src.v2 (copy)');

    expect(
      resolveUniqueCopyName('report.pdf', false, new Set(['other.pdf']), '副本', true),
    ).toBe('report.pdf');
  });

  it('detects same or descendant paths safely for POSIX and Windows paths', () => {
    expect(isSameOrDescendantPath('/srv/app', '/srv/app')).toBe(true);
    expect(isSameOrDescendantPath('/srv/app/logs/sub', '/srv/app')).toBe(true);
    expect(isSameOrDescendantPath('/srv/app-backup', '/srv/app')).toBe(false);
    expect(isSameOrDescendantPath('d:\\work\\dist\\assets', 'D:\\work\\dist')).toBe(true);
    expect(isSameOrDescendantPath('d:\\work\\dist2', 'D:\\work\\dist')).toBe(false);
  });
});

describe('file browser stores for symlinks, du usage, sticky selection, move, and duplicate', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('loads remote directory usage via du and routes elevated symlink/move calls when leased', async () => {
    const folderEntry = makeRemoteEntry('releases', { isDirectory: true, size: null, permissionsMode: 0o755 });
    const linkEntry = makeRemoteEntry('current', { isSymlink: true, symlinkTarget: '/srv/releases/v2', size: null });
    sftpApiMocks.listRemoteDirectory.mockResolvedValue({
      ok: true,
      requestId: 'sftp-1',
      data: { path: '/srv', entries: [folderEntry, linkEntry] },
    });
    sftpApiMocks.calculateRemoteDirectoryUsage.mockResolvedValue({
      ok: true,
      requestId: 'du-1',
      data: {
        path: '/srv',
        totalSizeLabel: '1.2G',
        entrySizeLabels: { releases: '980M' },
        partial: false,
      },
    });
    sftpApiMocks.resolveRemoteLinkTarget.mockResolvedValue({
      ok: true,
      requestId: 'lnk-1',
      data: { targetPath: '/srv/releases/v2', targetKind: 'directory', parentPath: '/srv/releases' },
    });

    const sessions = useSessionsStore();
    const sftp = useSftpStore();
    const privilege = usePrivilegeStore();
    sessions.summaries = [{
      id: 'sess-1',
      generation: 1,
      profileId: 'prof-1',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
      state: 'connected',
      host: '10.1.2.3',
      port: 22,
      username: 'ops',
      lastError: null,
    }];

    expect(await sftp.load('sess-1', '/srv')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(sftp.directoryUsage).toEqual({
      path: '/srv',
      totalSizeLabel: '1.2G',
      entrySizeLabels: { releases: '980M' },
      partial: false,
    });
    expect(await sftp.resolveLink('/srv/current')).toEqual({
      targetPath: '/srv/releases/v2',
      targetKind: 'directory',
      parentPath: '/srv/releases',
    });

    // Switch session into elevated lease mode
    const now = Date.now();
    privilege.leases = {
      'sess-1': {
        sessionId: 'sess-1',
        generation: 1,
        state: 'elevated',
        username: 'ops',
        host: '10.1.2.3',
        port: 22,
        grantedAtMs: now,
        expiresAtMs: now + 60_000,
        ttlSeconds: 60,
      },
    };
    privilegeApiMocks.elevatedResolveLinkTarget.mockResolvedValue({
      ok: true,
      requestId: 'elnk-1',
      data: { targetPath: '/root/secret.txt', targetKind: 'file', parentPath: '/root' },
    });
    privilegeApiMocks.elevatedMoveEntry.mockResolvedValue({ ok: true, requestId: 'emv-1', data: undefined });
    privilegeApiMocks.elevatedListDirectory.mockResolvedValue({
      ok: true,
      requestId: 'elist-1',
      data: { path: '/srv', entries: [folderEntry] },
    });
    privilegeApiMocks.elevatedDirectoryUsage.mockResolvedValue({
      ok: true,
      requestId: 'edu-1',
      data: { path: '/srv', totalSizeLabel: '1.2G', entrySizeLabels: { releases: '980M' }, partial: false },
    });

    expect(await sftp.resolveLink('/srv/current')).toEqual({
      targetPath: '/root/secret.txt',
      targetKind: 'file',
      parentPath: '/root',
    });
    expect(await sftp.moveMany([folderEntry, linkEntry], '/srv/archive')).toBe(2);
    expect(privilegeApiMocks.elevatedMoveEntry).toHaveBeenCalledTimes(2);
    expect(sftpApiMocks.moveRemoteEntry).not.toHaveBeenCalled();
  });

  it('duplicates local and remote files with autoRename and updates selection to created copies', async () => {
    const fileA = makeRemoteEntry('notes.txt');
    const createdRemoteName = 'notes (副本).txt';
    const fileACopy = makeRemoteEntry(createdRemoteName);

    sftpApiMocks.listRemoteDirectory
      .mockResolvedValueOnce({
        ok: true,
        requestId: 'sftp-1',
        data: { path: '/srv', entries: [fileA] },
      })
      .mockResolvedValueOnce({
        ok: true,
        requestId: 'sftp-2',
        data: { path: '/srv', entries: [fileA, fileACopy] },
      });
    sftpApiMocks.calculateRemoteDirectoryUsage.mockResolvedValue({
      ok: true,
      requestId: 'du-2',
      data: { path: '/srv', totalSizeLabel: '4.0K', entrySizeLabels: {}, partial: false },
    });
    sftpApiMocks.copyRemoteEntry.mockResolvedValue({
      ok: true,
      requestId: 'cp-1',
      data: createdRemoteName,
    });

    const sftp = useSftpStore();
    await sftp.load('sess-1', '/srv');
    const remoteCreated = await sftp.duplicateMany([fileA], '/srv', '副本');
    expect(remoteCreated).toEqual([createdRemoteName]);
    expect(sftpApiMocks.copyRemoteEntry).toHaveBeenCalledWith(
      'sess-1',
      '/srv/notes.txt',
      '/srv',
      'notes.txt',
      expect.any(String),
      { autoRename: true, copySuffix: '副本' },
    );
    expect(sftp.selectedPath).toBe('/srv/notes (副本).txt');

    const localA = makeLocalEntry('todo.md');
    const localB = makeLocalEntry('sub', { isDirectory: true, size: null });
    localFilesApiMocks.listLocalDirectory
      .mockResolvedValueOnce({
        ok: true,
        requestId: 'loc-1',
        data: { path: 'D:\\work', parentPath: 'D:\\', entries: [localA, localB], truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        requestId: 'loc-2',
        data: {
          path: 'D:\\work',
          parentPath: 'D:\\',
          entries: [localA, makeLocalEntry('todo (副本).md'), localB],
          truncated: false,
        },
      });
    localFilesApiMocks.copyLocalEntry.mockResolvedValue({
      ok: true,
      requestId: 'lcp-1',
      data: 'todo (副本).md',
    });

    const localFiles = useLocalFilesStore();
    await localFiles.load('D:\\work');
    localFiles.toggleMultiSelectMode();
    localFiles.setEntrySelected(localA, true);
    localFiles.selectWithModifiers(localB);
    expect(localFiles.selectedPaths).toEqual(['D:\\work\\todo.md', 'D:\\work\\sub']);

    const localCreated = await localFiles.duplicateMany([localA], 'D:\\work', '副本');
    expect(localCreated).toEqual(['todo (副本).md']);
    expect(localFiles.selectedPath).toBe('D:\\work\\todo (副本).md');

    localFiles.clearSelection();
    expect(localFiles.selectedPaths).toEqual([]);
    expect(localFiles.multiSelectMode).toBe(false);
  });

  it('preserves existing remote directory listing and clears error when follow-terminal load fails with preserveOnError', async () => {
    const fileA = makeRemoteEntry('docker-compose.yml');
    sftpApiMocks.listRemoteDirectory
      .mockResolvedValueOnce({
        ok: true,
        requestId: 'list-ok',
        data: { path: '/home/porlog/software', entries: [fileA] },
      })
      .mockResolvedValueOnce({
        ok: false,
        requestId: 'list-fail',
        error: {
          code: 'SFTP_FAILED',
          messageKey: 'errors.sftpFailed',
          retryable: true,
          remoteState: 'reachable',
        },
      });
    sftpApiMocks.calculateRemoteDirectoryUsage.mockResolvedValue({
      ok: false,
      requestId: 'du-skip',
      error: {
        code: 'SFTP_FAILED',
        messageKey: 'errors.sftpFailed',
        retryable: true,
        remoteState: 'reachable',
      },
    });

    const sftp = useSftpStore();
    expect(await sftp.load('sess-1', '/home/porlog/software')).toBe(true);
    expect(sftp.path).toBe('/home/porlog/software');
    expect(sftp.entries).toHaveLength(1);

    expect(await sftp.load('sess-1', '/home/porlog/ap', { preserveOnError: true })).toBe(false);
    expect(sftp.path).toBe('/home/porlog/software');
    expect(sftp.entries).toHaveLength(1);
    expect(sftp.error).toBeNull();
  });
});
