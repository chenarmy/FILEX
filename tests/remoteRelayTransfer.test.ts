import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionsStore } from '@/stores/sessions';
import { useTransfersStore } from '@/stores/transfers';
import type { SessionSummary, TransferTask } from '@/types/contracts';

const mockEnqueueTransfer = vi.fn();
const mockResumeTransfer = vi.fn();
const mockRetryTransfer = vi.fn();
const mockResetTransferStaging = vi.fn();

vi.mock('@/api/domain/transfersApi', () => ({
  listTransfers: vi.fn(() => Promise.resolve({ ok: true, data: [], requestId: 'req-list' })),
  enqueueTransfer: (...args: unknown[]) => mockEnqueueTransfer(...args),
  resumeTransfer: (...args: unknown[]) => mockResumeTransfer(...args),
  pauseTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  retryTransfer: (...args: unknown[]) => mockRetryTransfer(...args),
  resetTransferStaging: (...args: unknown[]) => mockResetTransferStaging(...args),
  clearCompletedTransfers: vi.fn(),
}));

function makeSession(
  id: string,
  profileId: string,
  host: string,
  state: SessionSummary['state'] = 'connected',
): SessionSummary {
  return {
    id,
    generation: 1,
    profileId,
    sessionKind: 'ssh',
    host,
    port: 22,
    username: 'deploy',
    state,
    capabilities: ['remote_shell', 'sftp', 'tunneling', 'remote_jobs'],
    lastError: null,
  };
}

function makeRelayTask(id: string, overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id,
    profileId: 'prof-src',
    sessionId: 'sess-src',
    direction: 'remote_to_remote',
    localPath: '',
    remotePath: '/srv/src/release.tgz',
    destinationProfileId: 'prof-dst',
    destinationSessionId: 'sess-dst',
    destinationRemotePath: '/srv/dst/release.tgz',
    state: 'paused',
    bytesTransferred: 1024,
    totalBytes: 4096,
    conflictPolicy: 'overwrite',
    remoteSizeBytes: 4096,
    remoteMtimeMs: 1_700_000_000_000,
    stagingPath: '/srv/dst/.filex-part-task-relay',
    resumeState: 'safe_to_resume',
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}

describe('remote_to_remote relay transfers store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('resolves both connected source and destination sessions on enqueue and resetStaging', async () => {
    const sessions = useSessionsStore();
    sessions.summaries = [
      makeSession('sess-src', 'prof-src', '192.0.2.10'),
      makeSession('sess-dst', 'prof-dst', '192.0.2.20'),
    ];
    sessions.activeSessionId = 'sess-dst';

    const transfers = useTransfersStore();
    const created = makeRelayTask('task-relay', { state: 'running', bytesTransferred: 0 });
    mockEnqueueTransfer.mockResolvedValue({
      ok: true,
      data: created,
      requestId: 'req-enqueue',
    });

    const result = await transfers.enqueue({
      profileId: 'prof-src',
      direction: 'remote_to_remote',
      localPath: '',
      remotePath: '/srv/src/release.tgz',
      destinationProfileId: 'prof-dst',
      destinationRemotePath: '/srv/dst/release.tgz',
      conflictPolicy: 'overwrite',
      totalBytes: 4096,
    });

    expect(result).toBe(true);
    expect(transfers.tasks[0]?.id).toBe('task-relay');
    expect(mockEnqueueTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'prof-src',
        direction: 'remote_to_remote',
        destinationProfileId: 'prof-dst',
        destinationRemotePath: '/srv/dst/release.tgz',
      }),
      'sess-src',
      'sess-dst',
    );

    mockResetTransferStaging.mockResolvedValue({
      ok: true,
      data: { ...created, resumeState: 'not_applicable', stagingPath: null },
      requestId: 'req-reset',
    });
    expect(await transfers.resetStaging('task-relay')).toBe(true);
    expect(mockResetTransferStaging).toHaveBeenCalledWith('task-relay', 'sess-src', 'sess-dst');
  });

  it('requires both endpoints to be connected before resuming a paused relay task', async () => {
    const sessions = useSessionsStore();
    sessions.summaries = [
      makeSession('sess-src', 'prof-src', '192.0.2.10', 'connected'),
      makeSession('sess-dst', 'prof-dst', '192.0.2.20', 'disconnected'),
    ];
    sessions.activeSessionId = 'sess-src';

    const transfers = useTransfersStore();
    const pausedTask = makeRelayTask('task-relay');
    transfers.tasks = [pausedTask];

    await transfers.retry('task-relay');
    expect(mockResumeTransfer).not.toHaveBeenCalled();
    expect(mockRetryTransfer).not.toHaveBeenCalled();
    expect(transfers.error?.code).toBe('TRANSFER_SESSION_UNAVAILABLE');

    sessions.summaries[1] = makeSession('sess-dst-2', 'prof-dst', '192.0.2.20', 'connected');
    mockResumeTransfer.mockResolvedValue({
      ok: true,
      data: { ...pausedTask, state: 'running', destinationSessionId: 'sess-dst-2' },
      requestId: 'req-resume',
    });

    await transfers.retry('task-relay');
    expect(mockResumeTransfer).toHaveBeenCalledWith('task-relay', 'sess-src', 'sess-dst-2');
  });
});
