export const MAX_UPLOAD_BATCH_ITEMS = 64;

export function isSafeTransferName(name: string): boolean {
  return name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    // eslint-disable-next-line no-control-regex -- control characters must be detected here
    && !/[\\/\u0000-\u001f\u007f]/u.test(name);
}

export function joinRemoteUploadPath(directory: string, name: string): string {
  const parent = directory.replace(/\/+$/, '');
  return parent ? `${parent}/${name}` : `/${name}`;
}

export function parseClipboardFileUriList(raw: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parsed = parseSingleFileUri(trimmed);
    if (!parsed || seen.has(parsed)) continue;
    seen.add(parsed);
    paths.push(parsed);
    if (paths.length >= 256) break;
  }
  return paths;
}

function parseSingleFileUri(uri: string): string | null {
  let rest: string;
  if (uri.startsWith('file://localhost/')) {
    rest = `/${uri.slice('file://localhost/'.length)}`;
  } else if (uri.startsWith('file:///')) {
    rest = `/${uri.slice('file:///'.length)}`;
  } else {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (!decoded || decoded.length > 4_096 || decoded.includes('\0')) return null;
  if (/^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1).replace(/\//g, '\\');
  }
  return decoded;
}

export function extractClipboardPathsFromEvent(event: ClipboardEvent): string[] {
  const data = event.clipboardData;
  if (!data) return [];
  const uriList = data.getData('text/uri-list');
  if (uriList) {
    const parsed = parseClipboardFileUriList(uriList);
    if (parsed.length > 0) return parsed;
  }
  const gnomeCopied = data.getData('x-special/gnome-copied-files');
  if (gnomeCopied) {
    const lines = gnomeCopied.split(/\r?\n/u);
    const action = lines[0]?.trim();
    if (action === 'copy' || action === 'cut') {
      const parsed = parseClipboardFileUriList(lines.slice(1).join('\n'));
      if (parsed.length > 0) return parsed;
    }
  }
  return [];
}
