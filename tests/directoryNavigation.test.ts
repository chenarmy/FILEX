import { describe, expect, it } from 'vitest';
import { directoryAncestors, directoryEntries, directoryRoot, missingAncestorDirectories } from '@/domain/directoryNavigation';

describe('directory navigation', () => {
  it('keeps only real directories in the navigation tree', () => {
    expect(directoryEntries([
      { name: 'logs', path: '/srv/logs', isDirectory: true, isSymlink: false },
      { name: 'latest', path: '/srv/latest', isDirectory: true, isSymlink: true },
      { name: 'app.log', path: '/srv/app.log', isDirectory: false, isSymlink: false },
    ])).toEqual([{ name: 'logs', path: '/srv/logs' }]);
  });

  it('builds POSIX and Windows ancestor chains', () => {
    expect(directoryAncestors('/srv/app/logs')).toEqual(['/', '/srv', '/srv/app', '/srv/app/logs']);
    expect(directoryAncestors('C:\\Users\\dev')).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\dev']);
    expect(directoryRoot('C:\\Users\\dev')).toBe('C:\\');
  });

  it('identifies uncached ancestor directories while skipping in-flight or failed paths', () => {
    expect(missingAncestorDirectories('/root', {
      '/root': [{ name: '.ssh', path: '/root/.ssh' }],
    })).toEqual(['/']);

    expect(missingAncestorDirectories(
      '/srv/app/logs',
      {
        '/srv': [{ name: 'app', path: '/srv/app' }],
        '/srv/app/logs': [],
      },
      ['/'],
      [],
    )).toEqual(['/srv/app']);

    expect(missingAncestorDirectories(
      'C:\\Users\\dev',
      { 'C:\\Users\\dev': [] },
      [],
      ['C:\\'],
    )).toEqual(['C:\\Users']);
  });
});
