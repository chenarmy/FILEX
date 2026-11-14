export type FileVisualKind =
  | 'folder'
  | 'symlink'
  | 'code'
  | 'data'
  | 'config'
  | 'archive'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'spreadsheet'
  | 'database'
  | 'key'
  | 'executable'
  | 'generic';

const EXTENSIONS: ReadonlyArray<readonly [FileVisualKind, ReadonlySet<string>]> = [
  ['archive', new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'txz', 'xz', 'zip', 'zst'])],
  ['image', new Set(['avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'])],
  ['audio', new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'wma'])],
  ['video', new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv'])],
  ['spreadsheet', new Set(['csv', 'ods', 'tsv', 'xls', 'xlsm', 'xlsx'])],
  ['database', new Set(['db', 'db3', 'duckdb', 'mdb', 'sqlite', 'sqlite3'])],
  ['key', new Set(['cer', 'crt', 'der', 'key', 'p12', 'pem', 'pfx', 'ppk', 'pub'])],
  ['data', new Set(['json', 'json5', 'jsonl', 'toml', 'xml', 'yaml', 'yml'])],
  ['config', new Set(['cfg', 'conf', 'config', 'editorconfig', 'env', 'ini', 'properties'])],
  ['document', new Set(['doc', 'docx', 'epub', 'log', 'md', 'mdx', 'odt', 'pdf', 'ppt', 'pptx', 'rst', 'rtf', 'tex', 'txt'])],
  ['code', new Set(['c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'kt', 'lua', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue', 'wasm', 'zsh'])],
  ['executable', new Set(['appimage', 'bat', 'bin', 'cmd', 'com', 'deb', 'dll', 'dmg', 'exe', 'msi', 'out', 'pkg', 'rpm'])],
];

const CONFIG_NAMES = new Set([
  '.bash_logout',
  '.bash_profile',
  '.bashrc',
  '.cshrc',
  '.dockerignore',
  '.env',
  '.gitattributes',
  '.gitconfig',
  '.gitignore',
  '.inputrc',
  '.npmrc',
  '.profile',
  '.ssh_config',
  '.tcshrc',
  '.viminfo',
  '.vimrc',
  '.wgetrc',
  '.zprofile',
  '.zshrc',
  'dockerfile',
  'makefile',
  'nginx.conf',
]);

const COMPOUND_ARCHIVES = ['.tar.bz2', '.tar.gz', '.tar.xz', '.tar.zst'];
const DOCUMENT_NAMES = new Set(['.bash_history', '.python_history', '.zsh_history', 'license', 'readme']);

export function fileVisualKind(
  name: string,
  isDirectory: boolean,
  isSymlink = false,
): FileVisualKind {
  if (isSymlink) return 'symlink';
  if (isDirectory) return 'folder';

  const normalized = name.trim().toLocaleLowerCase('en-US');
  if (CONFIG_NAMES.has(normalized)) return 'config';
  if (DOCUMENT_NAMES.has(normalized)) return 'document';
  if (COMPOUND_ARCHIVES.some((suffix) => normalized.endsWith(suffix))) return 'archive';

  const lastDot = normalized.lastIndexOf('.');
  const extension = lastDot >= 0 ? normalized.slice(lastDot + 1) : '';
  for (const [kind, extensions] of EXTENSIONS) {
    if (extensions.has(extension)) return kind;
  }
  return 'generic';
}
