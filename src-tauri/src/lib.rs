use filex_contracts::{ConnectionProfile, CreateConnectionProfileInput, OperationResult};
use filex_core::ProfileCatalog;
use tauri::State;

#[tauri::command]
fn list_connection_profiles(
    catalog: State<'_, ProfileCatalog>,
) -> OperationResult<Vec<ConnectionProfile>> {
    match catalog.list() {
        Ok(profiles) => OperationResult::success(profiles),
        Err(error) => OperationResult::failure(error),
    }
}

#[tauri::command]
fn create_connection_profile(
    catalog: State<'_, ProfileCatalog>,
    input: CreateConnectionProfileInput,
) -> OperationResult<ConnectionProfile> {
    match catalog.create(input) {
        Ok(profile) => OperationResult::success(profile),
        Err(error) => OperationResult::failure(error),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProfileCatalog::default())
        .invoke_handler(tauri::generate_handler![
            list_connection_profiles,
            create_connection_profile
        ])
        .run(tauri::generate_context!())
        .expect("failed to run FILEX desktop application");
}
