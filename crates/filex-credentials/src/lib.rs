use std::fmt;

use filex_contracts::CredentialStoreStatus;
use keyring::v1::{Entry, Error as KeyringError};
use thiserror::Error;
use zeroize::Zeroizing;

const SERVICE_NAME: &str = "dev.filex.workbench";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialKind {
    Password,
    PrivateKeyPassphrase,
    ProviderToken,
}

impl CredentialKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKeyPassphrase => "key-passphrase",
            Self::ProviderToken => "provider-token",
        }
    }

    pub fn matches_reference(self, reference: &str) -> bool {
        let Some((kind, id)) = reference.split_once(':') else {
            return false;
        };
        kind == self.prefix() && uuid::Uuid::parse_str(id).is_ok()
    }
}

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    #[error("the credential reference is invalid")]
    InvalidReference,
    #[error("the credential was not found")]
    NotFound,
    #[error("the system credential store is locked")]
    Locked,
    #[error("the system credential store is unavailable")]
    Unavailable,
    #[error("the system credential store is unsupported")]
    Unsupported,
}

pub struct SecretLease(Zeroizing<String>);

impl SecretLease {
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretLease([REDACTED])")
    }
}

pub trait CredentialStore: Send + Sync {
    fn put(&self, kind: CredentialKind, secret: &str) -> Result<String, CredentialError>;
    fn get(&self, reference: &str) -> Result<SecretLease, CredentialError>;
    fn delete(&self, reference: &str) -> Result<(), CredentialError>;
    fn status(&self) -> CredentialStoreStatus;
}

#[derive(Debug, Default)]
pub struct SystemCredentialStore;

impl SystemCredentialStore {
    fn entry(reference: &str) -> Result<Entry, CredentialError> {
        validate_reference(reference)?;
        Entry::new(SERVICE_NAME, reference).map_err(map_keyring_error)
    }
}

impl CredentialStore for SystemCredentialStore {
    fn put(&self, kind: CredentialKind, secret: &str) -> Result<String, CredentialError> {
        let reference = format!("{}:{}", kind.prefix(), uuid::Uuid::new_v4());
        Self::entry(&reference)?
            .set_password(secret)
            .map_err(map_keyring_error)?;
        Ok(reference)
    }

    fn get(&self, reference: &str) -> Result<SecretLease, CredentialError> {
        let secret = Self::entry(reference)?
            .get_password()
            .map_err(map_keyring_error)?;
        Ok(SecretLease(Zeroizing::new(secret)))
    }

    fn delete(&self, reference: &str) -> Result<(), CredentialError> {
        Self::entry(reference)?
            .delete_credential()
            .map_err(map_keyring_error)
    }

    fn status(&self) -> CredentialStoreStatus {
        match Entry::store_status() {
            Ok(()) => CredentialStoreStatus::Available,
            Err(error) => match map_keyring_error_ref(error) {
                CredentialError::Locked => CredentialStoreStatus::Locked,
                CredentialError::Unsupported => CredentialStoreStatus::Unsupported,
                _ => CredentialStoreStatus::Unavailable,
            },
        }
    }
}

fn validate_reference(reference: &str) -> Result<(), CredentialError> {
    let Some((kind, id)) = reference.split_once(':') else {
        return Err(CredentialError::InvalidReference);
    };
    if !matches!(kind, "password" | "key-passphrase" | "provider-token")
        || uuid::Uuid::parse_str(id).is_err()
    {
        return Err(CredentialError::InvalidReference);
    }
    Ok(())
}

fn map_keyring_error(error: KeyringError) -> CredentialError {
    map_keyring_error_ref(&error)
}

fn map_keyring_error_ref(error: &KeyringError) -> CredentialError {
    match error {
        KeyringError::NoEntry => CredentialError::NotFound,
        KeyringError::NoStorageAccess(_) => CredentialError::Locked,
        KeyringError::NoDefaultStore
        | KeyringError::NotSupportedByStore(_)
        | KeyringError::Invalid(_, _) => CredentialError::Unsupported,
        _ => CredentialError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::{CredentialError, SecretLease, validate_reference};
    use zeroize::Zeroizing;

    #[test]
    fn rejects_arbitrary_credential_references() {
        assert_eq!(
            validate_reference("../../settings.json"),
            Err(CredentialError::InvalidReference)
        );
    }

    #[test]
    fn secret_debug_output_is_redacted() {
        let lease = SecretLease(Zeroizing::new("do-not-log-me".to_owned()));
        let debug = format!("{lease:?}");
        assert_eq!(debug, "SecretLease([REDACTED])");
        assert!(!debug.contains(lease.expose()));
    }
}
