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
  modifiers: { ctrlOrMeta?: boolean; shift?: boolean; stickyMulti?: boolean } = {},
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
    const selectedPaths = (modifiers.ctrlOrMeta || modifiers.stickyMulti)
      ? orderedPaths.filter((path) => currentSelected.includes(path) || range.includes(path))
      : range;
    return {
      selectedPaths,
      primaryPath: targetPath,
      anchorPath: effectiveAnchor,
    };
  }

  if (modifiers.ctrlOrMeta || modifiers.stickyMulti) {
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

export function applyExplicitSelection(
  orderedPaths: readonly string[],
  currentSelected: readonly string[],
  anchorPath: string | null,
  targetPath: string,
  selected: boolean,
): MultiSelectResult {
  if (!orderedPaths.includes(targetPath)) {
    return {
      selectedPaths: [...currentSelected],
      primaryPath: currentSelected.at(-1) ?? null,
      anchorPath,
    };
  }
  const exists = currentSelected.includes(targetPath);
  if (selected) {
    const next = exists ? [...currentSelected] : [...currentSelected, targetPath];
    return {
      selectedPaths: next,
      primaryPath: targetPath,
      anchorPath: targetPath,
    };
  }
  const next = exists ? currentSelected.filter((path) => path !== targetPath) : [...currentSelected];
  return {
    selectedPaths: next,
    primaryPath: next.at(-1) ?? null,
    anchorPath: next.length > 0 ? (anchorPath === targetPath ? next.at(-1) ?? null : anchorPath) : null,
  };
}

const COMPOUND_TAR_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.lz4'] as const;

export function splitCopyStemAndExtension(name: string, isDirectory: boolean): { stem: string; ext: string } {
  if (isDirectory || !name) return { stem: name, ext: '' };
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_TAR_EXTENSIONS) {
    if (lower.length > compound.length && lower.endsWith(compound)) {
      const split = name.length - compound.length;
      if (split > 0) return { stem: name.slice(0, split), ext: name.slice(split) };
    }
  }
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

function stripTrailingCopyTag(stem: string, copySuffix: string): { baseStem: string; hadCopyTag: boolean } {
  let current = stem.trimEnd();
  let hadCopyTag = false;
  const trimmedSuffix = copySuffix.trim();
  const candidates = [...new Set(['副本', 'copy', trimmedSuffix].filter(Boolean))];
  while (true) {
    const open = current.lastIndexOf(' (');
    if (open < 0 || !current.endsWith(')')) break;
    const inner = current.slice(open + 2, -1);
    const matched = candidates.some((candidate) => (
      inner === candidate
      || (
        inner.startsWith(`${candidate} `)
        && /^\d{1,4}$/.test(inner.slice(candidate.length + 1))
      )
    ));
    if (!matched) break;
    const next = current.slice(0, open).trimEnd();
    if (!next) break;
    current = next;
    hadCopyTag = true;
  }
  return { baseStem: current, hadCopyTag };
}

export function resolveUniqueCopyName(
  sourceName: string,
  isDirectory: boolean,
  existingNames: ReadonlySet<string>,
  copySuffix: string,
  preferOriginalName = false,
): string {
  if (preferOriginalName && sourceName && !existingNames.has(sourceName)) {
    return sourceName;
  }
  const effectiveSuffix = copySuffix.trim() || 'copy';
  const { stem, ext } = splitCopyStemAndExtension(sourceName, isDirectory);
  const { baseStem, hadCopyTag } = stripTrailingCopyTag(stem, effectiveSuffix);
  if (!hadCopyTag) {
    const firstCandidate = `${baseStem} (${effectiveSuffix})${ext}`;
    if (!existingNames.has(firstCandidate)) return firstCandidate;
  }
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${baseStem} (${effectiveSuffix} ${index})${ext}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${baseStem} (${effectiveSuffix} ${Date.now()})${ext}`;
}

export function isSameOrDescendantPath(candidatePath: string, rootPath: string): boolean {
  const isWindows = rootPath.includes('\\') && !rootPath.startsWith('/');
  const normalize = (value: string) => {
    const trimmed = value.trim().replace(/[\\/]+$/, '');
    if (!trimmed) return isWindows ? '' : '/';
    return isWindows ? trimmed.toLowerCase() : trimmed;
  };
  const normCandidate = normalize(candidatePath);
  const normRoot = normalize(rootPath);
  if (!normCandidate || !normRoot) return false;
  if (normCandidate === normRoot) return true;
  if (normRoot === '/') return normCandidate.startsWith('/');
  const sep = isWindows ? '\\' : '/';
  return normCandidate.startsWith(`${normRoot}${sep}`);
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
