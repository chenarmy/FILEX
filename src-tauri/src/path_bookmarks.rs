pub(crate) mod commands {
    use filex_contracts::{CreatePathBookmarkInput, OperationResult, PathBookmark};
    use filex_core::PathBookmarkService;
    use tauri::State;

    #[tauri::command]
    pub(crate) fn list_path_bookmarks(
        profile_id: String,
        service: State<'_, PathBookmarkService>,
    ) -> OperationResult<Vec<PathBookmark>> {
        match service.list(&profile_id) {
            Ok(entries) => OperationResult::success(entries),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn save_path_bookmark(
        input: CreatePathBookmarkInput,
        service: State<'_, PathBookmarkService>,
    ) -> OperationResult<PathBookmark> {
        match service.save(input) {
            Ok(entry) => OperationResult::success(entry),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn delete_path_bookmark(
        profile_id: String,
        bookmark_id: String,
        service: State<'_, PathBookmarkService>,
    ) -> OperationResult<bool> {
        match service.delete(&profile_id, &bookmark_id) {
            Ok(deleted) => OperationResult::success(deleted),
            Err(error) => OperationResult::failure(error),
        }
    }
}
