use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use filex_contracts::{
    AppError, ExternalEditorSession, ExternalEditorState, ExternalEditorSyncResult,
    OperationResult, RemoteState,
};
use tauri::{Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::session_runtime::SessionRuntime;

const EXTERNAL_EDITOR_SESSION_LIMIT: usize = 16;

#[derive(Default)]
pub struct ExternalEditorRuntime {
    sessions: AsyncMutex<HashMap<String, Arc<AsyncMutex<ManagedEditorRecord>>>>,
}

struct ManagedEditorRecord {
    session: ExternalEditorSession,
}

#[tauri::command]
pub async fn open_remote_file_in_editor(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
    editor_path: Option<String>,
    sessions: State<'_, SessionRuntime>,
    editors: State<'_, ExternalEditorRuntime>,
) -> Result<OperationResult<ExternalEditorSession>, ()> {
    let cache_directory = match app.path().app_data_dir() {
        Ok(directory) => directory.join("external-open"),
        Err(_) => return Ok(OperationResult::failure(external_editor_launch_error())),
    };
    let editor = match normalize_editor_path(editor_path).await {
        Ok(editor) => editor,
        Err(error) => return Ok(OperationResult::failure(error)),
    };
    let candidates = {
        let managed = editors.sessions.lock().await;
        managed.values().cloned().collect::<Vec<_>>()
    };
    let mut existing = None;
    for candidate in candidates {
        let record = candidate.lock().await;
        if record.session.session_id == session_id && record.session.remote_path == path {
            existing = Some(record.session.clone());
            break;
        }
    }
    if let Some(existing) = existing {
        return Ok(OperationResult::success(existing));
    }
    if editors.sessions.lock().await.len() >= EXTERNAL_EDITOR_SESSION_LIMIT {
        return Ok(OperationResult::failure(external_editor_limit_error()));
    }

    let copy = match sessions
        .create_external_edit_copy(&session_id, &path, &cache_directory)
        .await
    {
        Ok(copy) => copy,
        Err(error) => return Ok(OperationResult::failure(error)),
    };
    if launch_editor(editor.as_deref(), &copy.path).is_err() {
        let _ = tokio::fs::remove_file(&copy.path).await;
        return Ok(OperationResult::failure(external_editor_launch_error()));
    }
    let descriptor = ExternalEditorSession {
        id: uuid::Uuid::new_v4().to_string(),
        session_id,
        remote_path: path,
        local_path: copy.path.to_string_lossy().into_owned(),
        local_revision: copy.revision.clone(),
        remote_revision: copy.revision,
        bytes: copy.bytes,
        state: ExternalEditorState::Watching,
        last_synced_at_ms: None,
        error: None,
    };
    editors.sessions.lock().await.insert(
        descriptor.id.clone(),
        Arc::new(AsyncMutex::new(ManagedEditorRecord {
            session: descriptor.clone(),
        })),
    );
    Ok(OperationResult::success(descriptor))
}

#[tauri::command]
pub async fn sync_external_editor(
    id: String,
    sessions: State<'_, SessionRuntime>,
    editors: State<'_, ExternalEditorRuntime>,
) -> Result<OperationResult<ExternalEditorSyncResult>, ()> {
    let record = {
        let managed = editors.sessions.lock().await;
        managed.get(&id).cloned()
    };
    let Some(record) = record else {
        return Ok(OperationResult::failure(external_editor_session_error()));
    };
    let mut record = record.lock().await;
    if matches!(
        record.session.state,
        ExternalEditorState::Conflict | ExternalEditorState::Failed
    ) {
        return Ok(OperationResult::failure(
            record
                .session
                .error
                .clone()
                .unwrap_or_else(external_editor_sync_error),
        ));
    }
    let local_path = PathBuf::from(&record.session.local_path);
    match sessions
        .sync_external_edit_file(
            &record.session.session_id,
            &record.session.remote_path,
            &local_path,
            &record.session.local_revision,
            &record.session.remote_revision,
        )
        .await
    {
        Ok(result) => {
            record.session.local_revision = result.revision.clone();
            record.session.remote_revision = result.revision;
            record.session.bytes = result.bytes;
            record.session.state = ExternalEditorState::Synced;
            record.session.last_synced_at_ms = unix_time_ms().ok();
            record.session.error = None;
            Ok(OperationResult::success(ExternalEditorSyncResult {
                session: record.session.clone(),
                uploaded: result.uploaded,
            }))
        }
        Err(error) => {
            if error.code == "EXTERNAL_EDIT_LOCAL_CHANGING" {
                record.session.state = ExternalEditorState::Watching;
            } else if error.code == "EXTERNAL_EDIT_REMOTE_CHANGED" {
                record.session.state = ExternalEditorState::Conflict;
                record.session.error = Some(error.clone());
            } else {
                record.session.state = ExternalEditorState::Failed;
                record.session.error = Some(error.clone());
            }
            Ok(OperationResult::failure(error))
        }
    }
}

#[tauri::command]
pub async fn close_external_editor(
    id: String,
    editors: State<'_, ExternalEditorRuntime>,
) -> Result<OperationResult<()>, ()> {
    let record = editors.sessions.lock().await.remove(&id);
    if let Some(record) = record {
        let local_path = record.lock().await.session.local_path.clone();
        let _ = tokio::fs::remove_file(local_path).await;
    }
    Ok(OperationResult::success(()))
}

impl ExternalEditorRuntime {
    pub async fn shutdown(&self) {
        let records = {
            let mut managed = self.sessions.lock().await;
            managed
                .drain()
                .map(|(_, record)| record)
                .collect::<Vec<_>>()
        };
        for record in records {
            let local_path = record.lock().await.session.local_path.clone();
            let _ = tokio::fs::remove_file(local_path).await;
        }
    }
}

pub(crate) fn launch_editor(editor: Option<&Path>, local_path: &Path) -> std::io::Result<()> {
    let mut command = if let Some(editor) = editor {
        let mut command = Command::new(editor);
        command.arg(local_path);
        command
    } else {
        default_open_command(local_path)?
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

fn default_open_command(path: &Path) -> std::io::Result<Command> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(path);
        Ok(command)
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(path);
        Ok(command)
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        Ok(command)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "external editor opening is unsupported",
        ))
    }
}

pub(crate) async fn normalize_editor_path(
    value: Option<String>,
) -> Result<Option<PathBuf>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 4_096 || trimmed.contains('\0') {
        return Err(external_editor_path_error());
    }
    let canonical = tokio::fs::canonicalize(trimmed)
        .await
        .map_err(|_| external_editor_path_error())?;
    let metadata = tokio::fs::symlink_metadata(&canonical)
        .await
        .map_err(|_| external_editor_path_error())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(external_editor_path_error());
    }
    Ok(Some(canonical))
}

fn unix_time_ms() -> Result<u64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|_| external_editor_sync_error())
}

fn external_editor_launch_error() -> AppError {
    external_editor_error(
        "EXTERNAL_EDITOR_LAUNCH_FAILED",
        "errors.externalEditorLaunchFailed",
        true,
    )
}

fn external_editor_path_error() -> AppError {
    external_editor_error(
        "EXTERNAL_EDITOR_PATH_INVALID",
        "errors.externalEditorPathInvalid",
        false,
    )
}

fn external_editor_limit_error() -> AppError {
    external_editor_error("EXTERNAL_EDITOR_LIMIT", "errors.externalEditorLimit", false)
}

fn external_editor_session_error() -> AppError {
    external_editor_error(
        "EXTERNAL_EDITOR_SESSION_NOT_FOUND",
        "errors.externalEditorSessionNotFound",
        false,
    )
}

fn external_editor_sync_error() -> AppError {
    external_editor_error(
        "EXTERNAL_EDITOR_SYNC_FAILED",
        "errors.externalEditorSyncFailed",
        true,
    )
}

fn external_editor_error(code: &str, message_key: &str, retryable: bool) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}
