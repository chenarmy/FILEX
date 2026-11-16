use std::sync::Arc;

use filex_contracts::{
    AppError, CreateProxyProfileInput, ProxyKind, ProxyProfile, RemoteState, RotateSshKeyInput,
    SshKeyEntry, SshKeyMetadataInspection, UpdateProxyProfileInput,
};

pub trait KeyLibraryRepository: Send + Sync {
    fn list(&self) -> Result<Vec<SshKeyEntry>, AppError>;
    fn get(&self, id: &str) -> Result<Option<SshKeyEntry>, AppError>;
    fn insert(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, AppError>;
    fn update(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, AppError>;
    fn delete(&self, id: &str) -> Result<bool, AppError>;
    fn count_profile_references(&self, id: &str) -> Result<usize, AppError>;
}

pub trait ProxyLibraryRepository: Send + Sync {
    fn list(&self) -> Result<Vec<ProxyProfile>, AppError>;
    fn get(&self, id: &str) -> Result<Option<ProxyProfile>, AppError>;
    fn insert(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, AppError>;
    fn update(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, AppError>;
    fn delete(&self, id: &str) -> Result<bool, AppError>;
    fn count_profile_references(&self, id: &str) -> Result<usize, AppError>;
}

pub struct SshKeyService {
    repository: Arc<dyn KeyLibraryRepository>,
}

impl SshKeyService {
    pub fn new(repository: Arc<dyn KeyLibraryRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<SshKeyEntry>, AppError> {
        self.repository.list()
    }

    pub fn get(&self, id: &str) -> Result<SshKeyEntry, AppError> {
        self.repository
            .get(id)?
            .ok_or_else(|| not_found_error("KEY_NOT_FOUND", "errors.sshKeyNotFound"))
    }

    pub fn register(
        &self,
        label: &str,
        key_path: &str,
        inspection: &SshKeyMetadataInspection,
        passphrase_ref: Option<String>,
    ) -> Result<SshKeyEntry, AppError> {
        let label = validate_label(label, "label")?;
        let key_path = validate_key_path(key_path, "keyPath")?;
        validate_inspection(inspection)?;
        let entry = SshKeyEntry {
            id: uuid::Uuid::new_v4().to_string(),
            label,
            key_path,
            algorithm: inspection.algorithm.trim().to_owned(),
            fingerprint_sha256: inspection.fingerprint_sha256.trim().to_owned(),
            has_passphrase: passphrase_ref.is_some(),
            passphrase_ref,
            created_at: String::new(),
            updated_at: String::new(),
        };
        self.repository.insert(&entry)
    }

    pub fn rotate(
        &self,
        input: &RotateSshKeyInput,
        inspection: &SshKeyMetadataInspection,
        passphrase_ref: Option<String>,
    ) -> Result<SshKeyEntry, AppError> {
        let mut existing = self.get(&input.key_id)?;
        if let Some(label) = input.label.as_deref() {
            existing.label = validate_label(label, "label")?;
        }
        existing.key_path = validate_key_path(&input.new_key_path, "newKeyPath")?;
        validate_inspection(inspection)?;
        existing.algorithm = inspection.algorithm.trim().to_owned();
        existing.fingerprint_sha256 = inspection.fingerprint_sha256.trim().to_owned();
        existing.has_passphrase = passphrase_ref.is_some();
        existing.passphrase_ref = passphrase_ref;
        self.repository.update(&existing)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        if !self.repository.delete(id)? {
            return Err(not_found_error("KEY_NOT_FOUND", "errors.sshKeyNotFound"));
        }
        Ok(())
    }

    pub fn count_references(&self, id: &str) -> Result<usize, AppError> {
        let _ = self.get(id)?;
        self.repository.count_profile_references(id)
    }
}

pub struct ProxyProfileService {
    repository: Arc<dyn ProxyLibraryRepository>,
}

impl ProxyProfileService {
    pub fn new(repository: Arc<dyn ProxyLibraryRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<ProxyProfile>, AppError> {
        self.repository.list()
    }

    pub fn get(&self, id: &str) -> Result<ProxyProfile, AppError> {
        self.repository.get(id)?.ok_or_else(|| {
            not_found_error("PROXY_PROFILE_NOT_FOUND", "errors.proxyProfileNotFound")
        })
    }

    pub fn create(
        &self,
        input: &CreateProxyProfileInput,
        credential_ref: Option<String>,
    ) -> Result<ProxyProfile, AppError> {
        let (label, host, port, username) = validate_proxy_fields(
            &input.label,
            &input.kind,
            &input.host,
            input.port,
            input.username.as_deref(),
            credential_ref.is_some() || input.password.as_deref().is_some_and(|p| !p.is_empty()),
        )?;
        let proxy = ProxyProfile {
            id: uuid::Uuid::new_v4().to_string(),
            label,
            kind: input.kind.clone(),
            host,
            port,
            username,
            has_password: credential_ref.is_some(),
            credential_ref,
            created_at: String::new(),
            updated_at: String::new(),
        };
        self.repository.insert(&proxy)
    }

    pub fn update(
        &self,
        input: &UpdateProxyProfileInput,
        credential_ref: Option<String>,
    ) -> Result<ProxyProfile, AppError> {
        let existing = self.get(&input.id)?;
        let has_secret =
            credential_ref.is_some() || input.password.as_deref().is_some_and(|p| !p.is_empty());
        let (label, host, port, username) = validate_proxy_fields(
            &input.label,
            &input.kind,
            &input.host,
            input.port,
            input.username.as_deref(),
            has_secret,
        )?;
        let updated = ProxyProfile {
            id: existing.id,
            label,
            kind: input.kind.clone(),
            host,
            port,
            username,
            has_password: credential_ref.is_some(),
            credential_ref,
            created_at: existing.created_at,
            updated_at: existing.updated_at,
        };
        self.repository.update(&updated)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        if !self.repository.delete(id)? {
            return Err(not_found_error(
                "PROXY_PROFILE_NOT_FOUND",
                "errors.proxyProfileNotFound",
            ));
        }
        Ok(())
    }

    pub fn count_references(&self, id: &str) -> Result<usize, AppError> {
        let _ = self.get(id)?;
        self.repository.count_profile_references(id)
    }
}

pub fn validate_proxy_secret_input(
    kind: &ProxyKind,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), AppError> {
    let trimmed_user = username.map(str::trim).filter(|value| !value.is_empty());
    let has_password = password.is_some_and(|value| !value.is_empty());
    if has_password && trimmed_user.is_none() {
        return Err(validation_error(
            "proxy.usernameRequiredForPassword",
            "username",
        ));
    }
    if let Some(user) = trimmed_user {
        if user.len() > 255 || user.chars().any(char::is_control) {
            return Err(validation_error("proxy.usernameInvalid", "username"));
        }
    }
    if let Some(secret) = password.filter(|value| !value.is_empty()) {
        let max_bytes = match kind {
            ProxyKind::Socks5 => 255,
            ProxyKind::HttpConnect => 1024,
        };
        if secret.len() > max_bytes || secret.chars().any(char::is_control) {
            return Err(validation_error("proxy.passwordInvalid", "password"));
        }
    }
    Ok(())
}

fn validate_label(raw: &str, field: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 || trimmed.chars().any(char::is_control)
    {
        return Err(validation_error("errors.validationFailed", field));
    }
    Ok(trimmed.to_owned())
}

fn validate_key_path(raw: &str, field: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.chars().any(|ch| ch == '\0') {
        return Err(validation_error("profile.privateKeyPathRequired", field));
    }
    Ok(trimmed.to_owned())
}

fn validate_inspection(inspection: &SshKeyMetadataInspection) -> Result<(), AppError> {
    if !inspection.supported
        || inspection.algorithm.trim().is_empty()
        || !super::valid_sha256_fingerprint(inspection.fingerprint_sha256.trim())
    {
        return Err(AppError {
            code: "SSH_KEY_UNSUPPORTED".to_owned(),
            message_key: "errors.sshKeyUnsupported".to_owned(),
            retryable: false,
            remote_state: RemoteState::NotApplicable,
            field: Some("keyPath".to_owned()),
        });
    }
    Ok(())
}

fn validate_proxy_fields(
    label: &str,
    kind: &ProxyKind,
    host: &str,
    port: u16,
    username: Option<&str>,
    has_secret: bool,
) -> Result<(String, String, u16, Option<String>), AppError> {
    let label = validate_label(label, "label")?;
    let host = host.trim();
    if !super::valid_host(host) {
        return Err(validation_error("profile.hostInvalid", "host"));
    }
    if port == 0 {
        return Err(validation_error("profile.portInvalid", "port"));
    }
    let normalized_user = username
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if has_secret && normalized_user.is_none() {
        return Err(validation_error(
            "proxy.usernameRequiredForPassword",
            "username",
        ));
    }
    if let Some(user) = normalized_user.as_deref() {
        if user.len() > 255 || user.chars().any(char::is_control) {
            return Err(validation_error("proxy.usernameInvalid", "username"));
        }
    }
    if matches!(kind, ProxyKind::Socks5) && normalized_user.is_some() && !has_secret {
        return Err(validation_error("proxy.socksPasswordRequired", "password"));
    }
    Ok((label, host.to_owned(), port, normalized_user))
}

fn validation_error(message_key: &str, field: &str) -> AppError {
    AppError {
        code: "VALIDATION_FAILED".to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some(field.to_owned()),
    }
}

fn not_found_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use filex_contracts::{
        CreateProxyProfileInput, ProxyKind, ProxyProfile, RotateSshKeyInput, SshKeyEntry,
        SshKeyMetadataInspection, UpdateProxyProfileInput,
    };

    use super::{
        KeyLibraryRepository, ProxyLibraryRepository, ProxyProfileService, SshKeyService,
        validate_proxy_secret_input,
    };

    #[derive(Default)]
    struct MemoryKeyRepo {
        entries: Mutex<Vec<SshKeyEntry>>,
    }

    impl KeyLibraryRepository for MemoryKeyRepo {
        fn list(&self) -> Result<Vec<SshKeyEntry>, filex_contracts::AppError> {
            Ok(self.entries.lock().expect("keys").clone())
        }

        fn get(&self, id: &str) -> Result<Option<SshKeyEntry>, filex_contracts::AppError> {
            Ok(self
                .entries
                .lock()
                .expect("keys")
                .iter()
                .find(|entry| entry.id == id)
                .cloned())
        }

        fn insert(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, filex_contracts::AppError> {
            let mut created = entry.clone();
            created.created_at = "2026-11-15T00:00:00Z".to_owned();
            created.updated_at = created.created_at.clone();
            self.entries.lock().expect("keys").push(created.clone());
            Ok(created)
        }

        fn update(&self, entry: &SshKeyEntry) -> Result<SshKeyEntry, filex_contracts::AppError> {
            let mut guard = self.entries.lock().expect("keys");
            let slot = guard
                .iter_mut()
                .find(|item| item.id == entry.id)
                .expect("existing");
            let mut updated = entry.clone();
            updated.updated_at = "2026-11-15T01:00:00Z".to_owned();
            *slot = updated.clone();
            Ok(updated)
        }

        fn delete(&self, id: &str) -> Result<bool, filex_contracts::AppError> {
            let mut guard = self.entries.lock().expect("keys");
            let before = guard.len();
            guard.retain(|item| item.id != id);
            Ok(guard.len() != before)
        }

        fn count_profile_references(&self, _id: &str) -> Result<usize, filex_contracts::AppError> {
            Ok(0)
        }
    }

    #[derive(Default)]
    struct MemoryProxyRepo {
        entries: Mutex<Vec<ProxyProfile>>,
    }

    impl ProxyLibraryRepository for MemoryProxyRepo {
        fn list(&self) -> Result<Vec<ProxyProfile>, filex_contracts::AppError> {
            Ok(self.entries.lock().expect("proxies").clone())
        }

        fn get(&self, id: &str) -> Result<Option<ProxyProfile>, filex_contracts::AppError> {
            Ok(self
                .entries
                .lock()
                .expect("proxies")
                .iter()
                .find(|entry| entry.id == id)
                .cloned())
        }

        fn insert(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, filex_contracts::AppError> {
            let mut created = proxy.clone();
            created.created_at = "2026-11-15T00:00:00Z".to_owned();
            created.updated_at = created.created_at.clone();
            self.entries.lock().expect("proxies").push(created.clone());
            Ok(created)
        }

        fn update(&self, proxy: &ProxyProfile) -> Result<ProxyProfile, filex_contracts::AppError> {
            let mut guard = self.entries.lock().expect("proxies");
            let slot = guard
                .iter_mut()
                .find(|item| item.id == proxy.id)
                .expect("existing");
            let mut updated = proxy.clone();
            updated.updated_at = "2026-11-15T01:00:00Z".to_owned();
            *slot = updated.clone();
            Ok(updated)
        }

        fn delete(&self, id: &str) -> Result<bool, filex_contracts::AppError> {
            let mut guard = self.entries.lock().expect("proxies");
            let before = guard.len();
            guard.retain(|item| item.id != id);
            Ok(guard.len() != before)
        }

        fn count_profile_references(&self, _id: &str) -> Result<usize, filex_contracts::AppError> {
            Ok(0)
        }
    }

    fn valid_inspection() -> SshKeyMetadataInspection {
        SshKeyMetadataInspection {
            algorithm: "ssh-ed25519".to_owned(),
            fingerprint_sha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_owned(),
            encrypted: false,
            supported: true,
        }
    }

    #[test]
    fn key_service_registers_rotates_and_rejects_unsupported_keys() {
        let service = SshKeyService::new(Arc::new(MemoryKeyRepo::default()));
        let bad = service.register(
            "Bad Key",
            "/tmp/bad",
            &SshKeyMetadataInspection {
                supported: false,
                ..valid_inspection()
            },
            None,
        );
        assert_eq!(bad.expect_err("must reject").code, "SSH_KEY_UNSUPPORTED");

        let created = service
            .register(
                "Prod Ed25519",
                "/keys/id_ed25519",
                &valid_inspection(),
                Some("filex-key-1".to_owned()),
            )
            .expect("register succeeds");
        assert!(created.has_passphrase);

        let rotated = service
            .rotate(
                &RotateSshKeyInput {
                    key_id: created.id.clone(),
                    label: Some("Prod Ed25519 v2".to_owned()),
                    new_key_path: "/keys/id_ed25519_v2".to_owned(),
                    passphrase: None,
                    save_passphrase: false,
                },
                &SshKeyMetadataInspection {
                    fingerprint_sha256: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                        .to_owned(),
                    ..valid_inspection()
                },
                None,
            )
            .expect("rotate succeeds");
        assert_eq!(rotated.label, "Prod Ed25519 v2");
        assert!(!rotated.has_passphrase);
        assert_eq!(rotated.key_path, "/keys/id_ed25519_v2");
    }

    #[test]
    fn proxy_service_validates_endpoints_and_credentials() {
        let service = ProxyProfileService::new(Arc::new(MemoryProxyRepo::default()));
        let invalid = service.create(
            &CreateProxyProfileInput {
                label: "Broken Proxy".to_owned(),
                kind: ProxyKind::Socks5,
                host: "bad host".to_owned(),
                port: 1080,
                username: None,
                password: None,
                save_password: false,
            },
            None,
        );
        assert!(invalid.is_err());

        let socks_missing_pass = service.create(
            &CreateProxyProfileInput {
                label: "Corp SOCKS5".to_owned(),
                kind: ProxyKind::Socks5,
                host: "proxy.internal".to_owned(),
                port: 1080,
                username: Some("alice".to_owned()),
                password: None,
                save_password: false,
            },
            None,
        );
        assert_eq!(
            socks_missing_pass
                .expect_err("socks user requires password")
                .field
                .as_deref(),
            Some("password")
        );

        let crlf_error =
            validate_proxy_secret_input(&ProxyKind::HttpConnect, Some("user"), Some("bad\r\n"));
        assert!(crlf_error.is_err());

        let created = service
            .create(
                &CreateProxyProfileInput {
                    label: "Corp HTTP Proxy".to_owned(),
                    kind: ProxyKind::HttpConnect,
                    host: "127.0.0.1".to_owned(),
                    port: 8080,
                    username: Some("alice".to_owned()),
                    password: Some("secret".to_owned()),
                    save_password: true,
                },
                Some("filex-proxy-cred-1".to_owned()),
            )
            .expect("proxy creates");
        assert!(created.has_password);

        let updated = service
            .update(
                &UpdateProxyProfileInput {
                    id: created.id.clone(),
                    label: "Corp HTTP Direct".to_owned(),
                    kind: ProxyKind::HttpConnect,
                    host: "::1".to_owned(),
                    port: 3128,
                    username: None,
                    password: None,
                    save_password: false,
                    clear_password: true,
                },
                None,
            )
            .expect("proxy updates");
        assert!(!updated.has_password);
        assert_eq!(updated.host, "::1");
    }
}
