import type { TransferTask } from '@/types/contracts';

type TransferPaths = Pick<TransferTask, 'direction' | 'localPath' | 'remotePath'>;

function normalizePath(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const trimmed = unified.replace(/\/+$/, '');
  return trimmed || (unified.startsWith('/') ? '/' : '.');
}

function isCaseInsensitiveLocalPath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return isCaseInsensitiveLocalPath(normalizedLeft) || isCaseInsensitiveLocalPath(normalizedRight)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function remoteParentPath(value: string): string {
  const normalized = normalizePath(value);
  if (normalized === '/' || normalized === '.') return normalized;
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return '.';
  return separator === 0 ? '/' : normalized.slice(0, separator);
}

export function localParentPath(value: string): string {
  const normalized = normalizePath(value);
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return '.';
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.slice(0, separator);
}

export function completedTransferAffectsRemoteListing(task: TransferPaths, currentPath: string): boolean {
  if (task.direction !== 'upload') return false;
  const target = normalizePath(task.remotePath);
  const current = normalizePath(currentPath);
  return current === remoteParentPath(target)
    || current === target
    || current.startsWith(`${target}/`);
}

export function completedTransferAffectsLocalListing(task: TransferPaths, currentPath: string): boolean {
  if (task.direction !== 'download') return false;
  const current = normalizePath(currentPath);
  const target = normalizePath(task.localPath);
  return sameLocalPath(current, localParentPath(target))
    || sameLocalPath(current, target)
    || (isCaseInsensitiveLocalPath(current)
      ? current.toLowerCase().startsWith(`${target.toLowerCase()}/`)
      : current.startsWith(`${target}/`));
}
