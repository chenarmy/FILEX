pub(crate) mod commands {
    use filex_contracts::{OperationResult, ProfileCommandHistoryEntry};
    use filex_core::CommandHistoryService;
    use tauri::State;

    #[tauri::command]
    pub(crate) fn list_profile_command_history(
        profile_id: String,
        history: State<'_, CommandHistoryService>,
    ) -> OperationResult<Vec<ProfileCommandHistoryEntry>> {
        match history.list(&profile_id) {
            Ok(entries) => OperationResult::success(entries),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn append_profile_command_history(
        profile_id: String,
        command: String,
        history: State<'_, CommandHistoryService>,
    ) -> OperationResult<Option<ProfileCommandHistoryEntry>> {
        match history.record(&profile_id, &command) {
            Ok(entry) => OperationResult::success(entry),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn delete_profile_command_history_entry(
        profile_id: String,
        entry_id: String,
        history: State<'_, CommandHistoryService>,
    ) -> OperationResult<bool> {
        match history.delete_entry(&profile_id, &entry_id) {
            Ok(deleted) => OperationResult::success(deleted),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn clear_profile_command_history(
        profile_id: String,
        history: State<'_, CommandHistoryService>,
    ) -> OperationResult<()> {
        match history.clear_profile(&profile_id) {
            Ok(()) => OperationResult::success(()),
            Err(error) => OperationResult::failure(error),
        }
    }
}
