use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use filex_contracts::{AppError, ProfileCommandHistoryEntry, RemoteState};

pub const MAX_PROFILE_COMMAND_HISTORY_ENTRIES: usize = 200;
pub const MAX_HISTORY_COMMAND_CHARS: usize = 4_096;

pub trait CommandHistoryRepository: Send + Sync {
    fn list_for_profile(
        &self,
        profile_id: &str,
    ) -> Result<Vec<ProfileCommandHistoryEntry>, AppError>;

    fn upsert_and_prune(
        &self,
        entry: &ProfileCommandHistoryEntry,
        limit: usize,
    ) -> Result<ProfileCommandHistoryEntry, AppError>;

    fn delete_entry(&self, profile_id: &str, entry_id: &str) -> Result<bool, AppError>;

    fn clear_profile(&self, profile_id: &str) -> Result<(), AppError>;
}

pub struct CommandHistoryService {
    repository: Arc<dyn CommandHistoryRepository>,
}

impl CommandHistoryService {
    pub fn new(repository: Arc<dyn CommandHistoryRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self, profile_id: &str) -> Result<Vec<ProfileCommandHistoryEntry>, AppError> {
        let trimmed_id = normalize_profile_id(profile_id)?;
        self.repository.list_for_profile(&trimmed_id)
    }

    pub fn record(
        &self,
        profile_id: &str,
        command: &str,
    ) -> Result<Option<ProfileCommandHistoryEntry>, AppError> {
        let trimmed_id = normalize_profile_id(profile_id)?;
        let normalized_cmd = normalize_command_text(command);
        let Some(cmd) = normalized_cmd else {
            return Ok(None);
        };
        if should_exclude_command_from_history(&cmd) {
            return Ok(None);
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AppError {
                code: "CLOCK_UNAVAILABLE".to_owned(),
                message_key: "errors.clockUnavailable".to_owned(),
                retryable: false,
                remote_state: RemoteState::NotApplicable,
                field: None,
            })?
            .as_millis() as i64;
        let entry = ProfileCommandHistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: trimmed_id,
            command: cmd,
            created_at_ms: now_ms,
        };
        let saved = self
            .repository
            .upsert_and_prune(&entry, MAX_PROFILE_COMMAND_HISTORY_ENTRIES)?;
        Ok(Some(saved))
    }

    pub fn delete_entry(&self, profile_id: &str, entry_id: &str) -> Result<bool, AppError> {
        let trimmed_id = normalize_profile_id(profile_id)?;
        let trimmed_entry_id = entry_id.trim();
        if trimmed_entry_id.is_empty() {
            return Err(AppError {
                code: "VALIDATION_FAILED".to_owned(),
                message_key: "errors.validationFailed".to_owned(),
                retryable: false,
                remote_state: RemoteState::NotApplicable,
                field: Some("entryId".to_owned()),
            });
        }
        self.repository.delete_entry(&trimmed_id, trimmed_entry_id)
    }

    pub fn clear_profile(&self, profile_id: &str) -> Result<(), AppError> {
        let trimmed_id = normalize_profile_id(profile_id)?;
        self.repository.clear_profile(&trimmed_id)
    }
}

fn normalize_profile_id(profile_id: &str) -> Result<String, AppError> {
    let trimmed = profile_id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains('\0') {
        return Err(AppError {
            code: "VALIDATION_FAILED".to_owned(),
            message_key: "errors.profileNotFound".to_owned(),
            retryable: false,
            remote_state: RemoteState::NotApplicable,
            field: Some("profileId".to_owned()),
        });
    }
    Ok(trimmed.to_owned())
}

fn normalize_command_text(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty()
        || trimmed.contains('\0')
        || trimmed.chars().count() > MAX_HISTORY_COMMAND_CHARS
    {
        return None;
    }
    Some(trimmed.to_owned())
}

/// Excludes commands that likely embed inline credentials, tokens, passphrases, or key material.
pub fn should_exclude_command_from_history(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty()
        || trimmed.contains('\0')
        || trimmed.chars().count() > MAX_HISTORY_COMMAND_CHARS
    {
        return true;
    }

    let upper = trimmed.to_ascii_uppercase();
    if upper.contains("BEGIN ") && upper.contains("PRIVATE KEY") {
        return true;
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("authorization: bearer")
        || lower.contains("authorization: basic")
        || has_url_credentials(&lower)
        || has_stdin_password_pipe(&lower)
    {
        return true;
    }

    if has_sensitive_env_assignment(&lower) || has_sensitive_cli_flag(&lower) {
        return true;
    }

    false
}

fn has_url_credentials(lower: &str) -> bool {
    for scheme in ["https://", "http://", "socks5://", "ssh://", "ftp://"] {
        let mut rest = lower;
        while let Some(idx) = rest.find(scheme) {
            let after_scheme = &rest[idx + scheme.len()..];
            let authority = after_scheme
                .split(['/', '?', '#', ' ', '\t', '\r', '\n', '\'', '"'])
                .next()
                .unwrap_or("");
            if let Some((userinfo, _host)) = authority.split_once('@') {
                if userinfo.contains(':') && !userinfo.ends_with(':') {
                    return true;
                }
            }
            rest = after_scheme;
        }
    }
    false
}

fn has_stdin_password_pipe(lower: &str) -> bool {
    let has_pipe_cmd = lower.contains("| sudo -s")
        || lower.contains("|sudo -s")
        || lower.contains("| chpasswd")
        || lower.contains("|chpasswd")
        || lower.contains("| passwd")
        || lower.contains("|passwd");
    if has_pipe_cmd {
        return true;
    }
    lower.contains("sshpass ") && (lower.contains(" -p") || lower.contains("-p'"))
}

fn has_sensitive_env_assignment(lower: &str) -> bool {
    const SECRET_ENV_KEYWORDS: [&str; 10] = [
        "password",
        "passwd",
        "passphrase",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_key",
        "private_key",
        "auth_header",
    ];
    for raw_token in lower.split(|ch: char| ch.is_whitespace() || ch == ';' || ch == '&') {
        let token = raw_token.trim_matches(|ch: char| ch == '\'' || ch == '"');
        let Some((lhs, rhs)) = token.split_once('=') else {
            continue;
        };
        let normalized_lhs = lhs.trim_matches(|ch: char| ch == '\'' || ch == '"');
        let normalized_rhs = rhs.trim_matches(|ch: char| ch == '\'' || ch == '"');
        if normalized_rhs.is_empty() {
            continue;
        }
        if SECRET_ENV_KEYWORDS
            .iter()
            .any(|keyword| normalized_lhs.contains(keyword))
        {
            return true;
        }
    }
    false
}

fn has_sensitive_cli_flag(lower: &str) -> bool {
    const SECRET_FLAGS: [&str; 12] = [
        "--password",
        "-password",
        "--passphrase",
        "--token",
        "--access-token",
        "--secret",
        "--client-secret",
        "--api-key",
        "--apikey",
        "--auth-token",
        "-x-api-key",
        "--bearer",
    ];
    let tokens: Vec<&str> = lower.split_whitespace().collect();
    for (idx, raw) in tokens.iter().enumerate() {
        let token = raw.trim_matches(|ch: char| ch == '\'' || ch == '"');
        if SECRET_FLAGS.iter().any(|flag| {
            token == *flag
                || token.starts_with(&format!("{flag}="))
                || token.starts_with(&format!("{flag}:"))
        }) && (token.contains('=') || token.contains(':') || tokens.get(idx + 1).is_some())
        {
            return true;
        }
        if (token == "bearer" || token == "token")
            && tokens.get(idx + 1).is_some()
            && idx
                .checked_sub(1)
                .and_then(|i| tokens.get(i))
                .is_some_and(|prev| {
                    prev.contains("header") || prev.contains("-h") || prev.contains("auth")
                })
        {
            return true;
        }
        // Catch inline MySQL/CLI passwords like `mysql -u root -pMySecret` while allowing `mkdir -p`.
        if token.starts_with("-p") && token.len() > 2 && !token.starts_with("--") {
            let cmd = tokens.first().copied().unwrap_or("");
            if matches!(
                cmd,
                "mysql"
                    | "mariadb"
                    | "mysqldump"
                    | "sshpass"
                    | "psql"
                    | "redis-cli"
                    | "unzip"
                    | "zip"
            ) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct MemoryHistoryRepo {
        entries: Mutex<Vec<ProfileCommandHistoryEntry>>,
    }

    impl CommandHistoryRepository for MemoryHistoryRepo {
        fn list_for_profile(
            &self,
            profile_id: &str,
        ) -> Result<Vec<ProfileCommandHistoryEntry>, AppError> {
            let mut list: Vec<_> = self
                .entries
                .lock()
                .expect("history lock")
                .iter()
                .filter(|item| item.profile_id == profile_id)
                .cloned()
                .collect();
            list.sort_by_key(|item| std::cmp::Reverse(item.created_at_ms));
            Ok(list)
        }

        fn upsert_and_prune(
            &self,
            entry: &ProfileCommandHistoryEntry,
            limit: usize,
        ) -> Result<ProfileCommandHistoryEntry, AppError> {
            let mut guard = self.entries.lock().expect("history lock");
            guard.retain(|item| {
                !(item.profile_id == entry.profile_id && item.command == entry.command)
            });
            guard.push(entry.clone());
            let mut for_profile: Vec<_> = guard
                .iter()
                .filter(|item| item.profile_id == entry.profile_id)
                .cloned()
                .collect();
            for_profile.sort_by_key(|item| std::cmp::Reverse(item.created_at_ms));
            if for_profile.len() > limit {
                for_profile.truncate(limit);
            }
            guard.retain(|item| item.profile_id != entry.profile_id);
            guard.extend(for_profile);
            Ok(entry.clone())
        }

        fn delete_entry(&self, profile_id: &str, entry_id: &str) -> Result<bool, AppError> {
            let mut guard = self.entries.lock().expect("history lock");
            let before = guard.len();
            guard.retain(|item| !(item.profile_id == profile_id && item.id == entry_id));
            Ok(guard.len() < before)
        }

        fn clear_profile(&self, profile_id: &str) -> Result<(), AppError> {
            let mut guard = self.entries.lock().expect("history lock");
            guard.retain(|item| item.profile_id != profile_id);
            Ok(())
        }
    }

    #[test]
    fn secret_filter_excludes_credentials_tokens_and_private_keys() {
        assert!(should_exclude_command_from_history(""));
        assert!(should_exclude_command_from_history("   \n  "));
        assert!(should_exclude_command_from_history(
            "curl -H 'Authorization: Bearer secret123456' https://api.example.com"
        ));
        assert!(should_exclude_command_from_history(
            "export API_TOKEN=topsecret && deploy.sh"
        ));
        assert!(should_exclude_command_from_history(
            "AWS_SECRET_KEY=abcd1234 terraform apply"
        ));
        assert!(should_exclude_command_from_history(
            "docker login -u bot --password supersecret"
        ));
        assert!(should_exclude_command_from_history(
            "mysql -u root -pMyDbPass123"
        ));
        assert!(should_exclude_command_from_history(
            "echo pw123 | sudo -S systemctl restart nginx"
        ));
        assert!(should_exclude_command_from_history(
            "https://deploy:s3cr3t@git.example.com/repo.git"
        ));
        assert!(should_exclude_command_from_history(
            "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\nEOF"
        ));

        assert!(!should_exclude_command_from_history(
            "systemctl status nginx"
        ));
        assert!(!should_exclude_command_from_history(
            "mkdir -p /var/log/app"
        ));
        assert!(!should_exclude_command_from_history(
            "journalctl -u docker -n 100 --no-pager"
        ));
        assert!(!should_exclude_command_from_history("docker ps -a"));
    }

    #[test]
    fn service_persists_safe_commands_and_skips_sensitive_ones() {
        let service = CommandHistoryService::new(Arc::new(MemoryHistoryRepo::default()));
        assert!(
            service
                .record("prof-1", "export SECRET=abc123")
                .expect("ok")
                .is_none()
        );
        let saved = service
            .record("prof-1", "  df -hP  ")
            .expect("ok")
            .expect("saved");
        assert_eq!(saved.command, "df -hP");
        assert_eq!(service.list("prof-1").expect("list").len(), 1);
        assert!(service.delete_entry("prof-1", &saved.id).expect("del"));
        assert!(service.list("prof-1").expect("empty").is_empty());
    }
}
