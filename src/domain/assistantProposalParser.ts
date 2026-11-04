import type {
  AssistantChangePlanProposalV1,
  AssistantChangePlanStepV1,
  AssistantCommandDraft,
  AssistantCommandDraftProposalV1,
  AssistantCommandShell,
} from '@/types/contracts';

const COMMAND_DRAFT_MAX_BLOCKS = 5;
const COMMAND_DRAFT_MAX_BYTES = 10_000;
const CHANGE_PLAN_MAX_STEPS = 5;
const CHANGE_PLAN_MAX_COMMANDS_PER_STEP = 3;
const CHANGE_PLAN_MAX_COMMANDS = 15;
const CHANGE_PLAN_MAX_JSON_BYTES = 24_000;
const CHANGE_PLAN_MAX_TITLE_BYTES = 160;
const CHANGE_PLAN_MAX_SUMMARY_BYTES = 2_000;
const CHANGE_PLAN_MAX_STEP_TEXT_BYTES = 1_000;

export type AssistantProposalNotice =
  | 'too_many'
  | 'too_large'
  | 'unsafe_control'
  | 'plan_invalid'
  | 'plan_too_many'
  | 'plan_too_large'
  | 'plan_unsafe_control';

export type AssistantDraftProposalContent =
  | Pick<AssistantCommandDraftProposalV1, 'kind' | 'commands'>
  | Pick<AssistantChangePlanProposalV1, 'kind' | 'title' | 'summary' | 'steps'>;

export interface AssistantDraftContentParseResult {
  content: AssistantDraftProposalContent | null;
  notice: AssistantProposalNotice | null;
}

type ChangePlanNotice = Extract<AssistantProposalNotice, 'plan_invalid' | 'plan_too_many' | 'plan_too_large' | 'plan_unsafe_control'>;
type ChangePlanContentV1 = Pick<AssistantChangePlanProposalV1, 'title' | 'summary' | 'steps'>;

type ChangePlanParseResult =
  | { recognized: false }
  | { recognized: true; content: ChangePlanContentV1; notice: null }
  | { recognized: true; content: null; notice: ChangePlanNotice };

type PlanTextValidation =
  | { valid: true; value: string; bytes: number }
  | { valid: false; notice: ChangePlanNotice };

interface CommandDraftParseResult {
  commands: AssistantCommandDraft[];
  notice: 'too_many' | 'too_large' | 'unsafe_control' | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnsafeProposalCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x08
      || (codePoint >= 0x0b && codePoint <= 0x0c)
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || (codePoint >= 0x80 && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || codePoint === 0x7f
      || codePoint === 0x061c
      || (codePoint >= 0x200b && codePoint <= 0x200f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2060 && codePoint <= 0x2069)
      || codePoint === 0xfeff;
  });
}

function normalizeAssistantShell(value: unknown): AssistantCommandShell | null {
  if (typeof value !== 'string') return null;
  const shell = value.toLowerCase();
  if (shell === 'shell') return 'sh';
  if (shell === 'pwsh') return 'powershell';
  if (shell === 'bash' || shell === 'sh' || shell === 'zsh' || shell === 'powershell' || shell === 'cmd') {
    return shell;
  }
  return null;
}

function validatePlanText(value: unknown, maxBytes: number, singleLine = false): PlanTextValidation {
  if (typeof value !== 'string') return { valid: false, notice: 'plan_invalid' };
  const lineNormalized = value.replace(/\r\n?/g, '\n');
  if (hasUnsafeProposalCharacters(lineNormalized)) return { valid: false, notice: 'plan_unsafe_control' };
  const normalized = lineNormalized.trim();
  if (!normalized || (singleLine && /[\n\t\u2028\u2029]/.test(normalized))) {
    return { valid: false, notice: 'plan_invalid' };
  }
  const bytes = utf8ByteLength(normalized);
  if (bytes > maxBytes) return { valid: false, notice: 'plan_too_large' };
  return { valid: true, value: normalized, bytes };
}

function validatePlanCommand(value: unknown): PlanTextValidation {
  if (typeof value !== 'string') return { valid: false, notice: 'plan_invalid' };
  const normalized = value.replace(/\r\n?/g, '\n');
  if (hasUnsafeProposalCharacters(normalized)) return { valid: false, notice: 'plan_unsafe_control' };
  if (!normalized.trim()) return { valid: false, notice: 'plan_invalid' };
  const bytes = utf8ByteLength(normalized);
  if (bytes > COMMAND_DRAFT_MAX_BYTES) return { valid: false, notice: 'plan_too_large' };
  return { valid: true, value: normalized, bytes };
}

function parseSupportedCommandBlocks(content: string): CommandDraftParseResult {
  const commands: AssistantCommandDraft[] = [];
  let totalBytes = 0;

  for (const match of content.matchAll(/\x60{3}(bash|sh|zsh|shell|powershell|pwsh|cmd)[ \t]*\r?\n([\s\S]*?)\x60{3}/gi)) {
    const shellLabel = (match[1] ?? '').toLowerCase();
    const command = (match[2] ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (!command.trim()) continue;
    const bytes = utf8ByteLength(command);
    if (bytes > COMMAND_DRAFT_MAX_BYTES || totalBytes + bytes > COMMAND_DRAFT_MAX_BYTES) {
      return { commands: [], notice: 'too_large' };
    }
    if (hasUnsafeProposalCharacters(command)) return { commands: [], notice: 'unsafe_control' };

    totalBytes += bytes;
    const shell = normalizeAssistantShell(shellLabel);
    if (!shell) continue;
    commands.push({ shell, command });
    if (commands.length > COMMAND_DRAFT_MAX_BLOCKS) return { commands: [], notice: 'too_many' };
  }

  return { commands, notice: null };
}

function parseChangePlanDraft(content: string): ChangePlanParseResult {
  const openings = [...content.matchAll(/\x60{3}filex-change-plan-v1[ \t]*\r?\n/gi)];
  if (openings.length === 0) {
    return /\x60{3}filex-change-plan-v1\b/i.test(content)
      ? { recognized: true, content: null, notice: 'plan_invalid' }
      : { recognized: false };
  }

  const blocks = [...content.matchAll(/\x60{3}filex-change-plan-v1[ \t]*\r?\n([\s\S]*?)\x60{3}/gi)];
  if (blocks.length !== openings.length) return { recognized: true, content: null, notice: 'plan_invalid' };
  if (blocks.length > 1) return { recognized: true, content: null, notice: 'plan_too_many' };

  const json = blocks[0]?.[1] ?? '';
  if (utf8ByteLength(json) > CHANGE_PLAN_MAX_JSON_BYTES) {
    return { recognized: true, content: null, notice: 'plan_too_large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { recognized: true, content: null, notice: 'plan_invalid' };
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['title', 'summary', 'steps'])) {
    return { recognized: true, content: null, notice: 'plan_invalid' };
  }
  const rawSteps = parsed.steps;
  if (!isUnknownArray(rawSteps)) return { recognized: true, content: null, notice: 'plan_invalid' };
  if (rawSteps.length === 0) return { recognized: true, content: null, notice: 'plan_invalid' };
  if (rawSteps.length > CHANGE_PLAN_MAX_STEPS) return { recognized: true, content: null, notice: 'plan_too_many' };

  const title = validatePlanText(parsed.title, CHANGE_PLAN_MAX_TITLE_BYTES, true);
  const summary = validatePlanText(parsed.summary, CHANGE_PLAN_MAX_SUMMARY_BYTES);
  if (!title.valid) return { recognized: true, content: null, notice: title.notice };
  if (!summary.valid) return { recognized: true, content: null, notice: summary.notice };

  const steps: AssistantChangePlanStepV1[] = [];
  let totalCommandBytes = 0;
  let totalCommands = 0;
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || !hasExactKeys(rawStep, ['title', 'commands', 'expectedEffect', 'rollback'])) {
      return { recognized: true, content: null, notice: 'plan_invalid' };
    }
    const rawCommands = rawStep.commands;
    if (!isUnknownArray(rawCommands)) return { recognized: true, content: null, notice: 'plan_invalid' };
    if (rawCommands.length === 0) return { recognized: true, content: null, notice: 'plan_invalid' };
    if (rawCommands.length > CHANGE_PLAN_MAX_COMMANDS_PER_STEP) {
      return { recognized: true, content: null, notice: 'plan_too_many' };
    }

    const stepTitle = validatePlanText(rawStep.title, CHANGE_PLAN_MAX_TITLE_BYTES, true);
    const expectedEffect = validatePlanText(rawStep.expectedEffect, CHANGE_PLAN_MAX_STEP_TEXT_BYTES);
    const rollback = validatePlanText(rawStep.rollback, CHANGE_PLAN_MAX_STEP_TEXT_BYTES);
    if (!stepTitle.valid) return { recognized: true, content: null, notice: stepTitle.notice };
    if (!expectedEffect.valid) return { recognized: true, content: null, notice: expectedEffect.notice };
    if (!rollback.valid) return { recognized: true, content: null, notice: rollback.notice };

    const commands: AssistantChangePlanStepV1['commands'] = [];
    for (const rawCommand of rawCommands) {
      if (!isRecord(rawCommand) || !hasExactKeys(rawCommand, ['shell', 'command'])) {
        return { recognized: true, content: null, notice: 'plan_invalid' };
      }
      const shell = normalizeAssistantShell(rawCommand.shell);
      const command = validatePlanCommand(rawCommand.command);
      if (!shell) return { recognized: true, content: null, notice: 'plan_invalid' };
      if (!command.valid) return { recognized: true, content: null, notice: command.notice };
      totalCommands += 1;
      totalCommandBytes += command.bytes;
      if (totalCommands > CHANGE_PLAN_MAX_COMMANDS) {
        return { recognized: true, content: null, notice: 'plan_too_many' };
      }
      if (totalCommandBytes > COMMAND_DRAFT_MAX_BYTES) {
        return { recognized: true, content: null, notice: 'plan_too_large' };
      }
      commands.push({ shell, command: command.value });
    }

    steps.push({
      title: stepTitle.value,
      commands,
      expectedEffect: expectedEffect.value,
      rollback: rollback.value,
    });
  }

  return {
    recognized: true,
    content: { title: title.value, summary: summary.value, steps },
    notice: null,
  };
}

export function parseAssistantDraftContent(content: string): AssistantDraftContentParseResult {
  const plan = parseChangePlanDraft(content);
  if (plan.recognized) {
    if (plan.content === null) return { content: null, notice: plan.notice };
    if (/\x60{3}(?:bash|sh|zsh|shell|powershell|pwsh|cmd)[ \t]*\r?\n/i.test(content)) {
      return { content: null, notice: 'plan_invalid' };
    }
    return { content: { kind: 'change-plan.draft', ...plan.content }, notice: null };
  }

  const commandDraft = parseSupportedCommandBlocks(content);
  if (commandDraft.commands.length > 0) {
    return { content: { kind: 'command.draft', commands: commandDraft.commands }, notice: null };
  }
  return { content: null, notice: commandDraft.notice };
}
