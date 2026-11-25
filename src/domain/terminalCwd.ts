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

export function extractCommandFromPromptLine(line: string): string | null {
  const normalized = line.replace(/[\r\n]+$/, '').trimEnd();
  const match = /^(?:.*?[$#%>]\s+)?(cd(?:\s+[^\r\n]*)?)$/.exec(normalized);
  return match?.[1]?.trim() ?? null;
}

type EscapeState = 'none' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc_esc';

export interface TerminalCwdTracker {
  feed: (
    data: string,
    currentDirectory: string | null,
    readPromptLine?: () => string | null,
  ) => string | null;
  reset: () => void;
}

export function createTerminalCwdTracker(): TerminalCwdTracker {
  let buffer = '';
  let tainted = false;
  let escapeState: EscapeState = 'none';

  function reset(): void {
    buffer = '';
    tainted = false;
    escapeState = 'none';
  }

  function feed(
    data: string,
    currentDirectory: string | null,
    readPromptLine?: () => string | null,
  ): string | null {
    let resolvedDirectory: string | null = null;
    for (const character of data) {
      if (escapeState === 'esc') {
        tainted = true;
        if (character === '[') escapeState = 'csi';
        else if (character === 'O') escapeState = 'ss3';
        else if (character === ']') escapeState = 'osc';
        else escapeState = 'none';
        continue;
      }
      if (escapeState === 'csi') {
        if (character >= '@' && character <= '~') escapeState = 'none';
        continue;
      }
      if (escapeState === 'ss3') {
        escapeState = 'none';
        continue;
      }
      if (escapeState === 'osc') {
        if (character === '\x07') escapeState = 'none';
        else if (character === '\x1b') escapeState = 'osc_esc';
        continue;
      }
      if (escapeState === 'osc_esc') {
        escapeState = character === '\\' ? 'none' : 'osc';
        continue;
      }

      if (character === '\r' || character === '\n') {
        const raw = buffer;
        const wasTainted = tainted;
        buffer = '';
        tainted = false;
        if (!wasTainted) {
          resolvedDirectory = resolveCdCommand(raw, currentDirectory) ?? resolvedDirectory;
        } else {
          const line = readPromptLine?.() ?? null;
          const command = line ? extractCommandFromPromptLine(line) : null;
          if (command) {
            resolvedDirectory = resolveCdCommand(command, currentDirectory) ?? resolvedDirectory;
          }
        }
        continue;
      }
      if (character === '\x03') {
        buffer = '';
        tainted = false;
        continue;
      }
      if (character === '\x15') {
        buffer = '';
        tainted = false;
        continue;
      }
      if (character === '\x1b') {
        tainted = true;
        escapeState = 'esc';
        continue;
      }
      if (character === '\t') {
        tainted = true;
        continue;
      }
      if (character === '\x7f' || character === '\x08') {
        if (!tainted) buffer = buffer.slice(0, -1);
        continue;
      }
      if (character < ' ') {
        tainted = true;
        continue;
      }
      if (!tainted && buffer.length < 4_096) buffer += character;
    }
    return resolvedDirectory;
  }

  return { feed, reset };
}
