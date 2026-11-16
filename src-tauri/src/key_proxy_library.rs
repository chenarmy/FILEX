use std::time::Duration;

use filex_contracts::{
    AppError, ConnectionProfile, CreateProxyProfileInput, ProxyKind, ProxyPreflightResult,
    ProxyProfile, RegisterSshKeyInput, RemoteState, RotateSshKeyInput, SshKeyEntry,
    SshKeyMetadataInspection, UpdateProxyProfileInput,
};
use filex_core::{ProxyProfileService, SshKeyService, validate_proxy_secret_input};
use filex_credentials::{CredentialKind, CredentialStore, SystemCredentialStore};
use filex_ssh::{
    ProxyConnectionSpec, ProxyProtocolKind, inspect_private_key_file, probe_proxy_endpoint,
};
use zeroize::Zeroizing;

pub(crate) fn resolve_route_key_paths(
    route: &mut [ConnectionProfile],
    keys: &SshKeyService,
) -> Result<(), AppError> {
    for profile in route {
        if let Some(key_id) = profile
            .key_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            let entry = keys.get(key_id)?;
            profile.identity_file = Some(entry.key_path);
        }
    }
    Ok(())
}

pub(crate) fn resolve_proxy_spec(
    proxy_profile_id: Option<&str>,
    proxies: &ProxyProfileService,
    credentials: &SystemCredentialStore,
) -> Result<Option<ProxyConnectionSpec>, AppError> {
    let Some(proxy_id) = proxy_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let proxy = proxies.get(proxy_id)?;
    build_proxy_spec(&proxy, credentials).map(Some)
}

fn build_proxy_spec(
    proxy: &ProxyProfile,
    credentials: &SystemCredentialStore,
) -> Result<ProxyConnectionSpec, AppError> {
    let password = match proxy.credential_ref.as_deref() {
        Some(reference) => {
            if !CredentialKind::ProxyPassword.matches_reference(reference) {
                return Err(crate::credential_type_mismatch_error());
            }
            let secret = credentials
                .get(reference)
                .map_err(|error| crate::map_credential_error(&error))?;
            Some(Zeroizing::new(secret.expose().to_owned()))
        }
        None => None,
    };
    Ok(ProxyConnectionSpec {
        kind: match proxy.kind {
            ProxyKind::Socks5 => ProxyProtocolKind::Socks5,
            ProxyKind::HttpConnect => ProxyProtocolKind::HttpConnect,
        },
        proxy_host: proxy.host.clone(),
        proxy_port: proxy.port,
        username: proxy.username.clone(),
        password,
    })
}

fn validate_key_passphrase_length(passphrase: Option<&str>) -> Result<(), AppError> {
    if passphrase.is_some_and(|secret| secret.len() > crate::PRIVATE_KEY_PASSPHRASE_MAX_BYTES) {
        return Err(crate::private_key_passphrase_size_error());
    }
    Ok(())
}

fn empty_key_path_error() -> AppError {
    AppError {
        code: "SSH_PRIVATE_KEY_PATH_REQUIRED".to_owned(),
        message_key: "profile.privateKeyPathRequired".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("keyPath".to_owned()),
    }
}

fn passphrase_required_to_save_error() -> AppError {
    AppError {
        code: "CREDENTIAL_EMPTY".to_owned(),
        message_key: "errors.sshKeyPassphraseRequiredToSave".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("passphrase".to_owned()),
    }
}

fn store_optional_key_passphrase(
    save_passphrase: bool,
    passphrase: Option<&str>,
    credentials: &SystemCredentialStore,
) -> Result<Option<String>, AppError> {
    if !save_passphrase {
        return Ok(None);
    }
    let Some(secret) = passphrase.filter(|value| !value.is_empty()) else {
        return Err(passphrase_required_to_save_error());
    };
    let reference = credentials
        .put(CredentialKind::PrivateKeyPassphrase, secret)
        .map_err(|error| crate::map_credential_error(&error))?;
    Ok(Some(reference))
}

pub(crate) mod commands {
    use tauri::State;
    use zeroize::Zeroizing;

    use crate::OperationResult;
    use crate::session_runtime::ssh_error;

    use super::*;

    #[tauri::command]
    pub(crate) fn list_ssh_keys(
        keys: State<'_, SshKeyService>,
    ) -> OperationResult<Vec<SshKeyEntry>> {
        match keys.list() {
            Ok(entries) => OperationResult::success(entries),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) async fn inspect_ssh_key_file(
        key_path: String,
        passphrase: Option<String>,
    ) -> Result<OperationResult<SshKeyMetadataInspection>, ()> {
        let trimmed = key_path.trim().to_owned();
        if trimmed.is_empty() {
            return Ok(OperationResult::failure(empty_key_path_error()));
        }
        let secret = passphrase.map(Zeroizing::new);
        if let Err(error) =
            validate_key_passphrase_length(secret.as_ref().map(|value| value.as_str()))
        {
            return Ok(OperationResult::failure(error));
        }
        match inspect_private_key_file(&trimmed, secret.as_ref().map(|value| value.as_str())).await
        {
            Ok(inspection) => Ok(OperationResult::success(inspection)),
            Err(error) => Ok(OperationResult::failure(ssh_error(&error))),
        }
    }

    #[tauri::command]
    pub(crate) async fn register_ssh_key(
        input: RegisterSshKeyInput,
        keys: State<'_, SshKeyService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> Result<OperationResult<SshKeyEntry>, ()> {
        let trimmed_path = input.key_path.trim().to_owned();
        if trimmed_path.is_empty() {
            return Ok(OperationResult::failure(empty_key_path_error()));
        }
        let secret = input.passphrase.clone().map(Zeroizing::new);
        let secret_ref = secret.as_ref().map(|value| value.as_str());
        if let Err(error) = validate_key_passphrase_length(secret_ref) {
            return Ok(OperationResult::failure(error));
        }
        let inspection = match inspect_private_key_file(&trimmed_path, secret_ref).await {
            Ok(inspection) => inspection,
            Err(error) => return Ok(OperationResult::failure(ssh_error(&error))),
        };
        let passphrase_ref =
            match store_optional_key_passphrase(input.save_passphrase, secret_ref, &credentials) {
                Ok(reference) => reference,
                Err(error) => return Ok(OperationResult::failure(error)),
            };
        match keys.register(
            &input.label,
            &trimmed_path,
            &inspection,
            passphrase_ref.clone(),
        ) {
            Ok(entry) => Ok(OperationResult::success(entry)),
            Err(error) => {
                if let Some(reference) = passphrase_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                Ok(OperationResult::failure(error))
            }
        }
    }

    #[tauri::command]
    pub(crate) async fn rotate_ssh_key(
        input: RotateSshKeyInput,
        keys: State<'_, SshKeyService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> Result<OperationResult<SshKeyEntry>, ()> {
        let previous = match keys.get(&input.key_id) {
            Ok(entry) => entry,
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        let trimmed_path = input.new_key_path.trim().to_owned();
        if trimmed_path.is_empty() {
            return Ok(OperationResult::failure(empty_key_path_error()));
        }
        let secret = input.passphrase.clone().map(Zeroizing::new);
        let secret_ref = secret.as_ref().map(|value| value.as_str());
        if let Err(error) = validate_key_passphrase_length(secret_ref) {
            return Ok(OperationResult::failure(error));
        }
        let inspection = match inspect_private_key_file(&trimmed_path, secret_ref).await {
            Ok(inspection) => inspection,
            Err(error) => return Ok(OperationResult::failure(ssh_error(&error))),
        };
        let new_passphrase_ref =
            match store_optional_key_passphrase(input.save_passphrase, secret_ref, &credentials) {
                Ok(reference) => reference,
                Err(error) => return Ok(OperationResult::failure(error)),
            };
        match keys.rotate(&input, &inspection, new_passphrase_ref.clone()) {
            Ok(updated) => {
                if let Some(old_ref) = previous
                    .passphrase_ref
                    .as_deref()
                    .filter(|old| Some(*old) != new_passphrase_ref.as_deref())
                {
                    let _ = credentials.delete(old_ref);
                }
                Ok(OperationResult::success(updated))
            }
            Err(error) => {
                if let Some(reference) = new_passphrase_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                Ok(OperationResult::failure(error))
            }
        }
    }

    #[tauri::command]
    pub(crate) fn delete_ssh_key(
        key_id: String,
        keys: State<'_, SshKeyService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> OperationResult<()> {
        let existing = match keys.get(&key_id) {
            Ok(entry) => entry,
            Err(error) => return OperationResult::failure(error),
        };
        match keys.delete(&key_id) {
            Ok(()) => {
                if let Some(reference) = existing.passphrase_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                OperationResult::success(())
            }
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn count_ssh_key_references(
        key_id: String,
        keys: State<'_, SshKeyService>,
    ) -> OperationResult<usize> {
        match keys.count_references(&key_id) {
            Ok(count) => OperationResult::success(count),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn list_proxy_profiles(
        proxies: State<'_, ProxyProfileService>,
    ) -> OperationResult<Vec<ProxyProfile>> {
        match proxies.list() {
            Ok(list) => OperationResult::success(list),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn create_proxy_profile(
        input: CreateProxyProfileInput,
        proxies: State<'_, ProxyProfileService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> OperationResult<ProxyProfile> {
        let secret = input.password.clone().map(Zeroizing::new);
        let secret_ref = secret.as_ref().map(|value| value.as_str());
        if let Err(error) =
            validate_proxy_secret_input(&input.kind, input.username.as_deref(), secret_ref)
        {
            return OperationResult::failure(error);
        }
        let stored_ref = if input.save_password {
            match secret_ref.filter(|value| !value.is_empty()) {
                Some(password) => match credentials.put(CredentialKind::ProxyPassword, password) {
                    Ok(reference) => Some(reference),
                    Err(error) => {
                        return OperationResult::failure(crate::map_credential_error(&error));
                    }
                },
                None => None,
            }
        } else {
            None
        };
        match proxies.create(&input, stored_ref.clone()) {
            Ok(proxy) => OperationResult::success(proxy),
            Err(error) => {
                if let Some(reference) = stored_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                OperationResult::failure(error)
            }
        }
    }

    #[tauri::command]
    pub(crate) fn update_proxy_profile(
        input: UpdateProxyProfileInput,
        proxies: State<'_, ProxyProfileService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> OperationResult<ProxyProfile> {
        let existing = match proxies.get(&input.id) {
            Ok(proxy) => proxy,
            Err(error) => return OperationResult::failure(error),
        };
        let secret = input.password.clone().map(Zeroizing::new);
        let secret_ref = secret.as_ref().map(|value| value.as_str());
        if let Err(error) =
            validate_proxy_secret_input(&input.kind, input.username.as_deref(), secret_ref)
        {
            return OperationResult::failure(error);
        }

        let (effective_ref, created_new_ref) = if input.clear_password {
            (None, None)
        } else if input.save_password
            && let Some(password) = secret_ref.filter(|value| !value.is_empty())
        {
            match credentials.put(CredentialKind::ProxyPassword, password) {
                Ok(reference) => (Some(reference.clone()), Some(reference)),
                Err(error) => return OperationResult::failure(crate::map_credential_error(&error)),
            }
        } else {
            (existing.credential_ref.clone(), None)
        };

        match proxies.update(&input, effective_ref.clone()) {
            Ok(updated) => {
                if let Some(old_ref) = existing
                    .credential_ref
                    .as_deref()
                    .filter(|old| Some(*old) != effective_ref.as_deref())
                {
                    let _ = credentials.delete(old_ref);
                }
                OperationResult::success(updated)
            }
            Err(error) => {
                if let Some(reference) = created_new_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                OperationResult::failure(error)
            }
        }
    }

    #[tauri::command]
    pub(crate) fn delete_proxy_profile(
        proxy_id: String,
        proxies: State<'_, ProxyProfileService>,
        credentials: State<'_, SystemCredentialStore>,
    ) -> OperationResult<()> {
        let existing = match proxies.get(&proxy_id) {
            Ok(proxy) => proxy,
            Err(error) => return OperationResult::failure(error),
        };
        match proxies.delete(&proxy_id) {
            Ok(()) => {
                if let Some(reference) = existing.credential_ref.as_deref() {
                    let _ = credentials.delete(reference);
                }
                OperationResult::success(())
            }
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) fn count_proxy_references(
        proxy_id: String,
        proxies: State<'_, ProxyProfileService>,
    ) -> OperationResult<usize> {
        match proxies.count_references(&proxy_id) {
            Ok(count) => OperationResult::success(count),
            Err(error) => OperationResult::failure(error),
        }
    }

    #[tauri::command]
    pub(crate) async fn test_proxy_profile(
        proxy_id: String,
        proxies: State<'_, ProxyProfileService>,
        credentials: State<'_, SystemCredentialStore>,
        settings: State<'_, filex_core::SettingsService>,
    ) -> Result<OperationResult<ProxyPreflightResult>, ()> {
        let proxy = match proxies.get(&proxy_id) {
            Ok(proxy) => proxy,
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        let spec = match build_proxy_spec(&proxy, &credentials) {
            Ok(spec) => spec,
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        let timeout_secs = settings
            .load()
            .map(|item| u64::from(item.connection_timeout_seconds.max(3)))
            .unwrap_or(10);
        match probe_proxy_endpoint(&spec, Duration::from_secs(timeout_secs)).await {
            Ok(result) => Ok(OperationResult::success(result)),
            Err(error) => Ok(OperationResult::failure(ssh_error(&error))),
        }
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::{
        ConnectionProfile, ConnectionState, CreateProxyProfileInput, EnvironmentKind, ProxyKind,
        RegisterSshKeyInput, RotateSshKeyInput, UpdateProxyProfileInput,
    };

    #[test]
    fn redacts_passphrase_and_proxy_password_from_debug_output() {
        let reg = format!(
            "{:?}",
            RegisterSshKeyInput {
                label: "k1".to_owned(),
                key_path: "/keys/id_ed25519".to_owned(),
                passphrase: Some("super-secret-passphrase".to_owned()),
                save_passphrase: true,
            }
        );
        assert!(!reg.contains("super-secret-passphrase"));
        assert!(reg.contains("[REDACTED]"));

        let rot = format!(
            "{:?}",
            RotateSshKeyInput {
                key_id: "k1".to_owned(),
                label: None,
                new_key_path: "/keys/id_ed25519_next".to_owned(),
                passphrase: Some("rotated-secret".to_owned()),
                save_passphrase: true,
            }
        );
        assert!(!rot.contains("rotated-secret"));

        let create_proxy = format!(
            "{:?}",
            CreateProxyProfileInput {
                label: "p1".to_owned(),
                kind: ProxyKind::Socks5,
                host: "127.0.0.1".to_owned(),
                port: 1080,
                username: Some("alice".to_owned()),
                password: Some("proxy-secret-pw".to_owned()),
                save_password: true,
            }
        );
        assert!(!create_proxy.contains("proxy-secret-pw"));

        let update_proxy = format!(
            "{:?}",
            UpdateProxyProfileInput {
                id: "p1".to_owned(),
                label: "p1".to_owned(),
                kind: ProxyKind::HttpConnect,
                host: "127.0.0.1".to_owned(),
                port: 8080,
                username: Some("alice".to_owned()),
                password: Some("updated-secret-pw".to_owned()),
                save_password: true,
                clear_password: false,
            }
        );
        assert!(!update_proxy.contains("updated-secret-pw"));

        let mut profile = ConnectionProfile {
            id: "prof-1".to_owned(),
            name: "host".to_owned(),
            group: "dev".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 22,
            username: "op".to_owned(),
            environment: EnvironmentKind::Development,
            favorite: false,
            tags: Vec::new(),
            authentication_method: filex_contracts::AuthenticationMethod::PrivateKey,
            identity_file: None,
            key_id: Some("key-1".to_owned()),
            proxy_jump: None,
            proxy_jump_profile_ids: Vec::new(),
            proxy_profile_id: Some("proxy-1".to_owned()),
            credential_ref: None,
            state: ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
        };
        assert_eq!(profile.key_id.as_deref(), Some("key-1"));
        profile.key_id = None;
        assert!(profile.key_id.is_none());
    }
}
