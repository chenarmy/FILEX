import { describe, expect, it } from 'vitest';
import { fileVisualKind } from '@/domain/fileVisualKind';

describe('file visual kind', () => {
  it('gives folders and symlinks their own shapes', () => {
    expect(fileVisualKind('src', true)).toBe('folder');
    expect(fileVisualKind('latest', true, true)).toBe('symlink');
  });

  it.each([
    ['archive.TAR.GZ', 'archive'],
    ['main.ts', 'code'],
    ['package.json', 'data'],
    ['.bashrc', 'config'],
    ['.tcshrc', 'config'],
    ['.bash_history', 'document'],
    ['photo.webp', 'image'],
    ['podcast.flac', 'audio'],
    ['demo.mp4', 'video'],
    ['guide.pdf', 'document'],
    ['report.xlsx', 'spreadsheet'],
    ['cache.sqlite3', 'database'],
    ['server.pem', 'key'],
    ['installer.msi', 'executable'],
    ['README', 'document'],
  ] as const)('classifies %s as %s', (name, expected) => {
    expect(fileVisualKind(name, false)).toBe(expected);
  });
});
