export const MAX_PROFILE_COMMAND_HISTORY_ENTRIES = 200;
export const MAX_HISTORY_COMMAND_CHARS = 4_096;

const SECRET_ENV_KEYWORDS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'api_key',
  'apikey',
  'access_key',
  'private_key',
  'auth_header',
] as const;

const SECRET_FLAGS = [
  '--password',
  '-password',
  '--passphrase',
  '--token',
  '--access-token',
  '--secret',
  '--client-secret',
  '--api-key',
  '--apikey',
  '--auth-token',
  '-x-api-key',
  '--bearer',
] as const;

const INLINE_PASSWORD_FLAG_CMDS = new Set([
  'mysql',
  'mariadb',
  'mysqldump',
  'sshpass',
  'psql',
  'redis-cli',
  'unzip',
  'zip',
]);

/** Returns true when a command looks empty, malformed, or likely contains credentials/keys. */
export function shouldExcludeCommandFromHistory(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes('\0') || Array.from(trimmed).length > MAX_HISTORY_COMMAND_CHARS) {
    return true;
  }

  const upper = trimmed.toUpperCase();
  if (upper.includes('BEGIN ') && upper.includes('PRIVATE KEY')) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('authorization: bearer')
    || lower.includes('authorization: basic')
    || hasUrlCredentials(lower)
    || hasStdinPasswordPipe(lower)
  ) {
    return true;
  }

  return hasSensitiveEnvAssignment(lower) || hasSensitiveCliFlag(lower);
}

function hasUrlCredentials(lower: string): boolean {
  for (const scheme of ['https://', 'http://', 'socks5://', 'ssh://', 'ftp://']) {
    let rest = lower;
    while (true) {
      const idx = rest.indexOf(scheme);
      if (idx < 0) break;
      const afterScheme = rest.slice(idx + scheme.length);
      const authority = afterScheme.split(/[/?#\s'"]/)[0] ?? '';
      const atIdx = authority.indexOf('@');
      if (atIdx >= 0) {
        const userinfo = authority.slice(0, atIdx);
        if (userinfo.includes(':') && !userinfo.endsWith(':')) {
          return true;
        }
      }
      rest = afterScheme;
    }
  }
  return false;
}

function hasStdinPasswordPipe(lower: string): boolean {
  if (
    lower.includes('| sudo -s')
    || lower.includes('|sudo -s')
    || lower.includes('| chpasswd')
    || lower.includes('|chpasswd')
    || lower.includes('| passwd')
    || lower.includes('|passwd')
  ) {
    return true;
  }
  return lower.includes('sshpass ') && (lower.includes(' -p') || lower.includes("-p'"));
}

function hasSensitiveEnvAssignment(lower: string): boolean {
  for (const rawToken of lower.split(/[\s;&]+/)) {
    const token = rawToken.replace(/^['"]+|['"]+$/g, '');
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const lhs = token.slice(0, eq).replace(/^['"]+|['"]+$/g, '');
    const rhs = token.slice(eq + 1).replace(/^['"]+|['"]+$/g, '');
    if (!rhs) continue;
    if (SECRET_ENV_KEYWORDS.some((keyword) => lhs.includes(keyword))) {
      return true;
    }
  }
  return false;
}

function hasSensitiveCliFlag(lower: string): boolean {
  const tokens = lower.trim().split(/\s+/);
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = (tokens[idx] ?? '').replace(/^['"]+|['"]+$/g, '');
    if (!token) continue;
    if (
      SECRET_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`) || token.startsWith(`${flag}:`))
      && (token.includes('=') || token.includes(':') || idx + 1 < tokens.length)
    ) {
      return true;
    }
    if ((token === 'bearer' || token === 'token') && idx + 1 < tokens.length) {
      const prev = tokens[idx - 1] ?? '';
      if (prev.includes('header') || prev.includes('-h') || prev.includes('auth')) {
        return true;
      }
    }
    if (token.startsWith('-p') && token.length > 2 && !token.startsWith('--')) {
      const cmd = tokens[0] ?? '';
      if (INLINE_PASSWORD_FLAG_CMDS.has(cmd)) return true;
    }
  }
  return false;
}
