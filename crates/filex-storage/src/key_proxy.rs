use filex_contracts::{AppError, ProxyKind, ProxyProfile, SshKeyEntry};
use filex_core::{KeyLibraryRepository, ProxyLibraryRepository};
use rusqlite::{OptionalExtension, TransactionBehavior, params, types::Type};

use crate::{SqliteProfileRepository, storage_error};

fn map_ssh_key_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SshKeyEntry> {
    let passphrase_ref: Option<String> = row.get(5)?;
    Ok(SshKeyEntry {
        id: row.get(0)?,
        label: row.get(1)?,
        key_path: row.get(2)?,
        algorithm: row.get(3)?,
        fingerprint_sha256: row.get(4)?,
        has_passphrase: passphrase_ref.is_some(),
        passphrase_ref,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn proxy_kind_name(kind: &ProxyKind) -> &'static str {
    match kind {
        ProxyKind::Socks5 => "socks5",
        ProxyKind::HttpConnect => "http_connect",
    }
}

fn parse_proxy_kind(index: usize, value: String) -> rusqlite::Result<ProxyKind> {
    match value.as_str() {
        "socks5" => Ok(ProxyKind::Socks5),
        "http_connect" => Ok(ProxyKind::HttpConnect),
        _ => Err(rusqlite::Error::InvalidColumnType(index, value, Type::Text)),
    }
}

fn map_proxy_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProxyProfile> {
    let credential_ref: Option<String> = row.get(6)?;
    let port: u16 = row.get(4)?;
    Ok(ProxyProfile {
        id: row.get(0)?,
        label: row.get(1)?,
        kind: parse_proxy_kind(2, row.get(2)?)?,
        host: row.get(3)?,
        port,
        username: row.get(5)?,
        has_password: credential_ref.is_some(),
        credential_ref,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

impl KeyLibraryRepository for SqliteProfileRepository {
    fn list(&self) -> Result<Vec<SshKeyEntry>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, label, key_path, algorithm, fingerprint_sha256,
                          passphrase_ref, created_at, updated_at
                   FROM ssh_keys
                   ORDER BY label COLLATE NOCASE, id"#,
            )
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))?;
        let rows = statement
            .query_map([], map_ssh_key_row)
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))
    }

    fn get(&self, id: &str) -> Result<Option<SshKeyEntry>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, label, key_path, algorithm, fingerprint_sha256,
                          passphrase_ref, created_at, updated_at
                   FROM ssh_keys
                   WHERE id = ?1"#,
            )
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))?;
        statement
            .query_row([id], map_ssh_key_row)
            .optional()
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))
    }

    fn insert(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .execute(
                r#"INSERT INTO ssh_keys (
                       id, label, key_path, algorithm, fingerprint_sha256, passphrase_ref
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                params![
                    entry.id,
                    entry.label,
                    entry.key_path,
                    entry.algorithm,
                    entry.fingerprint_sha256,
                    entry.passphrase_ref,
                ],
            )
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        let stored = transaction
            .query_row(
                r#"SELECT id, label, key_path, algorithm, fingerprint_sha256,
                          passphrase_ref, created_at, updated_at
                   FROM ssh_keys WHERE id = ?1"#,
                [&entry.id],
                map_ssh_key_row,
            )
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .commit()
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        Ok(stored)
    }

    fn update(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .execute(
                r#"UPDATE ssh_keys SET
                       label = ?2,
                       key_path = ?3,
                       algorithm = ?4,
                       fingerprint_sha256 = ?5,
                       passphrase_ref = ?6,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?1"#,
                params![
                    entry.id,
                    entry.label,
                    entry.key_path,
                    entry.algorithm,
                    entry.fingerprint_sha256,
                    entry.passphrase_ref,
                ],
            )
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        let stored = transaction
            .query_row(
                r#"SELECT id, label, key_path, algorithm, fingerprint_sha256,
                          passphrase_ref, created_at, updated_at
                   FROM ssh_keys WHERE id = ?1"#,
                [&entry.id],
                map_ssh_key_row,
            )
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .commit()
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        Ok(stored)
    }

    fn delete(&self, id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let changed = connection
            .execute("DELETE FROM ssh_keys WHERE id = ?1", [id])
            .map_err(|_| storage_error("KEY_LIBRARY_WRITE_FAILED"))?;
        Ok(changed > 0)
    }

    fn count_profile_references(&self, id: &str) -> Result<usize, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM connection_profiles WHERE key_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| storage_error("KEY_LIBRARY_QUERY_FAILED"))?;
        Ok(usize::try_from(count.max(0)).unwrap_or(0))
    }
}

impl ProxyLibraryRepository for SqliteProfileRepository {
    fn list(&self) -> Result<Vec<ProxyProfile>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, label, kind, host, port, username,
                          credential_ref, created_at, updated_at
                   FROM proxy_profiles
                   ORDER BY label COLLATE NOCASE, id"#,
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))?;
        let rows = statement
            .query_map([], map_proxy_row)
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))
    }

    fn get(&self, id: &str) -> Result<Option<ProxyProfile>, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let mut statement = connection
            .prepare(
                r#"SELECT id, label, kind, host, port, username,
                          credential_ref, created_at, updated_at
                   FROM proxy_profiles
                   WHERE id = ?1"#,
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))?;
        statement
            .query_row([id], map_proxy_row)
            .optional()
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))
    }

    fn insert(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .execute(
                r#"INSERT INTO proxy_profiles (
                       id, label, kind, host, port, username, credential_ref
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![
                    proxy.id,
                    proxy.label,
                    proxy_kind_name(&proxy.kind),
                    proxy.host,
                    proxy.port,
                    proxy.username,
                    proxy.credential_ref,
                ],
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        let stored = transaction
            .query_row(
                r#"SELECT id, label, kind, host, port, username,
                          credential_ref, created_at, updated_at
                   FROM proxy_profiles WHERE id = ?1"#,
                [&proxy.id],
                map_proxy_row,
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .commit()
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        Ok(stored)
    }

    fn update(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, AppError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .execute(
                r#"UPDATE proxy_profiles SET
                       label = ?2,
                       kind = ?3,
                       host = ?4,
                       port = ?5,
                       username = ?6,
                       credential_ref = ?7,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?1"#,
                params![
                    proxy.id,
                    proxy.label,
                    proxy_kind_name(&proxy.kind),
                    proxy.host,
                    proxy.port,
                    proxy.username,
                    proxy.credential_ref,
                ],
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        let stored = transaction
            .query_row(
                r#"SELECT id, label, kind, host, port, username,
                          credential_ref, created_at, updated_at
                   FROM proxy_profiles WHERE id = ?1"#,
                [&proxy.id],
                map_proxy_row,
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        transaction
            .commit()
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        Ok(stored)
    }

    fn delete(&self, id: &str) -> Result<bool, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let changed = connection
            .execute("DELETE FROM proxy_profiles WHERE id = ?1", [id])
            .map_err(|_| storage_error("PROXY_LIBRARY_WRITE_FAILED"))?;
        Ok(changed > 0)
    }

    fn count_profile_references(&self, id: &str) -> Result<usize, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| storage_error("DATABASE_LOCK_FAILED"))?;
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM connection_profiles WHERE proxy_profile_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| storage_error("PROXY_LIBRARY_QUERY_FAILED"))?;
        Ok(usize::try_from(count.max(0)).unwrap_or(0))
    }
}
