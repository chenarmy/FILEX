use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use filex_contracts::{AppError, RemoteState, TransferState, TransferTask};
use filex_core::{ProfileRepository, TransferRepository};
use filex_storage::SqliteProfileRepository;

const MAX_TRANSIENT_TRANSFERS: usize = 200;

/// Routes durable-profile transfers to SQLite and transient quick/bastion session transfers
/// to a bounded in-memory store so quick sessions can upload/download without polluting SQLite.
pub(crate) struct HybridTransferRepository {
    persistent: Arc<SqliteProfileRepository>,
    transient: Mutex<HashMap<String, TransferTask>>,
}

impl HybridTransferRepository {
    pub(crate) fn new(persistent: Arc<SqliteProfileRepository>) -> Self {
        Self {
            persistent,
            transient: Mutex::new(HashMap::new()),
        }
    }

    fn is_persistent_profile(&self, profile_id: &str) -> Result<bool, AppError> {
        Ok(ProfileRepository::get(self.persistent.as_ref(), profile_id)?.is_some())
    }

    fn should_persist(&self, task: &TransferTask) -> Result<bool, AppError> {
        if !self.is_persistent_profile(&task.profile_id)? {
            return Ok(false);
        }
        if let Some(dest_id) = task.destination_profile_id.as_deref()
            && !self.is_persistent_profile(dest_id)?
        {
            return Ok(false);
        }
        Ok(true)
    }
}

impl TransferRepository for HybridTransferRepository {
    fn list(&self) -> Result<Vec<TransferTask>, AppError> {
        let mut tasks = TransferRepository::list(self.persistent.as_ref())?;
        let transient = self
            .transient
            .lock()
            .map_err(|_| transient_transfer_lock_error())?;
        tasks.extend(transient.values().cloned());
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at_ms));
        Ok(tasks)
    }

    fn get(&self, id: &str) -> Result<Option<TransferTask>, AppError> {
        if let Some(task) = self
            .transient
            .lock()
            .map_err(|_| transient_transfer_lock_error())?
            .get(id)
            .cloned()
        {
            return Ok(Some(task));
        }
        TransferRepository::get(self.persistent.as_ref(), id)
    }

    fn insert(&self, task: &TransferTask) -> Result<(), AppError> {
        if self.should_persist(task)? {
            return TransferRepository::insert(self.persistent.as_ref(), task);
        }
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| transient_transfer_lock_error())?;
        while transient.len() >= MAX_TRANSIENT_TRANSFERS {
            let evict_id = transient
                .values()
                .filter(|item| is_terminal_state(&item.state))
                .min_by_key(|item| item.updated_at_ms)
                .or_else(|| transient.values().min_by_key(|item| item.created_at_ms))
                .map(|item| item.id.clone());
            if let Some(evict_id) = evict_id {
                transient.remove(&evict_id);
            } else {
                break;
            }
        }
        transient.insert(task.id.clone(), task.clone());
        Ok(())
    }

    fn update(&self, task: &TransferTask) -> Result<(), AppError> {
        {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| transient_transfer_lock_error())?;
            if let Some(existing) = transient.get_mut(&task.id) {
                *existing = task.clone();
                return Ok(());
            }
        }
        TransferRepository::update(self.persistent.as_ref(), task)
    }

    fn delete_terminal_transfers(&self) -> Result<u64, AppError> {
        let persistent_deleted =
            TransferRepository::delete_terminal_transfers(self.persistent.as_ref())?;
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| transient_transfer_lock_error())?;
        let before = transient.len();
        transient.retain(|_, task| !is_terminal_state(&task.state));
        let transient_deleted = u64::try_from(before.saturating_sub(transient.len())).unwrap_or(0);
        Ok(persistent_deleted.saturating_add(transient_deleted))
    }
}

fn is_terminal_state(state: &TransferState) -> bool {
    matches!(
        state,
        TransferState::Completed | TransferState::Failed | TransferState::Cancelled
    )
}

fn transient_transfer_lock_error() -> AppError {
    AppError {
        code: "TRANSFER_STORAGE_LOCK_FAILED".to_owned(),
        message_key: "errors.transferStorageFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use filex_contracts::{ConflictPolicy, CreateTransferInput, TransferDirection, TransferState};
    use filex_core::{TransferRepository, TransferService};
    use filex_storage::SqliteProfileRepository;

    use super::HybridTransferRepository;

    #[test]
    fn stores_quick_session_transfers_in_memory_without_polluting_sqlite() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("filex.sqlite3");
        let sqlite = Arc::new(SqliteProfileRepository::open(&db_path).expect("open sqlite"));
        let hybrid = Arc::new(HybridTransferRepository::new(sqlite.clone()));
        let service = TransferService::new(hybrid.clone());

        let task = service
            .enqueue(CreateTransferInput {
                profile_id: "quick-profile-uuid".to_owned(),
                direction: TransferDirection::Upload,
                local_path: "C:\\tmp\\report.txt".to_owned(),
                remote_path: "/home/cudp/report.txt".to_owned(),
                destination_profile_id: None,
                destination_remote_path: None,
                conflict_policy: ConflictPolicy::Ask,
                total_bytes: Some(128),
            })
            .expect("enqueue transient transfer");

        assert_eq!(task.state, TransferState::Queued);
        assert_eq!(service.list().expect("list hybrid").len(), 1);
        assert!(
            TransferRepository::list(sqlite.as_ref())
                .expect("list sqlite")
                .is_empty()
        );

        let running = service
            .start(&task.id, "quick-session-1")
            .expect("start transient transfer");
        assert_eq!(running.state, TransferState::Running);

        let completed = service
            .complete(&task.id, 128)
            .expect("complete transient transfer");
        assert_eq!(completed.state, TransferState::Completed);

        let remaining = service.clear_completed().expect("clear completed");
        assert!(remaining.is_empty());
        assert!(service.list().expect("list after clear").is_empty());
    }
}
