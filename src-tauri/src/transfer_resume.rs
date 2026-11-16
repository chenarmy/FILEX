use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use filex_contracts::{AppError, RemoteState, TransferResumeState, TransferTask};

#[derive(Debug, Clone)]
pub enum TransferRuntimeEvent {
    Metadata {
        source_size_bytes: Option<u64>,
        source_mtime_ms: Option<u64>,
        staging_path: Option<String>,
        resume_state: TransferResumeState,
    },
    Progress {
        bytes_transferred: u64,
        total_bytes: Option<u64>,
    },
    IdentityChanged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumePlan {
    FreshStart,
    ResumeFromOffset { offset: u64 },
    RestartFromBeginning,
    IdentityChanged,
}

/// Evaluates whether a regular-file transfer should start fresh, resume from a verified staging
/// offset, restart from byte 0, or refuse resume because the source identity changed.
pub fn evaluate_resume_plan(
    task: &TransferTask,
    current_source_size: Option<u64>,
    current_source_mtime_ms: Option<u64>,
    staged_len: Option<u64>,
) -> ResumePlan {
    if task.resume_state == TransferResumeState::IdentityChanged {
        return ResumePlan::IdentityChanged;
    }
    let Some(_) = task.staging_path.as_deref() else {
        if task.bytes_transferred > 0 || task.remote_mtime_ms.is_some() {
            return ResumePlan::RestartFromBeginning;
        }
        return ResumePlan::FreshStart;
    };

    if !source_identity_matches(
        task.remote_size_bytes,
        task.remote_mtime_ms,
        current_source_size,
        current_source_mtime_ms,
    ) {
        return ResumePlan::IdentityChanged;
    }

    match staged_len {
        Some(len) if current_source_size.is_some_and(|src_size| len > src_size) => {
            ResumePlan::IdentityChanged
        }
        Some(len) if len > 0 => ResumePlan::ResumeFromOffset { offset: len },
        Some(_) | None => ResumePlan::RestartFromBeginning,
    }
}

pub fn source_identity_matches(
    expected_size: Option<u64>,
    expected_mtime_ms: Option<u64>,
    current_size: Option<u64>,
    current_mtime_ms: Option<u64>,
) -> bool {
    if let Some(prev_size) = expected_size
        && current_size != Some(prev_size)
    {
        return false;
    }
    if let Some(prev_mtime) = expected_mtime_ms
        && current_mtime_ms != Some(prev_mtime)
    {
        return false;
    }
    true
}

pub fn system_time_to_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

pub fn should_preserve_staging_on_error(error: &AppError) -> bool {
    matches!(
        error.code.as_str(),
        "TRANSFER_INTERRUPTED"
            | "TRANSFER_IDENTITY_CHANGED"
            | "TRANSFER_STREAM_FAILED"
            | "TRANSFER_SIZE_MISMATCH"
    )
}

pub fn deterministic_local_staging_path(parent: &Path, task_id: &str) -> PathBuf {
    let sanitized: String = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    parent.join(format!(".filex-part-{sanitized}"))
}

pub fn deterministic_remote_staging_path(target: &str, task_id: &str) -> String {
    let sanitized: String = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    format!("{target}.filex-part-{sanitized}")
}

pub fn transfer_identity_changed_error() -> AppError {
    AppError {
        code: "TRANSFER_IDENTITY_CHANGED".to_owned(),
        message_key: "errors.transferIdentityChanged".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

pub fn transfer_interrupted_error() -> AppError {
    AppError {
        code: "TRANSFER_INTERRUPTED".to_owned(),
        message_key: "errors.transferInterrupted".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

pub fn transfer_size_mismatch_error() -> AppError {
    AppError {
        code: "TRANSFER_SIZE_MISMATCH".to_owned(),
        message_key: "errors.transferSizeMismatch".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::{
        ConflictPolicy, TransferDirection, TransferResumeState, TransferState, TransferTask,
    };

    use super::{ResumePlan, evaluate_resume_plan, should_preserve_staging_on_error};

    fn sample_task() -> TransferTask {
        TransferTask {
            id: "task-123".to_owned(),
            profile_id: "prof-1".to_owned(),
            session_id: None,
            direction: TransferDirection::Download,
            local_path: "C:\\tmp\\archive.tar.gz".to_owned(),
            remote_path: "/srv/archive.tar.gz".to_owned(),
            destination_profile_id: None,
            destination_session_id: None,
            destination_remote_path: None,
            state: TransferState::Paused,
            bytes_transferred: 512,
            total_bytes: Some(2048),
            conflict_policy: ConflictPolicy::Overwrite,
            remote_size_bytes: Some(2048),
            remote_mtime_ms: Some(1_700_000_000_000),
            staging_path: Some("C:\\tmp\\.filex-part-task-123".to_owned()),
            resume_state: TransferResumeState::SafeToResume,
            error: None,
            created_at_ms: 1000,
            updated_at_ms: 2000,
        }
    }

    #[test]
    fn evaluates_resume_plan_by_source_identity_and_staging_state() {
        let mut fresh = sample_task();
        fresh.state = TransferState::Queued;
        fresh.bytes_transferred = 0;
        fresh.remote_mtime_ms = None;
        fresh.staging_path = None;
        fresh.resume_state = TransferResumeState::NotApplicable;
        assert_eq!(
            evaluate_resume_plan(&fresh, Some(2048), Some(1_700_000_000_000), None),
            ResumePlan::FreshStart
        );

        let staged = sample_task();
        assert_eq!(
            evaluate_resume_plan(&staged, Some(2048), Some(1_700_000_000_000), Some(768)),
            ResumePlan::ResumeFromOffset { offset: 768 }
        );

        assert_eq!(
            evaluate_resume_plan(&staged, Some(4096), Some(1_700_000_000_000), Some(768)),
            ResumePlan::IdentityChanged
        );
        assert_eq!(
            evaluate_resume_plan(&staged, Some(2048), Some(1_700_000_005_000), Some(768)),
            ResumePlan::IdentityChanged
        );
        assert_eq!(
            evaluate_resume_plan(&staged, Some(512), Some(1_700_000_000_000), Some(768)),
            ResumePlan::IdentityChanged
        );

        assert_eq!(
            evaluate_resume_plan(&staged, Some(2048), Some(1_700_000_000_000), None),
            ResumePlan::RestartFromBeginning
        );
        assert_eq!(
            evaluate_resume_plan(&staged, Some(2048), Some(1_700_000_000_000), Some(0)),
            ResumePlan::RestartFromBeginning
        );
    }

    #[test]
    fn cancelled_discards_staging_while_interrupted_or_changed_preserves_staging() {
        assert!(!should_preserve_staging_on_error(
            &crate::session_runtime::transfer_cancelled_error_for_test()
        ));
        assert!(should_preserve_staging_on_error(
            &super::transfer_interrupted_error()
        ));
        assert!(should_preserve_staging_on_error(
            &super::transfer_identity_changed_error()
        ));
    }
}
