export interface AssistantInlineToken {
  kind: 'text' | 'strong' | 'code';
  value: string;
}

export type AssistantMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; language: string | null; text: string };

const FENCE_OPEN = /^```[ \t]*([A-Za-z0-9_+-]{0,32})?[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,3})[ \t]+(.+)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.+)$/;
const ORDERED = /^[ \t]*(\d+)[.)][ \t]+(.+)$/;
const QUOTE = /^[ \t]*>[ \t]?(.*)$/;

function startsBlock(line: string): boolean {
  return FENCE_OPEN.test(line)
    || HEADING.test(line)
    || BULLET.test(line)
    || ORDERED.test(line)
    || QUOTE.test(line);
}

export function parseAssistantInline(text: string): AssistantInlineToken[] {
  const tokens: AssistantInlineToken[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) tokens.push({ kind: 'text', value: text.slice(offset, index) });
    const value = match[0];
    if (value.startsWith('**')) {
      tokens.push({ kind: 'strong', value: value.slice(2, -2) });
    } else {
      tokens.push({ kind: 'code', value: value.slice(1, -1) });
    }
    offset = index + value.length;
  }
  if (offset < text.length) tokens.push({ kind: 'text', value: text.slice(offset) });
  return tokens.length > 0 ? tokens : [{ kind: 'text', value: text }];
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
      const content: string[] = [];
      const language = fence[1]?.toLowerCase() || null;
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? '')) {
        content.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language, text: content.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2]?.trim() ?? '' });
      index += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = BULLET.exec(lines[index] ?? '');
        if (!item) break;
        items.push(item[1]?.trim() ?? '');
        index += 1;
      }
      blocks.push({ kind: 'bullet-list', items });
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = ORDERED.exec(lines[index] ?? '');
        if (!item) break;
        items.push(item[2]?.trim() ?? '');
        index += 1;
      }
      blocks.push({ kind: 'ordered-list', items });
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
      if (!next.trim() || startsBlock(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}
