use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use filex_contracts::{
    AcquireElevatedAccessInput, AppError, ElevatedAccessLeaseSummary, LinkTargetKind,
    PrivilegeState, RemoteDirectoryListing, RemoteDirectoryUsage, RemoteFileEntry, RemoteState,
    RemoteTextPreview, RemoteTextSaveResult, ResolvedLinkTarget, SessionKind, SessionState,
    SessionSummary,
};
use filex_ssh::ConnectedSshSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::session_runtime::{REMOTE_TEXT_PREVIEW_MAX_BYTES, text_revision};
use crate::text_encoding::decode_text_bytes;

pub(crate) const ELEVATED_MIN_TTL_SECONDS: u32 = 60;
pub(crate) const ELEVATED_MAX_TTL_SECONDS: u32 = 1_800;
const ELEVATED_SUDO_TIMEOUT: Duration = Duration::from_secs(12);
const ELEVATED_FILE_IO_TIMEOUT: Duration = Duration::from_secs(20);
const ELEVATED_LIST_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const ELEVATED_PREVIEW_MAX_OUTPUT_BYTES: usize = REMOTE_TEXT_PREVIEW_MAX_BYTES as usize + 16 * 1024;

struct StoredElevatedLease {
    session_id: String,
    generation: u64,
    host: String,
    port: u16,
    username: String,
    password: Zeroizing<String>,
    granted_at_ms: u64,
    expires_at_ms: u64,
    ttl_seconds: u32,
}

impl std::fmt::Debug for StoredElevatedLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredElevatedLease")
            .field("session_id", &self.session_id)
            .field("generation", &self.generation)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("granted_at_ms", &self.granted_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("ttl_seconds", &self.ttl_seconds)
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct ElevatedAccessManager {
    leases: Arc<Mutex<HashMap<String, StoredElevatedLease>>>,
}

impl ElevatedAccessManager {
    pub(crate) fn is_active(&self, session: &SessionSummary, now_ms: u64) -> bool {
        let Ok(mut guard) = self.leases.lock() else {
            return false;
        };
        prune_invalid_lease(&mut guard, &session.id, Some(session), now_ms).is_some()
    }

    pub(crate) fn status(
        &self,
        session_id: &str,
        session: Option<&SessionSummary>,
        now_ms: u64,
    ) -> ElevatedAccessLeaseSummary {
        let Ok(mut guard) = self.leases.lock() else {
            return standard_summary(session_id, session);
        };
        if let Some(lease) = prune_invalid_lease(&mut guard, session_id, session, now_ms) {
            return ElevatedAccessLeaseSummary {
                session_id: lease.session_id.clone(),
                generation: lease.generation,
                state: PrivilegeState::Elevated,
                username: lease.username.clone(),
                host: lease.host.clone(),
                port: lease.port,
                granted_at_ms: Some(lease.granted_at_ms),
                expires_at_ms: Some(lease.expires_at_ms),
                ttl_seconds: Some(lease.ttl_seconds),
            };
        }
        standard_summary(session_id, session)
    }

    pub(crate) fn invalidate_session(&self, session_id: &str) {
        if let Ok(mut guard) = self.leases.lock() {
            guard.remove(session_id);
        }
    }

    pub(crate) fn clear_all(&self) {
        if let Ok(mut guard) = self.leases.lock() {
            guard.clear();
        }
    }

    pub(crate) fn require_lease(
        &self,
        session: &SessionSummary,
        now_ms: u64,
    ) -> Result<(Zeroizing<String>, u64), AppError> {
        ensure_elevatable_session(session)?;
        let mut guard = self.leases.lock().map_err(|_| elevated_lock_error())?;
        let Some(existing) = guard.get(&session.id) else {
            return Err(elevated_not_active_error());
        };
        if !lease_matches_session(existing, session) {
            guard.remove(&session.id);
            return Err(elevated_not_active_error());
        }
        if now_ms >= existing.expires_at_ms {
            guard.remove(&session.id);
            return Err(elevated_lease_expired_error());
        }
        Ok((existing.password.clone(), existing.generation))
    }

    pub(crate) fn insert_verified_lease(
        &self,
        session: &SessionSummary,
        password: Zeroizing<String>,
        ttl_seconds: u32,
        now_ms: u64,
    ) -> Result<ElevatedAccessLeaseSummary, AppError> {
        ensure_elevatable_session(session)?;
        validate_ttl_seconds(ttl_seconds)?;
        let expires_at_ms = now_ms.saturating_add(u64::from(ttl_seconds) * 1_000);
        let mut guard = self.leases.lock().map_err(|_| elevated_lock_error())?;
        guard.insert(
            session.id.clone(),
            StoredElevatedLease {
                session_id: session.id.clone(),
                generation: session.generation,
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                password,
                granted_at_ms: now_ms,
                expires_at_ms,
                ttl_seconds,
            },
        );
        Ok(ElevatedAccessLeaseSummary {
            session_id: session.id.clone(),
            generation: session.generation,
            state: PrivilegeState::Elevated,
            username: session.username.clone(),
            host: session.host.clone(),
            port: session.port,
            granted_at_ms: Some(now_ms),
            expires_at_ms: Some(expires_at_ms),
            ttl_seconds: Some(ttl_seconds),
        })
    }
}

pub(crate) fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) mod commands {
    use filex_contracts::{
        AcquireElevatedAccessInput, ElevatedAccessLeaseSummary, OperationResult,
        RemoteDirectoryListing, RemoteDirectoryUsage, RemoteTextPreview, RemoteTextSaveResult,
        ResolvedLinkTarget,
    };
    use tauri::State;

    use super::{
        acquire_elevated_access as acquire_lease_impl, current_epoch_ms,
        elevated_chmod_entry as chmod_impl, elevated_create_directory as create_dir_impl,
        elevated_create_file as create_file_impl, elevated_delete_entry as delete_impl,
        elevated_directory_usage as directory_usage_impl, elevated_list_directory as list_dir_impl,
        elevated_move_entry as move_impl, elevated_preview_text as preview_impl,
        elevated_rename_entry as rename_impl, elevated_resolve_link_target as resolve_link_impl,
        elevated_save_text as save_impl,
    };
    use crate::session_runtime::SessionRuntime;

    #[tauri::command]
    pub(crate) fn get_elevated_access_status(
        session_id: String,
        sessions: State<'_, SessionRuntime>,
    ) -> OperationResult<ElevatedAccessLeaseSummary> {
        let summary = sessions.summary(&session_id).ok();
        OperationResult::success(sessions.elevated_access().status(
            &session_id,
            summary.as_ref(),
            current_epoch_ms(),
        ))
    }

    #[tauri::command]
    pub(crate) async fn acquire_elevated_access(
        input: AcquireElevatedAccessInput,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<ElevatedAccessLeaseSummary>, ()> {
        let session_id = input.session_id.clone();
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                acquire_lease_impl(sessions.elevated_access(), &session, &ssh, input).await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(lease) => OperationResult::success(lease),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) fn revoke_elevated_access(
        session_id: String,
        sessions: State<'_, SessionRuntime>,
    ) -> OperationResult<ElevatedAccessLeaseSummary> {
        sessions.elevated_access().invalidate_session(&session_id);
        let summary = sessions.summary(&session_id).ok();
        OperationResult::success(sessions.elevated_access().status(
            &session_id,
            summary.as_ref(),
            current_epoch_ms(),
        ))
    }

    #[tauri::command]
    pub(crate) async fn elevated_list_directory(
        session_id: String,
        path: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<RemoteDirectoryListing>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                list_dir_impl(sessions.elevated_access(), &session, &ssh, &path).await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(listing) => OperationResult::success(listing),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_create_directory(
        session_id: String,
        parent_path: String,
        name: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<()>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                create_dir_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &parent_path,
                    &name,
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_create_file(
        session_id: String,
        parent_path: String,
        name: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<()>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                create_file_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &parent_path,
                    &name,
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_rename_entry(
        session_id: String,
        source_path: String,
        target_name: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<()>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                rename_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &source_path,
                    &target_name,
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_delete_entry(
        session_id: String,
        path: String,
        recursive: Option<bool>,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<u32>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                delete_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &path,
                    recursive.unwrap_or(false),
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(deleted) => OperationResult::success(deleted),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_chmod_entry(
        session_id: String,
        path: String,
        mode: u32,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<()>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                chmod_impl(sessions.elevated_access(), &session, &ssh, &path, mode).await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_preview_text(
        session_id: String,
        path: String,
        encoding: Option<String>,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<RemoteTextPreview>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                preview_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &path,
                    encoding.as_deref(),
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(preview) => OperationResult::success(preview),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_save_text(
        session_id: String,
        path: String,
        content: String,
        expected_revision: String,
        encoding: Option<String>,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<RemoteTextSaveResult>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                save_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &path,
                    &content,
                    &expected_revision,
                    encoding.as_deref(),
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(saved) => OperationResult::success(saved),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_resolve_link_target(
        session_id: String,
        path: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<ResolvedLinkTarget>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                resolve_link_impl(sessions.elevated_access(), &session, &ssh, &path).await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(resolved) => OperationResult::success(resolved),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_move_entry(
        session_id: String,
        source_path: String,
        target_directory: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<()>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                move_impl(
                    sessions.elevated_access(),
                    &session,
                    &ssh,
                    &source_path,
                    &target_directory,
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn elevated_directory_usage(
        session_id: String,
        path: String,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<RemoteDirectoryUsage>, ()> {
        let result = match sessions.connected_ssh_target(&session_id).await {
            Ok((session, ssh)) => {
                directory_usage_impl(sessions.elevated_access(), &session, &ssh, &path).await
            }
            Err(error) => Err(error),
        };
        Ok(match result {
            Ok(usage) => OperationResult::success(usage),
            Err(error) => OperationResult::failure(error),
        })
    }
}

pub(crate) async fn acquire_elevated_access(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    input: AcquireElevatedAccessInput,
) -> Result<ElevatedAccessLeaseSummary, AppError> {
    ensure_elevatable_session(session)?;
    validate_ttl_seconds(input.ttl_seconds)?;

    let password = Zeroizing::new(input.password.unwrap_or_default());
    let (probe_cmd, probe_stdin) = probe_command_and_stdin(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &probe_cmd,
            probe_stdin.as_slice(),
            16 * 1024,
            ELEVATED_SUDO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("ELEVATED_PROBE_FAILED", RemoteState::Unchanged)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_failure(
            &output.stderr,
            RemoteState::Unchanged,
        ));
    }

    manager.insert_verified_lease(session, password, input.ttl_seconds, current_epoch_ms())
}

pub(crate) async fn elevated_list_directory(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
) -> Result<RemoteDirectoryListing, AppError> {
    validate_remote_path(path)?;
    let (password, _generation) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_LIST_SCRIPT, &[path]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            ELEVATED_LIST_MAX_OUTPUT_BYTES,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("ELEVATED_LIST_FAILED", RemoteState::Unchanged)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "ELEVATED_LIST_FAILED",
            "errors.sftpDirectoryFailed",
            RemoteState::Unchanged,
        ));
    }
    parse_elevated_directory_output(&output.stdout)
}

pub(crate) async fn elevated_create_directory(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    parent_path: &str,
    name: &str,
) -> Result<(), AppError> {
    validate_remote_path(parent_path)?;
    validate_entry_name(name)?;
    let target = join_remote_path(parent_path, name);
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_CREATE_DIR_SCRIPT, &[&target]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("ELEVATED_CREATE_DIR_FAILED", RemoteState::Unknown)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_CREATE_DIR_FAILED",
            "errors.remoteCreateDirectoryFailed",
            RemoteState::Unchanged,
        ));
    }
    Ok(())
}

pub(crate) async fn elevated_create_file(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    parent_path: &str,
    name: &str,
) -> Result<(), AppError> {
    validate_remote_path(parent_path)?;
    validate_entry_name(name)?;
    let target = join_remote_path(parent_path, name);
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_CREATE_FILE_SCRIPT, &[&target]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("ELEVATED_CREATE_FILE_FAILED", RemoteState::Unknown)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_CREATE_FILE_FAILED",
            "errors.remoteCreateFileFailed",
            RemoteState::Unchanged,
        ));
    }
    Ok(())
}

pub(crate) async fn elevated_rename_entry(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    source_path: &str,
    target_name: &str,
) -> Result<(), AppError> {
    validate_destructive_target(source_path)?;
    validate_entry_name(target_name)?;
    let (parent, current_name) = split_remote_parent(source_path)?;
    if current_name == target_name {
        return Ok(());
    }
    let destination = join_remote_path(parent, target_name);
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(
        password.as_str(),
        ELEVATED_RENAME_SCRIPT,
        &[source_path, &destination],
    );
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("REMOTE_RENAME_FAILED", RemoteState::Unknown)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_RENAME_FAILED",
            "errors.remoteRenameFailed",
            RemoteState::Unchanged,
        ));
    }
    Ok(())
}

pub(crate) async fn elevated_delete_entry(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
    recursive: bool,
) -> Result<u32, AppError> {
    validate_destructive_target(path)?;
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let script = if recursive {
        ELEVATED_DELETE_RECURSIVE_SCRIPT
    } else {
        ELEVATED_DELETE_SINGLE_SCRIPT
    };
    let command = sudo_exec_command(password.as_str(), script, &[path]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("REMOTE_DELETE_FAILED", RemoteState::Unknown)
        })?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_DELETE_FAILED",
            "errors.remoteDeleteFailed",
            RemoteState::Unknown,
        ));
    }
    Ok(1)
}

pub(crate) async fn elevated_chmod_entry(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
    mode: u32,
) -> Result<(), AppError> {
    validate_remote_path(path)?;
    if mode > 0o7777 {
        return Err(AppError {
            code: "REMOTE_MODE_INVALID".to_owned(),
            message_key: "errors.remoteModeInvalid".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: Some("mode".to_owned()),
        });
    }
    let octal = format!("{mode:04o}");
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_CHMOD_SCRIPT, &[path, &octal]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| elevated_operation_failed_error("REMOTE_MODE_FAILED", RemoteState::Unknown))?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_MODE_FAILED",
            "errors.remoteModeFailed",
            RemoteState::Unchanged,
        ));
    }
    Ok(())
}

pub(crate) async fn elevated_preview_text(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
    encoding_label: Option<&str>,
) -> Result<RemoteTextPreview, AppError> {
    validate_remote_path(path)?;
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_PREVIEW_SCRIPT, &[path]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            ELEVATED_PREVIEW_MAX_OUTPUT_BYTES,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("SFTP_PREVIEW_FAILED", RemoteState::Unchanged)
        })?;
    if output.exit_status != Some(0) {
        if output.exit_status == Some(22) {
            return Err(AppError {
                code: "SFTP_PREVIEW_UNSUPPORTED".to_owned(),
                message_key: "errors.sftpPreviewUnsupported".to_owned(),
                retryable: false,
                remote_state: RemoteState::Unchanged,
                field: None,
            });
        }
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "SFTP_PREVIEW_FAILED",
            "errors.sftpPreviewFailed",
            RemoteState::Unchanged,
        ));
    }

    let Some(newline) = output.stdout.iter().position(|byte| *byte == b'\n') else {
        return Err(elevated_operation_failed_error(
            "SFTP_PREVIEW_FAILED",
            RemoteState::Unchanged,
        ));
    };
    let size_text = std::str::from_utf8(&output.stdout[..newline]).map_err(|_| {
        elevated_operation_failed_error("SFTP_PREVIEW_FAILED", RemoteState::Unchanged)
    })?;
    let total_size: u64 = size_text.trim().parse().map_err(|_| {
        elevated_operation_failed_error("SFTP_PREVIEW_FAILED", RemoteState::Unchanged)
    })?;
    let mut raw_bytes = output.stdout[newline + 1..].to_vec();
    let max_bytes = REMOTE_TEXT_PREVIEW_MAX_BYTES as usize;
    let truncated =
        raw_bytes.len() > max_bytes || total_size > u64::from(REMOTE_TEXT_PREVIEW_MAX_BYTES);
    raw_bytes.truncate(max_bytes);
    let selected_encoding = encoding_label.unwrap_or("utf-8");
    let content = decode_text_bytes(&raw_bytes, selected_encoding, truncated)?;
    Ok(RemoteTextPreview {
        path: path.to_owned(),
        bytes: u32::try_from(content.len()).unwrap_or(REMOTE_TEXT_PREVIEW_MAX_BYTES),
        revision: text_revision(content.as_bytes()),
        content,
        truncated,
    })
}

pub(crate) async fn elevated_save_text(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
    content: &str,
    expected_revision: &str,
    encoding_label: Option<&str>,
) -> Result<RemoteTextSaveResult, AppError> {
    validate_remote_path(path)?;
    if content.len() > REMOTE_TEXT_PREVIEW_MAX_BYTES as usize {
        return Err(AppError {
            code: "REMOTE_TEXT_TOO_LARGE".to_owned(),
            message_key: "errors.remoteTextTooLarge".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: None,
        });
    }
    let selected_encoding = encoding_label.unwrap_or("utf-8");
    let encoded_bytes = crate::text_encoding::encode_text_lossless(content, selected_encoding)?;
    if encoded_bytes.len() > REMOTE_TEXT_PREVIEW_MAX_BYTES as usize {
        return Err(AppError {
            code: "REMOTE_TEXT_TOO_LARGE".to_owned(),
            message_key: "errors.remoteTextTooLarge".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: None,
        });
    }

    let current_preview =
        elevated_preview_text(manager, session, ssh, path, Some(selected_encoding)).await?;
    if current_preview.truncated {
        return Err(AppError {
            code: "REMOTE_TEXT_TOO_LARGE".to_owned(),
            message_key: "errors.remoteTextTooLarge".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: None,
        });
    }
    if current_preview.revision != expected_revision {
        return Err(AppError {
            code: "REMOTE_TEXT_CONFLICT".to_owned(),
            message_key: "errors.remoteTextConflict".to_owned(),
            retryable: false,
            remote_state: RemoteState::Changed,
            field: None,
        });
    }

    // Revalidate the lease right before creating staging data & saving.
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let staging_path = format!("/tmp/.filex-elev-{}", Uuid::new_v4());
    let sftp = ssh.open_sftp().await.map_err(|_| {
        elevated_operation_failed_error("REMOTE_SAVE_FAILED", RemoteState::Unchanged)
    })?;
    let stage_result = async {
        let mut staging_file = sftp
            .open_with_flags(
                &staging_path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
            .map_err(|_| {
                elevated_operation_failed_error("REMOTE_SAVE_FAILED", RemoteState::Unchanged)
            })?;
        let _ = sftp
            .set_metadata(
                &staging_path,
                FileAttributes {
                    permissions: Some(0o600),
                    ..FileAttributes::default()
                },
            )
            .await;
        staging_file.write_all(&encoded_bytes).await.map_err(|_| {
            elevated_operation_failed_error("REMOTE_SAVE_FAILED", RemoteState::Unchanged)
        })?;
        staging_file.shutdown().await.map_err(|_| {
            elevated_operation_failed_error("REMOTE_SAVE_FAILED", RemoteState::Unchanged)
        })?;
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(err) = stage_result {
        let _ = sftp.remove_file(&staging_path).await;
        let _ = sftp.close().await;
        return Err(err);
    }

    let command = sudo_exec_command(
        password.as_str(),
        ELEVATED_SAVE_SCRIPT,
        &[path, &staging_path],
    );
    let stdin = password_stdin_bytes(password.as_str());
    let exec_result = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await;
    let _ = sftp.remove_file(&staging_path).await;
    let _ = sftp.close().await;

    let output = exec_result
        .map_err(|_| elevated_operation_failed_error("REMOTE_SAVE_FAILED", RemoteState::Unknown))?;
    if output.exit_status != Some(0) {
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "REMOTE_SAVE_FAILED",
            "errors.remoteSaveFailed",
            RemoteState::Unknown,
        ));
    }

    Ok(RemoteTextSaveResult {
        path: path.to_owned(),
        bytes: u32::try_from(content.len()).unwrap_or(REMOTE_TEXT_PREVIEW_MAX_BYTES),
        revision: text_revision(content.as_bytes()),
        recovery_copy_path: None,
    })
}

pub(crate) async fn elevated_resolve_link_target(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
) -> Result<ResolvedLinkTarget, AppError> {
    validate_remote_path(path)?;
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(password.as_str(), ELEVATED_RESOLVE_LINK_SCRIPT, &[path]);
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| {
            elevated_operation_failed_error("SYMLINK_TARGET_UNAVAILABLE", RemoteState::Unchanged)
        })?;
    if output.exit_status != Some(0) {
        let sudo_err = classify_sudo_failure(&output.stderr, RemoteState::Unchanged);
        if matches!(
            sudo_err.code.as_str(),
            "ELEVATED_NOT_SUPPORTED" | "ELEVATED_AUTH_FAILED"
        ) {
            return Err(sudo_err);
        }
        return Err(crate::session_runtime::symlink_target_unavailable_error());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let kind_flag = lines.next().unwrap_or("").trim();
    let target_path = lines.next().unwrap_or("").trim().to_owned();
    if target_path.is_empty() {
        return Err(crate::session_runtime::symlink_target_unavailable_error());
    }
    let target_kind = match kind_flag {
        "d" => LinkTargetKind::Directory,
        "f" => LinkTargetKind::File,
        _ => LinkTargetKind::Unsupported,
    };
    Ok(ResolvedLinkTarget {
        parent_path: crate::session_runtime::posix_parent_path(&target_path),
        target_path,
        target_kind,
    })
}

pub(crate) async fn elevated_move_entry(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    source_path: &str,
    target_directory: &str,
) -> Result<(), AppError> {
    validate_destructive_target(source_path)?;
    validate_remote_path(target_directory)?;
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(
        password.as_str(),
        ELEVATED_MOVE_SCRIPT,
        &[source_path, target_directory],
    );
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            32 * 1024,
            ELEVATED_FILE_IO_TIMEOUT,
        )
        .await
        .map_err(|_| elevated_operation_failed_error("SFTP_MOVE_FAILED", RemoteState::Unknown))?;
    if output.exit_status != Some(0) {
        if output.exit_status == Some(17) {
            return Err(AppError {
                code: "SFTP_TARGET_EXISTS".to_owned(),
                message_key: "errors.sftpTargetExists".to_owned(),
                retryable: false,
                remote_state: RemoteState::Unchanged,
                field: Some("path".to_owned()),
            });
        }
        return Err(classify_sudo_or_fs_failure(
            &output.stderr,
            output.exit_status,
            "SFTP_MOVE_FAILED",
            "errors.sftpMoveFailed",
            RemoteState::Unchanged,
        ));
    }
    Ok(())
}

pub(crate) async fn elevated_directory_usage(
    manager: &ElevatedAccessManager,
    session: &SessionSummary,
    ssh: &ConnectedSshSession,
    path: &str,
) -> Result<RemoteDirectoryUsage, AppError> {
    validate_remote_path(path)?;
    let (password, _) = manager.require_lease(session, current_epoch_ms())?;
    let command = sudo_exec_command(
        password.as_str(),
        crate::session_runtime::REMOTE_DIRECTORY_USAGE_SCRIPT,
        &[path],
    );
    let stdin = password_stdin_bytes(password.as_str());
    let output = ssh
        .execute_bounded_with_stdin(
            &command,
            stdin.as_slice(),
            crate::session_runtime::REMOTE_DU_MAX_OUTPUT_BYTES,
            crate::session_runtime::REMOTE_DU_TIMEOUT,
        )
        .await
        .map_err(|_| crate::session_runtime::directory_usage_failed_error())?;
    if matches!(output.exit_status, Some(2) | Some(127)) || output.stdout.is_empty() {
        let sudo_err = classify_sudo_failure(&output.stderr, RemoteState::Unchanged);
        if matches!(
            sudo_err.code.as_str(),
            "ELEVATED_NOT_SUPPORTED" | "ELEVATED_AUTH_FAILED"
        ) {
            return Err(sudo_err);
        }
    }
    crate::session_runtime::parse_remote_directory_usage_output(&output.stdout, output.exit_status)
}

pub(crate) fn posix_single_quote(value: &str) -> String {
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

fn probe_command_and_stdin(password: &str) -> (String, Zeroizing<Vec<u8>>) {
    if password.is_empty() {
        (
            "LC_ALL=C sudo -n true".to_owned(),
            Zeroizing::new(Vec::new()),
        )
    } else {
        (
            "LC_ALL=C sudo -S -k -p '' true".to_owned(),
            password_stdin_bytes(password),
        )
    }
}

fn password_stdin_bytes(password: &str) -> Zeroizing<Vec<u8>> {
    if password.is_empty() {
        Zeroizing::new(Vec::new())
    } else {
        Zeroizing::new(format!("{password}\n").into_bytes())
    }
}

fn sudo_exec_command(password: &str, script: &'static str, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 4);
    if password.is_empty() {
        parts.push("LC_ALL=C sudo -n env LC_ALL=C sh -c".to_owned());
    } else {
        parts.push("LC_ALL=C sudo -S -k -p '' env LC_ALL=C sh -c".to_owned());
    }
    parts.push(posix_single_quote(script));
    parts.push("_".to_owned());
    for arg in args {
        parts.push(posix_single_quote(arg));
    }
    parts.join(" ")
}

fn ensure_elevatable_session(session: &SessionSummary) -> Result<(), AppError> {
    if session.session_kind != SessionKind::Ssh {
        return Err(AppError {
            code: "ELEVATED_NOT_SUPPORTED".to_owned(),
            message_key: "errors.elevatedNotSupported".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: None,
        });
    }
    if session.state != SessionState::Connected {
        return Err(AppError {
            code: "SESSION_NOT_CONNECTED".to_owned(),
            message_key: "errors.sessionNotConnected".to_owned(),
            retryable: true,
            remote_state: RemoteState::Unchanged,
            field: None,
        });
    }
    Ok(())
}

fn validate_ttl_seconds(ttl_seconds: u32) -> Result<(), AppError> {
    if !(ELEVATED_MIN_TTL_SECONDS..=ELEVATED_MAX_TTL_SECONDS).contains(&ttl_seconds) {
        return Err(AppError {
            code: "ELEVATED_TTL_INVALID".to_owned(),
            message_key: "errors.elevatedTtlInvalid".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: Some("ttlSeconds".to_owned()),
        });
    }
    Ok(())
}

fn lease_matches_session(lease: &StoredElevatedLease, session: &SessionSummary) -> bool {
    session.session_kind == SessionKind::Ssh
        && session.state == SessionState::Connected
        && lease.generation == session.generation
        && lease.host == session.host
        && lease.port == session.port
        && lease.username == session.username
}

fn prune_invalid_lease<'a>(
    leases: &'a mut HashMap<String, StoredElevatedLease>,
    session_id: &str,
    session: Option<&SessionSummary>,
    now_ms: u64,
) -> Option<&'a StoredElevatedLease> {
    let invalid = match (leases.get(session_id), session) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(lease), Some(summary)) => {
            !lease_matches_session(lease, summary) || now_ms >= lease.expires_at_ms
        }
    };
    if invalid {
        leases.remove(session_id);
        None
    } else {
        leases.get(session_id)
    }
}

fn standard_summary(
    session_id: &str,
    session: Option<&SessionSummary>,
) -> ElevatedAccessLeaseSummary {
    ElevatedAccessLeaseSummary {
        session_id: session_id.to_owned(),
        generation: session.map_or(0, |item| item.generation),
        state: PrivilegeState::Standard,
        username: session.map_or_else(String::new, |item| item.username.clone()),
        host: session.map_or_else(String::new, |item| item.host.clone()),
        port: session.map_or(0, |item| item.port),
        granted_at_ms: None,
        expires_at_ms: None,
        ttl_seconds: None,
    }
}

pub(crate) fn validate_remote_path(path: &str) -> Result<(), AppError> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || path.contains('\r')
        || path.contains('\n')
    {
        return Err(invalid_remote_path_error());
    }
    Ok(())
}

pub(crate) fn validate_entry_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\0')
        || name.contains('\r')
        || name.contains('\n')
    {
        return Err(invalid_remote_path_error());
    }
    Ok(())
}

pub(crate) fn validate_destructive_target(path: &str) -> Result<(), AppError> {
    validate_remote_path(path)?;
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed == "/"
        || trimmed == "."
        || trimmed == ".."
        || trimmed == "~"
        || trimmed == "/*"
        || trimmed.trim_end_matches('/').is_empty()
    {
        return Err(AppError {
            code: "REMOTE_PATH_PROTECTED".to_owned(),
            message_key: "errors.elevatedProtectedTarget".to_owned(),
            retryable: false,
            remote_state: RemoteState::Unchanged,
            field: Some("path".to_owned()),
        });
    }
    Ok(())
}

fn split_remote_parent(path: &str) -> Result<(&str, &str), AppError> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", name)) if !name.is_empty() => Ok(("/", name)),
        Some((parent, name)) if !name.is_empty() => Ok((parent, name)),
        None if !trimmed.is_empty() => Ok((".", trimmed)),
        _ => Err(invalid_remote_path_error()),
    }
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn classify_sudo_failure(stderr: &[u8], remote_state: RemoteState) -> AppError {
    let message = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if message.contains("command not found")
        || message.contains("not found") && message.contains("sudo")
    {
        return AppError {
            code: "ELEVATED_NOT_SUPPORTED".to_owned(),
            message_key: "errors.elevatedNotSupported".to_owned(),
            retryable: false,
            remote_state,
            field: None,
        };
    }
    if message.contains("password is required")
        || message.contains("sorry, try again")
        || message.contains("incorrect password")
        || message.contains("authentication failure")
        || message.contains("not in the sudoers")
        || message.contains("may not run sudo")
    {
        return AppError {
            code: "ELEVATED_AUTH_FAILED".to_owned(),
            message_key: "errors.elevatedAuthFailed".to_owned(),
            retryable: true,
            remote_state,
            field: Some("password".to_owned()),
        };
    }
    elevated_operation_failed_error("ELEVATED_OPERATION_FAILED", remote_state)
}

fn classify_sudo_or_fs_failure(
    stderr: &[u8],
    exit_status: Option<u32>,
    fallback_code: &str,
    fallback_message_key: &str,
    remote_state: RemoteState,
) -> AppError {
    let sudo_err = classify_sudo_failure(stderr, remote_state.clone());
    if matches!(
        sudo_err.code.as_str(),
        "ELEVATED_NOT_SUPPORTED" | "ELEVATED_AUTH_FAILED"
    ) {
        return sudo_err;
    }
    if exit_status == Some(127) {
        return AppError {
            code: "ELEVATED_NOT_SUPPORTED".to_owned(),
            message_key: "errors.elevatedNotSupported".to_owned(),
            retryable: false,
            remote_state,
            field: None,
        };
    }
    AppError {
        code: fallback_code.to_owned(),
        message_key: fallback_message_key.to_owned(),
        retryable: false,
        remote_state,
        field: None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PythonListedDirectory {
    path: String,
    entries: Vec<RemoteFileEntry>,
}

fn parse_elevated_directory_output(stdout: &[u8]) -> Result<RemoteDirectoryListing, AppError> {
    if stdout.starts_with(b"JSON\n") {
        let mut parsed: PythonListedDirectory =
            serde_json::from_slice(&stdout[5..]).map_err(|_| {
                elevated_operation_failed_error("ELEVATED_LIST_FAILED", RemoteState::Unchanged)
            })?;
        sort_remote_entries(&mut parsed.entries);
        return Ok(RemoteDirectoryListing {
            path: parsed.path,
            entries: parsed.entries,
        });
    }
    if stdout.starts_with(b"RAW\0") {
        let mut records = stdout[4..].split(|byte| *byte == 0);
        let path_bytes = records.next().ok_or_else(|| {
            elevated_operation_failed_error("ELEVATED_LIST_FAILED", RemoteState::Unchanged)
        })?;
        let resolved_path = String::from_utf8_lossy(path_bytes).into_owned();
        let mut entries = Vec::new();
        for record in records {
            if record.is_empty() {
                continue;
            }
            let text = String::from_utf8_lossy(record);
            let mut fields = text.splitn(7, '\t');
            let kind = fields.next().unwrap_or("-");
            let size = fields.next().and_then(|value| value.parse::<u64>().ok());
            let mtime_sec = fields.next().and_then(|value| value.parse::<u64>().ok());
            let mode = fields
                .next()
                .and_then(|value| u32::from_str_radix(value.trim(), 8).ok())
                .map(|value| value & 0o7777);
            let uid = fields.next().and_then(|value| value.parse::<u32>().ok());
            let gid = fields.next().and_then(|value| value.parse::<u32>().ok());
            let Some(name) = fields.next() else {
                continue;
            };
            if name.is_empty() || matches!(name, "." | "..") {
                continue;
            }
            let is_symlink = kind == "l";
            let is_directory = !is_symlink && kind == "d";
            entries.push(RemoteFileEntry {
                name: name.to_owned(),
                path: join_remote_path(&resolved_path, name),
                is_directory,
                is_symlink,
                size: if is_directory { None } else { size },
                modified_at_ms: mtime_sec.map(|seconds| seconds.saturating_mul(1000)),
                permissions_mode: if is_symlink { None } else { mode },
                uid,
                gid,
                symlink_target: None,
            });
        }
        sort_remote_entries(&mut entries);
        return Ok(RemoteDirectoryListing {
            path: resolved_path,
            entries,
        });
    }
    Err(elevated_operation_failed_error(
        "ELEVATED_LIST_FAILED",
        RemoteState::Unchanged,
    ))
}

fn sort_remote_entries(entries: &mut [RemoteFileEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

fn invalid_remote_path_error() -> AppError {
    AppError {
        code: "REMOTE_PATH_INVALID".to_owned(),
        message_key: "errors.remotePathInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("path".to_owned()),
    }
}

fn elevated_not_active_error() -> AppError {
    AppError {
        code: "ELEVATED_NOT_ACTIVE".to_owned(),
        message_key: "errors.elevatedNotActive".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn elevated_lease_expired_error() -> AppError {
    AppError {
        code: "ELEVATED_LEASE_EXPIRED".to_owned(),
        message_key: "errors.elevatedLeaseExpired".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn elevated_lock_error() -> AppError {
    AppError {
        code: "ELEVATED_LOCK_FAILED".to_owned(),
        message_key: "errors.elevatedOperationFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn elevated_operation_failed_error(code: &str, remote_state: RemoteState) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: "errors.elevatedOperationFailed".to_owned(),
        retryable: false,
        remote_state,
        field: None,
    }
}

const ELEVATED_LIST_SCRIPT: &str = r#"target="$1"
if command -v python3 >/dev/null 2>&1; then
  printf 'JSON\n'
  exec python3 -c '
import json, os, stat, sys
target = os.path.realpath(sys.argv[1])
if not os.path.isdir(target):
    sys.exit(2)
out = []
with os.scandir(target) as it:
    for i, entry in enumerate(it):
        if i >= 10000:
            break
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        is_link = stat.S_ISLNK(st.st_mode)
        is_dir = False if is_link else stat.S_ISDIR(st.st_mode)
        full = ("/" + entry.name) if target == "/" else (target.rstrip("/") + "/" + entry.name)
        link_target = None
        if is_link:
            try:
                link_target = os.readlink(full)
            except OSError:
                link_target = None
        out.append({
            "name": entry.name,
            "path": full,
            "isDirectory": is_dir,
            "isSymlink": is_link,
            "size": None if is_dir else st.st_size,
            "modifiedAtMs": int(st.st_mtime * 1000),
            "permissionsMode": None if is_link else (stat.S_IMODE(st.st_mode) & 0o7777),
            "uid": st.st_uid,
            "gid": st.st_gid,
            "symlinkTarget": link_target,
        })
print(json.dumps({"path": target, "entries": out}, ensure_ascii=False))
' "$target"
fi
resolved=$(cd -- "$target" 2>/dev/null && pwd -P) || exit 2
printf 'RAW\0%s\0' "$resolved"
count=0
for entry in "$resolved"/* "$resolved"/.[!.]* "$resolved"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=${entry##*/}
  kind="-"
  if [ -L "$entry" ]; then kind="l"; elif [ -d "$entry" ]; then kind="d"; fi
  if meta=$(stat -c '%s\t%Y\t%a\t%u\t%g' -- "$entry" 2>/dev/null); then
    :
  elif meta=$(stat -f '%z\t%m\t%Lp\t%u\t%g' -- "$entry" 2>/dev/null); then
    :
  else
    meta="\t\t\t\t"
  fi
  printf '%s\t%s\t%s\0' "$kind" "$meta" "$name"
  count=$((count + 1))
  [ "$count" -ge 10000 ] && break
done"#;

const ELEVATED_CREATE_DIR_SCRIPT: &str = r#"mkdir -- "$1""#;

const ELEVATED_CREATE_FILE_SCRIPT: &str = r#"if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi
(umask 022 && set -C && : > "$1")"#;

const ELEVATED_RENAME_SCRIPT: &str = r#"if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi
mv -n -- "$1" "$2""#;

const ELEVATED_DELETE_SINGLE_SCRIPT: &str = r#"target="$1"
case "$target" in ""|"/"|"."|".."|"/*"|"~") exit 22 ;; esac
if [ -L "$target" ] || [ ! -d "$target" ]; then
  rm -f -- "$target"
else
  rmdir -- "$target"
fi"#;

const ELEVATED_DELETE_RECURSIVE_SCRIPT: &str = r#"target="$1"
case "$target" in ""|"/"|"."|".."|"/*"|"~") exit 22 ;; esac
rm -rf -- "$target""#;

const ELEVATED_CHMOD_SCRIPT: &str = r#"if [ -L "$1" ]; then exit 22; fi
chmod "$2" -- "$1""#;

const ELEVATED_PREVIEW_SCRIPT: &str = r#"target="$1"
if [ -L "$target" ] || [ ! -f "$target" ]; then exit 22; fi
sz=$(wc -c < "$target" | tr -d '[:space:]') || exit 1
printf '%s\n' "$sz"
head -c 1048580 -- "$target""#;

const ELEVATED_SAVE_SCRIPT: &str = r#"target="$1"
staging="$2"
cleanup() { rm -f -- "$staging" 2>/dev/null || true; }
trap cleanup EXIT
if [ -L "$target" ] || [ ! -f "$target" ]; then exit 22; fi
dir=$(dirname -- "$target")
base=$(basename -- "$target")
tmp=$(mktemp "$dir/.${base}.filex.XXXXXX") || exit 1
chmod 600 -- "$tmp" || { rm -f -- "$tmp"; exit 1; }
if mode=$(stat -f '%Lp' "$target" 2>/dev/null) && [ -n "$mode" ]; then
  chmod "$mode" -- "$tmp" 2>/dev/null || true
elif chmod --reference="$target" -- "$tmp" 2>/dev/null; then
  :
fi
if owner=$(stat -f '%u:%g' "$target" 2>/dev/null) && [ -n "$owner" ]; then
  chown "$owner" -- "$tmp" 2>/dev/null || true
elif chown --reference="$target" -- "$tmp" 2>/dev/null; then
  :
fi
cat -- "$staging" > "$tmp" || { rm -f -- "$tmp"; exit 1; }
mv -f -- "$tmp" "$target" || { rm -f -- "$tmp"; exit 1; }"#;

const ELEVATED_RESOLVE_LINK_SCRIPT: &str = r#"target="$1"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -c '
import os, stat, sys
p = os.path.realpath(sys.argv[1])
st = os.stat(p)
if stat.S_ISDIR(st.st_mode):
    print("d")
elif stat.S_ISREG(st.st_mode):
    print("f")
else:
    print("u")
print(p)
' "$target" 2>/dev/null || exit 2
fi
if [ -d "$target" ]; then
  resolved=$(cd -- "$target" 2>/dev/null && pwd -P) || exit 2
  printf 'd\n%s\n' "$resolved"
  exit 0
fi
if [ -f "$target" ]; then
  resolved=$(readlink -f -- "$target" 2>/dev/null || realpath -- "$target" 2>/dev/null) || exit 2
  printf 'f\n%s\n' "$resolved"
  exit 0
fi
exit 2"#;

const ELEVATED_MOVE_SCRIPT: &str = r#"src="$1"
dst_dir="$2"
[ -e "$src" ] || [ -L "$src" ] || exit 2
[ -d "$dst_dir" ] || exit 20
dst_real=$(cd -- "$dst_dir" 2>/dev/null && pwd -P) || exit 20
base=${src##*/}
[ -n "$base" ] && [ "$base" != "." ] && [ "$base" != ".." ] || exit 22
if [ ! -L "$src" ] && [ -d "$src" ]; then
  src_real=$(cd -- "$src" 2>/dev/null && pwd -P) || exit 2
  case "$dst_real" in
    "$src_real"|"$src_real"/*) exit 22 ;;
  esac
fi
if [ "$dst_real" = "/" ]; then
  target="/$base"
else
  target="${dst_real%/}/$base"
fi
if [ -e "$target" ] || [ -L "$target" ]; then
  exit 17
fi
mv -n -- "$src" "$target""#;

#[cfg(test)]
mod tests {
    use filex_contracts::{
        AcquireElevatedAccessInput, PrivilegeState, SessionKind, SessionState, SessionSummary,
        capabilities_for_local, capabilities_for_ssh,
    };
    use zeroize::Zeroizing;

    use super::{
        ELEVATED_LIST_SCRIPT, ElevatedAccessManager, parse_elevated_directory_output,
        posix_single_quote, sudo_exec_command, validate_destructive_target,
    };

    fn sample_ssh_session(generation: u64) -> SessionSummary {
        SessionSummary {
            id: "sess-1".to_owned(),
            generation,
            profile_id: "prof-1".to_owned(),
            session_kind: SessionKind::Ssh,
            capabilities: capabilities_for_ssh(false),
            state: SessionState::Connected,
            host: "10.0.0.5".to_owned(),
            port: 22,
            username: "ops".to_owned(),
            last_error: None,
        }
    }

    #[test]
    fn validates_ttl_bounds_and_expires_leases() {
        let manager = ElevatedAccessManager::default();
        let session = sample_ssh_session(1);

        let err = manager
            .insert_verified_lease(&session, Zeroizing::new("secret".to_owned()), 10, 1_000)
            .expect_err("rejects too-short TTL");
        assert_eq!(err.code, "ELEVATED_TTL_INVALID");

        let summary = manager
            .insert_verified_lease(&session, Zeroizing::new("secret".to_owned()), 300, 1_000)
            .expect("inserts valid 5m lease");
        assert_eq!(summary.state, PrivilegeState::Elevated);
        assert!(manager.is_active(&session, 100_000));
        assert!(manager.require_lease(&session, 200_000).is_ok());

        let expired = manager
            .require_lease(&session, 301_000)
            .expect_err("expires at TTL boundary");
        assert_eq!(expired.code, "ELEVATED_LEASE_EXPIRED");
        assert!(!manager.is_active(&session, 301_000));
    }

    #[test]
    fn invalidates_lease_on_generation_host_or_session_kind_mismatch() {
        let manager = ElevatedAccessManager::default();
        let session = sample_ssh_session(3);
        manager
            .insert_verified_lease(&session, Zeroizing::new("secret".to_owned()), 300, 1_000)
            .expect("lease granted");

        let bumped_gen = sample_ssh_session(4);
        assert!(!manager.is_active(&bumped_gen, 2_000));

        manager
            .insert_verified_lease(&session, Zeroizing::new("secret".to_owned()), 300, 2_000)
            .expect("lease re-granted");
        let mut changed_host = session.clone();
        changed_host.host = "10.0.0.9".to_owned();
        assert!(!manager.is_active(&changed_host, 3_000));

        let local = SessionSummary {
            session_kind: SessionKind::Local,
            capabilities: capabilities_for_local(),
            ..session
        };
        assert_eq!(
            manager.status(&local.id, Some(&local), 3_000).state,
            PrivilegeState::Standard
        );
    }

    #[test]
    fn redacts_passwords_from_debug_representations() {
        let input = AcquireElevatedAccessInput {
            session_id: "sess-1".to_owned(),
            password: Some("super-secret-password".to_owned()),
            ttl_seconds: 300,
        };
        let rendered = format!("{input:?}");
        assert!(!rendered.contains("super-secret-password"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn rejects_destructive_root_targets_and_quotes_arguments_without_interpolation() {
        for dangerous in ["/", "///", ".", "..", "/*", "~", ""] {
            assert!(
                validate_destructive_target(dangerous).is_err(),
                "expected {dangerous:?} to be rejected"
            );
        }
        assert!(validate_destructive_target("/etc/nginx/conf.d").is_ok());

        let evil_path = "/tmp/a'b; rm -rf /; $(whoami)";
        let cmd = sudo_exec_command("pw", ELEVATED_LIST_SCRIPT, &[evil_path]);
        assert!(!cmd.contains("$(whoami)\n"));
        assert!(cmd.ends_with(&posix_single_quote(evil_path)));
    }

    #[test]
    fn parses_json_and_fallback_nul_directory_listings() {
        let json_payload = b"JSON\n{\"path\":\"/etc\",\"entries\":[{\"name\":\"hosts\",\"path\":\"/etc/hosts\",\"isDirectory\":false,\"isSymlink\":false,\"size\":42,\"modifiedAtMs\":1700000000000,\"permissionsMode\":420,\"uid\":0,\"gid\":0},{\"name\":\"nginx\",\"path\":\"/etc/nginx\",\"isDirectory\":true,\"isSymlink\":false,\"size\":null,\"modifiedAtMs\":1700000001000,\"permissionsMode\":493,\"uid\":0,\"gid\":0}]}";
        let listed = parse_elevated_directory_output(json_payload).expect("parses json listing");
        assert_eq!(listed.path, "/etc");
        assert_eq!(listed.entries.len(), 2);
        assert_eq!(listed.entries[0].name, "nginx");
        assert!(listed.entries[0].is_directory);

        let raw_payload = b"RAW\0/etc\0d\t4096\t1700000001\t755\t0\t0\tnginx\0-\t42\t1700000000\t644\t0\t0\thosts\0";
        let raw_listed = parse_elevated_directory_output(raw_payload).expect("parses raw listing");
        assert_eq!(raw_listed.path, "/etc");
        assert_eq!(raw_listed.entries.len(), 2);
        assert_eq!(raw_listed.entries[1].permissions_mode, Some(0o644));
    }
}
