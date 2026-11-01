use std::sync::RwLock;

use filex_contracts::{
    AppError, ConnectionProfile, ConnectionState, CreateConnectionProfileInput, RemoteState,
};

#[derive(Default)]
pub struct ProfileCatalog {
    profiles: RwLock<Vec<ConnectionProfile>>,
}

impl ProfileCatalog {
    pub fn with_seed(profiles: Vec<ConnectionProfile>) -> Self {
        Self {
            profiles: RwLock::new(profiles),
        }
    }

    pub fn list(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        self.profiles
            .read()
            .map(|profiles| profiles.clone())
            .map_err(|_| {
                internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageUnavailable")
            })
    }

    pub fn create(
        &self,
        input: CreateConnectionProfileInput,
    ) -> Result<ConnectionProfile, AppError> {
        validate_profile(&input)?;
        let profile = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name.trim().to_owned(),
            group: normalized_group(&input.group),
            host: input.host.trim().to_owned(),
            port: input.port,
            username: input.username.trim().to_owned(),
            environment: input.environment,
            favorite: false,
            tags: input
                .tags
                .into_iter()
                .map(|tag| tag.trim().to_owned())
                .filter(|tag| !tag.is_empty())
                .collect(),
            credential_ref: None,
            state: ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
        };
        self.profiles
            .write()
            .map_err(|_| {
                internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
            })?
            .push(profile.clone());
        Ok(profile)
    }
}

pub fn validate_profile(input: &CreateConnectionProfileInput) -> Result<(), AppError> {
    if input.name.trim().chars().count() < 2 {
        return Err(validation_error("profile.nameTooShort", "name"));
    }
    if !valid_host(input.host.trim()) {
        return Err(validation_error("profile.hostInvalid", "host"));
    }
    if input.username.trim().is_empty() {
        return Err(validation_error("profile.usernameRequired", "username"));
    }
    Ok(())
}

fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace) {
        return false;
    }
    if host.starts_with('[') && host.ends_with(']') {
        return host[1..host.len() - 1]
            .parse::<std::net::Ipv6Addr>()
            .is_ok();
    }
    host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

fn normalized_group(group: &str) -> String {
    let trimmed = group.trim();
    if trimmed.is_empty() {
        "未分组".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn validation_error(message_key: &str, field: &str) -> AppError {
    AppError {
        code: "PROFILE_VALIDATION_FAILED".to_owned(),
        message_key: message_key.to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: Some(field.to_owned()),
    }
}

fn internal_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::{CreateConnectionProfileInput, EnvironmentKind};

    use super::{ProfileCatalog, validate_profile};

    fn valid_input() -> CreateConnectionProfileInput {
        CreateConnectionProfileInput {
            name: "example-host".to_owned(),
            group: "Development".to_owned(),
            host: "example.internal".to_owned(),
            port: 22,
            username: "developer".to_owned(),
            environment: EnvironmentKind::Development,
            tags: vec!["api".to_owned()],
        }
    }

    #[test]
    fn rejects_empty_username() {
        let mut input = valid_input();
        input.username.clear();
        let error = validate_profile(&input).expect_err("username must be rejected");
        assert_eq!(error.field.as_deref(), Some("username"));
    }

    #[test]
    fn catalog_creates_non_secret_profile() {
        let catalog = ProfileCatalog::default();
        let profile = catalog
            .create(valid_input())
            .expect("profile should be created");
        assert!(profile.credential_ref.is_none());
        assert_eq!(catalog.list().expect("list should work").len(), 1);
    }
}
