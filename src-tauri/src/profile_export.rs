use std::{
    io::{self, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use filex_contracts::{
    AppError, ConnectionProfilesExport, MaintenanceArtifact, OperationResult, RemoteState,
};
use filex_core::{ProfileService, SettingsService};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

const PROFILE_EXPORT_MAX_BYTES: usize = 16 * 1024 * 1024;
const PROFILE_EXPORT_LIMIT_ERROR: &str = "connection profile export exceeds its size limit";

#[tauri::command]
pub(crate) async fn export_connection_profiles(
    app: AppHandle,
    profiles: State<'_, ProfileService>,
    settings: State<'_, SettingsService>,
) -> Result<OperationResult<Option<MaintenanceArtifact>>, ()> {
    Ok(async {
    let exported_at_ms = match current_time_ms() {
        Ok(value) => value,
        Err(error) => return OperationResult::failure(error),
    };
    let payload = match profiles.portable_export(exported_at_ms) {
        Ok(payload) => payload,
        Err(error) => return OperationResult::failure(error),
    };

    let locale = settings
        .load()
        .map(|settings| settings.locale)
        .unwrap_or_else(|_| "zh-CN".to_owned());
    let (dialog_title, filter_label) = if locale == "zh-CN" {
        ("导出 FILEX 连接资料", "FILEX 连接资料")
    } else {
        (
            "Export FILEX connection profiles",
            "FILEX connection profiles",
        )
    };

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(dialog_title)
        .set_file_name("filex-connections.json")
        .add_filter(filter_label, &["json"])
        .save_file(move |selected_path| {
            let _ = sender.send(selected_path);
        });
    let selected_path = match receiver.await {
        Ok(Some(path)) => path,
        Ok(None) => return OperationResult::success(None),
        Err(_) => {
            return OperationResult::failure(profile_export_error("PROFILE_EXPORT_DIALOG_FAILED"));
        }
    };
    let path = match selected_path.into_path() {
        Ok(path) => path,
        Err(_) => {
            return OperationResult::failure(profile_export_error("PROFILE_EXPORT_PATH_INVALID"));
        }
    };
    let write_path = path.clone();
    let write_result =
        tauri::async_runtime::spawn_blocking(move || write_atomically(&write_path, &payload)).await;
        match write_result {
            Ok(Ok(byte_count)) => OperationResult::success(Some(MaintenanceArtifact {
                kind: "connection_profiles".to_owned(),
                path: path.to_string_lossy().into_owned(),
                bytes: byte_count,
                created_at_ms: exported_at_ms,
            })),
            Ok(Err(ProfileExportWriteError::TooLarge)) => {
                OperationResult::failure(profile_export_too_large_error())
            }
            Ok(Err(_)) | Err(_) => {
                OperationResult::failure(profile_export_error("PROFILE_EXPORT_WRITE_FAILED"))
            }
        }
    }.await)
}

enum ProfileExportWriteError {
    TooLarge,
    Failed,
}

struct BoundedWriter<W> {
    inner: W,
    max_bytes: u64,
    written: u64,
    exceeded: bool,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, max_bytes: u64) -> Self {
        Self {
            inner,
            max_bytes,
            written: 0,
            exceeded: false,
        }
    }

    fn limit_exceeded(&self) -> bool {
        self.exceeded
    }

    fn into_inner(self) -> W {
        self.inner
    }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let remaining = self.max_bytes.saturating_sub(self.written);
        if u64::try_from(buffer.len()).unwrap_or(u64::MAX) > remaining {
            self.exceeded = true;
            return Err(io::Error::other(PROFILE_EXPORT_LIMIT_ERROR));
        }

        let written = self.inner.write(buffer)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_atomically(
    path: &Path,
    payload: &ConnectionProfilesExport,
) -> Result<u64, ProfileExportWriteError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = NamedTempFile::new_in(parent).map_err(|_| ProfileExportWriteError::Failed)?;
    let mut writer = BoundedWriter::new(temporary, PROFILE_EXPORT_MAX_BYTES as u64);
    if serde_json::to_writer_pretty(&mut writer, payload).is_err() {
        return Err(if writer.limit_exceeded() {
            ProfileExportWriteError::TooLarge
        } else {
            ProfileExportWriteError::Failed
        });
    }

    let byte_count = writer.written;
    let temporary = writer.into_inner();
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| ProfileExportWriteError::Failed)?;
    temporary
        .persist(path)
        .map_err(|_| ProfileExportWriteError::Failed)?;
    Ok(byte_count)
}

fn current_time_ms() -> Result<u64, AppError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| profile_export_error("CLOCK_UNAVAILABLE"))?
        .as_millis();
    u64::try_from(value).map_err(|_| profile_export_error("CLOCK_UNAVAILABLE"))
}

fn profile_export_error(code: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: "errors.profileExportFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn profile_export_too_large_error() -> AppError {
    AppError {
        code: "PROFILE_EXPORT_TOO_LARGE".to_owned(),
        message_key: "errors.profileExportTooLarge".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}
