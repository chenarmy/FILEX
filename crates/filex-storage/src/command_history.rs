use filex_contracts::{AppError, ProfileCommandHistoryEntry};
use filex_core::CommandHistoryRepository;
use rusqlite::params;

use crate::{SqliteProfileRepository, storage_error};

fn map_history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProfileCommandHistoryEntry> {
    Ok(ProfileCommandHistoryEntry {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        command: row.get(2)?,
        created_at_ms: row.get(3)?,
    })
}

impl CommandHistoryRepository for SqliteProfileRepository {
    fn list_for_profile(
        &self,
        profile_id: &str,
    ) -> Result<Vec<ProfileCommandHistoryEntry>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"
                SELECT id, profile_id, command, created_at_ms
                FROM profile_command_history
                WHERE profile_id = ?1
                ORDER BY created_at_ms DESC, rowid DESC
                "#,
            )
            .map_err(|_| storage_error("DATABASE_QUERY_FAILED"))?;
        let rows = statement
            .query_map([profile_id], map_history_row)
            .map_err(|_| storage_error("DATABASE_QUERY_FAILED"))?;
        let mut list = Vec::new();
        for row in rows {
            list.push(row.map_err(|_| storage_error("DATABASE_QUERY_FAILED"))?);
        }
        Ok(list)
    }

    fn upsert_and_prune(
        &self,
        entry: &ProfileCommandHistoryEntry,
        limit: usize,
    ) -> Result<ProfileCommandHistoryEntry, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;

        transaction
            .execute(
                r#"
                DELETE FROM profile_command_history
                WHERE profile_id = ?1 AND command = ?2
                "#,
                params![entry.profile_id, entry.command],
            )
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;

        transaction
            .execute(
                r#"
                INSERT INTO profile_command_history (id, profile_id, command, created_at_ms)
                VALUES (?1, ?2, ?3, ?4)
                "#,
                params![
                    entry.id,
                    entry.profile_id,
                    entry.command,
                    entry.created_at_ms
                ],
            )
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;

        transaction
            .execute(
                r#"
                DELETE FROM profile_command_history
                WHERE profile_id = ?1
                  AND id NOT IN (
                      SELECT id FROM profile_command_history
                      WHERE profile_id = ?1
                      ORDER BY created_at_ms DESC, rowid DESC
                      LIMIT ?2
                  )
                "#,
                params![entry.profile_id, limit as i64],
            )
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;

        transaction
            .commit()
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;

        Ok(entry.clone())
    }

    fn delete_entry(&self, profile_id: &str, entry_id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let affected = connection
            .execute(
                "DELETE FROM profile_command_history WHERE profile_id = ?1 AND id = ?2",
                params![profile_id, entry_id],
            )
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;
        Ok(affected > 0)
    }

    fn clear_profile(&self, profile_id: &str) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                "DELETE FROM profile_command_history WHERE profile_id = ?1",
                [profile_id],
            )
            .map_err(|_| storage_error("DATABASE_WRITE_FAILED"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::{AuthenticationMethod, CreateConnectionProfileInput, EnvironmentKind};
    use filex_core::{CommandHistoryRepository, CommandHistoryService, ProfileRepository};

    use super::*;

    fn create_test_profile(repo: &SqliteProfileRepository, name: &str) -> String {
        let profile = filex_contracts::ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_owned(),
            group: "Ops".to_owned(),
            host: "10.0.0.10".to_owned(),
            port: 22,
            username: "ops".to_owned(),
            environment: EnvironmentKind::Production,
            tags: Vec::new(),
            authentication_method: AuthenticationMethod::Password,
            identity_file: None,
            key_id: None,
            proxy_profile_id: None,
            proxy_jump: None,
            proxy_jump_profile_ids: Vec::new(),
            favorite: false,
            credential_ref: None,
            state: filex_contracts::ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
        };
        let _input: Option<CreateConnectionProfileInput> = None;
        ProfileRepository::insert(repo, &profile).expect("profile");
        profile.id
    }

    #[test]
    fn sqlite_history_deduplicates_prunes_to_200_and_cascades_on_profile_delete() {
        let repo = std::sync::Arc::new(SqliteProfileRepository::open_in_memory().expect("db"));
        let service = CommandHistoryService::new(repo.clone());
        let profile_id = create_test_profile(&repo, "node-a");

        for idx in 0..205 {
            repo.upsert_and_prune(
                &ProfileCommandHistoryEntry {
                    id: format!("cmd-{idx}"),
                    profile_id: profile_id.clone(),
                    command: format!("echo step-{idx}"),
                    created_at_ms: 1_000 + idx,
                },
                filex_core::MAX_PROFILE_COMMAND_HISTORY_ENTRIES,
            )
            .expect("insert");
        }

        let listed = service.list(&profile_id).expect("list");
        assert_eq!(listed.len(), 200);
        assert_eq!(listed.first().expect("first").command, "echo step-204");
        assert_eq!(listed.last().expect("last").command, "echo step-5");

        // Re-inserting an older command promotes it to newest without duplicating.
        repo.upsert_and_prune(
            &ProfileCommandHistoryEntry {
                id: "cmd-dup".to_owned(),
                profile_id: profile_id.clone(),
                command: "echo step-10".to_owned(),
                created_at_ms: 5_000,
            },
            filex_core::MAX_PROFILE_COMMAND_HISTORY_ENTRIES,
        )
        .expect("dedup");
        let after_dedup = service.list(&profile_id).expect("dedup list");
        assert_eq!(after_dedup.len(), 200);
        assert_eq!(
            after_dedup.first().expect("promoted").command,
            "echo step-10"
        );

        // Deleting the profile cascades to remove its command history.
        repo.delete(&profile_id).expect("delete profile");
        assert!(
            service
                .list(&profile_id)
                .expect("empty after cascade")
                .is_empty()
        );
    }
}
