use std::collections::{HashMap, VecDeque};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use filex_contracts::{
    AppError, CapabilityKind, RemoteJobKind, RemoteJobOutputChunk, RemoteJobRiskClass,
    RemoteJobState, RemoteJobSummary, RemoteState, SessionKind, SessionState, SessionSummary,
    StartRemoteJobInput,
};
use filex_ssh::{ConnectedSshSession, ExecControl, ExecStreamEvent};
use tauri::{Emitter, async_runtime::JoinHandle};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::remote_ops::strip_ansi_escape_sequences;
use crate::session_runtime::{SessionRuntime, ssh_error};

pub(crate) const MAX_ACTIVE_JOBS_PER_SESSION: usize = 4;
const MAX_RETAINED_FINISHED_JOBS: usize = 64;
const JOB_OUTPUT_RING_MAX_BYTES: usize = 256 * 1024;
const DEFAULT_READ_CHUNK_BYTES: usize = 64 * 1024;
const DEFAULT_JOB_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_EVENT_THROTTLE: Duration = Duration::from_millis(120);
const CANCEL_GRACE_PERIOD: Duration = Duration::from_millis(500);
const SHUTDOWN_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

const INTENT_NONE: u8 = 0;
const INTENT_CANCEL: u8 = 1;
const INTENT_TERMINATE: u8 = 2;
const INTENT_SESSION_LOST: u8 = 3;
const INTENT_SHUTDOWN: u8 = 4;

#[derive(Clone, Default)]
pub struct RemoteJobRuntime {
    store: Arc<Mutex<RemoteJobStore>>,
}

#[derive(Default)]
struct RemoteJobStore {
    jobs: HashMap<String, StoredJob>,
    order: VecDeque<String>,
    controls: HashMap<String, JobControlHandle>,
}

struct StoredJob {
    summary: RemoteJobSummary,
    output: JobOutputRing,
}

#[derive(Clone)]
struct JobControlHandle {
    intent: Arc<AtomicU8>,
    notify: Arc<Notify>,
    exec_control: Arc<tokio::sync::Mutex<Option<ExecControl>>>,
    worker_handle: Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>,
}

#[derive(Default)]
struct JobOutputRing {
    buffer: VecDeque<u8>,
    total_bytes: u64,
    truncated: bool,
}

impl JobOutputRing {
    fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        self.total_bytes = self.total_bytes.saturating_add(data.len() as u64);
        if data.len() >= JOB_OUTPUT_RING_MAX_BYTES {
            self.buffer.clear();
            let start = data.len() - JOB_OUTPUT_RING_MAX_BYTES;
            self.buffer.extend(&data[start..]);
            self.truncated = true;
            return;
        }
        let needed = self
            .buffer
            .len()
            .saturating_add(data.len())
            .saturating_sub(JOB_OUTPUT_RING_MAX_BYTES);
        if needed > 0 {
            self.buffer.drain(..needed);
            self.truncated = true;
        }
        self.buffer.extend(data);
    }

    fn start_offset(&self) -> u64 {
        self.total_bytes.saturating_sub(self.buffer.len() as u64)
    }

    fn end_offset(&self) -> u64 {
        self.total_bytes
    }

    fn retained_bytes(&self) -> usize {
        self.buffer.len()
    }

    fn read_slice(
        &self,
        since_offset: Option<u64>,
        max_bytes: usize,
    ) -> (u64, u64, u64, u64, bool, String) {
        let retained_start = self.start_offset();
        let retained_end = self.end_offset();
        let clamped_start = since_offset
            .unwrap_or(retained_start)
            .max(retained_start)
            .min(retained_end);
        let rel_start = (clamped_start - retained_start) as usize;
        let available = self.buffer.len().saturating_sub(rel_start);
        let read_len = available.min(max_bytes.max(1));
        let slice_end_offset = clamped_start.saturating_add(read_len as u64);
        let raw_bytes: Vec<u8> = self
            .buffer
            .iter()
            .skip(rel_start)
            .take(read_len)
            .copied()
            .collect();
        let content = sanitize_job_output_bytes(&raw_bytes);
        let gap_before_request = since_offset.is_some_and(|offset| offset < retained_start);
        (
            clamped_start,
            slice_end_offset,
            retained_start,
            retained_end,
            self.truncated || gap_before_request,
            content,
        )
    }
}

struct BuiltJobCommand {
    command: String,
    command_label: String,
    target_detail: Option<String>,
    risk_class: RemoteJobRiskClass,
}

impl RemoteJobRuntime {
    pub async fn start_job<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        sessions: &SessionRuntime,
        input: StartRemoteJobInput,
    ) -> Result<RemoteJobSummary, AppError> {
        let session_id = input.session_id.trim().to_owned();
        if session_id.is_empty() {
            return Err(remote_job_invalid_error("sessionId"));
        }
        let built = build_remote_job_command(&input)?;
        let (session_summary, ssh_session) = sessions.connected_ssh_target(&session_id).await?;
        validate_job_session(&session_summary)?;

        let job_id = Uuid::new_v4().to_string();
        let now_ms = current_epoch_ms();
        let summary = RemoteJobSummary {
            id: job_id.clone(),
            session_id: session_summary.id.clone(),
            session_generation: session_summary.generation,
            profile_id: session_summary.profile_id.clone(),
            target_host: session_summary.host.clone(),
            target_port: session_summary.port,
            target_username: session_summary.username.clone(),
            kind: input.kind,
            command_label: built.command_label,
            target_detail: built.target_detail,
            risk_class: built.risk_class,
            state: RemoteJobState::Queued,
            created_at_ms: now_ms,
            started_at_ms: None,
            finished_at_ms: None,
            exit_code: None,
            exit_signal: None,
            output_start_offset: 0,
            output_end_offset: 0,
            output_retained_bytes: 0,
            output_truncated: false,
            error: None,
        };

        let control = JobControlHandle {
            intent: Arc::new(AtomicU8::new(INTENT_NONE)),
            notify: Arc::new(Notify::new()),
            exec_control: Arc::new(tokio::sync::Mutex::new(None)),
            worker_handle: Arc::new(tokio::sync::Mutex::new(None)),
        };

        {
            let mut store = self.lock_store()?;
            let active_for_session = store
                .jobs
                .values()
                .filter(|job| {
                    job.summary.session_id == session_summary.id
                        && is_active_state(job.summary.state)
                })
                .count();
            if active_for_session >= MAX_ACTIVE_JOBS_PER_SESSION {
                return Err(remote_job_limit_error());
            }
            store.order.push_back(job_id.clone());
            store.jobs.insert(
                job_id.clone(),
                StoredJob {
                    summary: summary.clone(),
                    output: JobOutputRing::default(),
                },
            );
            store.controls.insert(job_id.clone(), control.clone());
        }

        let _ = app.emit("remote-job-updated", summary.clone());

        let runtime = self.clone();
        let worker_control = control.clone();
        let worker_job_id = job_id.clone();
        let worker_app = app.clone();
        let worker_command = built.command;
        let handle = tauri::async_runtime::spawn(async move {
            run_remote_job_worker(
                runtime,
                worker_app,
                worker_job_id,
                ssh_session,
                worker_command,
                worker_control,
            )
            .await;
        });
        *control.worker_handle.lock().await = Some(handle);

        Ok(summary)
    }

    pub fn list_jobs(&self, session_id: Option<&str>) -> Result<Vec<RemoteJobSummary>, AppError> {
        let store = self.lock_store()?;
        let filter_session = session_id.map(str::trim).filter(|id| !id.is_empty());
        let mut results = Vec::new();
        for job_id in store.order.iter().rev() {
            if let Some(job) = store.jobs.get(job_id) {
                if let Some(target_session) = filter_session
                    && job.summary.session_id != target_session
                {
                    continue;
                }
                results.push(job.summary.clone());
            }
        }
        Ok(results)
    }

    pub fn read_job_output(
        &self,
        job_id: &str,
        since_offset: Option<u64>,
        max_bytes: Option<usize>,
    ) -> Result<RemoteJobOutputChunk, AppError> {
        let store = self.lock_store()?;
        let job = store
            .jobs
            .get(job_id.trim())
            .ok_or_else(remote_job_not_found_error)?;
        let capped_max = max_bytes
            .unwrap_or(DEFAULT_READ_CHUNK_BYTES)
            .clamp(1024, JOB_OUTPUT_RING_MAX_BYTES);
        let (
            start_offset,
            end_offset,
            retained_start_offset,
            retained_end_offset,
            truncated,
            content,
        ) = job.output.read_slice(since_offset, capped_max);
        Ok(RemoteJobOutputChunk {
            job_id: job.summary.id.clone(),
            start_offset,
            end_offset,
            retained_start_offset,
            retained_end_offset,
            truncated,
            content,
            state: job.summary.state,
        })
    }

    pub async fn cancel_job<R: tauri::Runtime>(
        &self,
        app: Option<&tauri::AppHandle<R>>,
        job_id: &str,
    ) -> Result<RemoteJobSummary, AppError> {
        self.request_stop(app, job_id, false).await
    }

    pub async fn terminate_job<R: tauri::Runtime>(
        &self,
        app: Option<&tauri::AppHandle<R>>,
        job_id: &str,
    ) -> Result<RemoteJobSummary, AppError> {
        self.request_stop(app, job_id, true).await
    }

    async fn request_stop<R: tauri::Runtime>(
        &self,
        app: Option<&tauri::AppHandle<R>>,
        job_id: &str,
        force_terminate: bool,
    ) -> Result<RemoteJobSummary, AppError> {
        let clean_id = job_id.trim().to_owned();
        let (summary, control, immediate_finish) = {
            let mut store = self.lock_store()?;
            let current_state = store
                .jobs
                .get(&clean_id)
                .ok_or_else(remote_job_not_found_error)?
                .summary
                .state;
            if !is_active_state(current_state) {
                return Err(remote_job_invalid_state_error());
            }
            let control = store.controls.get(&clean_id).cloned();
            let target_intent = if force_terminate {
                INTENT_TERMINATE
            } else {
                INTENT_CANCEL
            };
            if let Some(ctrl) = control.as_ref() {
                let current = ctrl.intent.load(Ordering::Acquire);
                if force_terminate || current == INTENT_NONE {
                    ctrl.intent.store(target_intent, Ordering::Release);
                }
            }
            let job = store
                .jobs
                .get_mut(&clean_id)
                .ok_or_else(remote_job_not_found_error)?;
            if job.summary.state == RemoteJobState::Queued {
                job.summary.state = RemoteJobState::Cancelled;
                job.summary.finished_at_ms = Some(current_epoch_ms());
                job.summary.error = None;
                let updated = job.summary.clone();
                store.controls.remove(&clean_id);
                prune_finished_jobs_locked(&mut store);
                (updated, control, true)
            } else {
                job.summary.state = RemoteJobState::Stopping;
                (job.summary.clone(), control, false)
            }
        };

        if let Some(app) = app {
            let _ = app.emit("remote-job-updated", summary.clone());
        }
        if let Some(ctrl) = control {
            ctrl.notify.notify_waiters();
            if !immediate_finish {
                let guard = ctrl.exec_control.lock().await;
                if let Some(exec_ctrl) = guard.as_ref() {
                    if force_terminate {
                        let _ = exec_ctrl.signal_terminate().await;
                    } else {
                        let _ = exec_ctrl.signal_interrupt().await;
                    }
                }
            }
        }
        Ok(summary)
    }

    pub fn dismiss_job(&self, job_id: &str) -> Result<Vec<RemoteJobSummary>, AppError> {
        let clean_id = job_id.trim();
        let mut store = self.lock_store()?;
        let job = store
            .jobs
            .get(clean_id)
            .ok_or_else(remote_job_not_found_error)?;
        if is_active_state(job.summary.state) {
            return Err(remote_job_invalid_state_error());
        }
        store.jobs.remove(clean_id);
        store.controls.remove(clean_id);
        store.order.retain(|id| id != clean_id);
        drop(store);
        self.list_jobs(None)
    }

    pub async fn mark_session_disconnected<R: tauri::Runtime>(
        &self,
        app: Option<&tauri::AppHandle<R>>,
        session_id: &str,
    ) -> Result<(), AppError> {
        let clean_session_id = session_id.trim();
        let (updated_summaries, controls) = {
            let mut store = self.lock_store()?;
            let mut updated = Vec::new();
            let mut ctrls = Vec::new();
            let now_ms = current_epoch_ms();
            let affected_ids: Vec<String> = store
                .jobs
                .iter()
                .filter(|(_, job)| {
                    job.summary.session_id == clean_session_id && is_active_state(job.summary.state)
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in affected_ids {
                if let Some(ctrl) = store.controls.remove(&id) {
                    ctrl.intent.store(INTENT_SESSION_LOST, Ordering::Release);
                    ctrls.push(ctrl);
                }
                if let Some(job) = store.jobs.get_mut(&id) {
                    if job.summary.state == RemoteJobState::Queued {
                        job.summary.state = RemoteJobState::Cancelled;
                        job.summary.error = None;
                    } else {
                        job.summary.state = RemoteJobState::OutcomeUncertain;
                        job.summary.error = Some(remote_job_outcome_uncertain_error());
                    }
                    job.summary.finished_at_ms = Some(now_ms);
                    updated.push(job.summary.clone());
                }
            }
            if !updated.is_empty() {
                prune_finished_jobs_locked(&mut store);
            }
            (updated, ctrls)
        };

        for ctrl in controls {
            ctrl.notify.notify_waiters();
            if let Some(exec_ctrl) = ctrl.exec_control.lock().await.take() {
                let _ = exec_ctrl.close().await;
            }
        }
        if let Some(app) = app {
            for summary in updated_summaries {
                let _ = app.emit("remote-job-updated", summary);
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let active_controls = {
            let mut store = match self.lock_store() {
                Ok(store) => store,
                Err(_) => return,
            };
            let now_ms = current_epoch_ms();
            let mut controls = Vec::new();
            let active_ids: Vec<String> = store
                .jobs
                .iter()
                .filter(|(_, job)| is_active_state(job.summary.state))
                .map(|(id, _)| id.clone())
                .collect();
            for id in active_ids {
                if let Some(ctrl) = store.controls.remove(&id) {
                    ctrl.intent.store(INTENT_SHUTDOWN, Ordering::Release);
                    controls.push(ctrl);
                }
                if let Some(job) = store.jobs.get_mut(&id) {
                    job.summary.state = if job.summary.state == RemoteJobState::Queued {
                        RemoteJobState::Cancelled
                    } else {
                        RemoteJobState::Stopping
                    };
                    if job.summary.state == RemoteJobState::Cancelled {
                        job.summary.finished_at_ms = Some(now_ms);
                    }
                }
            }
            controls
        };

        for ctrl in &active_controls {
            ctrl.notify.notify_waiters();
            if let Some(exec_ctrl) = ctrl.exec_control.lock().await.as_ref() {
                let _ = exec_ctrl.signal_terminate().await;
                let _ = exec_ctrl.close().await;
            }
        }

        let join_futures = active_controls.into_iter().map(|ctrl| async move {
            let handle = ctrl.worker_handle.lock().await.take();
            if let Some(handle) = handle {
                let _ = tokio::time::timeout(SHUTDOWN_WAIT_TIMEOUT, handle).await;
            }
        });
        let _ = futures_util::future::join_all(join_futures).await;
    }

    fn lock_store(&self) -> Result<std::sync::MutexGuard<'_, RemoteJobStore>, AppError> {
        self.store.lock().map_err(|_| AppError {
            code: "REMOTE_JOB_LOCK_FAILED".to_owned(),
            message_key: "errors.remoteJobFailed".to_owned(),
            retryable: true,
            remote_state: RemoteState::Unknown,
            field: None,
        })
    }

    fn record_running<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, job_id: &str) {
        let updated = {
            let mut store = match self.lock_store() {
                Ok(store) => store,
                Err(_) => return,
            };
            let Some(job) = store.jobs.get_mut(job_id) else {
                return;
            };
            if job.summary.state != RemoteJobState::Queued {
                return;
            }
            job.summary.state = RemoteJobState::Running;
            job.summary.started_at_ms = Some(current_epoch_ms());
            job.summary.clone()
        };
        let _ = app.emit("remote-job-updated", updated);
    }

    fn append_output<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        job_id: &str,
        bytes: &[u8],
        last_emit: &mut Instant,
    ) {
        let summary = {
            let mut store = match self.lock_store() {
                Ok(store) => store,
                Err(_) => return,
            };
            let Some(job) = store.jobs.get_mut(job_id) else {
                return;
            };
            job.output.push(bytes);
            job.summary.output_start_offset = job.output.start_offset();
            job.summary.output_end_offset = job.output.end_offset();
            job.summary.output_retained_bytes = job.output.retained_bytes();
            job.summary.output_truncated = job.output.truncated;
            if last_emit.elapsed() >= OUTPUT_EVENT_THROTTLE {
                *last_emit = Instant::now();
                Some(job.summary.clone())
            } else {
                None
            }
        };
        if let Some(summary) = summary {
            let _ = app.emit("remote-job-updated", summary);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_job<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        job_id: &str,
        state: RemoteJobState,
        exit_code: Option<i32>,
        exit_signal: Option<String>,
        error: Option<AppError>,
    ) {
        let summary = {
            let mut store = match self.lock_store() {
                Ok(store) => store,
                Err(_) => return,
            };
            store.controls.remove(job_id);
            let Some(job) = store.jobs.get_mut(job_id) else {
                return;
            };
            if !is_active_state(job.summary.state) {
                return;
            }
            job.summary.state = state;
            job.summary.finished_at_ms = Some(current_epoch_ms());
            job.summary.exit_code = exit_code;
            job.summary.exit_signal = exit_signal;
            job.summary.output_start_offset = job.output.start_offset();
            job.summary.output_end_offset = job.output.end_offset();
            job.summary.output_retained_bytes = job.output.retained_bytes();
            job.summary.output_truncated = job.output.truncated;
            job.summary.error = error;
            let result = job.summary.clone();
            prune_finished_jobs_locked(&mut store);
            result
        };
        let _ = app.emit("remote-job-updated", summary);
    }
}

async fn run_remote_job_worker<R: tauri::Runtime>(
    runtime: RemoteJobRuntime,
    app: tauri::AppHandle<R>,
    job_id: String,
    ssh_session: Arc<ConnectedSshSession>,
    command: String,
    control: JobControlHandle,
) {
    let early_intent = control.intent.load(Ordering::Acquire);
    if early_intent != INTENT_NONE {
        let (state, error) = match early_intent {
            INTENT_CANCEL | INTENT_TERMINATE | INTENT_SHUTDOWN => (RemoteJobState::Cancelled, None),
            _ => (
                RemoteJobState::OutcomeUncertain,
                Some(remote_job_outcome_uncertain_error()),
            ),
        };
        runtime.finalize_job(&app, &job_id, state, None, None, error);
        return;
    }

    let (exec_control, mut exec_output) = match ssh_session.open_exec_stream(&command).await {
        Ok(pair) => pair,
        Err(error) => {
            runtime.finalize_job(
                &app,
                &job_id,
                RemoteJobState::Failed,
                None,
                None,
                Some(ssh_error(&error)),
            );
            return;
        }
    };

    *control.exec_control.lock().await = Some(exec_control);
    runtime.record_running(&app, &job_id);

    let deadline = tokio::time::Instant::now() + DEFAULT_JOB_TIMEOUT;
    let mut last_emit = Instant::now();
    let mut exit_status: Option<u32> = None;
    let mut exit_signal: Option<String> = None;
    let mut timed_out = false;
    let mut transport_closed = false;

    loop {
        tokio::select! {
            biased;
            () = control.notify.notified() => {
                let intent = control.intent.load(Ordering::Acquire);
                match intent {
                    INTENT_TERMINATE | INTENT_SHUTDOWN => {
                        if let Some(ctrl) = control.exec_control.lock().await.as_ref() {
                            let _ = ctrl.signal_kill().await;
                            let _ = ctrl.close().await;
                        }
                        if exit_signal.is_none() {
                            exit_signal = Some("SIGTERM".to_owned());
                        }
                        break;
                    }
                    INTENT_CANCEL => {
                        if let Some(ctrl) = control.exec_control.lock().await.as_ref() {
                            let _ = ctrl.signal_interrupt().await;
                        }
                        let grace_until = tokio::time::Instant::now() + CANCEL_GRACE_PERIOD;
                        loop {
                            tokio::select! {
                                biased;
                                () = tokio::time::sleep_until(grace_until) => {
                                    if let Some(ctrl) = control.exec_control.lock().await.as_ref() {
                                        let _ = ctrl.signal_terminate().await;
                                        let _ = ctrl.close().await;
                                    }
                                    break;
                                }
                                () = control.notify.notified() => {
                                    if matches!(control.intent.load(Ordering::Acquire), INTENT_TERMINATE | INTENT_SHUTDOWN | INTENT_SESSION_LOST) {
                                        if let Some(ctrl) = control.exec_control.lock().await.as_ref() {
                                            let _ = ctrl.signal_kill().await;
                                            let _ = ctrl.close().await;
                                        }
                                        break;
                                    }
                                }
                                event = exec_output.next() => {
                                    match event {
                                        ExecStreamEvent::Stdout(bytes) | ExecStreamEvent::Stderr(bytes) => {
                                            runtime.append_output(&app, &job_id, &bytes, &mut last_emit);
                                        }
                                        ExecStreamEvent::ExitStatus(code) => exit_status = Some(code),
                                        ExecStreamEvent::ExitSignal { signal_name, .. } => {
                                            exit_signal = Some(signal_name);
                                        }
                                        ExecStreamEvent::Eof => {}
                                        ExecStreamEvent::Closed => {
                                            transport_closed = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        break;
                    }
                    INTENT_SESSION_LOST => {
                        if let Some(ctrl) = control.exec_control.lock().await.take() {
                            let _ = ctrl.close().await;
                        }
                        transport_closed = true;
                        break;
                    }
                    _ => {}
                }
            }
            () = tokio::time::sleep_until(deadline) => {
                timed_out = true;
                if let Some(ctrl) = control.exec_control.lock().await.as_ref() {
                    let _ = ctrl.signal_terminate().await;
                    let _ = ctrl.close().await;
                }
                break;
            }
            event = exec_output.next() => {
                match event {
                    ExecStreamEvent::Stdout(bytes) | ExecStreamEvent::Stderr(bytes) => {
                        runtime.append_output(&app, &job_id, &bytes, &mut last_emit);
                    }
                    ExecStreamEvent::ExitStatus(code) => {
                        exit_status = Some(code);
                    }
                    ExecStreamEvent::ExitSignal { signal_name, .. } => {
                        exit_signal = Some(signal_name);
                    }
                    ExecStreamEvent::Eof => {}
                    ExecStreamEvent::Closed => {
                        transport_closed = true;
                        break;
                    }
                }
            }
        }
    }

    let _ = control.exec_control.lock().await.take();
    let final_intent = control.intent.load(Ordering::Acquire);
    let signed_exit = exit_status.and_then(|code| i32::try_from(code).ok());

    let (final_state, final_error) = match final_intent {
        INTENT_SESSION_LOST => (
            RemoteJobState::OutcomeUncertain,
            Some(remote_job_outcome_uncertain_error()),
        ),
        INTENT_CANCEL | INTENT_TERMINATE | INTENT_SHUTDOWN => {
            if !transport_closed && final_intent == INTENT_SHUTDOWN && exit_status.is_none() {
                (
                    RemoteJobState::OutcomeUncertain,
                    Some(remote_job_outcome_uncertain_error()),
                )
            } else {
                (RemoteJobState::Cancelled, None)
            }
        }
        _ if timed_out => (
            RemoteJobState::OutcomeUncertain,
            Some(remote_job_timeout_error()),
        ),
        _ => match exit_status {
            Some(0) => (RemoteJobState::Completed, None),
            Some(_) => (
                RemoteJobState::Failed,
                Some(remote_job_nonzero_exit_error()),
            ),
            None => (
                RemoteJobState::OutcomeUncertain,
                Some(remote_job_outcome_uncertain_error()),
            ),
        },
    };

    runtime.finalize_job(
        &app,
        &job_id,
        final_state,
        signed_exit,
        exit_signal,
        final_error,
    );
}

fn validate_job_session(summary: &SessionSummary) -> Result<(), AppError> {
    if summary.session_kind != SessionKind::Ssh
        || !summary.capabilities.contains(&CapabilityKind::RemoteJobs)
    {
        return Err(remote_job_unsupported_error());
    }
    if summary.state != SessionState::Connected {
        return Err(session_not_connected_error());
    }
    Ok(())
}

fn is_active_state(state: RemoteJobState) -> bool {
    matches!(
        state,
        RemoteJobState::Queued | RemoteJobState::Running | RemoteJobState::Stopping
    )
}

fn prune_finished_jobs_locked(store: &mut RemoteJobStore) {
    let mut finished_ids: Vec<String> = store
        .order
        .iter()
        .filter(|id| {
            store
                .jobs
                .get(*id)
                .is_some_and(|job| !is_active_state(job.summary.state))
        })
        .cloned()
        .collect();
    if finished_ids.len() <= MAX_RETAINED_FINISHED_JOBS {
        return;
    }
    let excess = finished_ids.len() - MAX_RETAINED_FINISHED_JOBS;
    for remove_id in finished_ids.drain(..excess) {
        store.jobs.remove(&remove_id);
        store.controls.remove(&remove_id);
        store.order.retain(|id| id != &remove_id);
    }
}

fn build_remote_job_command(input: &StartRemoteJobInput) -> Result<BuiltJobCommand, AppError> {
    match input.kind {
        RemoteJobKind::TailSystemLog => {
            let lines = input.max_lines.unwrap_or(100).clamp(10, 500);
            let command = format!(
                "if command -v journalctl >/dev/null 2>&1; then journalctl -n {lines} --no-pager -o short-iso; elif [ -r /var/log/syslog ]; then tail -n {lines} /var/log/syslog; elif [ -r /var/log/messages ]; then tail -n {lines} /var/log/messages; else echo 'no supported system log readable' >&2; exit 1; fi"
            );
            Ok(BuiltJobCommand {
                command,
                command_label: format!("journalctl -n {lines}"),
                target_detail: None,
                risk_class: RemoteJobRiskClass::ReadOnly,
            })
        }
        RemoteJobKind::InspectDiskUsage => {
            let raw_path = input.target_path.as_deref().unwrap_or("/var/log");
            let path = validate_unix_target_path(raw_path)?;
            let quoted = posix_single_quote(&path);
            let command = format!(
                "du -shx --max-depth=1 -- {quoted} 2>&1 || du -shx -- {quoted}"
            );
            Ok(BuiltJobCommand {
                command,
                command_label: format!("du -shx {path}"),
                target_detail: Some(path),
                risk_class: RemoteJobRiskClass::BoundedDiagnostic,
            })
        }
        RemoteJobKind::CheckServiceHealth => {
            let trimmed = input.service_name.as_deref().map(str::trim).unwrap_or("");
            if trimmed.is_empty() {
                Ok(BuiltJobCommand {
                    command: "if command -v systemctl >/dev/null 2>&1; then systemctl --no-pager --failed --plain; else ps -eo pid,ppid,stat,comm | head -n 40; fi".to_owned(),
                    command_label: "systemctl --failed".to_owned(),
                    target_detail: None,
                    risk_class: RemoteJobRiskClass::ReadOnly,
                })
            } else {
                let unit = validate_service_name(trimmed)?;
                let quoted = posix_single_quote(&unit);
                let command = format!(
                    "if command -v systemctl >/dev/null 2>&1; then systemctl status --no-pager -n 25 -- {quoted}; elif command -v service >/dev/null 2>&1; then service {quoted} status; else echo 'service manager unavailable' >&2; exit 1; fi"
                );
                Ok(BuiltJobCommand {
                    command,
                    command_label: format!("systemctl status {unit}"),
                    target_detail: Some(unit),
                    risk_class: RemoteJobRiskClass::ReadOnly,
                })
            }
        }
        RemoteJobKind::InspectListeningPorts => Ok(BuiltJobCommand {
            command: "if command -v ss >/dev/null 2>&1; then ss -tulpen 2>/dev/null || ss -tuln; elif command -v netstat >/dev/null 2>&1; then netstat -tuln; else echo 'neither ss nor netstat available' >&2; exit 1; fi".to_owned(),
            command_label: "ss -tuln".to_owned(),
            target_detail: None,
            risk_class: RemoteJobRiskClass::ReadOnly,
        }),
        RemoteJobKind::CheckSystemHealth => Ok(BuiltJobCommand {
            command: "{ uname -srmo 2>/dev/null || uname -a; uptime; free -h 2>/dev/null || vm_stat 2>/dev/null || true; df -h -x tmpfs -x devtmpfs 2>/dev/null || df -h; }".to_owned(),
            command_label: "system-health-check".to_owned(),
            target_detail: None,
            risk_class: RemoteJobRiskClass::ReadOnly,
        }),
    }
}

fn validate_unix_target_path(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 512
        || !trimmed.starts_with('/')
        || trimmed.chars().any(|ch| ch.is_control() || ch == '\0')
        || trimmed.split('/').any(|seg| seg == "..")
    {
        return Err(remote_job_invalid_error("targetPath"));
    }
    Ok(trimmed.to_owned())
}

fn validate_service_name(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || trimmed.starts_with('-')
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '@' | '-'))
    {
        return Err(remote_job_invalid_error("serviceName"));
    }
    Ok(trimmed.to_owned())
}

fn posix_single_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

fn sanitize_job_output_bytes(bytes: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    let stripped = strip_ansi_escape_sequences(&lossy);
    stripped
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
        .collect()
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn remote_job_invalid_error(field: &str) -> AppError {
    AppError {
        code: "REMOTE_JOB_INVALID".to_owned(),
        message_key: "errors.remoteJobInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some(field.to_owned()),
    }
}

fn remote_job_limit_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_LIMIT_REACHED".to_owned(),
        message_key: "errors.remoteJobLimitReached".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn remote_job_not_found_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_NOT_FOUND".to_owned(),
        message_key: "errors.remoteJobNotFound".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn remote_job_unsupported_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_UNSUPPORTED".to_owned(),
        message_key: "errors.remoteJobUnsupported".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn session_not_connected_error() -> AppError {
    AppError {
        code: "SESSION_NOT_CONNECTED".to_owned(),
        message_key: "errors.sessionNotConnected".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn remote_job_outcome_uncertain_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_OUTCOME_UNCERTAIN".to_owned(),
        message_key: "errors.remoteJobOutcomeUncertain".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_job_nonzero_exit_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_FAILED".to_owned(),
        message_key: "errors.remoteJobFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_job_timeout_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_TIMEOUT".to_owned(),
        message_key: "errors.remoteJobTimeout".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_job_invalid_state_error() -> AppError {
    AppError {
        code: "REMOTE_JOB_INVALID_STATE".to_owned(),
        message_key: "errors.remoteJobInvalidState".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_summary(id: &str, session_id: &str, state: RemoteJobState) -> RemoteJobSummary {
        RemoteJobSummary {
            id: id.to_owned(),
            session_id: session_id.to_owned(),
            session_generation: 1,
            profile_id: "prof-1".to_owned(),
            target_host: "192.0.2.10".to_owned(),
            target_port: 22,
            target_username: "deploy".to_owned(),
            kind: RemoteJobKind::CheckSystemHealth,
            command_label: "system-health-check".to_owned(),
            target_detail: None,
            risk_class: RemoteJobRiskClass::ReadOnly,
            state,
            created_at_ms: 1_000,
            started_at_ms: Some(1_010),
            finished_at_ms: None,
            exit_code: None,
            exit_signal: None,
            output_start_offset: 0,
            output_end_offset: 0,
            output_retained_bytes: 0,
            output_truncated: false,
            error: None,
        }
    }

    #[test]
    fn validates_structured_job_inputs_and_builds_safe_commands() {
        let log_job = build_remote_job_command(&StartRemoteJobInput {
            session_id: "sess-1".to_owned(),
            kind: RemoteJobKind::TailSystemLog,
            target_path: None,
            service_name: None,
            max_lines: Some(9999),
        })
        .expect("clamp max_lines cleanly");
        assert_eq!(log_job.command_label, "journalctl -n 500");
        assert!(log_job.command.contains("journalctl -n 500"));

        let disk_job = build_remote_job_command(&StartRemoteJobInput {
            session_id: "sess-1".to_owned(),
            kind: RemoteJobKind::InspectDiskUsage,
            target_path: Some("/var/log/app's".to_owned()),
            service_name: None,
            max_lines: None,
        })
        .expect("quote valid path safely");
        assert!(disk_job.command.contains("'/var/log/app'\\''s'"));

        assert_eq!(
            build_remote_job_command(&StartRemoteJobInput {
                session_id: "sess-1".to_owned(),
                kind: RemoteJobKind::InspectDiskUsage,
                target_path: Some("../etc/passwd".to_owned()),
                service_name: None,
                max_lines: None,
            })
            .err()
            .map(|err| err.code),
            Some("REMOTE_JOB_INVALID".to_owned())
        );

        assert_eq!(
            build_remote_job_command(&StartRemoteJobInput {
                session_id: "sess-1".to_owned(),
                kind: RemoteJobKind::CheckServiceHealth,
                target_path: None,
                service_name: Some("nginx; rm -rf /".to_owned()),
                max_lines: None,
            })
            .err()
            .map(|err| err.code),
            Some("REMOTE_JOB_INVALID".to_owned())
        );
    }

    #[test]
    fn ring_buffer_bounds_output_tracks_offsets_and_truncates_cleanly() {
        let mut ring = JobOutputRing::default();
        ring.push(b"\x1b[32mhello\x1b[0m\n");
        let filler = vec![b'a'; JOB_OUTPUT_RING_MAX_BYTES + 128];
        ring.push(&filler);

        let expected_total = 15 + JOB_OUTPUT_RING_MAX_BYTES as u64 + 128;
        assert_eq!(ring.end_offset(), expected_total);
        assert_eq!(
            ring.start_offset(),
            expected_total - JOB_OUTPUT_RING_MAX_BYTES as u64
        );
        assert_eq!(ring.retained_bytes(), JOB_OUTPUT_RING_MAX_BYTES);
        assert!(ring.truncated);

        let (start, end, ret_start, ret_end, truncated, content) = ring.read_slice(Some(0), 64);
        assert!(truncated);
        assert_eq!(start, ret_start);
        assert_eq!(end, start + 64);
        assert_eq!(ret_end, expected_total);
        assert_eq!(content.len(), 64);
        assert!(content.chars().all(|ch| ch == 'a'));
    }

    #[tokio::test]
    async fn lifecycle_distinguishes_cancel_terminate_session_loss_and_active_limit() {
        let runtime = RemoteJobRuntime::default();
        {
            let mut store = runtime.lock_store().expect("lock store");
            for idx in 0..MAX_ACTIVE_JOBS_PER_SESSION {
                let id = format!("job-{idx}");
                store.order.push_back(id.clone());
                store.jobs.insert(
                    id.clone(),
                    StoredJob {
                        summary: sample_summary(
                            &id,
                            "sess-1",
                            if idx == 0 {
                                RemoteJobState::Queued
                            } else {
                                RemoteJobState::Running
                            },
                        ),
                        output: JobOutputRing::default(),
                    },
                );
                store.controls.insert(
                    id,
                    JobControlHandle {
                        intent: Arc::new(AtomicU8::new(INTENT_NONE)),
                        notify: Arc::new(Notify::new()),
                        exec_control: Arc::new(tokio::sync::Mutex::new(None)),
                        worker_handle: Arc::new(tokio::sync::Mutex::new(None)),
                    },
                );
            }
        }

        // Cancel a queued job -> immediately Cancelled (distinct from uncertain outcome)
        let queued_cancelled = runtime
            .cancel_job::<tauri::Wry>(None, "job-0")
            .await
            .expect("cancel queued job");
        assert_eq!(queued_cancelled.state, RemoteJobState::Cancelled);

        // Terminate a running job -> transitions to Stopping with INTENT_TERMINATE
        let stopping = runtime
            .terminate_job::<tauri::Wry>(None, "job-1")
            .await
            .expect("terminate running job");
        assert_eq!(stopping.state, RemoteJobState::Stopping);
        let terminate_intent = runtime
            .lock_store()
            .expect("lock store")
            .controls
            .get("job-1")
            .expect("job-1 control")
            .intent
            .load(Ordering::Acquire);
        assert_eq!(terminate_intent, INTENT_TERMINATE);

        // Active job cannot be dismissed
        assert_eq!(
            runtime.dismiss_job("job-1").err().map(|e| e.code),
            Some("REMOTE_JOB_INVALID_STATE".to_owned())
        );

        // Disconnecting session marks still-running jobs OutcomeUncertain (preserving cancelled job-0)
        runtime
            .mark_session_disconnected::<tauri::Wry>(None, "sess-1")
            .await
            .expect("disconnect marks running jobs uncertain");
        let jobs = runtime.list_jobs(Some("sess-1")).expect("list jobs");
        let job0 = jobs.iter().find(|j| j.id == "job-0").expect("job-0");
        let job2 = jobs.iter().find(|j| j.id == "job-2").expect("job-2");
        assert_eq!(job0.state, RemoteJobState::Cancelled);
        assert_eq!(job2.state, RemoteJobState::OutcomeUncertain);
        assert_eq!(
            job2.error.as_ref().map(|e| e.code.as_str()),
            Some("REMOTE_JOB_OUTCOME_UNCERTAIN")
        );

        // Finished job can be dismissed cleanly
        let remaining = runtime.dismiss_job("job-2").expect("dismiss uncertain job");
        assert!(!remaining.iter().any(|j| j.id == "job-2"));
    }
}
