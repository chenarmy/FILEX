use std::io::SeekFrom;

use filex_contracts::{AppError, ConflictPolicy, TransferResumeState, TransferTask};
use filex_ssh::ConnectedSshSession;
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::session_runtime::{
    RemoteTransferEntry, TransferControl, atomic_commit_remote_file,
    canonical_remote_transfer_target, copy_transfer_stream, directory_tree_limit_error,
    directory_tree_unsupported_error, ensure_remote_transfer_directory, invalid_remote_path_error,
    join_remote_directory_path, remote_transfer_child_path, remote_transfer_metadata,
    remove_remote_tree, scan_remote_transfer_tree, split_remote_parent, transfer_conflict_error,
    transfer_io_error, unique_remote_path, validate_remote_transfer_destination_path,
};
use crate::transfer_resume::{
    ResumePlan, TransferRuntimeEvent, deterministic_remote_staging_path, evaluate_resume_plan,
    should_preserve_staging_on_error, source_identity_matches, transfer_identity_changed_error,
    transfer_size_mismatch_error,
};

fn file_attributes_mtime_ms(metadata: &FileAttributes) -> Option<u64> {
    metadata.mtime.map(|seconds| u64::from(seconds) * 1_000)
}

fn normalize_remote_prefix(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() { "/" } else { trimmed }
}

fn remote_paths_overlap(source: &str, target: &str) -> bool {
    let source = normalize_remote_prefix(source);
    let target = normalize_remote_prefix(target);
    if source == "/" {
        return target.starts_with('/');
    }
    target == source
        || target
            .strip_prefix(source)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn bounded_relay_staging_path(target: &str, task_id: &str) -> Result<String, AppError> {
    let candidate = deterministic_remote_staging_path(target, task_id);
    if candidate.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    Ok(candidate)
}

pub(crate) async fn relay_remote_to_remote(
    source_session: &ConnectedSshSession,
    source_sftp: &SftpSession,
    destination_session: &ConnectedSshSession,
    destination_sftp: &SftpSession,
    task: &TransferTask,
    control: &TransferControl,
    on_event: &(dyn Fn(TransferRuntimeEvent) + Send + Sync),
) -> Result<u64, AppError> {
    let destination_path = task
        .destination_remote_path
        .as_deref()
        .ok_or_else(invalid_remote_path_error)?;
    if task.remote_path.is_empty() || destination_path.is_empty() || task.remote_path.contains('\0')
    {
        return Err(invalid_remote_path_error());
    }
    if task.remote_path.len() > 4_096 || destination_path.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }

    let source_metadata = remote_transfer_metadata(source_sftp, &task.remote_path)
        .await?
        .ok_or_else(|| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
    if source_metadata.is_symlink() {
        return Err(directory_tree_unsupported_error());
    }
    if source_metadata.is_regular() {
        return relay_regular_file(
            source_session,
            source_sftp,
            destination_session,
            destination_sftp,
            task,
            destination_path,
            &source_metadata,
            control,
            on_event,
        )
        .await;
    }
    if source_metadata.is_dir() {
        return relay_directory(
            source_session,
            source_sftp,
            destination_session,
            destination_sftp,
            task,
            destination_path,
            control,
            on_event,
        )
        .await;
    }
    Err(directory_tree_unsupported_error())
}

#[allow(clippy::too_many_arguments)]
async fn relay_regular_file(
    source_session: &ConnectedSshSession,
    source_sftp: &SftpSession,
    destination_session: &ConnectedSshSession,
    destination_sftp: &SftpSession,
    task: &TransferTask,
    destination_remote_path: &str,
    source_metadata: &FileAttributes,
    control: &TransferControl,
    on_event: &(dyn Fn(TransferRuntimeEvent) + Send + Sync),
) -> Result<u64, AppError> {
    let initial_target =
        canonical_remote_transfer_target(destination_sftp, destination_remote_path).await?;
    if std::ptr::eq(source_session, destination_session)
        && let Ok(canonical_source) = source_sftp.canonicalize(task.remote_path.clone()).await
        && canonical_source == initial_target
    {
        return Err(invalid_remote_path_error());
    }

    let source_size = source_metadata.size;
    let source_mtime_ms = file_attributes_mtime_ms(source_metadata);
    let staged_len = if let Some(staging) = task.staging_path.as_deref() {
        match remote_transfer_metadata(destination_sftp, staging).await? {
            Some(metadata) if !metadata.is_symlink() && metadata.is_regular() => metadata.size,
            _ => None,
        }
    } else {
        None
    };

    let plan = evaluate_resume_plan(task, source_size, source_mtime_ms, staged_len);
    let (staging_path, resume_offset, target, exists_at_start) = match plan {
        ResumePlan::IdentityChanged => {
            on_event(TransferRuntimeEvent::IdentityChanged);
            return Err(transfer_identity_changed_error());
        }
        ResumePlan::ResumeFromOffset { offset } => {
            let Some(staging) = task.staging_path.clone() else {
                return Err(transfer_io_error(
                    "TRANSFER_STAGING_MISSING",
                    "errors.sftpFailed",
                ));
            };
            let mut target = initial_target;
            let exists = destination_sftp
                .try_exists(target.clone())
                .await
                .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
            if exists {
                match task.conflict_policy {
                    ConflictPolicy::Ask => return Err(transfer_conflict_error()),
                    ConflictPolicy::Skip => {
                        let _ = destination_sftp.remove_file(staging).await;
                        return Ok(0);
                    }
                    ConflictPolicy::Overwrite => {}
                    ConflictPolicy::Rename => {
                        target = unique_remote_path(destination_sftp, &target).await?;
                    }
                }
            }
            (staging, offset, target, exists)
        }
        ResumePlan::FreshStart | ResumePlan::RestartFromBeginning => {
            let mut target = initial_target;
            let exists = destination_sftp
                .try_exists(target.clone())
                .await
                .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
            if exists {
                match task.conflict_policy {
                    ConflictPolicy::Ask => return Err(transfer_conflict_error()),
                    ConflictPolicy::Skip => return Ok(0),
                    ConflictPolicy::Overwrite => {}
                    ConflictPolicy::Rename => {
                        target = unique_remote_path(destination_sftp, &target).await?;
                    }
                }
            }
            let staging = match task.staging_path.clone() {
                Some(existing) if existing.len() <= 4_096 => existing,
                Some(_) => return Err(directory_tree_limit_error()),
                None => bounded_relay_staging_path(&target, &task.id)?,
            };
            (staging, 0, target, exists)
        }
    };

    on_event(TransferRuntimeEvent::Metadata {
        source_size_bytes: source_size,
        source_mtime_ms,
        staging_path: Some(staging_path.clone()),
        resume_state: TransferResumeState::SafeToResume,
    });
    control.set_bytes_transferred(resume_offset);
    on_event(TransferRuntimeEvent::Progress {
        bytes_transferred: resume_offset,
        total_bytes: source_size,
    });

    let forward_progress = |bytes, _| {
        on_event(TransferRuntimeEvent::Progress {
            bytes_transferred: bytes,
            total_bytes: source_size,
        });
    };

    let transfer_result = async {
        let mut source_file = source_sftp
            .open(task.remote_path.clone())
            .await
            .map_err(|_| transfer_io_error("SFTP_OPEN_FAILED", "errors.sftpFailed"))?;
        let mut dest_file = if resume_offset > 0 {
            source_file
                .seek(SeekFrom::Start(resume_offset))
                .await
                .map_err(|_| transfer_io_error("SFTP_SEEK_FAILED", "errors.sftpFailed"))?;
            let mut handle = destination_sftp
                .open_with_flags(staging_path.clone(), OpenFlags::WRITE)
                .await
                .map_err(|_| transfer_io_error("SFTP_OPEN_FAILED", "errors.sftpFailed"))?;
            handle
                .seek(SeekFrom::Start(resume_offset))
                .await
                .map_err(|_| transfer_io_error("SFTP_SEEK_FAILED", "errors.sftpFailed"))?;
            handle
        } else {
            destination_sftp
                .open_with_flags(
                    staging_path.clone(),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(|_| transfer_io_error("SFTP_CREATE_FAILED", "errors.sftpFailed"))?
        };

        let copied = copy_transfer_stream(
            &mut source_file,
            &mut dest_file,
            control,
            &forward_progress,
            resume_offset,
        )
        .await?;
        let _ = source_file.close().await;
        dest_file.flush().await.map_err(|_| {
            transfer_io_error("TRANSFER_STREAM_FAILED", "errors.transferStreamFailed")
        })?;
        dest_file
            .close()
            .await
            .map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;

        let staged_meta = remote_transfer_metadata(destination_sftp, &staging_path)
            .await?
            .ok_or_else(|| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
        let staged_size = staged_meta
            .size
            .ok_or_else(|| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
        if let Some(expected_size) = source_size
            && staged_size != expected_size
        {
            return Err(transfer_size_mismatch_error());
        }

        let recheck = source_sftp
            .symlink_metadata(task.remote_path.clone())
            .await
            .map_err(|_| transfer_identity_changed_error())?;
        let recheck_mtime_ms = file_attributes_mtime_ms(&recheck);
        if recheck.is_symlink()
            || !recheck.is_regular()
            || !source_identity_matches(
                source_size,
                source_mtime_ms,
                recheck.size,
                recheck_mtime_ms,
            )
        {
            on_event(TransferRuntimeEvent::IdentityChanged);
            return Err(transfer_identity_changed_error());
        }

        control.begin_commit().await?;
        let commit_result = async {
            let mut commit_target = target.clone();
            let now_exists = destination_sftp
                .try_exists(commit_target.clone())
                .await
                .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
            if now_exists && !exists_at_start {
                match task.conflict_policy {
                    ConflictPolicy::Ask => return Err(transfer_conflict_error()),
                    ConflictPolicy::Skip => {
                        let _ = destination_sftp.remove_file(staging_path.clone()).await;
                        return Ok(false);
                    }
                    ConflictPolicy::Overwrite => {}
                    ConflictPolicy::Rename => {
                        commit_target =
                            unique_remote_path(destination_sftp, &commit_target).await?;
                    }
                }
            }
            let overwrite_existing = exists_at_start
                || (now_exists && task.conflict_policy == ConflictPolicy::Overwrite);
            atomic_commit_remote_file(
                destination_sftp,
                &staging_path,
                &commit_target,
                overwrite_existing,
            )
            .await?;
            Ok(true)
        }
        .await;
        control.end_commit()?;
        let committed = commit_result?;
        if !committed {
            return Ok(0);
        }
        Ok(staged_size.max(resume_offset.saturating_add(copied)))
    }
    .await;

    if let Err(ref error) = transfer_result
        && !should_preserve_staging_on_error(error)
    {
        let _ = destination_sftp.remove_file(staging_path).await;
    }
    transfer_result
}

#[allow(clippy::too_many_arguments)]
async fn relay_directory(
    source_session: &ConnectedSshSession,
    source_sftp: &SftpSession,
    destination_session: &ConnectedSshSession,
    destination_sftp: &SftpSession,
    task: &TransferTask,
    destination_remote_path: &str,
    control: &TransferControl,
    on_event: &(dyn Fn(TransferRuntimeEvent) + Send + Sync),
) -> Result<u64, AppError> {
    let mut target_root =
        canonical_remote_transfer_target(destination_sftp, destination_remote_path).await?;
    if std::ptr::eq(source_session, destination_session)
        && let Ok(canonical_source) = source_sftp.canonicalize(task.remote_path.clone()).await
        && remote_paths_overlap(&canonical_source, &target_root)
    {
        return Err(invalid_remote_path_error());
    }

    let root_metadata = remote_transfer_metadata(destination_sftp, &target_root).await?;
    let mut merge_existing = false;
    if let Some(metadata) = root_metadata.as_ref() {
        if metadata.is_symlink() {
            return Err(directory_tree_unsupported_error());
        }
        match task.conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite if metadata.is_dir() => merge_existing = true,
            ConflictPolicy::Overwrite => return Err(directory_tree_unsupported_error()),
            ConflictPolicy::Rename => {
                target_root = unique_remote_path(destination_sftp, &target_root).await?;
            }
        }
    }

    let directory_reader = source_session
        .open_sftp_directory_reader()
        .await
        .map_err(|_| transfer_io_error("SFTP_LIST_FAILED", "errors.sftpFailed"))?;
    let scan_result =
        scan_remote_transfer_tree(&directory_reader, &task.remote_path, Some(control), None).await;
    let close_result = directory_reader.close();
    let entries = scan_result?;
    close_result.map_err(|_| transfer_io_error("SFTP_LIST_FAILED", "errors.sftpFailed"))?;

    let all_sizes_known = entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .all(|entry| entry.size.is_some());
    let total_size = if all_sizes_known {
        Some(
            entries
                .iter()
                .filter(|entry| !entry.is_directory)
                .try_fold(0_u64, |total, entry| {
                    total
                        .checked_add(entry.size.unwrap_or(0))
                        .ok_or_else(directory_tree_limit_error)
                })?,
        )
    } else {
        None
    };

    on_event(TransferRuntimeEvent::Metadata {
        source_size_bytes: total_size,
        source_mtime_ms: None,
        staging_path: None,
        resume_state: TransferResumeState::RestartFromBeginning,
    });
    if let Some(total) = total_size {
        on_event(TransferRuntimeEvent::Progress {
            bytes_transferred: control.bytes_transferred(),
            total_bytes: Some(total),
        });
    }

    let staging_root = if merge_existing {
        None
    } else {
        let (parent, _) = split_remote_parent(&target_root)?;
        let path = join_remote_directory_path(
            parent,
            &format!(".filex-transfer-{}", uuid::Uuid::new_v4()),
        );
        if path.len() > 4_096 {
            return Err(directory_tree_limit_error());
        }
        if remote_transfer_metadata(destination_sftp, &path)
            .await?
            .is_some()
        {
            return Err(transfer_conflict_error());
        }
        Some(path)
    };
    let write_root = staging_root.as_deref().unwrap_or(&target_root);

    let result = async {
        if merge_existing {
            validate_remote_relay_destinations(
                destination_sftp,
                &target_root,
                &entries,
                &task.conflict_policy,
                control,
            )
            .await?;
        }
        ensure_remote_transfer_directory(destination_sftp, write_root).await?;

        let forward_progress = |bytes, _| {
            on_event(TransferRuntimeEvent::Progress {
                bytes_transferred: bytes,
                total_bytes: total_size,
            });
        };

        let mut total_bytes = 0_u64;
        for entry in &entries {
            control.wait_until_running().await?;
            let destination_entry = remote_transfer_child_path(write_root, &entry.relative_path);
            if entry.is_directory {
                ensure_remote_transfer_directory(destination_sftp, &destination_entry).await?;
                continue;
            }
            let copied = relay_directory_file(
                source_sftp,
                destination_sftp,
                &entry.remote_path,
                &destination_entry,
                &task.conflict_policy,
                control,
                &forward_progress,
                total_bytes,
            )
            .await?;
            total_bytes = total_bytes.saturating_add(copied);
        }

        if let Some(staging) = staging_root.as_deref() {
            control.begin_commit().await?;
            let commit_result = async {
                let mut final_target = target_root.clone();
                if let Some(existing) =
                    remote_transfer_metadata(destination_sftp, &final_target).await?
                {
                    if existing.is_symlink() {
                        return Err(directory_tree_unsupported_error());
                    }
                    match task.conflict_policy {
                        ConflictPolicy::Ask => return Err(transfer_conflict_error()),
                        ConflictPolicy::Skip => {
                            let _ =
                                remove_remote_tree(destination_session, destination_sftp, staging)
                                    .await;
                            return Ok(false);
                        }
                        ConflictPolicy::Overwrite => return Err(transfer_conflict_error()),
                        ConflictPolicy::Rename => {
                            final_target =
                                unique_remote_path(destination_sftp, &final_target).await?;
                        }
                    }
                }
                destination_sftp
                    .rename(staging.to_owned(), final_target)
                    .await
                    .map_err(|_| transfer_io_error("SFTP_COMMIT_FAILED", "errors.sftpFailed"))?;
                Ok(true)
            }
            .await;
            control.end_commit()?;
            if !commit_result? {
                return Ok(0);
            }
        }
        Ok(total_bytes)
    }
    .await;

    if result.is_err()
        && let Some(staging) = staging_root.as_deref()
    {
        let _ = remove_remote_tree(destination_session, destination_sftp, staging).await;
    }
    result
}

async fn validate_remote_relay_destinations(
    sftp: &SftpSession,
    target_root: &str,
    entries: &[RemoteTransferEntry],
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
) -> Result<(), AppError> {
    for entry in entries {
        validate_remote_transfer_destination_path(
            sftp,
            target_root,
            &entry.relative_path,
            entry.is_directory,
            conflict_policy,
            control,
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn relay_directory_file(
    source_sftp: &SftpSession,
    destination_sftp: &SftpSession,
    source_path: &str,
    requested_target: &str,
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    base_bytes: u64,
) -> Result<u64, AppError> {
    let mut target = requested_target.to_owned();
    let existing = remote_transfer_metadata(destination_sftp, &target).await?;
    let mut overwrite_existing = false;
    if let Some(metadata) = existing {
        if metadata.is_symlink() || !metadata.is_regular() {
            return Err(directory_tree_unsupported_error());
        }
        match conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite => overwrite_existing = true,
            ConflictPolicy::Rename => {
                target = unique_remote_path(destination_sftp, &target).await?
            }
        }
    }

    let (parent, _) = split_remote_parent(&target)?;
    let temporary =
        join_remote_directory_path(parent, &format!(".filex-part-{}", uuid::Uuid::new_v4()));
    if temporary.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }

    let mut source_file = source_sftp
        .open(source_path.to_owned())
        .await
        .map_err(|_| transfer_io_error("SFTP_OPEN_FAILED", "errors.sftpFailed"))?;
    let mut dest_file = destination_sftp
        .open_with_flags(
            temporary.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|_| transfer_io_error("SFTP_CREATE_FAILED", "errors.sftpFailed"))?;

    let stream_result = copy_transfer_stream(
        &mut source_file,
        &mut dest_file,
        control,
        on_progress,
        base_bytes,
    )
    .await;
    let _ = source_file.close().await;
    let bytes = match stream_result {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = dest_file.close().await;
            let _ = destination_sftp.remove_file(temporary).await;
            return Err(error);
        }
    };
    if dest_file.flush().await.is_err() {
        let _ = dest_file.close().await;
        let _ = destination_sftp.remove_file(temporary).await;
        return Err(transfer_io_error(
            "TRANSFER_STREAM_FAILED",
            "errors.transferStreamFailed",
        ));
    }
    if dest_file.close().await.is_err() {
        let _ = destination_sftp.remove_file(temporary).await;
        return Err(transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"));
    }

    control.begin_commit().await?;
    let commit_result = async {
        if !overwrite_existing
            && let Some(metadata) = remote_transfer_metadata(destination_sftp, &target).await?
        {
            if metadata.is_symlink() || !metadata.is_regular() {
                return Err(directory_tree_unsupported_error());
            }
            match conflict_policy {
                ConflictPolicy::Ask => return Err(transfer_conflict_error()),
                ConflictPolicy::Skip => return Ok(false),
                ConflictPolicy::Overwrite => overwrite_existing = true,
                ConflictPolicy::Rename => {
                    target = unique_remote_path(destination_sftp, &target).await?;
                }
            }
        }
        atomic_commit_remote_file(destination_sftp, &temporary, &target, overwrite_existing)
            .await?;
        Ok(true)
    }
    .await;
    control.end_commit()?;
    match commit_result {
        Ok(true) => Ok(bytes),
        Ok(false) => {
            let _ = destination_sftp.remove_file(temporary).await;
            Ok(0)
        }
        Err(error) => {
            let _ = destination_sftp.remove_file(temporary).await;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_relay_staging_path, remote_paths_overlap};

    #[test]
    fn remote_paths_overlap_rejects_self_and_descendants() {
        assert!(remote_paths_overlap("/var/app", "/var/app"));
        assert!(remote_paths_overlap("/var/app/", "/var/app/releases/v1"));
        assert!(remote_paths_overlap("/", "/var/app"));
        assert!(!remote_paths_overlap("/var/app", "/var/app-backup"));
        assert!(!remote_paths_overlap("/srv/a", "/srv/b"));
    }

    #[test]
    fn bounded_relay_staging_path_stays_deterministic_and_bounded() {
        let staging = bounded_relay_staging_path("/var/data/archive.tar.gz", "relay-123")
            .expect("valid path");
        assert_eq!(staging, "/var/data/archive.tar.gz.filex-part-relay-123");
        let too_long = format!("/{}", "a".repeat(4090));
        assert!(bounded_relay_staging_path(&too_long, "relay-123").is_err());
    }
}
