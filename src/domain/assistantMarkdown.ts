export type AssistantTableAlignment = 'left' | 'center' | 'right' | null;

export type AssistantInlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: string; children?: AssistantInlineToken[] }
  | { kind: 'em'; value: string; children?: AssistantInlineToken[] }
  | { kind: 'strike'; value: string; children?: AssistantInlineToken[] }
  | { kind: 'link'; value: string; href: string; children?: AssistantInlineToken[] };

export type AssistantMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet-list'; items: string[]; itemDepths?: number[] }
  | { kind: 'ordered-list'; items: string[]; start?: number; itemDepths?: number[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; headers: string[]; alignments: AssistantTableAlignment[]; rows: string[][] }
  | { kind: 'hr' }
  | { kind: 'code'; language: string | null; text: string };

const MAX_INLINE_DEPTH = 4;
const MAX_LIST_DEPTH = 4;

const FENCE_OPEN = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]{0,40})?.*$/;
const HEADING = /^[ ]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/;
const HORIZONTAL_RULE = /^[ ]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.+)$/;
const ORDERED = /^([ \t]*)(\d+)[.)][ \t]+(.+)$/;
const QUOTE = /^[ ]{0,3}>[ \t]?(.*)$/;
const TABLE_DELIMITER_CELL = /^:?-{1,}:?$/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE_CHAR = /\s/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE_CHAR.test(ch);
}

function countIndent(prefix: string): number {
  let spaces = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    spaces += prefix[i] === '\t' ? 2 : 1;
  }
  return spaces;
}

function pushText(tokens: AssistantInlineToken[], value: string): void {
  if (!value) return;
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === 'text') {
    previous.value += value;
    return;
  }
  tokens.push({ kind: 'text', value });
}

function countBackticks(text: string, index: number): number {
  let count = 0;
  while (index + count < text.length && text[index + count] === '`') {
    count += 1;
  }
  return count;
}

function findClosingCodeSpan(text: string, startAfterOpen: number, tickCount: number): number {
  let pos = startAfterOpen;
  while (pos < text.length) {
    if (text[pos] === '`') {
      const run = countBackticks(text, pos);
      if (run === tickCount) return pos;
      pos += run;
      continue;
    }
    pos += 1;
  }
  return -1;
}

function normalizeCodeSpanContent(raw: string): string {
  if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim().length > 0) {
    return raw.slice(1, -1);
  }
  return raw;
}

function findClosingDelimiter(
  text: string,
  start: number,
  delimiter: '***' | '**' | '__' | '*' | '_' | '~~',
): number {
  let pos = start;
  const len = delimiter.length;

  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\n') return -1;

    if (ch === '`') {
      const run = countBackticks(text, pos);
      const close = findClosingCodeSpan(text, pos + run, run);
      if (close !== -1) {
        pos = close + run;
        continue;
      }
      pos += run;
      continue;
    }

    if (text.startsWith(delimiter, pos)) {
      if (delimiter === '**' && text.startsWith('***', pos) && !text.startsWith('****', pos)) {
        // Prefer letting the inner `*` close an italic span before `**` closes bold.
        if (pos > start && !isWhitespaceChar(text[pos])) {
          const innerStart = text.slice(start, pos);
          if (innerStart.includes('*')) {
            pos += 1;
            continue;
          }
        }
      }

      if (delimiter === '*' && text[pos + 1] === '*') {
        pos += 2;
        continue;
      }
      if (delimiter === '_' && text[pos + 1] === '_') {
        pos += 2;
        continue;
      }

      const prev = pos > 0 ? text[pos - 1] : undefined;
      const next = text[pos + len];
      const validBoundary = (delimiter === '_' || delimiter === '__') ? !isWordChar(next) : true;
      if (pos > start && !isWhitespaceChar(prev) && validBoundary) {
        return pos;
      }
    }

    pos += 1;
  }

  return -1;
}

function isSafeHttpUrl(raw: string): boolean {
  if (!/^https?:\/\/[^\s<>"]+$/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function findClosingBracket(text: string, start: number): number {
  let pos = start;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\n' || ch === '[') return -1;
    if (ch === '`') {
      const run = countBackticks(text, pos);
      const close = findClosingCodeSpan(text, pos + run, run);
      if (close !== -1) {
        pos = close + run;
        continue;
      }
      pos += run;
      continue;
    }
    if (ch === ']') return pos;
    pos += 1;
  }
  return -1;
}

function findClosingParen(text: string, start: number): number {
  let pos = start;
  let nested = 0;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '\n' || isWhitespaceChar(ch)) return -1;
    if (ch === '(') {
      nested += 1;
    } else if (ch === ')') {
      if (nested === 0) return pos;
      nested -= 1;
    }
    pos += 1;
  }
  return -1;
}

function wrapInlineToken(
  kind: 'strong' | 'em' | 'strike',
  rawInner: string,
  depth: number,
): Extract<AssistantInlineToken, { kind: 'strong' | 'em' | 'strike' }> {
  if (depth < MAX_INLINE_DEPTH) {
    const children = parseAssistantInlineInternal(rawInner, depth + 1);
    if (children.length > 1 || (children.length === 1 && children[0]?.kind !== 'text')) {
      return { kind, value: rawInner, children };
    }
  }
  return { kind, value: rawInner };
}

function parseAssistantInlineInternal(text: string, depth: number): AssistantInlineToken[] {
  const tokens: AssistantInlineToken[] = [];
  let pos = 0;

  while (pos < text.length) {
    const ch = text[pos];

    // Inline code spans have highest precedence.
    if (ch === '`') {
      const run = countBackticks(text, pos);
      const close = findClosingCodeSpan(text, pos + run, run);
      if (close !== -1 && close > pos + run) {
        const content = normalizeCodeSpanContent(text.slice(pos + run, close));
        tokens.push({ kind: 'code', value: content });
        pos = close + run;
        continue;
      }
      pushText(tokens, text.slice(pos, pos + run));
      pos += run;
      continue;
    }

    // Markdown links: [label](https://...)
    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const closeBracket = findClosingBracket(text, pos + 1);
      if (closeBracket > pos + 1 && text[closeBracket + 1] === '(') {
        const closeParen = findClosingParen(text, closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          const label = text.slice(pos + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen).trim();
          if (label.trim().length > 0 && isSafeHttpUrl(href)) {
            const children = parseAssistantInlineInternal(label, depth + 1);
            const hasStructuredChildren = children.length > 1
              || (children.length === 1 && children[0]?.kind !== 'text');
            tokens.push(hasStructuredChildren
              ? { kind: 'link', value: label, href, children }
              : { kind: 'link', value: label, href });
            pos = closeParen + 1;
            continue;
          }
        }
      }
    }

    // Bold + italic: ***text***
    if (text.startsWith('***', pos) && !text.startsWith('****', pos) && !isWhitespaceChar(text[pos + 3])) {
      const close = findClosingDelimiter(text, pos + 3, '***');
      if (close !== -1) {
        const rawInner = text.slice(pos + 3, close);
        const emToken = wrapInlineToken('em', rawInner, depth + 1);
        tokens.push({ kind: 'strong', value: rawInner, children: [emToken] });
        pos = close + 3;
        continue;
      }
    }

    // Bold: **text**
    if (text.startsWith('**', pos) && !text.startsWith('***', pos) && !isWhitespaceChar(text[pos + 2])) {
      const close = findClosingDelimiter(text, pos + 2, '**');
      if (close !== -1) {
        const rawInner = text.slice(pos + 2, close);
        tokens.push(wrapInlineToken('strong', rawInner, depth));
        pos = close + 2;
        continue;
      }
    }

    // Bold: __text__ (respect intraword boundaries)
    if (
      text.startsWith('__', pos)
      && !text.startsWith('___', pos)
      && !isWordChar(text[pos - 1])
      && !isWhitespaceChar(text[pos + 2])
    ) {
      const close = findClosingDelimiter(text, pos + 2, '__');
      if (close !== -1) {
        const rawInner = text.slice(pos + 2, close);
        tokens.push(wrapInlineToken('strong', rawInner, depth));
        pos = close + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text.startsWith('~~', pos) && !text.startsWith('~~~', pos) && !isWhitespaceChar(text[pos + 2])) {
      const close = findClosingDelimiter(text, pos + 2, '~~');
      if (close !== -1) {
        const rawInner = text.slice(pos + 2, close);
        tokens.push(wrapInlineToken('strike', rawInner, depth));
        pos = close + 2;
        continue;
      }
    }

    // Italic: *text*
    if (ch === '*' && text[pos + 1] !== '*' && !isWhitespaceChar(text[pos + 1])) {
      const close = findClosingDelimiter(text, pos + 1, '*');
      if (close !== -1) {
        const rawInner = text.slice(pos + 1, close);
        tokens.push(wrapInlineToken('em', rawInner, depth));
        pos = close + 1;
        continue;
      }
    }

    // Italic: _text_ (respect intraword boundaries so snake_case stays intact)
    if (
      ch === '_'
      && text[pos + 1] !== '_'
      && !isWordChar(text[pos - 1])
      && !isWhitespaceChar(text[pos + 1])
    ) {
      const close = findClosingDelimiter(text, pos + 1, '_');
      if (close !== -1) {
        const rawInner = text.slice(pos + 1, close);
        tokens.push(wrapInlineToken('em', rawInner, depth));
        pos = close + 1;
        continue;
      }
    }

    pushText(tokens, ch ?? '');
    pos += 1;
  }

  return tokens.length > 0 ? tokens : [{ kind: 'text', value: text }];
}

export function parseAssistantInline(text: string): AssistantInlineToken[] {
  return parseAssistantInlineInternal(text, 0);
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) return null;

  const pipePositions: number[] = [];
  let pos = 0;
  while (pos < trimmed.length) {
    const ch = trimmed[pos];
    if (ch === '`') {
      const run = countBackticks(trimmed, pos);
      const close = findClosingCodeSpan(trimmed, pos + run, run);
      if (close !== -1) {
        pos = close + run;
        continue;
      }
      pos += run;
      continue;
    }
    if (ch === '|' && !isEscapedAt(trimmed, pos)) {
      pipePositions.push(pos);
    }
    pos += 1;
  }

  if (pipePositions.length === 0) return null;

  const hasLeadingPipe = pipePositions[0] === 0;
  const hasTrailingPipe = pipePositions[pipePositions.length - 1] === trimmed.length - 1;
  const segments: string[] = [];

  let segmentStart = hasLeadingPipe ? 1 : 0;
  for (let i = hasLeadingPipe ? 1 : 0; i < pipePositions.length; i += 1) {
    const pipePos = pipePositions[i] ?? 0;
    segments.push(trimmed.slice(segmentStart, pipePos));
    segmentStart = pipePos + 1;
  }
  if (!hasTrailingPipe) {
    segments.push(trimmed.slice(segmentStart));
  }

  if (segments.length === 0) return null;
  return segments.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function parseTableAlignments(line: string): AssistantTableAlignment[] | null {
  const cells = splitTableRow(line);
  if (!cells || cells.length === 0) return null;
  const alignments: AssistantTableAlignment[] = [];

  for (const cell of cells) {
    if (!TABLE_DELIMITER_CELL.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) {
      alignments.push('center');
    } else if (left) {
      alignments.push('left');
    } else if (right) {
      alignments.push('right');
    } else {
      alignments.push(null);
    }
  }

  return alignments;
}

function parseTableStart(
  lines: string[],
  index: number,
): { headers: string[]; alignments: AssistantTableAlignment[] } | null {
  if (index + 1 >= lines.length) return null;
  const headerLine = lines[index] ?? '';
  const delimiterLine = lines[index + 1] ?? '';
  if (startsNonTableBlock(headerLine)) return null;
  const headers = splitTableRow(headerLine);
  if (!headers) return null;
  const alignments = parseTableAlignments(delimiterLine);
  if (!alignments || alignments.length !== headers.length) return null;
  return { headers, alignments };
}

function startsNonTableBlock(line: string): boolean {
  return FENCE_OPEN.test(line)
    || HEADING.test(line)
    || HORIZONTAL_RULE.test(line)
    || BULLET.test(line)
    || ORDERED.test(line)
    || QUOTE.test(line);
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return startsNonTableBlock(line) || parseTableStart(lines, index) !== null;
}

function isFenceClose(line: string, markerChar: string, markerLen: number): boolean {
  const match = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  const run = match[1] ?? '';
  return run[0] === markerChar && run.length >= markerLen;
}

export function parseAssistantMarkdown(markdown: string): AssistantMarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AssistantMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const markerChar = marker[0] ?? '`';
      const markerLen = marker.length;
      const content: string[] = [];
      const language = fence[2]?.toLowerCase() || null;
      index += 1;
      while (index < lines.length && !isFenceClose(lines[index] ?? '', markerChar, markerLen)) {
        content.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language, text: content.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1]?.length ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: heading[2]?.trim() ?? '' });
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    const tableStart = parseTableStart(lines, index);
    if (tableStart) {
      const { headers, alignments } = tableStart;
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index] ?? '';
        if (!rowLine.trim() || startsNonTableBlock(rowLine)) break;
        const cells = splitTableRow(rowLine);
        if (!cells) break;
        rows.push(Array.from({ length: headers.length }, (_, col) => cells[col] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', headers, alignments, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const items: string[] = [];
      const depths: number[] = [];
      const baseIndent = countIndent(bullet[1] ?? '');
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (HORIZONTAL_RULE.test(current)) break;
        const item = BULLET.exec(current);
        if (item) {
          const indent = countIndent(item[1] ?? '');
          const depth = Math.min(MAX_LIST_DEPTH, Math.floor(Math.max(0, indent - baseIndent) / 2));
          items.push(item[2]?.trim() ?? '');
          depths.push(depth);
          index += 1;
          continue;
        }
        // Indented continuation line for the current list item.
        if (
          items.length > 0
          && current.trim().length > 0
          && countIndent(current.match(/^[ \t]*/)?.[0] ?? '') >= baseIndent + 2
          && !startsBlock(lines, index)
        ) {
          items[items.length - 1] = `${items[items.length - 1]}\n${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      const hasNesting = depths.some((depth) => depth > 0);
      blocks.push(hasNesting
        ? { kind: 'bullet-list', items, itemDepths: depths }
        : { kind: 'bullet-list', items });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      const items: string[] = [];
      const depths: number[] = [];
      const baseIndent = countIndent(ordered[1] ?? '');
      const parsedStart = Number.parseInt(ordered[2] ?? '1', 10);
      const start = Number.isFinite(parsedStart) && parsedStart >= 0 ? parsedStart : 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = ORDERED.exec(current);
        if (item) {
          const indent = countIndent(item[1] ?? '');
          const depth = Math.min(MAX_LIST_DEPTH, Math.floor(Math.max(0, indent - baseIndent) / 2));
          items.push(item[3]?.trim() ?? '');
          depths.push(depth);
          index += 1;
          continue;
        }
        if (
          items.length > 0
          && current.trim().length > 0
          && countIndent(current.match(/^[ \t]*/)?.[0] ?? '') >= baseIndent + 2
          && !startsBlock(lines, index)
        ) {
          items[items.length - 1] = `${items[items.length - 1]}\n${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      const hasNesting = depths.some((depth) => depth > 0);
      const block: Extract<AssistantMarkdownBlock, { kind: 'ordered-list' }> = {
        kind: 'ordered-list',
        items,
      };
      if (start !== 1) block.start = start;
      if (hasNesting) block.itemDepths = depths;
      blocks.push(block);
      continue;
    }

    if (QUOTE.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index] ?? '');
        if (!quote) break;
        quoteLines.push(quote[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quoteLines.join('\n').trim() });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (!next.trim() || startsBlock(lines, index)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}
