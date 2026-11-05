use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use filex_contracts::{
    AppError, OperationResult, RemoteState, SessionState, TerminalLogState, TerminalLogStatus,
};
use filex_core::SettingsService;
use futures_util::future::join_all;
use tauri::{AppHandle, Emitter, State};
use tokio::{
    fs::{File, OpenOptions},
    io::AsyncWriteExt,
    sync::{Mutex as AsyncMutex, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

use crate::session_runtime::SessionRuntime;

const TERMINAL_LOG_MAX_BYTES: u64 = 16 * 1024 * 1024;
const TERMINAL_LOG_MAX_ACTIVE: usize = 8;
const TERMINAL_LOG_QUEUE_MESSAGES: usize = 64;
const TERMINAL_LOG_QUEUE_CHUNK_BYTES: usize = 64 * 1024;
const TERMINAL_LOG_MAX_FILES: usize = 24;
const TERMINAL_LOG_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const TERMINAL_LOG_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_LOG_EVENT: &str = "terminal-log-status";

#[derive(Clone)]
pub struct TerminalLogRuntime {
    directory: PathBuf,
    active: Arc<Mutex<HashMap<String, TerminalLogControl>>>,
    start_lock: Arc<AsyncMutex<()>>,
}

struct TerminalLogControl {
    sender: mpsc::Sender<Vec<u8>>,
    cancellation: CancellationToken,
    completion: oneshot::Receiver<Option<AppError>>,
    path: String,
    bytes: Arc<AtomicU64>,
}

impl TerminalLogRuntime {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            active: Arc::new(Mutex::new(HashMap::new())),
            start_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    pub async fn initialize(&self) -> Result<(), AppError> {
        let _start_guard = self.start_lock.lock().await;
        self.initialize_unlocked().await
    }

    async fn initialize_unlocked(&self) -> Result<(), AppError> {
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|_| terminal_log_start_error())?;
        restrict_log_directory_permissions(&self.directory).await;
        self.prune().await;
        Ok(())
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        session_id: String,
    ) -> Result<TerminalLogStatus, AppError> {
        let _start_guard = self.start_lock.lock().await;
        if let Some(status) = self.active_status(&session_id) {
            return Ok(status);
        }
        if self
            .active
            .lock()
            .map_err(|_| terminal_log_start_error())?
            .len()
            >= TERMINAL_LOG_MAX_ACTIVE
        {
            return Err(terminal_log_active_limit_error());
        }
        self.initialize_unlocked().await?;
        let now = unix_time_ms()?;
        let path = self
            .directory
            .join(format!("terminal-{now}-{}.log", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .await
            .map_err(|_| terminal_log_start_error())?;
        restrict_log_permissions(&path).await;
        let path_label = path.to_string_lossy().into_owned();
        let (sender, receiver) = mpsc::channel(TERMINAL_LOG_QUEUE_MESSAGES);
        let cancellation = CancellationToken::new();
        let bytes = Arc::new(AtomicU64::new(0));
        let (completion_sender, completion) = oneshot::channel();
        let writer_bytes = bytes.clone();
        let writer_path = path_label.clone();
        let writer_cancel = cancellation.clone();
        let writer_active = self.active.clone();
        let writer_app = app.clone();
        let writer_session_id = session_id.clone();
        tauri::async_runtime::spawn(async move {
            let result = run_writer(
                writer_app,
                writer_session_id,
                writer_active,
                file,
                receiver,
                writer_cancel,
                writer_bytes,
                writer_path,
            )
            .await;
            let _ = completion_sender.send(result);
        });

        let control = TerminalLogControl {
            sender,
            cancellation,
            completion,
            path: path_label.clone(),
            bytes: bytes.clone(),
        };
        let replaced = self
            .active
            .lock()
            .map_err(|_| terminal_log_start_error())?
            .insert(session_id.clone(), control);
        if let Some(existing) = replaced {
            existing.cancellation.cancel();
            let _ = tokio::fs::remove_file(&path).await;
            return Ok(TerminalLogStatus {
                session_id,
                state: TerminalLogState::Active,
                path: Some(existing.path),
                bytes: existing.bytes.load(Ordering::Acquire),
                error: None,
            });
        }
        Ok(TerminalLogStatus {
            session_id,
            state: TerminalLogState::Active,
            path: Some(path_label),
            bytes: 0,
            error: None,
        })
    }

    pub fn append(&self, app: &AppHandle, session_id: &str, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let overflow = {
            let Ok(mut active) = self.active.lock() else {
                return;
            };
            let Some(sender) = active.get(session_id).map(|control| control.sender.clone()) else {
                return;
            };
            let mut overflow_status = None;
            for chunk in data.chunks(TERMINAL_LOG_QUEUE_CHUNK_BYTES) {
                if let Err(mpsc::error::TrySendError::Full(_))
                | Err(mpsc::error::TrySendError::Closed(_)) = sender.try_send(chunk.to_vec())
                {
                    overflow_status = active.remove(session_id).map(|control| {
                        control.cancellation.cancel();
                        TerminalLogStatus {
                            session_id: session_id.to_owned(),
                            state: TerminalLogState::Interrupted,
                            path: Some(control.path),
                            bytes: control.bytes.load(Ordering::Acquire),
                            error: Some(terminal_log_overflow_error()),
                        }
                    });
                    break;
                }
            }
            overflow_status
        };
        if let Some(status) = overflow {
            let _ = app.emit(TERMINAL_LOG_EVENT, status);
        }
    }

    pub async fn stop(
        &self,
        app: Option<&AppHandle>,
        session_id: &str,
    ) -> Result<TerminalLogStatus, AppError> {
        let control = self
            .active
            .lock()
            .map_err(|_| terminal_log_stop_error())?
            .remove(session_id);
        let Some(control) = control else {
            return Ok(TerminalLogStatus {
                session_id: session_id.to_owned(),
                state: TerminalLogState::Inactive,
                path: None,
                bytes: 0,
                error: None,
            });
        };
        control.cancellation.cancel();
        let result = tokio::time::timeout(TERMINAL_LOG_STOP_TIMEOUT, control.completion)
            .await
            .map_err(|_| terminal_log_stop_error())?
            .map_err(|_| terminal_log_stop_error())?;
        let status = match result {
            Some(error) => TerminalLogStatus {
                session_id: session_id.to_owned(),
                state: TerminalLogState::Failed,
                path: Some(control.path),
                bytes: control.bytes.load(Ordering::Acquire),
                error: Some(error),
            },
            None => TerminalLogStatus {
                session_id: session_id.to_owned(),
                state: TerminalLogState::Inactive,
                path: Some(control.path),
                bytes: control.bytes.load(Ordering::Acquire),
                error: None,
            },
        };
        if let Some(app) = app {
            let _ = app.emit(TERMINAL_LOG_EVENT, status.clone());
        }
        Ok(status)
    }

    pub async fn shutdown(&self) {
        let controls = self
            .active
            .lock()
            .ok()
            .map(|mut active| {
                active
                    .drain()
                    .map(|(_, control)| control)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut completions = Vec::with_capacity(controls.len());
        for control in controls {
            control.cancellation.cancel();
            completions.push(control.completion);
        }
        let wait = async {
            for completion in completions {
                let _ = completion.await;
            }
        };
        if tokio::time::timeout(TERMINAL_LOG_STOP_TIMEOUT, wait)
            .await
            .is_err()
        {
            eprintln!("FILEX terminal log shutdown timed out");
        }
    }

    pub async fn stop_all(&self, app: &AppHandle) -> Result<Vec<TerminalLogStatus>, AppError> {
        let session_ids = self
            .active
            .lock()
            .map(|active| active.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let results = join_all(
            session_ids
                .into_iter()
                .map(|session_id| async move { self.stop(Some(app), &session_id).await }),
        )
        .await;
        let mut statuses = Vec::with_capacity(results.len());
        let mut first_error = None;
        for result in results {
            match result {
                Ok(status) => statuses.push(status),
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(statuses),
        }
    }

    fn active_status(&self, session_id: &str) -> Option<TerminalLogStatus> {
        let active = self.active.lock().ok()?;
        active.get(session_id).map(|control| TerminalLogStatus {
            session_id: session_id.to_owned(),
            state: TerminalLogState::Active,
            path: Some(control.path.clone()),
            bytes: control.bytes.load(Ordering::Acquire),
            error: None,
        })
    }

    async fn prune(&self) {
        let active_paths = self
            .active
            .lock()
            .map(|active| {
                active
                    .values()
                    .map(|control| control.path.clone())
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        let Ok(mut directory) = tokio::fs::read_dir(&self.directory).await else {
            return;
        };
        let now = SystemTime::now();
        let mut newest = Vec::with_capacity(TERMINAL_LOG_MAX_FILES + 1);
        loop {
            let Ok(Some(entry)) = directory.next_entry().await else {
                break;
            };
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !file_name.starts_with("terminal-")
                || path.extension().and_then(|extension| extension.to_str()) != Some("log")
            {
                continue;
            }
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let path_label = path.to_string_lossy();
            if active_paths.contains(path_label.as_ref()) {
                continue;
            }
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            let expired = now
                .duration_since(modified)
                .is_ok_and(|age| age > TERMINAL_LOG_MAX_AGE);
            if expired {
                let _ = tokio::fs::remove_file(path).await;
                continue;
            }
            let position =
                newest.partition_point(|(_, candidate_modified)| *candidate_modified >= modified);
            newest.insert(position, (path, modified));
            if newest.len() > TERMINAL_LOG_MAX_FILES {
                if let Some((path, _)) = newest.pop() {
                    let _ = tokio::fs::remove_file(path).await;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)] // writer task wiring, all eight are required
async fn run_writer(
    app: AppHandle,
    session_id: String,
    active: Arc<Mutex<HashMap<String, TerminalLogControl>>>,
    mut file: File,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    cancellation: CancellationToken,
    bytes: Arc<AtomicU64>,
    path: String,
) -> Option<AppError> {
    let mut final_error = None;
    let mut terminal_state = None;
    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => break,
            data = receiver.recv() => {
                let Some(data) = data else {
                    final_error = Some(terminal_log_overflow_error());
                    break;
                };
                let written = bytes.load(Ordering::Acquire);
                if written >= TERMINAL_LOG_MAX_BYTES {
                    terminal_state = Some(TerminalLogState::LimitReached);
                    break;
                }
                let remaining = usize::try_from(TERMINAL_LOG_MAX_BYTES - written)
                    .unwrap_or(usize::MAX);
                let take = data.len().min(remaining);
                if file.write_all(&data[..take]).await.is_err() {
                    final_error = Some(terminal_log_write_error());
                    break;
                }
                let next = written.saturating_add(take as u64);
                bytes.store(next, Ordering::Release);
                if next / (1024 * 1024) > written / (1024 * 1024) {
                    let _ = app.emit(
                        TERMINAL_LOG_EVENT,
                        TerminalLogStatus {
                            session_id: session_id.clone(),
                            state: TerminalLogState::Active,
                            path: Some(path.clone()),
                            bytes: next,
                            error: None,
                        },
                    );
                }
                if next >= TERMINAL_LOG_MAX_BYTES {
                    terminal_state = Some(TerminalLogState::LimitReached);
                    break;
                }
            }
        }
    }
    while terminal_state.is_none() && final_error.is_none() {
        let Ok(data) = receiver.try_recv() else {
            break;
        };
        let written = bytes.load(Ordering::Acquire);
        if written >= TERMINAL_LOG_MAX_BYTES {
            terminal_state = Some(TerminalLogState::LimitReached);
            break;
        }
        let remaining = usize::try_from(TERMINAL_LOG_MAX_BYTES - written).unwrap_or(usize::MAX);
        let take = data.len().min(remaining);
        if file.write_all(&data[..take]).await.is_err() {
            final_error = Some(terminal_log_write_error());
            break;
        }
        let next = written.saturating_add(take as u64);
        bytes.store(next, Ordering::Release);
        if next >= TERMINAL_LOG_MAX_BYTES {
            terminal_state = Some(TerminalLogState::LimitReached);
        }
    }
    if file.flush().await.is_err() {
        final_error = Some(terminal_log_write_error());
    }
    let abnormal = final_error.is_some() || terminal_state.is_some();
    if abnormal && remove_matching_control(&active, &session_id, &path) {
        let status = TerminalLogStatus {
            session_id,
            state: terminal_state.unwrap_or_else(|| {
                if final_error.is_some() {
                    TerminalLogState::Failed
                } else {
                    TerminalLogState::Interrupted
                }
            }),
            path: Some(path),
            bytes: bytes.load(Ordering::Acquire),
            error: final_error.clone(),
        };
        let _ = app.emit(TERMINAL_LOG_EVENT, status);
    }
    final_error
}

fn remove_matching_control(
    active: &Mutex<HashMap<String, TerminalLogControl>>,
    session_id: &str,
    path: &str,
) -> bool {
    let Ok(mut active) = active.lock() else {
        return false;
    };
    if active
        .get(session_id)
        .is_some_and(|control| control.path == path)
    {
        active.remove(session_id);
        true
    } else {
        false
    }
}

async fn restrict_log_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    #[cfg(not(unix))]
    let _ = path;
}

async fn restrict_log_directory_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await;
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[tauri::command]
pub async fn start_terminal_logging(
    app: AppHandle,
    session_id: String,
    sessions: State<'_, SessionRuntime>,
    settings: State<'_, SettingsService>,
    logs: State<'_, TerminalLogRuntime>,
) -> Result<OperationResult<TerminalLogStatus>, ()> {
    let settings = match settings.load() {
        Ok(settings) => settings,
        Err(error) => return Ok(OperationResult::failure(error)),
    };
    if !settings.terminal_logging {
        return Ok(OperationResult::failure(terminal_log_disabled_error()));
    }
    match sessions.summary(&session_id) {
        Ok(summary) if summary.state == SessionState::Connected => {}
        Ok(_) => return Ok(OperationResult::failure(terminal_log_session_error())),
        Err(error) => return Ok(OperationResult::failure(error)),
    }
    Ok(match logs.start(&app, session_id).await {
        Ok(status) => OperationResult::success(status),
        Err(error) => OperationResult::failure(error),
    })
}

#[tauri::command]
pub async fn stop_terminal_logging(
    app: AppHandle,
    session_id: String,
    logs: State<'_, TerminalLogRuntime>,
) -> Result<OperationResult<TerminalLogStatus>, ()> {
    Ok(match logs.stop(Some(&app), &session_id).await {
        Ok(status) => OperationResult::success(status),
        Err(error) => OperationResult::failure(error),
    })
}

#[tauri::command]
pub async fn stop_all_terminal_logs(
    app: AppHandle,
    logs: State<'_, TerminalLogRuntime>,
) -> Result<OperationResult<Vec<TerminalLogStatus>>, ()> {
    Ok(match logs.stop_all(&app).await {
        Ok(statuses) => OperationResult::success(statuses),
        Err(error) => OperationResult::failure(error),
    })
}

fn unix_time_ms() -> Result<u64, AppError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| terminal_log_start_error())?
        .as_millis();
    u64::try_from(millis).map_err(|_| terminal_log_start_error())
}

fn terminal_log_disabled_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_DISABLED",
        "errors.terminalLogDisabled",
        false,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_session_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_SESSION_UNAVAILABLE",
        "errors.terminalLogSessionUnavailable",
        true,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_active_limit_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_ACTIVE_LIMIT_REACHED",
        "errors.terminalLogActiveLimitReached",
        false,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_start_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_START_FAILED",
        "errors.terminalLogStartFailed",
        true,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_write_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_WRITE_FAILED",
        "errors.terminalLogWriteFailed",
        true,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_overflow_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_OVERFLOW",
        "errors.terminalLogOverflow",
        true,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_stop_error() -> AppError {
    terminal_log_error(
        "TERMINAL_LOG_STOP_FAILED",
        "errors.terminalLogStopFailed",
        true,
        RemoteState::NotApplicable,
    )
}

fn terminal_log_error(
    code: &str,
    message_key: &str,
    retryable: bool,
    remote_state: RemoteState,
) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable,
        remote_state,
        field: None,
    }
}
