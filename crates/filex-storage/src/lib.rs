use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use filex_contracts::{
    AppError, AuthenticationMethod, ConflictPolicy, ConnectionProfile, ConnectionState,
    EnvironmentKind, HostTrustRecord, HostTrustSource, RemoteState, SafeSettings,
    TransferDirection, TransferState, TransferTask, TunnelKind, TunnelRule,
};
use filex_core::{
    HostTrustImportExpectation, HostTrustRepository, ProfileRepository, SettingsRepository, TransferRepository,
    TunnelRuleRepository,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params, types::Type};

const DEFAULT_WORKSPACE_ID: &str = "default";

struct Migration {
    version: i64,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: r#"
        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO workspaces (id, name) VALUES ('default', 'Infrastructure');

        CREATE TABLE connection_profiles (
            id TEXT PRIMARY KEY NOT NULL,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            group_name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
            username TEXT NOT NULL,
            environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'development')),
            favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
            credential_ref TEXT,
            last_used_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX connection_profiles_workspace_name
            ON connection_profiles(workspace_id, name COLLATE NOCASE);

        CREATE TABLE profile_tags (
            profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (profile_id, tag)
        );

        CREATE TABLE app_settings (
            key TEXT PRIMARY KEY NOT NULL,
            json_value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    },
    Migration {
        version: 2,
        sql: r#"
            ALTER TABLE connection_profiles
                ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'password'
                CHECK (authentication_method IN ('password', 'private_key', 'agent'));
            ALTER TABLE connection_profiles ADD COLUMN identity_file TEXT;
            ALTER TABLE connection_profiles ADD COLUMN proxy_jump TEXT;

            CREATE TABLE host_trust_records (
                id TEXT PRIMARY KEY NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
                algorithm TEXT NOT NULL,
                fingerprint_sha256 TEXT NOT NULL,
                previous_fingerprint_sha256 TEXT,
                source TEXT NOT NULL CHECK (source IN ('imported_known_hosts', 'filex_decision')),
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE INDEX host_trust_endpoint
                ON host_trust_records(host COLLATE NOCASE, port, algorithm, last_seen_at DESC);
        "#,
    },
    Migration {
        version: 3,
        sql: r#"
            CREATE TABLE transfer_tasks (
                id TEXT PRIMARY KEY NOT NULL,
                profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
                session_id TEXT,
                direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
                local_path TEXT NOT NULL,
                remote_path TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
                bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK (bytes_transferred >= 0),
                total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
                conflict_policy TEXT NOT NULL CHECK (conflict_policy IN ('ask', 'overwrite', 'skip', 'rename')),
                error_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE INDEX transfer_tasks_state_created
                ON transfer_tasks(state, created_at_ms);
        "#,
    },
    Migration {
        version: 4,
        sql: r#"
            CREATE TABLE tunnel_rules (
                id TEXT PRIMARY KEY NOT NULL,
                profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('local', 'dynamic')),
                bind_host TEXT NOT NULL,
                bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
                target_host TEXT,
                target_port INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
                CHECK ((kind = 'local' AND target_host IS NOT NULL AND target_port IS NOT NULL)
                    OR (kind = 'dynamic' AND target_host IS NULL AND target_port IS NULL))
            );

            CREATE INDEX tunnel_rules_profile_name
                ON tunnel_rules(profile_id, name COLLATE NOCASE);
        "#,
    },
    Migration {
        version: 5,
        sql: r#"
            ALTER TABLE tunnel_rules RENAME TO tunnel_rules_v4;

            CREATE TABLE tunnel_rules (
                id TEXT PRIMARY KEY NOT NULL,
                profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('local', 'dynamic', 'remote')),
                bind_host TEXT NOT NULL,
                bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
                target_host TEXT,
                target_port INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
                CHECK ((kind IN ('local', 'remote') AND target_host IS NOT NULL AND target_port IS NOT NULL)
                    OR (kind = 'dynamic' AND target_host IS NULL AND target_port IS NULL))
            );

            INSERT INTO tunnel_rules (id, profile_id, name, kind, bind_host, bind_port, target_host, target_port)
                SELECT id, profile_id, name, kind, bind_host, bind_port, target_host, target_port
                FROM tunnel_rules_v4;
            DROP TABLE tunnel_rules_v4;

            CREATE INDEX tunnel_rules_profile_name
                ON tunnel_rules(profile_id, name COLLATE NOCASE);
        "#,
    },
    Migration {
        version: 6,
        sql: r#"
            CREATE TABLE connection_profile_jumps (
                profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE CASCADE,
                hop_index INTEGER NOT NULL CHECK (hop_index BETWEEN 0 AND 3),
                jump_profile_id TEXT NOT NULL REFERENCES connection_profiles(id) ON DELETE RESTRICT,
                PRIMARY KEY (profile_id, hop_index),
                UNIQUE (profile_id, jump_profile_id),
                CHECK (profile_id <> jump_profile_id)
            );

            CREATE INDEX connection_profile_jumps_target
                ON connection_profile_jumps(jump_profile_id);
        "#,
    },
    Migration {
        version: 7,
        sql: r#"
            ALTER TABLE tunnel_rules
                ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0
                CHECK (auto_start IN (0, 1));
        "#,
    },
];

pub struct SqliteProfileRepository {
    connection: Mutex<Connection>,
    database_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageDiagnosticsSnapshot {
    pub sqlite_version: &'static str,
    pub schema_version: Option<i64>,
    pub database_file_bytes: Option<u64>,
    pub integrity_check: &'static str,
    pub foreign_key_check: &'static str,
}

impl StorageDiagnosticsSnapshot {
    pub fn unavailable() -> Self {
        Self {
            sqlite_version: rusqlite::version(),
            schema_version: None,
            database_file_bytes: None,
            integrity_check: "unavailable",
            foreign_key_check: "unavailable",
        }
    }
}

impl SqliteProfileRepository {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| storage_error("DATABASE_DIRECTORY_FAILED"))?;
        }
        let connection =
            Connection::open(path).map_err(|_| storage_error("DATABASE_OPEN_FAILED"))?;
        let mut repository = Self::from_connection(connection)?;
        repository.database_path = Some(
            path.canonicalize()
                .map_err(|_| storage_error("DATABASE_PATH_INVALID"))?,
        );
        Ok(repository)
    }

    pub fn open_in_memory() -> Result<Self, AppError> {
        let connection =
            Connection::open_in_memory().map_err(|_| storage_error("DATABASE_OPEN_FAILED"))?;
        Self::from_connection(connection)
    }

    fn from_connection(mut connection: Connection) -> Result<Self, AppError> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| storage_error("DATABASE_CONFIG_FAILED"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;\
                 PRAGMA journal_mode = WAL;\
                 PRAGMA synchronous = NORMAL;",
            )
            .map_err(|_| storage_error("DATABASE_CONFIG_FAILED"))?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            database_path: None,
        })
    }

    pub fn schema_version(&self) -> Result<i64, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        current_schema_version(&connection)
    }

    pub fn diagnostics_snapshot(&self) -> StorageDiagnosticsSnapshot {
        let database_file_bytes = self
            .database_path
            .as_deref()
            .and_then(|path| fs::metadata(path).ok().map(|metadata| metadata.len()));
        let connection = match self.connection.try_lock() {
            Ok(connection) => connection,
            Err(_) => {
                return StorageDiagnosticsSnapshot {
                    sqlite_version: rusqlite::version(),
                    schema_version: None,
                    database_file_bytes,
                    integrity_check: "unavailable",
                    foreign_key_check: "unavailable",
                };
            }
        };

        StorageDiagnosticsSnapshot {
            sqlite_version: rusqlite::version(),
            schema_version: current_schema_version(&connection).ok(),
            database_file_bytes,
            integrity_check: diagnostics_integrity_status(&connection),
            foreign_key_check: diagnostics_foreign_key_status(&connection),
        }
    }

    pub fn backup_to(&self, path: &Path) -> Result<u64, AppError> {
        if path.exists() {
            return Err(storage_error("BACKUP_ALREADY_EXISTS"));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| storage_error("BACKUP_DIRECTORY_FAILED"))?;
        }
        let destination = path
            .to_str()
            .ok_or_else(|| storage_error("BACKUP_PATH_INVALID"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute("VACUUM INTO ?1", [destination])
            .map_err(|_| storage_error("BACKUP_CREATE_FAILED"))?;
        fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|_| storage_error("BACKUP_METADATA_FAILED"))
    }

    pub fn restore_from_backup(&self, source_path: &Path) -> Result<u64, AppError> {
        let database_path = self
            .database_path
            .as_deref()
            .ok_or_else(|| backup_invalid_error())?;
        let source_path = source_path
            .canonicalize()
            .map_err(|_| backup_invalid_error())?;
        if source_path == database_path {
            return Err(backup_invalid_error());
        }
        let source = Connection::open_with_flags(
            &source_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| backup_invalid_error())?;
        let source_schema = current_schema_version(&source).map_err(|_| backup_invalid_error())?;
        let latest_schema = MIGRATIONS
            .last()
            .map(|migration| migration.version)
            .unwrap_or(0);
        if source_schema == 0 || source_schema > latest_schema {
            return Err(backup_invalid_error());
        }
        validate_database_integrity(&source).map_err(|_| backup_invalid_error())?;
        let source_bytes = fs::metadata(&source_path)
            .map_err(|_| backup_invalid_error())?
            .len();

        let rollback_path = database_path.with_file_name(format!(
            ".filex-restore-rollback-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let rollback_string = rollback_path
            .to_str()
            .ok_or_else(|| storage_error("BACKUP_PATH_INVALID"))?;
        connection
            .execute("VACUUM INTO ?1", [rollback_string])
            .map_err(|_| storage_error("BACKUP_CREATE_FAILED"))?;

        let restore_result = restore_database(&source, &mut connection)
            .and_then(|()| migrate(&mut connection))
            .and_then(|()| validate_database_integrity(&connection));
        if restore_result.is_err() {
            let rollback_source = Connection::open_with_flags(
                &rollback_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            );
            let rollback_result = rollback_source
                .map_err(|_| backup_rollback_error())
                .and_then(|rollback| restore_database(&rollback, &mut connection))
                .and_then(|()| migrate(&mut connection));
            let _ = fs::remove_file(&rollback_path);
            if rollback_result.is_err() {
                return Err(backup_rollback_error());
            }
            return Err(backup_restore_error());
        }
        let _ = fs::remove_file(&rollback_path);
        Ok(source_bytes)
    }

    pub fn read_app_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .query_row(
                "SELECT json_value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| storage_error("SETTINGS_QUERY_FAILED"))
    }

    pub fn write_app_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                r#"INSERT INTO app_settings (key, json_value, updated_at)
                   VALUES (?1, ?2, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       json_value = excluded.json_value,
                       updated_at = CURRENT_TIMESTAMP"#,
                params![key, value],
            )
            .map_err(|_| storage_error("SETTINGS_WRITE_FAILED"))?;
        Ok(())
    }

    pub fn delete_app_setting(&self, key: &str) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute("DELETE FROM app_settings WHERE key = ?1", [key])
            .map_err(|_| storage_error("SETTINGS_WRITE_FAILED"))?;
        Ok(())
    }
}

impl SettingsRepository for SqliteProfileRepository {
    fn load(&self) -> Result<Option<SafeSettings>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let value = connection
            .query_row(
                "SELECT json_value FROM app_settings WHERE key = 'safe_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| storage_error("SETTINGS_QUERY_FAILED"))?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|_| storage_error("SETTINGS_DECODE_FAILED"))
            })
            .transpose()
    }

    fn save(&self, settings: &SafeSettings) -> Result<(), AppError> {
        let json =
            serde_json::to_string(settings).map_err(|_| storage_error("SETTINGS_ENCODE_FAILED"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                r#"INSERT INTO app_settings (key, json_value, updated_at)
                   VALUES ('safe_settings', ?1, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET
                       json_value = excluded.json_value,
                       updated_at = CURRENT_TIMESTAMP"#,
                [json],
            )
            .map_err(|_| storage_error("SETTINGS_WRITE_FAILED"))?;
        Ok(())
    }
}

impl ProfileRepository for SqliteProfileRepository {
    fn list(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, name, group_name, host, port, username, environment, favorite,
                          credential_ref, last_used_at, authentication_method, identity_file,
                          proxy_jump
                   FROM connection_profiles
                   WHERE workspace_id = ?1
                   ORDER BY favorite DESC, name COLLATE NOCASE"#,
            )
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;

        let rows = statement
            .query_map([DEFAULT_WORKSPACE_ID], |row| {
                let environment: String = row.get(6)?;
                Ok(ConnectionProfile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    group: row.get(2)?,
                    host: row.get(3)?,
                    port: row.get(4)?,
                    username: row.get(5)?,
                    environment: parse_environment(6, environment)?,
                    favorite: row.get(7)?,
                    tags: Vec::new(),
                    authentication_method: parse_authentication_method(10, row.get(10)?)?,
                    identity_file: row.get(11)?,
                    proxy_jump: row.get(12)?,
                    proxy_jump_profile_ids: Vec::new(),
                    credential_ref: row.get(8)?,
                    state: ConnectionState::Idle,
                    latency_ms: None,
                    last_used_at: row.get(9)?,
                })
            })
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;

        let mut profiles = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
        drop(statement);

        let mut tags_by_profile: HashMap<String, Vec<String>> = HashMap::new();
        let mut tag_statement = connection
            .prepare("SELECT profile_id, tag FROM profile_tags ORDER BY tag COLLATE NOCASE")
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
        let tag_rows = tag_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
        for tag_row in tag_rows {
            let (profile_id, tag) = tag_row.map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
            tags_by_profile.entry(profile_id).or_default().push(tag);
        }
        for profile in &mut profiles {
            profile.tags = tags_by_profile.remove(&profile.id).unwrap_or_default();
        }

        let mut jump_statement = connection
            .prepare(
                "SELECT profile_id, jump_profile_id FROM connection_profile_jumps ORDER BY profile_id, hop_index",
            )
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
        let jump_rows = jump_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
        let mut jumps_by_profile: HashMap<String, Vec<String>> = HashMap::new();
        for jump_row in jump_rows {
            let (profile_id, jump_profile_id) =
                jump_row.map_err(|_| storage_error("PROFILE_QUERY_FAILED"))?;
            jumps_by_profile
                .entry(profile_id)
                .or_default()
                .push(jump_profile_id);
        }
        for profile in &mut profiles {
            profile.proxy_jump_profile_ids = jumps_by_profile.remove(&profile.id).unwrap_or_default();
        }
        Ok(profiles)
    }

    fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, AppError> {
        Ok(ProfileRepository::list(self)?
            .into_iter()
            .find(|profile| profile.id == id))
    }

    fn insert(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        transaction
            .execute(
                r#"INSERT INTO connection_profiles (
                       id, workspace_id, name, group_name, host, port, username, environment,
                       favorite, credential_ref, last_used_at, authentication_method,
                       identity_file, proxy_jump
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
                params![
                    profile.id,
                    DEFAULT_WORKSPACE_ID,
                    profile.name,
                    profile.group,
                    profile.host,
                    profile.port,
                    profile.username,
                    environment_name(&profile.environment),
                    profile.favorite,
                    profile.credential_ref,
                    profile.last_used_at,
                    authentication_method_name(&profile.authentication_method),
                    profile.identity_file,
                    profile.proxy_jump,
                ],
            )
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        for tag in &profile.tags {
            transaction
                .execute(
                    "INSERT INTO profile_tags (profile_id, tag) VALUES (?1, ?2)",
                    params![profile.id, tag],
                )
                .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        }
        for (hop_index, jump_profile_id) in profile.proxy_jump_profile_ids.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO connection_profile_jumps (profile_id, hop_index, jump_profile_id) VALUES (?1, ?2, ?3)",
                    params![profile.id, hop_index as i64, jump_profile_id],
                )
                .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        }
        transaction
            .commit()
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))
    }

    fn update(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        let changed = transaction
            .execute(
                r#"UPDATE connection_profiles SET
                       name = ?2, group_name = ?3, host = ?4, port = ?5, username = ?6,
                       environment = ?7, favorite = ?8, credential_ref = ?9,
                       authentication_method = ?10, identity_file = ?11, proxy_jump = ?12,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?1"#,
                params![
                    profile.id,
                    profile.name,
                    profile.group,
                    profile.host,
                    profile.port,
                    profile.username,
                    environment_name(&profile.environment),
                    profile.favorite,
                    profile.credential_ref,
                    authentication_method_name(&profile.authentication_method),
                    profile.identity_file,
                    profile.proxy_jump,
                ],
            )
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        if changed == 0 {
            return Ok(());
        }
        transaction
            .execute(
                "DELETE FROM profile_tags WHERE profile_id = ?1",
                [&profile.id],
            )
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        for tag in &profile.tags {
            transaction
                .execute(
                    "INSERT INTO profile_tags (profile_id, tag) VALUES (?1, ?2)",
                    params![profile.id, tag],
                )
                .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        }
        transaction
            .execute(
                "DELETE FROM connection_profile_jumps WHERE profile_id = ?1",
                [&profile.id],
            )
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        for (hop_index, jump_profile_id) in profile.proxy_jump_profile_ids.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO connection_profile_jumps (profile_id, hop_index, jump_profile_id) VALUES (?1, ?2, ?3)",
                    params![profile.id, hop_index as i64, jump_profile_id],
                )
                .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))?;
        }
        transaction
            .commit()
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))
    }

    fn delete(&self, id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute("DELETE FROM connection_profiles WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))
    }

    fn set_credential_ref(&self, id: &str, credential_ref: Option<&str>) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                "UPDATE connection_profiles SET credential_ref = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, credential_ref],
            )
            .map(|changed| changed > 0)
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))
    }

    fn mark_used(&self, id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                "UPDATE connection_profiles SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )
            .map(|changed| changed > 0)
            .map_err(|_| storage_error("PROFILE_WRITE_FAILED"))
    }
}

impl HostTrustRepository for SqliteProfileRepository {
    fn list(&self) -> Result<Vec<HostTrustRecord>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, host, port, algorithm, fingerprint_sha256,
                          previous_fingerprint_sha256, source, first_seen_at, last_seen_at
                   FROM host_trust_records
                   ORDER BY last_seen_at DESC, rowid DESC"#,
            )
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?;
        statement
            .query_map([], map_trust_record)
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))
    }

    fn latest(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
    ) -> Result<Option<HostTrustRecord>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, host, port, algorithm, fingerprint_sha256,
                          previous_fingerprint_sha256, source, first_seen_at, last_seen_at
                   FROM host_trust_records
                   WHERE host = ?1 COLLATE NOCASE AND port = ?2 AND algorithm = ?3
                   ORDER BY last_seen_at DESC, rowid DESC
                   LIMIT 1"#,
            )
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?;
        let mut rows = statement
            .query(params![host, port, algorithm])
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?;
        match rows
            .next()
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?
        {
            Some(row) => map_trust_record(row)
                .map(Some)
                .map_err(|_| storage_error("TRUST_QUERY_FAILED")),
            None => Ok(None),
        }
    }

    fn insert(&self, record: &HostTrustRecord) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute(
                r#"INSERT INTO host_trust_records (
                       id, host, port, algorithm, fingerprint_sha256,
                       previous_fingerprint_sha256, source, first_seen_at, last_seen_at
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                params![
                    record.id,
                    record.host,
                    record.port,
                    record.algorithm,
                    record.fingerprint_sha256,
                    record.previous_fingerprint_sha256,
                    trust_source_name(&record.source),
                    record.first_seen_at,
                    record.last_seen_at,
                ],
            )
            .map(|_| ())
            .map_err(|_| storage_error("TRUST_WRITE_FAILED"))
    }

    fn import_many_if_current(
        &self,
        expected: &[HostTrustImportExpectation],
        records: &[HostTrustRecord],
    ) -> Result<bool, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("TRUST_WRITE_FAILED"))?;
        let mut statement = transaction
            .prepare(
                r#"SELECT fingerprint_sha256
                   FROM host_trust_records
                   WHERE host = ?1 COLLATE NOCASE AND port = ?2 AND algorithm = ?3
                   ORDER BY last_seen_at DESC, rowid DESC
                   LIMIT 1"#,
            )
            .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?;
        for expectation in expected {
            let current = statement
                .query_row(
                    params![
                        expectation.host,
                        expectation.port,
                        expectation.algorithm,
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| storage_error("TRUST_QUERY_FAILED"))?;
            if current != expectation.current_fingerprint_sha256 {
                return Ok(false);
            }
        }
        drop(statement);

        for record in records {
            transaction
                .execute(
                    r#"INSERT INTO host_trust_records (
                           id, host, port, algorithm, fingerprint_sha256,
                           previous_fingerprint_sha256, source, first_seen_at, last_seen_at
                       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                    params![
                        record.id,
                        record.host,
                        record.port,
                        record.algorithm,
                        record.fingerprint_sha256,
                        record.previous_fingerprint_sha256,
                        trust_source_name(&record.source),
                        record.first_seen_at,
                        record.last_seen_at,
                    ],
                )
                .map_err(|_| storage_error("TRUST_WRITE_FAILED"))?;
        }
        transaction
            .commit()
            .map_err(|_| storage_error("TRUST_WRITE_FAILED"))?;
        Ok(true)
    }
}

impl TransferRepository for SqliteProfileRepository {
    fn list(&self) -> Result<Vec<TransferTask>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, profile_id, session_id, direction, local_path, remote_path, state,
                          bytes_transferred, total_bytes, conflict_policy, error_json,
                          created_at_ms, updated_at_ms
                   FROM transfer_tasks
                   ORDER BY created_at_ms DESC"#,
            )
            .map_err(|_| storage_error("TRANSFER_QUERY_FAILED"))?;
        statement
            .query_map([], map_transfer_task)
            .map_err(|_| storage_error("TRANSFER_QUERY_FAILED"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("TRANSFER_QUERY_FAILED"))
    }

    fn get(&self, id: &str) -> Result<Option<TransferTask>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, profile_id, session_id, direction, local_path, remote_path, state,
                          bytes_transferred, total_bytes, conflict_policy, error_json,
                          created_at_ms, updated_at_ms
                   FROM transfer_tasks WHERE id = ?1"#,
            )
            .map_err(|_| storage_error("TRANSFER_QUERY_FAILED"))?;
        match statement
            .query_row([id], map_transfer_task)
            .optional()
            .map_err(|_| storage_error("TRANSFER_QUERY_FAILED"))?
        {
            Some(task) => Ok(Some(task)),
            None => Ok(None),
        }
    }

    fn insert(&self, task: &TransferTask) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let bytes_transferred = to_i64(task.bytes_transferred)?;
        let total_bytes = task.total_bytes.map(to_i64).transpose()?;
        let created_at_ms = to_i64(task.created_at_ms)?;
        let updated_at_ms = to_i64(task.updated_at_ms)?;
        let error_json = task
            .error
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| storage_error("TRANSFER_WRITE_FAILED"))?;
        connection
            .execute(
                r#"INSERT INTO transfer_tasks (
                       id, profile_id, session_id, direction, local_path, remote_path, state,
                       bytes_transferred, total_bytes, conflict_policy, error_json,
                       created_at_ms, updated_at_ms
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"#,
                params![
                    task.id,
                    task.profile_id,
                    task.session_id,
                    transfer_direction_name(&task.direction),
                    task.local_path,
                    task.remote_path,
                    transfer_state_name(&task.state),
                    bytes_transferred,
                    total_bytes,
                    conflict_policy_name(&task.conflict_policy),
                    error_json,
                    created_at_ms,
                    updated_at_ms,
                ],
            )
            .map(|_| ())
            .map_err(|_| storage_error("TRANSFER_WRITE_FAILED"))
    }

    fn update(&self, task: &TransferTask) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let bytes_transferred = to_i64(task.bytes_transferred)?;
        let total_bytes = task.total_bytes.map(to_i64).transpose()?;
        let created_at_ms = to_i64(task.created_at_ms)?;
        let updated_at_ms = to_i64(task.updated_at_ms)?;
        let error_json = task
            .error
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| storage_error("TRANSFER_WRITE_FAILED"))?;
        connection
            .execute(
                r#"UPDATE transfer_tasks SET
                       profile_id = ?2, session_id = ?3, direction = ?4, local_path = ?5,
                       remote_path = ?6, state = ?7, bytes_transferred = ?8, total_bytes = ?9,
                       conflict_policy = ?10, error_json = ?11, created_at_ms = ?12,
                       updated_at_ms = ?13
                   WHERE id = ?1"#,
                params![
                    task.id,
                    task.profile_id,
                    task.session_id,
                    transfer_direction_name(&task.direction),
                    task.local_path,
                    task.remote_path,
                    transfer_state_name(&task.state),
                    bytes_transferred,
                    total_bytes,
                    conflict_policy_name(&task.conflict_policy),
                    error_json,
                    created_at_ms,
                    updated_at_ms,
                ],
            )
            .map(|_| ())
            .map_err(|_| storage_error("TRANSFER_WRITE_FAILED"))
    }
}

impl TunnelRuleRepository for SqliteProfileRepository {
    fn list_tunnel_rules(&self) -> Result<Vec<TunnelRule>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection.prepare(
            "SELECT id, profile_id, name, kind, bind_host, bind_port, target_host, target_port, auto_start FROM tunnel_rules ORDER BY name COLLATE NOCASE",
        ).map_err(|_| storage_error("TUNNEL_RULE_QUERY_FAILED"))?;
        statement
            .query_map([], map_tunnel_rule)
            .map_err(|_| storage_error("TUNNEL_RULE_QUERY_FAILED"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("TUNNEL_RULE_QUERY_FAILED"))
    }

    fn get_tunnel_rule(&self, id: &str) -> Result<Option<TunnelRule>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection.query_row(
            "SELECT id, profile_id, name, kind, bind_host, bind_port, target_host, target_port, auto_start FROM tunnel_rules WHERE id = ?1",
            [id], map_tunnel_rule,
        ).optional().map_err(|_| storage_error("TUNNEL_RULE_QUERY_FAILED"))
    }

    fn insert_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection.execute(
            "INSERT INTO tunnel_rules (id, profile_id, name, kind, bind_host, bind_port, target_host, target_port, auto_start) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![rule.id, rule.profile_id, rule.name, tunnel_kind_name(&rule.kind), rule.bind_host, rule.bind_port, rule.target_host, rule.target_port, rule.auto_start],
        ).map(|_| ()).map_err(|_| storage_error("TUNNEL_RULE_WRITE_FAILED"))
    }

    fn update_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let changed = connection.execute(
            "UPDATE tunnel_rules SET profile_id = ?2, name = ?3, kind = ?4, bind_host = ?5, bind_port = ?6, target_host = ?7, target_port = ?8, auto_start = ?9 WHERE id = ?1",
            params![rule.id, rule.profile_id, rule.name, tunnel_kind_name(&rule.kind), rule.bind_host, rule.bind_port, rule.target_host, rule.target_port, rule.auto_start],
        ).map_err(|_| storage_error("TUNNEL_RULE_WRITE_FAILED"))?;
        if changed == 0 {
            return Err(storage_error("TUNNEL_RULE_NOT_FOUND"));
        }
        Ok(())
    }

    fn delete_tunnel_rule(&self, id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        connection
            .execute("DELETE FROM tunnel_rules WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(|_| storage_error("TUNNEL_RULE_WRITE_FAILED"))
    }
}

fn map_tunnel_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<TunnelRule> {
    Ok(TunnelRule {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        name: row.get(2)?,
        kind: parse_tunnel_kind(3, row.get(3)?)?,
        bind_host: row.get(4)?,
        bind_port: row.get(5)?,
        target_host: row.get(6)?,
        target_port: row.get(7)?,
        auto_start: row.get(8)?,
    })
}

fn tunnel_kind_name(kind: &TunnelKind) -> &'static str {
    match kind {
        TunnelKind::Local => "local",
        TunnelKind::Dynamic => "dynamic",
        TunnelKind::Remote => "remote",
    }
}

fn parse_tunnel_kind(index: usize, value: String) -> rusqlite::Result<TunnelKind> {
    match value.as_str() {
        "local" => Ok(TunnelKind::Local),
        "dynamic" => Ok(TunnelKind::Dynamic),
        "remote" => Ok(TunnelKind::Remote),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn map_trust_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<HostTrustRecord> {
    Ok(HostTrustRecord {
        id: row.get(0)?,
        host: row.get(1)?,
        port: row.get(2)?,
        algorithm: row.get(3)?,
        fingerprint_sha256: row.get(4)?,
        previous_fingerprint_sha256: row.get(5)?,
        source: parse_trust_source(6, row.get(6)?)?,
        first_seen_at: row.get(7)?,
        last_seen_at: row.get(8)?,
    })
}

fn map_transfer_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<TransferTask> {
    let error_json: Option<String> = row.get(10)?;
    let error = error_json
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(10, Type::Text, Box::new(error))
            })
        })
        .transpose()?;
    Ok(TransferTask {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        session_id: row.get(2)?,
        direction: parse_transfer_direction(3, row.get(3)?)?,
        local_path: row.get(4)?,
        remote_path: row.get(5)?,
        state: parse_transfer_state(6, row.get(6)?)?,
        bytes_transferred: from_i64(7, row.get(7)?)?,
        total_bytes: row
            .get::<_, Option<i64>>(8)?
            .map(|value| from_i64(8, value))
            .transpose()?,
        conflict_policy: parse_conflict_policy(9, row.get(9)?)?,
        error,
        created_at_ms: from_i64(11, row.get(11)?)?,
        updated_at_ms: from_i64(12, row.get(12)?)?,
    })
}

fn transfer_direction_name(direction: &TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    }
}

fn parse_transfer_direction(index: usize, value: String) -> rusqlite::Result<TransferDirection> {
    match value.as_str() {
        "upload" => Ok(TransferDirection::Upload),
        "download" => Ok(TransferDirection::Download),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn transfer_state_name(state: &TransferState) -> &'static str {
    match state {
        TransferState::Queued => "queued",
        TransferState::Running => "running",
        TransferState::Paused => "paused",
        TransferState::Completed => "completed",
        TransferState::Failed => "failed",
        TransferState::Cancelled => "cancelled",
    }
}

fn parse_transfer_state(index: usize, value: String) -> rusqlite::Result<TransferState> {
    match value.as_str() {
        "queued" => Ok(TransferState::Queued),
        "running" => Ok(TransferState::Running),
        "paused" => Ok(TransferState::Paused),
        "completed" => Ok(TransferState::Completed),
        "failed" => Ok(TransferState::Failed),
        "cancelled" => Ok(TransferState::Cancelled),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn conflict_policy_name(policy: &ConflictPolicy) -> &'static str {
    match policy {
        ConflictPolicy::Ask => "ask",
        ConflictPolicy::Overwrite => "overwrite",
        ConflictPolicy::Skip => "skip",
        ConflictPolicy::Rename => "rename",
    }
}

fn parse_conflict_policy(index: usize, value: String) -> rusqlite::Result<ConflictPolicy> {
    match value.as_str() {
        "ask" => Ok(ConflictPolicy::Ask),
        "overwrite" => Ok(ConflictPolicy::Overwrite),
        "skip" => Ok(ConflictPolicy::Skip),
        "rename" => Ok(ConflictPolicy::Rename),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn to_i64(value: u64) -> Result<i64, AppError> {
    i64::try_from(value).map_err(|_| storage_error("TRANSFER_NUMBER_OUT_OF_RANGE"))
}

fn from_i64(index: usize, value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

fn restore_database(source: &Connection, destination: &mut Connection) -> Result<(), AppError> {
    let restore =
        rusqlite::backup::Backup::new(source, destination).map_err(|_| backup_restore_error())?;
    restore
        .run_to_completion(128, Duration::from_millis(10), None)
        .map_err(|_| backup_restore_error())
}

fn validate_database_integrity(connection: &Connection) -> Result<(), AppError> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| backup_invalid_error())?;
    if integrity != "ok" {
        return Err(backup_invalid_error());
    }
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| backup_invalid_error())?;
    let mut rows = statement.query([]).map_err(|_| backup_invalid_error())?;
    if rows.next().map_err(|_| backup_invalid_error())?.is_some() {
        return Err(backup_invalid_error());
    }
    Ok(())
}

fn diagnostics_integrity_status(connection: &Connection) -> &'static str {
    match connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
        Ok(result) if result == "ok" => "ok",
        Ok(_) => "issue_detected",
        Err(_) => "unavailable",
    }
}

fn diagnostics_foreign_key_status(connection: &Connection) -> &'static str {
    let mut statement = match connection.prepare("PRAGMA foreign_key_check") {
        Ok(statement) => statement,
        Err(_) => return "unavailable",
    };
    let mut rows = match statement.query([]) {
        Ok(rows) => rows,
        Err(_) => return "unavailable",
    };
    match rows.next() {
        Ok(Some(_)) => "issue_detected",
        Ok(None) => "ok",
        Err(_) => "unavailable",
    }
}

fn migrate(connection: &mut Connection) -> Result<(), AppError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
                version INTEGER PRIMARY KEY NOT NULL,\
                applied_at TEXT NOT NULL\
            );",
        )
        .map_err(|_| storage_error("DATABASE_MIGRATION_FAILED"))?;
    let current = current_schema_version(connection)?;
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current)
    {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("DATABASE_MIGRATION_FAILED"))?;
        transaction
            .execute_batch(migration.sql)
            .map_err(|_| storage_error("DATABASE_MIGRATION_FAILED"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, CURRENT_TIMESTAMP)",
                [migration.version],
            )
            .map_err(|_| storage_error("DATABASE_MIGRATION_FAILED"))?;
        transaction
            .commit()
            .map_err(|_| storage_error("DATABASE_MIGRATION_FAILED"))?;
    }
    Ok(())
}

fn current_schema_version(connection: &Connection) -> Result<i64, AppError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|_| storage_error("DATABASE_VERSION_QUERY_FAILED"))
}

fn environment_name(environment: &EnvironmentKind) -> &'static str {
    match environment {
        EnvironmentKind::Production => "production",
        EnvironmentKind::Staging => "staging",
        EnvironmentKind::Development => "development",
    }
}

fn authentication_method_name(method: &AuthenticationMethod) -> &'static str {
    match method {
        AuthenticationMethod::Password => "password",
        AuthenticationMethod::PrivateKey => "private_key",
        AuthenticationMethod::Agent => "agent",
    }
}

fn parse_authentication_method(
    index: usize,
    value: String,
) -> rusqlite::Result<AuthenticationMethod> {
    match value.as_str() {
        "password" => Ok(AuthenticationMethod::Password),
        "private_key" => Ok(AuthenticationMethod::PrivateKey),
        "agent" => Ok(AuthenticationMethod::Agent),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn trust_source_name(source: &HostTrustSource) -> &'static str {
    match source {
        HostTrustSource::ImportedKnownHosts => "imported_known_hosts",
        HostTrustSource::FilexDecision => "filex_decision",
    }
}

fn parse_trust_source(index: usize, value: String) -> rusqlite::Result<HostTrustSource> {
    match value.as_str() {
        "imported_known_hosts" => Ok(HostTrustSource::ImportedKnownHosts),
        "filex_decision" => Ok(HostTrustSource::FilexDecision),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn parse_environment(index: usize, value: String) -> rusqlite::Result<EnvironmentKind> {
    match value.as_str() {
        "production" => Ok(EnvironmentKind::Production),
        "staging" => Ok(EnvironmentKind::Staging),
        "development" => Ok(EnvironmentKind::Development),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn storage_error(code: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: "errors.profileStorageUnavailable".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn backup_invalid_error() -> AppError {
    AppError {
        code: "BACKUP_INVALID".to_owned(),
        message_key: "errors.backupInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("backupPath".to_owned()),
    }
}

fn backup_restore_error() -> AppError {
    AppError {
        code: "BACKUP_RESTORE_FAILED".to_owned(),
        message_key: "errors.backupRestoreFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn backup_rollback_error() -> AppError {
    AppError {
        code: "BACKUP_ROLLBACK_FAILED".to_owned(),
        message_key: "errors.backupRollbackFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use filex_contracts::{
        AuthenticationMethod, ConflictPolicy, CreateConnectionProfileInput, CreateTransferInput,
        EnvironmentKind, HostTrustEvaluation, HostTrustSource, RecordHostTrustInput,
        TransferDirection, TransferState, UpdateConnectionProfileInput,
    };
    use filex_core::{HostTrustService, ProfileService, TransferService};

    use super::SqliteProfileRepository;

    fn input() -> CreateConnectionProfileInput {
        CreateConnectionProfileInput {
            name: "Persistent host".to_owned(),
            group: "Lab".to_owned(),
            host: "192.0.2.10".to_owned(),
            port: 22,
            username: "operator".to_owned(),
            environment: EnvironmentKind::Development,
            tags: vec!["linux".to_owned(), "edge".to_owned()],
            authentication_method: AuthenticationMethod::Password,
            identity_file: None,
            proxy_jump: None,
            proxy_jump_profile_ids: Vec::new(),
        }
    }

    #[test]
    fn applies_schema_migrations_once() {
        let repository = SqliteProfileRepository::open_in_memory().expect("database opens");
        assert_eq!(repository.schema_version().expect("version reads"), 7);
    }

    #[test]
    fn safe_settings_survive_database_reopen() {
        use filex_core::{SettingsService, default_safe_settings};

        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("settings.sqlite3");
        {
            let repository =
                Arc::new(SqliteProfileRepository::open(&database_path).expect("database opens"));
            let settings = SettingsService::new(repository);
            let mut value = default_safe_settings();
            value.theme = "light".to_owned();
            value.connections_pane_width = 300;
            settings.save(value).expect("settings save");
        }
        let repository =
            Arc::new(SqliteProfileRepository::open(&database_path).expect("database reopens"));
        let settings = SettingsService::new(repository);
        let value = settings.load().expect("settings load");
        assert_eq!(value.theme, "light");
        assert_eq!(value.connections_pane_width, 300);
    }

    #[test]
    fn transfer_queue_survives_database_reopen() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("filex.sqlite3");
        let profile_id;
        {
            let repository =
                Arc::new(SqliteProfileRepository::open(&database_path).expect("database opens"));
            let profiles = ProfileService::new(repository.clone());
            profile_id = profiles.create(input()).expect("profile is stored").id;
            let transfers = TransferService::new(repository);
            let task = transfers
                .enqueue(CreateTransferInput {
                    profile_id: profile_id.clone(),
                    direction: TransferDirection::Upload,
                    local_path: "C:/fixtures/archive.tar".to_owned(),
                    remote_path: "/tmp/archive.tar".to_owned(),
                    conflict_policy: ConflictPolicy::Ask,
                    total_bytes: Some(4096),
                })
                .expect("transfer is queued");
            assert_eq!(task.state, TransferState::Queued);
        }
        let repository =
            Arc::new(SqliteProfileRepository::open(&database_path).expect("database reopens"));
        let transfers = TransferService::new(repository);
        let tasks = transfers.list().expect("queue loads");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].profile_id, profile_id);
        assert_eq!(tasks[0].total_bytes, Some(4096));
    }

    #[test]
    fn profiles_survive_database_reopen() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("filex.sqlite3");
        {
            let repository = SqliteProfileRepository::open(&database_path).expect("database opens");
            let service = ProfileService::new(Arc::new(repository));
            service.create(input()).expect("profile is stored");
        }
        let repository = SqliteProfileRepository::open(&database_path).expect("database reopens");
        let service = ProfileService::new(Arc::new(repository));
        let profiles = service.list().expect("profiles load");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Persistent host");
        assert_eq!(profiles[0].tags, vec!["edge", "linux"]);
        assert!(profiles[0].credential_ref.is_none());
    }

    #[test]
    fn trust_ledger_detects_changed_fingerprint() {
        let repository =
            Arc::new(SqliteProfileRepository::open_in_memory().expect("database opens"));
        let trust = HostTrustService::new(repository);
        assert_eq!(
            trust
                .evaluate("example.internal", 22, "ssh-ed25519", "SHA256:first")
                .expect("evaluation works"),
            HostTrustEvaluation::Unknown
        );
        trust
            .record(RecordHostTrustInput {
                host: "example.internal".to_owned(),
                port: 22,
                algorithm: "ssh-ed25519".to_owned(),
                fingerprint_sha256: "SHA256:first".to_owned(),
                source: HostTrustSource::FilexDecision,
                observed_at: "2026-11-01T13:00:00Z".to_owned(),
            })
            .expect("trust is recorded");
        assert_eq!(
            trust
                .evaluate("example.internal", 22, "ssh-ed25519", "SHA256:second")
                .expect("evaluation works"),
            HostTrustEvaluation::Changed
        );
        trust
            .record(RecordHostTrustInput {
                host: "example.internal".to_owned(),
                port: 22,
                algorithm: "ssh-ed25519".to_owned(),
                fingerprint_sha256: "SHA256:second".to_owned(),
                source: HostTrustSource::FilexDecision,
                observed_at: "2026-11-02T13:00:00Z".to_owned(),
            })
            .expect("replacement is appended");
        let records = trust.list().expect("ledger loads");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].previous_fingerprint_sha256.as_deref(),
            Some("SHA256:first")
        );
    }

    #[test]
    fn profile_crud_and_duplicate_are_durable() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("crud.sqlite3");
        let repository = SqliteProfileRepository::open(&database_path).expect("database opens");
        let service = ProfileService::new(Arc::new(repository));
        let created = service.create(input()).expect("profile is created");
        let updated = service
            .update(
                &created.id,
                UpdateConnectionProfileInput {
                    name: "Renamed host".to_owned(),
                    group: "Production".to_owned(),
                    host: created.host.clone(),
                    port: 2222,
                    username: created.username.clone(),
                    environment: EnvironmentKind::Production,
                    favorite: true,
                    tags: vec!["updated".to_owned()],
                    authentication_method: AuthenticationMethod::Agent,
                    identity_file: None,
                    proxy_jump: Some("bastion".to_owned()),
                    proxy_jump_profile_ids: Vec::new(),
                },
            )
            .expect("profile is updated");
        assert_eq!(updated.port, 2222);
        assert!(updated.favorite);
        let duplicate = service
            .duplicate(&created.id)
            .expect("profile is duplicated");
        assert_ne!(duplicate.id, created.id);
        assert!(duplicate.credential_ref.is_none());
        service.delete(&created.id).expect("source is deleted");
        drop(service);

        let reopened = ProfileService::new(Arc::new(
            SqliteProfileRepository::open(&database_path).expect("database reopens"),
        ));
        let profiles = reopened.list().expect("profiles load");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, duplicate.id);
        assert_eq!(profiles[0].proxy_jump.as_deref(), Some("bastion"));
    }
}
