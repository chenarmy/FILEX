use filex_contracts::{AppError, PathBookmark};
use filex_core::PathBookmarkRepository;
use rusqlite::params;

use crate::{SqliteProfileRepository, storage_error};

impl PathBookmarkRepository for SqliteProfileRepository {
    fn list_bookmarks(&self, profile_id: &str) -> Result<Vec<PathBookmark>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, profile_id, side, label, path, created_at_ms
                   FROM path_bookmarks
                   WHERE profile_id = ?1
                   ORDER BY created_at_ms DESC, label COLLATE NOCASE ASC"#,
            )
            .map_err(|_| storage_error("BOOKMARK_QUERY_FAILED"))?;
        statement
            .query_map([profile_id], |row| {
                Ok(PathBookmark {
                    id: row.get(0)?,
                    profile_id: row.get(1)?,
                    side: row.get(2)?,
                    label: row.get(3)?,
                    path: row.get(4)?,
                    created_at_ms: row.get(5)?,
                })
            })
            .map_err(|_| storage_error("BOOKMARK_QUERY_FAILED"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("BOOKMARK_QUERY_FAILED"))
    }

    fn upsert_bookmark(
        &self,
        bookmark: &PathBookmark,
        max_per_side: usize,
    ) -> Result<PathBookmark, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let tx = connection
            .transaction()
            .map_err(|_| storage_error("BOOKMARK_WRITE_FAILED"))?;
        tx.execute(
            r#"INSERT INTO path_bookmarks (id, profile_id, side, label, path, created_at_ms)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(profile_id, side, path) DO UPDATE SET
                   label = excluded.label,
                   created_at_ms = excluded.created_at_ms"#,
            params![
                bookmark.id,
                bookmark.profile_id,
                bookmark.side,
                bookmark.label,
                bookmark.path,
                bookmark.created_at_ms,
            ],
        )
        .map_err(|_| storage_error("BOOKMARK_WRITE_FAILED"))?;

        let limit = i64::try_from(max_per_side).unwrap_or(50);
        tx.execute(
            r#"DELETE FROM path_bookmarks
               WHERE profile_id = ?1 AND side = ?2
                 AND id NOT IN (
                     SELECT id FROM path_bookmarks
                     WHERE profile_id = ?1 AND side = ?2
                     ORDER BY created_at_ms DESC, rowid DESC
                     LIMIT ?3
                 )"#,
            params![bookmark.profile_id, bookmark.side, limit],
        )
        .map_err(|_| storage_error("BOOKMARK_WRITE_FAILED"))?;

        let stored = tx
            .query_row(
                r#"SELECT id, profile_id, side, label, path, created_at_ms
                   FROM path_bookmarks
                   WHERE profile_id = ?1 AND side = ?2 AND path = ?3"#,
                params![bookmark.profile_id, bookmark.side, bookmark.path],
                |row| {
                    Ok(PathBookmark {
                        id: row.get(0)?,
                        profile_id: row.get(1)?,
                        side: row.get(2)?,
                        label: row.get(3)?,
                        path: row.get(4)?,
                        created_at_ms: row.get(5)?,
                    })
                },
            )
            .map_err(|_| storage_error("BOOKMARK_QUERY_FAILED"))?;
        tx.commit()
            .map_err(|_| storage_error("BOOKMARK_WRITE_FAILED"))?;
        Ok(stored)
    }

    fn delete_bookmark(&self, profile_id: &str, bookmark_id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let deleted = connection
            .execute(
                "DELETE FROM path_bookmarks WHERE profile_id = ?1 AND id = ?2",
                params![profile_id, bookmark_id],
            )
            .map_err(|_| storage_error("BOOKMARK_WRITE_FAILED"))?;
        Ok(deleted > 0)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use filex_contracts::{
        AuthenticationMethod, ConnectionProfile, ConnectionState, CreatePathBookmarkInput,
        EnvironmentKind,
    };
    use filex_core::{PathBookmarkService, ProfileRepository};

    use crate::SqliteProfileRepository;

    fn sample_profile(id: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_owned(),
            name: "Bookmark host".to_owned(),
            group: "Ops".to_owned(),
            host: "10.0.0.8".to_owned(),
            port: 22,
            username: "deploy".to_owned(),
            environment: EnvironmentKind::Production,
            tags: Vec::new(),
            authentication_method: AuthenticationMethod::Agent,
            identity_file: None,
            key_id: None,
            proxy_jump: None,
            proxy_jump_profile_ids: Vec::new(),
            proxy_profile_id: None,
            favorite: false,
            last_used_at: None,
            credential_ref: None,
            state: ConnectionState::Idle,
            latency_ms: None,
        }
    }

    #[test]
    fn sqlite_bookmarks_deduplicate_persist_and_cascade_on_profile_delete() {
        let repo = Arc::new(SqliteProfileRepository::open_in_memory().expect("in-memory db"));
        let profile = sample_profile("prof-bookmark-1");
        ProfileRepository::insert(repo.as_ref(), &profile).expect("profile inserted");
        let service = PathBookmarkService::new(repo.clone());

        let first = service
            .save(CreatePathBookmarkInput {
                profile_id: profile.id.clone(),
                side: "remote".to_owned(),
                label: "Logs".to_owned(),
                path: "/var/log/nginx".to_owned(),
            })
            .expect("bookmark saved");
        let updated = service
            .save(CreatePathBookmarkInput {
                profile_id: profile.id.clone(),
                side: "remote".to_owned(),
                label: "Nginx Logs".to_owned(),
                path: "/var/log/nginx".to_owned(),
            })
            .expect("bookmark updated");
        assert_eq!(first.id, updated.id);
        assert_eq!(updated.label, "Nginx Logs");

        let local = service
            .save(CreatePathBookmarkInput {
                profile_id: profile.id.clone(),
                side: "local".to_owned(),
                label: "Artifacts".to_owned(),
                path: "C:\\builds".to_owned(),
            })
            .expect("local bookmark saved");
        assert_eq!(service.list(&profile.id).expect("lists").len(), 2);

        assert!(service.delete(&profile.id, &local.id).expect("deletes"));
        assert_eq!(service.list(&profile.id).expect("one left").len(), 1);

        ProfileRepository::delete(repo.as_ref(), &profile.id).expect("profile deleted");
        assert!(service.list(&profile.id).expect("cascaded").is_empty());
    }
}
