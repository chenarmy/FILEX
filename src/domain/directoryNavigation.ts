export interface DirectoryTreeEntry {
  name: string;
  path: string;
}

export function normalizeLocalPath(path: string): string {
  const value = path.trim();
  if (value.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (value.startsWith('\\\\?\\') && /^[A-Za-z]:/.test(value.slice(4))) {
    return value.slice(4);
  }
  return value;
}

export function directoryEntries<T extends {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
}>(entries: T[]): DirectoryTreeEntry[] {
  return entries
    .filter((entry) => entry.isDirectory && !entry.isSymlink)
    .map(({ name, path }) => ({ name, path }));
}

export function directoryRoot(path: string): string {
  const value = normalizeLocalPath(path);
  const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(value);
  if (unc) return `${unc[1]}\\`;
  const drive = /^([A-Za-z]:)[\\/]/.exec(value);
  if (drive) return `${drive[1]}\\`;
  if (value.startsWith('/')) return '/';
  return value || '/';
}

export function directoryAncestors(path: string): string[] {
  const value = normalizeLocalPath(path);
  if (!value) return [];
  const unc = /^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/.exec(value);
  if (unc) {
    const root = `${unc[1]}\\`;
    const parts = unc[2]?.split(/[\\/]+/).filter(Boolean) ?? [];
    const result = [root];
    for (const part of parts) result.push(joinDirectoryPath(result.at(-1) ?? root, part));
    return result;
  }
  const drive = /^([A-Za-z]:)[\\/](.*)$/.exec(value);
  if (drive) {
    const root = `${drive[1]}\\`;
    const parts = drive[2]?.split(/[\\/]+/).filter(Boolean) ?? [];
    const result = [root];
    for (const part of parts) result.push(joinDirectoryPath(result.at(-1) ?? root, part));
    return result;
  }
  if (value.startsWith('/')) {
    const parts = value.split('/').filter(Boolean);
    const result = ['/'];
    for (const part of parts) result.push(joinDirectoryPath(result.at(-1) ?? '/', part));
    return result;
  }
  return [value];
}

export function missingAncestorDirectories(
  path: string,
  childrenByPath: Record<string, DirectoryTreeEntry[]>,
  loadingPaths: readonly string[] = [],
  errorPaths: readonly string[] = [],
): string[] {
  return directoryAncestors(path).filter((ancestor) => (
    !Object.prototype.hasOwnProperty.call(childrenByPath, ancestor)
    && !loadingPaths.includes(ancestor)
    && !errorPaths.includes(ancestor)
  ));
}

export function directoryName(path: string): string {
  const normalized = normalizeLocalPath(path).replace(/[\\/]+$/, '');
  if (!normalized) return '/';
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  if (/^\\\\[^\\]+\\[^\\]+$/.test(normalized)) return `${normalized}\\`;
  return normalized.split(/[\\/]/).at(-1) ?? path;
}

export function joinDirectoryPath(parent: string, name: string): string {
  const normalizedParent = normalizeLocalPath(parent);
  if (/^[A-Za-z]:\\$/.test(normalizedParent) || /^\\\\[^\\]+\\[^\\]+\\$/.test(normalizedParent)) {
    return `${normalizedParent}${name}`;
  }
  const separator = normalizedParent.includes('\\') && !normalizedParent.includes('/') ? '\\' : '/';
  return `${normalizedParent.replace(/[\\/]+$/, '')}${separator}${name}`;
}
