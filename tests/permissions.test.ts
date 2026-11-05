import { describe, expect, it } from 'vitest';
import {
  formatOctalMode,
  formatSymbolicMode,
  matrixFromMode,
  modeFromMatrix,
  ownerLabel,
  parseOctalMode,
} from '@/domain/permissions';

describe('permissions domain', () => {
  it('formats octal and symbolic modes', () => {
    expect(formatOctalMode(0o644)).toBe('0644');
    expect(formatOctalMode(0)).toBe('0000');
    expect(formatOctalMode(0o7777)).toBe('7777');
    expect(formatSymbolicMode(0o644)).toBe('rw-r--r--');
    expect(formatSymbolicMode(0o755)).toBe('rwxr-xr-x');
    expect(formatSymbolicMode(0o4755)).toBe('rwsr-xr-x');
    expect(formatSymbolicMode(0o1777)).toBe('rwxrwxrwt');
    expect(formatSymbolicMode(0o2000)).toBe('-----S---');
  });

  it('parses octal input defensively', () => {
    expect(parseOctalMode('644')).toBe(0o644);
    expect(parseOctalMode('0644')).toBe(0o644);
    expect(parseOctalMode('7777')).toBe(0o7777);
    expect(parseOctalMode('8')).toBeNull();
    expect(parseOctalMode('abc')).toBeNull();
    expect(parseOctalMode('')).toBeNull();
    expect(parseOctalMode('12345')).toBeNull();
  });

  it('round-trips a permission matrix', () => {
    const mode = 0o751;
    expect(modeFromMatrix(matrixFromMode(mode))).toBe(mode);
    const special = 0o6755;
    expect(modeFromMatrix(matrixFromMode(special))).toBe(special);
  });

  it('labels numeric ownership', () => {
    expect(ownerLabel({ uid: 1000, gid: 1000 })).toBe('1000/1000');
    expect(ownerLabel({ uid: 0, gid: null })).toBe('0');
    expect(ownerLabel({ uid: null, gid: 33 })).toBe('—/33');
    expect(ownerLabel({})).toBe('—');
  });
});
