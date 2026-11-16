import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { canResumeTransferTask, resumeStateLabelKey } from '@/domain/transferResume';
import { useSessionsStore } from '@/stores/sessions';
import { useTransfersStore } from '@/stores/transfers';
import type { TransferResumeState, TransferTask } from '@/types/contracts';

const mockResetTransferStaging = vi.fn();
const mockResumeTransfer = vi.fn();
const mockRetryTransfer = vi.fn();

vi.mock('@/api/domain/transfersApi', () => ({
  listTransfers: vi.fn(() => Promise.resolve({ ok: true, data: [], requestId: 'req-list' })),
  enqueueTransfer: vi.fn(),
  resumeTransfer: (...args: unknown[]) => mockResumeTransfer(...args),
  pauseTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  retryTransfer: (...args: unknown[]) => mockRetryTransfer(...args),
  resetTransferStaging: (...args: unknown[]) => mockResetTransferStaging(...args),
  clearCompletedTransfers: vi.fn(),
}));

function makeTransfer(
  id: string,
  resumeState: TransferResumeState,
  overrides: Partial<TransferTask> = {},
): TransferTask {
  return {
    id,
    profileId: 'prof-1',
    sessionId: null,
    direction: 'download',
    localPath: `C:\\tmp\\${id}.tar.gz`,
    remotePath: `/srv/${id}.tar.gz`,
    destinationProfileId: null,
    destinationSessionId: null,
    destinationRemotePath: null,
    state: 'paused',
    bytesTransferred: 512,
    totalBytes: 2048,
    conflictPolicy: 'overwrite',
    remoteSizeBytes: 2048,
    remoteMtimeMs: 1_700_000_000_000,
    stagingPath: resumeState === 'restart_from_beginning' ? null : `C:\\tmp\\.filex-part-${id}`,
    resumeState,
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}

describe('verified transfer resume state machine', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('refuses unsafe resume on identity_changed and requires explicit staging reset', async () => {
    const sessions = useSessionsStore();
    sessions.summaries = [
      {
        id: 'sess-1',
        generation: 1,
        profileId: 'prof-1',
        sessionKind: 'ssh',
        host: '192.0.2.10',
        port: 22,
        username: 'deploy',
        state: 'connected',
        capabilities: ['remote_shell', 'sftp', 'tunneling', 'remote_jobs'],
        lastError: null,
      },
    ];
    sessions.activeSessionId = 'sess-1';

    const transfers = useTransfersStore();
    const changedTask = makeTransfer('task-changed', 'identity_changed', {
      error: {
        code: 'TRANSFER_IDENTITY_CHANGED',
        messageKey: 'errors.transferIdentityChanged',
        retryable: false,
        remoteState: 'unchanged',
      },
    });
    const safeTask = makeTransfer('task-safe', 'safe_to_resume');
    const restartTask = makeTransfer('task-restart', 'restart_from_beginning');
    transfers.tasks = [changedTask, safeTask, restartTask];

    await transfers.retry('task-changed');
    expect(mockResumeTransfer).not.toHaveBeenCalled();
    expect(mockRetryTransfer).not.toHaveBeenCalled();
    expect(transfers.error?.code).toBe('TRANSFER_IDENTITY_CHANGED');

    mockResumeTransfer.mockResolvedValue({
      ok: true,
      data: { ...safeTask, state: 'running', sessionId: 'sess-1' },
      requestId: 'req-resume',
    });
    await transfers.retry('task-safe');
    expect(mockResumeTransfer).toHaveBeenCalledWith('task-safe', 'sess-1');

    mockResetTransferStaging.mockResolvedValue({
      ok: true,
      data: {
        ...changedTask,
        state: 'running',
        bytesTransferred: 0,
        remoteMtimeMs: null,
        stagingPath: null,
        resumeState: 'not_applicable',
        error: null,
      },
      requestId: 'req-reset',
    });
    expect(await transfers.resetStaging('task-changed')).toBe(true);
    expect(mockResetTransferStaging).toHaveBeenCalledWith('task-changed', 'sess-1');
    expect(transfers.tasks[0]?.bytesTransferred).toBe(0);
    expect(transfers.tasks[0]?.resumeState).toBe('not_applicable');
  });

  it('maps resume states to explicit UI badges and gating rules', () => {
    expect(resumeStateLabelKey('safe_to_resume')).toBe('tasks.resumeSafe');
    expect(resumeStateLabelKey('restart_from_beginning')).toBe('tasks.resumeRestart');
    expect(resumeStateLabelKey('identity_changed')).toBe('tasks.resumeIdentityChanged');
    expect(resumeStateLabelKey('not_applicable')).toBeNull();

    expect(canResumeTransferTask(makeTransfer('a', 'safe_to_resume'))).toBe(true);
    expect(canResumeTransferTask(makeTransfer('b', 'restart_from_beginning'))).toBe(true);
    expect(canResumeTransferTask(makeTransfer('c', 'identity_changed'))).toBe(false);
    expect(
      canResumeTransferTask(
        makeTransfer('d', 'safe_to_resume', {
          state: 'failed',
          error: {
            code: 'TRANSFER_STREAM_FAILED',
            messageKey: 'errors.transferStreamFailed',
            retryable: true,
            remoteState: 'unknown',
          },
        }),
      ),
    ).toBe(true);
  });
});
