import { describe, expect, it } from 'vitest';
import { parseAssistantInline, parseAssistantMarkdown } from '@/domain/assistantMarkdown';

describe('assistant Markdown parser', () => {
  it('parses headings, lists and fenced code into safe structured blocks', () => {
    const blocks = parseAssistantMarkdown([
      '## Diagnosis',
      '',
      'Check **two** things with `journalctl`.',
      '',
      '- service state',
      '- recent errors',
      '',
      '```bash',
      'systemctl status nginx',
      '```',
      '',
      '<script>alert(1)</script>',
    ].join('\n'));

    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Diagnosis' },
      { kind: 'paragraph', text: 'Check **two** things with `journalctl`.' },
      { kind: 'bullet-list', items: ['service state', 'recent errors'] },
      { kind: 'code', language: 'bash', text: 'systemctl status nginx' },
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
    ]);
  });

  it('tokenizes emphasis and inline code without interpreting HTML', () => {
    expect(parseAssistantInline('Use **care** with `<host>` & done')).toEqual([
      { kind: 'text', value: 'Use ' },
      { kind: 'strong', value: 'care' },
      { kind: 'text', value: ' with ' },
      { kind: 'code', value: '<host>' },
      { kind: 'text', value: ' & done' },
    ]);
  });

  it('keeps an unterminated fence as code through the end of the response', () => {
    expect(parseAssistantMarkdown('```powershell\nGet-Service')).toEqual([
      { kind: 'code', language: 'powershell', text: 'Get-Service' },
    ]);
  });
});
