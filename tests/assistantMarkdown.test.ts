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

  it('parses GFM tables even immediately after a paragraph without a blank line', () => {
    const markdown = [
      '当前服务器进程概况如下（基于 `ps aux --sort=-%cpu | head -n 20`）：',
      '**Java 业务服务（用户 `wms`，均为 prod 配置，Xms=Xmx=768m，Oct19 启动）**',
      '| PID | 端口 | 模块 | %CPU | %MEM | RSS |',
      '|---:|---:|:---|---:|---:|---:|',
      '| 1256 | 9999 | wms-platform-whse-core | 1.0 | 2.3 | ~1.5 GB |',
      '| 1272 | 9977 | wms-sys-center-web | 0.7 | 1.3 | ~888 MB |',
    ].join('\n');

    expect(parseAssistantMarkdown(markdown)).toEqual([
      {
        kind: 'paragraph',
        text: [
          '当前服务器进程概况如下（基于 `ps aux --sort=-%cpu | head -n 20`）：',
          '**Java 业务服务（用户 `wms`，均为 prod 配置，Xms=Xmx=768m，Oct19 启动）**',
        ].join('\n'),
      },
      {
        kind: 'table',
        headers: ['PID', '端口', '模块', '%CPU', '%MEM', 'RSS'],
        alignments: ['right', 'right', 'left', 'right', 'right', 'right'],
        rows: [
          ['1256', '9999', 'wms-platform-whse-core', '1.0', '2.3', '~1.5 GB'],
          ['1272', '9977', 'wms-sys-center-web', '0.7', '1.3', '~888 MB'],
        ],
      },
    ]);
  });

  it('handles pipes inside inline code, escaped pipes, streaming header-only tables, and tables without outer pipes', () => {
    const markdown = [
      'Command | Description | Status',
      '--- | :---: | ---',
      '`ps aux | grep java` | Filter \\| Java | OK',
      '`df -h` | Disk usage',
      '',
      '| PID | Name |',
      '|---|---|',
    ].join('\n');

    expect(parseAssistantMarkdown(markdown)).toEqual([
      {
        kind: 'table',
        headers: ['Command', 'Description', 'Status'],
        alignments: [null, 'center', null],
        rows: [
          ['`ps aux | grep java`', 'Filter | Java', 'OK'],
          ['`df -h`', 'Disk usage', ''],
        ],
      },
      {
        kind: 'table',
        headers: ['PID', 'Name'],
        alignments: [null, null],
        rows: [],
      },
    ]);
  });

  it('parses nested inline code inside bold, italic, strikethrough and safe links while preserving snake_case', () => {
    expect(parseAssistantInline('**Java 业务服务（用户 `wms`，均为 prod 配置）**')).toEqual([
      {
        kind: 'strong',
        value: 'Java 业务服务（用户 `wms`，均为 prod 配置）',
        children: [
          { kind: 'text', value: 'Java 业务服务（用户 ' },
          { kind: 'code', value: 'wms' },
          { kind: 'text', value: '，均为 prod 配置）' },
        ],
      },
    ]);

    expect(parseAssistantInline('wsss_defence_service and rcu_sched stay plain')).toEqual([
      { kind: 'text', value: 'wsss_defence_service and rcu_sched stay plain' },
    ]);

    expect(parseAssistantInline('**5 * 768 MB** and ``code with `tick` inside``')).toEqual([
      { kind: 'strong', value: '5 * 768 MB' },
      { kind: 'text', value: ' and ' },
      { kind: 'code', value: 'code with `tick` inside' },
    ]);

    expect(parseAssistantInline('*italic*, ~~old~~, ***both***, [docs](https://example.com/a_(b)), [bad](javascript:alert(1))')).toEqual([
      { kind: 'em', value: 'italic' },
      { kind: 'text', value: ', ' },
      { kind: 'strike', value: 'old' },
      { kind: 'text', value: ', ' },
      { kind: 'strong', value: 'both', children: [{ kind: 'em', value: 'both' }] },
      { kind: 'text', value: ', ' },
      { kind: 'link', value: 'docs', href: 'https://example.com/a_(b)' },
      { kind: 'text', value: ', [bad](javascript:alert(1))' },
    ]);
  });

  it('parses headings up to level 6, horizontal rules, tilde fences, and nested lists', () => {
    const markdown = [
      '#### 详细排查',
      '',
      '---',
      '',
      '- **内存**',
      '  - JVM 堆 768 MB',
      '  - 堆外开销',
      '',
      '3. 第三步',
      '4. 第四步',
      '',
      '~~~ini',
      'max_connections = 200',
      '~~~',
    ].join('\n');

    expect(parseAssistantMarkdown(markdown)).toEqual([
      { kind: 'heading', level: 4, text: '详细排查' },
      { kind: 'hr' },
      { kind: 'bullet-list', items: ['**内存**', 'JVM 堆 768 MB', '堆外开销'], itemDepths: [0, 1, 1] },
      { kind: 'ordered-list', items: ['第三步', '第四步'], start: 3 },
      { kind: 'code', language: 'ini', text: 'max_connections = 200' },
    ]);
  });
});
