import { computed, ref, shallowRef } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { defineStore } from 'pinia';
import { isTauriRuntime } from '@/api/common';
import {
  cancelRemoteJob,
  dismissRemoteJob,
  listRemoteJobs,
  readRemoteJobOutput,
  startRemoteJob,
  terminateRemoteJob,
} from '@/api/domain/remoteJobsApi';
import { useEventsStore } from '@/stores/events';
import type {
  AppError,
  RemoteJobOutputChunk,
  RemoteJobState,
  RemoteJobSummary,
  StartRemoteJobInput,
} from '@/types/contracts';

const CLIENT_OUTPUT_BUFFER_LIMIT = 256 * 1024;

export function isRemoteJobActiveState(state: RemoteJobState): boolean {
  return state === 'queued' || state === 'running' || state === 'stopping';
}

export const useRemoteJobsStore = defineStore('remoteJobs', () => {
  const events = useEventsStore();
  const jobs = ref<RemoteJobSummary[]>([]);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref<AppError | null>(null);
  const selectedJobId = ref<string | null>(null);
  const outputByJob = shallowRef<Record<string, RemoteJobOutputChunk>>({});
  let unlistenJobs: UnlistenFn | null = null;

  const activeJobs = computed(() => jobs.value.filter((job) => isRemoteJobActiveState(job.state)));
  const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value) ?? null);
  const selectedOutput = computed(() => (
    selectedJobId.value ? outputByJob.value[selectedJobId.value] ?? null : null
  ));

  function clearError(): void {
    error.value = null;
  }

  function mergeOutputChunk(chunk: RemoteJobOutputChunk): void {
    const existing = outputByJob.value[chunk.jobId];
    let merged: RemoteJobOutputChunk = chunk;
    if (
      existing
      && chunk.startOffset === existing.endOffset
      && existing.endOffset >= chunk.retainedStartOffset
    ) {
      let combined = existing.content + chunk.content;
      if (combined.length > CLIENT_OUTPUT_BUFFER_LIMIT) {
        combined = combined.slice(combined.length - CLIENT_OUTPUT_BUFFER_LIMIT);
      }
      merged = {
        ...chunk,
        startOffset: existing.startOffset,
        truncated: existing.truncated || chunk.truncated,
        content: combined,
      };
    }
    outputByJob.value = {
      ...outputByJob.value,
      [chunk.jobId]: merged,
    };
  }

  function upsert(job: RemoteJobSummary): void {
    const index = jobs.value.findIndex((item) => item.id === job.id);
    const previous = index >= 0 ? jobs.value[index] : undefined;
    if (index >= 0) {
      const next = [...jobs.value];
      next[index] = job;
      jobs.value = next;
    } else {
      jobs.value = [job, ...jobs.value];
    }

    if (previous?.state !== job.state && !isRemoteJobActiveState(job.state)) {
      const severity = job.state === 'completed'
        ? 'success'
        : job.state === 'outcome_uncertain' || job.state === 'failed'
          ? 'warning'
          : 'info';
      events.record('session', `remote_job.${job.state}`, severity, {
        jobId: job.id,
        host: job.targetHost,
        command: job.commandLabel,
      });
    }

    if (selectedJobId.value === job.id && isTauriRuntime()) {
      const current = outputByJob.value[job.id];
      if (!current || job.outputEndOffset > current.endOffset) {
        void loadOutput(job.id, current?.endOffset);
      } else if (current.state !== job.state) {
        outputByJob.value = {
          ...outputByJob.value,
          [job.id]: { ...current, state: job.state },
        };
      }
    }
  }

  async function initializeEvents(): Promise<void> {
    if (!isTauriRuntime() || unlistenJobs) return;
    unlistenJobs = await listen<RemoteJobSummary>('remote-job-updated', ({ payload }) => {
      upsert(payload);
    });
  }

  async function load(sessionId?: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listRemoteJobs(sessionId);
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      jobs.value = result.data;
    } finally {
      loading.value = false;
    }
  }

  async function loadOutput(jobId: string, sinceOffset?: number): Promise<void> {
    const result = await readRemoteJobOutput(jobId, sinceOffset);
    if (!result.ok) {
      error.value = result.error;
      return;
    }
    mergeOutputChunk(result.data);
  }

  async function selectJob(jobId: string | null): Promise<void> {
    selectedJobId.value = jobId;
    if (!jobId) return;
    if (isTauriRuntime()) {
      await loadOutput(jobId);
    }
  }

  async function start(input: StartRemoteJobInput): Promise<RemoteJobSummary | null> {
    busy.value = true;
    error.value = null;
    try {
      const result = await startRemoteJob(input);
      if (!result.ok) {
        error.value = result.error;
        return null;
      }
      upsert(result.data);
      selectedJobId.value = result.data.id;
      events.record('session', 'remote_job.started', 'info', {
        jobId: result.data.id,
        host: result.data.targetHost,
        command: result.data.commandLabel,
      });
      return result.data;
    } finally {
      busy.value = false;
    }
  }

  async function cancel(jobId: string): Promise<boolean> {
    busy.value = true;
    error.value = null;
    try {
      const result = await cancelRemoteJob(jobId);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      upsert(result.data);
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function terminate(jobId: string): Promise<boolean> {
    busy.value = true;
    error.value = null;
    try {
      const result = await terminateRemoteJob(jobId);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      upsert(result.data);
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function dismiss(jobId: string): Promise<void> {
    busy.value = true;
    error.value = null;
    try {
      const result = await dismissRemoteJob(jobId);
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      jobs.value = result.data;
      if (selectedJobId.value === jobId) {
        selectedJobId.value = null;
      }
      const nextOutputs = { ...outputByJob.value };
      delete nextOutputs[jobId];
      outputByJob.value = nextOutputs;
    } finally {
      busy.value = false;
    }
  }

  return {
    jobs,
    activeJobs,
    selectedJobId,
    selectedJob,
    selectedOutput,
    outputByJob,
    loading,
    busy,
    error,
    clearError,
    initializeEvents,
    load,
    loadOutput,
    selectJob,
    start,
    cancel,
    terminate,
    dismiss,
    upsert,
  };
});
