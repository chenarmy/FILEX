import { invoke } from '@tauri-apps/api/core';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  OperationResult,
  RemoteJobOutputChunk,
  RemoteJobSummary,
  StartRemoteJobInput,
} from '@/types/contracts';

export async function startRemoteJob(
  input: StartRemoteJobInput,
): Promise<OperationResult<RemoteJobSummary>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'DESKTOP_ONLY',
      messageKey: 'errors.remoteJobUnsupported',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteJobSummary>>('start_remote_job', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_START_FAILED'));
  }
}

export async function listRemoteJobs(
  sessionId?: string | null,
): Promise<OperationResult<RemoteJobSummary[]>> {
  if (!isTauriRuntime()) {
    return success([]);
  }
  try {
    return await invoke<OperationResult<RemoteJobSummary[]>>('list_remote_jobs', {
      sessionId: sessionId ?? null,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_QUERY_FAILED'));
  }
}

export async function readRemoteJobOutput(
  jobId: string,
  sinceOffset?: number,
  maxBytes?: number,
): Promise<OperationResult<RemoteJobOutputChunk>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'REMOTE_JOB_NOT_FOUND',
      messageKey: 'errors.remoteJobNotFound',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteJobOutputChunk>>('read_remote_job_output', {
      jobId,
      sinceOffset: sinceOffset ?? null,
      maxBytes: maxBytes ?? null,
    });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_QUERY_FAILED'));
  }
}

export async function cancelRemoteJob(
  jobId: string,
): Promise<OperationResult<RemoteJobSummary>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'REMOTE_JOB_NOT_FOUND',
      messageKey: 'errors.remoteJobNotFound',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteJobSummary>>('cancel_remote_job', { jobId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_CANCEL_FAILED'));
  }
}

export async function terminateRemoteJob(
  jobId: string,
): Promise<OperationResult<RemoteJobSummary>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'REMOTE_JOB_NOT_FOUND',
      messageKey: 'errors.remoteJobNotFound',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<RemoteJobSummary>>('terminate_remote_job', { jobId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_CANCEL_FAILED'));
  }
}

export async function dismissRemoteJob(
  jobId: string,
): Promise<OperationResult<RemoteJobSummary[]>> {
  if (!isTauriRuntime()) {
    return success([]);
  }
  try {
    return await invoke<OperationResult<RemoteJobSummary[]>>('dismiss_remote_job', { jobId });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'REMOTE_JOB_QUERY_FAILED'));
  }
}
