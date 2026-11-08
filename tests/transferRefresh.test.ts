import { describe, expect, it } from 'vitest';
import {
  completedTransferAffectsLocalListing,
  completedTransferAffectsRemoteListing,
  localParentPath,
  remoteParentPath,
} from '@/domain/transferRefresh';

describe('completed transfer refresh targets', () => {
  it('refreshes the containing remote directory after an upload', () => {
    const task = { direction: 'upload' as const, localPath: 'C:\\tmp\\app.conf', remotePath: '/root/00/app.conf' };
    expect(remoteParentPath(task.remotePath)).toBe('/root/00');
    expect(completedTransferAffectsRemoteListing(task, '/root/00')).toBe(true);
    expect(completedTransferAffectsRemoteListing(task, '/root')).toBe(false);
  });

  it('refreshes the parent and an open uploaded directory subtree', () => {
    const task = { direction: 'upload' as const, localPath: 'C:\\tmp\\tree', remotePath: '/srv/tree' };
    expect(completedTransferAffectsRemoteListing(task, '/srv')).toBe(true);
    expect(completedTransferAffectsRemoteListing(task, '/srv/tree')).toBe(true);
    expect(completedTransferAffectsRemoteListing(task, '/srv/tree/assets')).toBe(true);
    expect(completedTransferAffectsRemoteListing(task, '/srv/other')).toBe(false);
  });

  it('refreshes the containing local directory after a download', () => {
    const task = { direction: 'download' as const, localPath: 'C:\\Users\\Admin\\archive.zip', remotePath: '/root/archive.zip' };
    expect(localParentPath(task.localPath)).toBe('C:/Users/Admin');
    expect(completedTransferAffectsLocalListing(task, 'c:\\users\\admin')).toBe(true);
    expect(completedTransferAffectsLocalListing(task, 'C:\\Users')).toBe(false);
  });

  it('does not cross transfer directions', () => {
    const upload = { direction: 'upload' as const, localPath: '/tmp/a', remotePath: '/root/a' };
    const download = { direction: 'download' as const, localPath: '/tmp/a', remotePath: '/root/a' };
    expect(completedTransferAffectsLocalListing(upload, '/tmp')).toBe(false);
    expect(completedTransferAffectsRemoteListing(download, '/root')).toBe(false);
  });
});
