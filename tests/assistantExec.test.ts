import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_SESSION_APPROVAL_LIMIT,
  assistantApprovalBindingKey,
  formatAssistantExecOutputForModel,
  isAssistantCommandRememberedInSession,
  parseAssistantExecRequest,
  rememberAssistantSessionCommand,
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

  it('scopes session-remembered command approvals strictly to session generation, host, port, and risk tier', () => {
    const target = { sessionId: 'sess-1', generation: 3, host: '10.0.0.10', port: 22 };
    const bindingKey = assistantApprovalBindingKey(target);
    let approved = rememberAssistantSessionCommand([], '  systemctl reload nginx  ');
    approved = rememberAssistantSessionCommand(approved, 'systemctl reload nginx');
    expect(approved).toEqual(['systemctl reload nginx']);

    // Exact match within the same target generation and requires_confirmation risk tier.
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      target,
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(true);

    // Different command does not match.
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      target,
      approved,
      'requires_confirmation',
      'systemctl restart nginx',
    )).toBe(false);

    // Destructive and blocked tiers are never auto-approved from session memory.
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      target,
      approved,
      'destructive',
      'systemctl reload nginx',
    )).toBe(false);
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      target,
      approved,
      'blocked',
      'systemctl reload nginx',
    )).toBe(false);

    // Changing generation, sessionId, host, or port invalidates remembered approvals.
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      { ...target, generation: 4 },
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(false);
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      { ...target, sessionId: 'sess-2' },
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(false);
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      { ...target, host: '10.0.0.11' },
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(false);
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      { ...target, port: 2222 },
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(false);
    expect(isAssistantCommandRememberedInSession(
      bindingKey,
      null,
      approved,
      'requires_confirmation',
      'systemctl reload nginx',
    )).toBe(false);
  });

  it('bounds remembered session approvals to the configured limit', () => {
    let approved: string[] = [];
    for (let index = 0; index < ASSISTANT_SESSION_APPROVAL_LIMIT + 5; index += 1) {
      approved = rememberAssistantSessionCommand(approved, `cmd-${index}`);
    }
    expect(approved).toHaveLength(ASSISTANT_SESSION_APPROVAL_LIMIT);
    expect(approved[0]).toBe('cmd-5');
    expect(approved[approved.length - 1]).toBe(`cmd-${ASSISTANT_SESSION_APPROVAL_LIMIT + 4}`);
  });
});
