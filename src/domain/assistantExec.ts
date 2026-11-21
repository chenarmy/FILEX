import type { AssistantCommandExecutionResult } from '@/api/domain/assistantApi';

export const ASSISTANT_DIAGNOSE_MAX_STEPS = 6;

export interface AssistantExecProposal {
  command: string;
  reason: string;
}

const EXEC_FENCE_PATTERN = /```filex-exec-v1[ \t]*\r?\n([\s\S]*?)```/i;
const EXEC_FENCE_GLOBAL_PATTERN = /```filex-exec-v1[ \t]*\r?\n[\s\S]*?```/gi;

function hasUnsafeControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0x00 && code <= 0x08)
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

export function parseAssistantExecRequest(content: string): AssistantExecProposal | null {
  const match = EXEC_FENCE_PATTERN.exec(content);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.command !== 'string') return null;
    const command = parsed.command.trim();
    if (!command || command.length > 2_000 || hasUnsafeControlChar(command)) return null;
    const rawReason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const reason = rawReason.slice(0, 400);
    return { command, reason };
  } catch {
    return null;
  }
}

export function stripAssistantExecFence(content: string): string {
  return content.replace(EXEC_FENCE_GLOBAL_PATTERN, '').trim();
}

export function formatAssistantExecOutputForModel(
  result: AssistantCommandExecutionResult,
  maxChars = 10_000,
): string {
  const sections: string[] = [
    `[FILEX command execution result; untrusted remote output]`,
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode === null ? 'unknown' : String(result.exitCode)}`,
    `Duration: ${result.durationMs} ms`,
  ];
  if (result.truncated) {
    sections.push('Note: Output was truncated at FILEX safety limit (32 KiB).');
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) {
    sections.push(`--- stdout ---\n${stdout}`);
  } else {
    sections.push('--- stdout ---\n(empty)');
  }
  if (stderr) {
    sections.push(`--- stderr ---\n${stderr}`);
  }
  const combined = sections.join('\n');
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}\n...[truncated by FILEX]...`;
}
