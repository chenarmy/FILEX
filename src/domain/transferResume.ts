import type { TransferResumeState, TransferTask } from '@/types/contracts';

export function resumeStateLabelKey(
  state: TransferResumeState,
): 'tasks.resumeSafe' | 'tasks.resumeRestart' | 'tasks.resumeIdentityChanged' | null {
  if (state === 'safe_to_resume') return 'tasks.resumeSafe';
  if (state === 'restart_from_beginning') return 'tasks.resumeRestart';
  if (state === 'identity_changed') return 'tasks.resumeIdentityChanged';
  return null;
}

export function canResumeTransferTask(task: Pick<TransferTask, 'state' | 'resumeState' | 'stagingPath' | 'error'>): boolean {
  if (task.resumeState === 'identity_changed') return false;
  if (task.state === 'paused') return true;
  return task.state === 'failed' && Boolean(task.stagingPath) && task.error?.retryable !== false;
}
