const PERMISSION_DIGITS = 3;

export interface PermissionTriple {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface PermissionMatrix {
  owner: PermissionTriple;
  group: PermissionTriple;
  other: PermissionTriple;
  setuid: boolean;
  setgid: boolean;
  sticky: boolean;
}

/** Formats a permission mode as a four-digit octal string (`0644`). */
export function formatOctalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** Renders the symbolic `rwxr-xr-x` form, with setuid/setgid/sticky flags. */
export function formatSymbolicMode(mode: number): string {
  const bits = (triple: number): string => `${triple & 4 ? 'r' : '-'}${triple & 2 ? 'w' : '-'}${triple & 1 ? 'x' : '-'}`;
  const value = mode & 0o7777;
  const owner = bits((value >> 6) & 7).split('');
  const group = bits((value >> 3) & 7).split('');
  const other = bits(value & 7).split('');
  if (value & 0o4000) owner[2] = owner[2] === 'x' ? 's' : 'S';
  if (value & 0o2000) group[2] = group[2] === 'x' ? 's' : 'S';
  if (value & 0o1000) other[2] = other[2] === 'x' ? 't' : 'T';
  return `${owner.join('')}${group.join('')}${other.join('')}`;
}

export function parseOctalMode(input: string): number | null {
  const trimmed = input.trim().replace(/^0+(?=\d)/, '');
  if (!/^[0-7]{1,4}$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 8);
  return value >= 0 && value <= 0o7777 ? value : null;
}

export function matrixFromMode(mode: number): PermissionMatrix {
  const value = mode & 0o7777;
  return {
    owner: { read: Boolean(value & 0o400), write: Boolean(value & 0o200), execute: Boolean(value & 0o100) },
    group: { read: Boolean(value & 0o040), write: Boolean(value & 0o020), execute: Boolean(value & 0o010) },
    other: { read: Boolean(value & 0o004), write: Boolean(value & 0o002), execute: Boolean(value & 0o001) },
    setuid: Boolean(value & 0o4000),
    setgid: Boolean(value & 0o2000),
    sticky: Boolean(value & 0o1000),
  };
}

export function modeFromMatrix(matrix: PermissionMatrix): number {
  const triple = (value: PermissionTriple): number =>
    (value.read ? 4 : 0) + (value.write ? 2 : 0) + (value.execute ? 1 : 0);
  return (matrix.setuid ? 0o4000 : 0)
    | (matrix.setgid ? 0o2000 : 0)
    | (matrix.sticky ? 0o1000 : 0)
    | (triple(matrix.owner) << 6)
    | (triple(matrix.group) << 3)
    | triple(matrix.other);
}

export function ownerLabel(entry: { uid?: number | null; gid?: number | null } | object): string {
  const remote = entry as { uid?: number | null; gid?: number | null };
  const uid = remote.uid ?? null;
  const gid = remote.gid ?? null;
  if (uid === null && gid === null) return '—';
  if (gid === null) return String(uid);
  if (uid === null) return `—/${gid}`;
  return `${uid}/${gid}`;
}

/** Number of full rwx permission digits (owner/group/other) for validation UIs. */
export const permissionDigitCount = PERMISSION_DIGITS;
