function tokenizeCdCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (!quote && /[;&|<>`]/.test(character)) return null;
    if (!quote && /\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
      continue;
    }
    token += character;
  }
  if (escaping || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

export function resolveCdCommand(command: string, currentDirectory: string | null): string | null {
  const tokens = tokenizeCdCommand(command);
  if (!tokens || tokens[0] !== 'cd') return null;
  const args = tokens.slice(1).filter((token) => token !== '--');
  if (args.length !== 1) return null;
  const target = args[0];
  if (!target || target.startsWith('~') || target.includes('$')) return null;
  if (target.startsWith('/')) return normalizePosixPath(target);
  if (!currentDirectory?.startsWith('/')) return null;
  return normalizePosixPath(`${currentDirectory}/${target}`);
}

function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
