import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { isRemoteJobActiveState, useRemoteJobsStore } from '@/stores/remoteJobs';
import { useEventsStore } from '@/stores/events';
import type { RemoteJobOutputChunk, RemoteJobSummary } from '@/types/contracts';

const mockStartRemoteJob = vi.fn();
const mockListRemoteJobs = vi.fn();
const mockReadRemoteJobOutput = vi.fn();
const mockCancelRemoteJob = vi.fn();
const mockTerminateRemoteJob = vi.fn();
const mockDismissRemoteJob = vi.fn();

vi.mock('@/api/domain/remoteJobsApi', () => ({
  startRemoteJob: (...args: unknown[]) => mockStartRemoteJob(...args),
  listRemoteJobs: (...args: unknown[]) => mockListRemoteJobs(...args),
  readRemoteJobOutput: (...args: unknown[]) => mockReadRemoteJobOutput(...args),
  cancelRemoteJob: (...args: unknown[]) => mockCancelRemoteJob(...args),
  terminateRemoteJob: (...args: unknown[]) => mockTerminateRemoteJob(...args),
  dismissRemoteJob: (...args: unknown[]) => mockDismissRemoteJob(...args),
}));

function makeJob(
  id: string,
  state: RemoteJobSummary['state'] = 'running',
  overrides: Partial<RemoteJobSummary> = {},
): RemoteJobSummary {
  return {
    id,
    sessionId: 'sess-1',
    sessionGeneration: 2,
    profileId: 'prof-1',
    targetHost: '192.0.2.10',
    targetPort: 22,
    targetUsername: 'deploy',
    kind: 'check_system_health',
    commandLabel: 'system-health-check',
    targetDetail: null,
    riskClass: 'read_only',
    state,
    createdAtMs: 1_000,
    startedAtMs: 1_020,
    finishedAtMs: null,
    exitCode: null,
    exitSignal: null,
    outputStartOffset: 0,
    outputEndOffset: 0,
    outputRetainedBytes: 0,
    outputTruncated: false,
    error: null,
    ...overrides,
  };
}

describe('remoteJobs store and activity lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('starts structured jobs, merges incremental output chunks, and records terminal diagnostics', async () => {
    const store = useRemoteJobsStore();
    const events = useEventsStore();

    const queued = makeJob('job-1', 'queued', { startedAtMs: null });
    mockStartRemoteJob.mockResolvedValue({ ok: true, data: queued, requestId: 'req-start' });
    const started = await store.start({
      sessionId: 'sess-1',
      kind: 'check_system_health',
    });
    expect(started?.id).toBe('job-1');
    expect(store.selectedJobId).toBe('job-1');
    expect(store.activeJobs).toHaveLength(1);
    expect(events.entries[0]?.code).toBe('remote_job.started');

    const chunk1: RemoteJobOutputChunk = {
      jobId: 'job-1',
      startOffset: 0,
      endOffset: 10,
      retainedStartOffset: 0,
      retainedEndOffset: 10,
      truncated: false,
      content: 'load=0.12\n',
      state: 'running',
    };
    mockReadRemoteJobOutput.mockResolvedValueOnce({ ok: true, data: chunk1, requestId: 'req-out-1' });
    await store.loadOutput('job-1', 0);
    expect(store.selectedOutput?.content).toBe('load=0.12\n');

    const chunk2: RemoteJobOutputChunk = {
      jobId: 'job-1',
      startOffset: 10,
      endOffset: 19,
      retainedStartOffset: 0,
      retainedEndOffset: 19,
      truncated: false,
      content: 'disk=42%\n',
      state: 'completed',
    };
    mockReadRemoteJobOutput.mockResolvedValueOnce({ ok: true, data: chunk2, requestId: 'req-out-2' });
    await store.loadOutput('job-1', 10);
    expect(store.selectedOutput?.content).toBe('load=0.12\ndisk=42%\n');

    store.upsert(makeJob('job-1', 'outcome_uncertain', {
      finishedAtMs: 5_000,
      error: {
        code: 'REMOTE_JOB_OUTCOME_UNCERTAIN',
        messageKey: 'errors.remoteJobOutcomeUncertain',
        retryable: false,
        remoteState: 'unknown',
      },
    }));
    expect(store.activeJobs).toHaveLength(0);
    expect(events.entries[0]?.code).toBe('remote_job.outcome_uncertain');
    expect(events.entries[0]?.severity).toBe('warning');
  });

  it('keeps cancel, terminate, and dismiss actions distinct', async () => {
    const store = useRemoteJobsStore();
    const running = makeJob('job-2', 'running');
    store.upsert(running);
    expect(isRemoteJobActiveState('queued')).toBe(true);
    expect(isRemoteJobActiveState('running')).toBe(true);
    expect(isRemoteJobActiveState('stopping')).toBe(true);
    expect(isRemoteJobActiveState('outcome_uncertain')).toBe(false);

    mockCancelRemoteJob.mockResolvedValue({
      ok: true,
      data: makeJob('job-2', 'stopping'),
      requestId: 'req-cancel',
    });
    expect(await store.cancel('job-2')).toBe(true);
    expect(mockCancelRemoteJob).toHaveBeenCalledWith('job-2');
    expect(mockTerminateRemoteJob).not.toHaveBeenCalled();

    mockTerminateRemoteJob.mockResolvedValue({
      ok: true,
      data: makeJob('job-2', 'cancelled', { exitSignal: 'SIGTERM', finishedAtMs: 2_500 }),
      requestId: 'req-term',
    });
    expect(await store.terminate('job-2')).toBe(true);
    expect(mockTerminateRemoteJob).toHaveBeenCalledWith('job-2');

    mockDismissRemoteJob.mockResolvedValue({ ok: true, data: [], requestId: 'req-dismiss' });
    await store.dismiss('job-2');
    expect(store.jobs).toHaveLength(0);
    expect(store.selectedJobId).toBeNull();
  });
});
