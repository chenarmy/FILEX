export interface MultiSelectResult {
  selectedPaths: string[];
  primaryPath: string | null;
  anchorPath: string | null;
}

export function resolveMultiSelection(
  orderedPaths: readonly string[],
  currentSelected: readonly string[],
  anchorPath: string | null,
  targetPath: string,
  modifiers: { ctrlOrMeta?: boolean; shift?: boolean } = {},
): MultiSelectResult {
  if (!orderedPaths.includes(targetPath)) {
    return {
      selectedPaths: [...currentSelected],
      primaryPath: currentSelected.at(-1) ?? null,
      anchorPath,
    };
  }

  if (modifiers.shift) {
    const effectiveAnchor = (anchorPath && orderedPaths.includes(anchorPath))
      ? anchorPath
      : (currentSelected.find((path) => orderedPaths.includes(path)) ?? targetPath);
    const startIndex = orderedPaths.indexOf(effectiveAnchor);
    const endIndex = orderedPaths.indexOf(targetPath);
    const low = Math.min(startIndex, endIndex);
    const high = Math.max(startIndex, endIndex);
    const range = orderedPaths.slice(low, high + 1);
    return {
      selectedPaths: range,
      primaryPath: targetPath,
      anchorPath: effectiveAnchor,
    };
  }

  if (modifiers.ctrlOrMeta) {
    const exists = currentSelected.includes(targetPath);
    if (exists) {
      const next = currentSelected.filter((path) => path !== targetPath);
      return {
        selectedPaths: next,
        primaryPath: next.at(-1) ?? null,
        anchorPath: next.length > 0 ? (anchorPath === targetPath ? next.at(-1) ?? null : anchorPath) : null,
      };
    }
    return {
      selectedPaths: [...currentSelected, targetPath],
      primaryPath: targetPath,
      anchorPath: targetPath,
    };
  }

  return {
    selectedPaths: [targetPath],
    primaryPath: targetPath,
    anchorPath: targetPath,
  };
}

export function resolveRenameStemRange(name: string, isDirectory: boolean): { start: number; end: number } {
  if (isDirectory || !name) return { start: 0, end: name.length };
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { start: 0, end: name.length };
  return { start: 0, end: lastDot };
}

export function buildDefaultArchiveName(
  remoteDirectory: string,
  entryNames: readonly string[],
  now = new Date(),
): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const sanitize = (raw: string) => Array.from(raw.trim(), (char) => (
    char.charCodeAt(0) < 0x20 || '<>:"/\\|?*'.includes(char) ? '_' : char
  ))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 64);

  if (entryNames.length === 1 && entryNames[0]) {
    const base = sanitize(entryNames[0]) || 'archive';
    return `${base}-${stamp}.tar.gz`;
  }
  const dirPart = remoteDirectory.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'remote-files';
  const base = sanitize(dirPart) || 'remote-files';
  return `${base}-${entryNames.length}items-${stamp}.tar.gz`;
}

export function extractLocalParentDirectory(localPath: string): string | null {
  const trimmed = localPath.trim();
  if (!trimmed) return null;
  const withoutTrailing = trimmed.replace(/[\\/]+$/, '');
  if (!withoutTrailing) return null;
  const lastBackslash = withoutTrailing.lastIndexOf('\\');
  const lastSlash = withoutTrailing.lastIndexOf('/');
  const splitIndex = Math.max(lastBackslash, lastSlash);
  if (splitIndex < 0) return null;
  if (splitIndex === 0) return '/';
  const parent = withoutTrailing.slice(0, splitIndex);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}
