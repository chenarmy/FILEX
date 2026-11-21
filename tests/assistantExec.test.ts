import { describe, expect, it } from 'vitest';
import {
  formatAssistantExecOutputForModel,
  parseAssistantExecRequest,
  stripAssistantExecFence,
} from '@/domain/assistantExec';

describe('assistant diagnostic execution protocol', () => {
  it('parses a valid filex-exec-v1 JSON fence and strips it from visible markdown', () => {
    const content = [
      '我将先检查 CPU 占用最高的进程。',
      '```filex-exec-v1',
      '{"command":"ps aux --sort=-%cpu | head -n 15","reason":"定位高 CPU 进程"}',
      '```',
    ].join('\n');

    expect(parseAssistantExecRequest(content)).toEqual({
      command: 'ps aux --sort=-%cpu | head -n 15',
      reason: '定位高 CPU 进程',
    });
    expect(stripAssistantExecFence(content)).toBe('我将先检查 CPU 占用最高的进程。');
  });

  it('rejects malformed JSON, missing commands, and unsafe control characters', () => {
    expect(parseAssistantExecRequest('plain text without fence')).toBeNull();
    expect(parseAssistantExecRequest('```filex-exec-v1\n{"reason":"no cmd"}\n```')).toBeNull();
    expect(parseAssistantExecRequest('```filex-exec-v1\n{"command":"ps\u0000aux"}\n```')).toBeNull();
    expect(parseAssistantExecRequest('```filex-exec-v1\nnot-json\n```')).toBeNull();
  });

  it('formats execution results with exit code, stdout, stderr, and truncation notices', () => {
    const formatted = formatAssistantExecOutputForModel({
      command: 'free -h',
      risk: 'read_only',
      exitCode: 0,
      stdout: 'Mem: 3.6Gi total, 2.5Gi used',
      stderr: '',
      truncated: true,
      durationMs: 142,
    });
    expect(formatted).toContain('Command: free -h');
    expect(formatted).toContain('Exit code: 0');
    expect(formatted).toContain('truncated');
    expect(formatted).toContain('Mem: 3.6Gi total, 2.5Gi used');
  });
});
