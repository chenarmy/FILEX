use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    net::{Ipv4Addr, Ipv6Addr},
    path::Path,
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use filex_contracts::{
    AppError, KnownHostsImportCandidate, KnownHostsImportPreview, KnownHostsImportWarning,
    KnownHostsImportWarningKind, RemoteState,
};
use sha2::{Digest, Sha256};

const KNOWN_HOSTS_IMPORT_MAX_BYTES: usize = 2 * 1024 * 1024;
const KNOWN_HOSTS_IMPORT_MAX_CANDIDATES: usize = 5_000;
const SSH_KEY_BLOB_MAX_BYTES: usize = 64 * 1024;
const KEY_ALGORITHM_MAX_BYTES: usize = 128;

pub fn preview_file(path: &Path) -> Result<KnownHostsImportPreview, AppError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| import_error("TRUST_IMPORT_FILE_INVALID", "errors.trustImportFileInvalid"))?;
    if !metadata.file_type().is_file() {
        return Err(import_error(
            "TRUST_IMPORT_FILE_INVALID",
            "errors.trustImportFileInvalid",
        ));
    }
    if metadata.len() > KNOWN_HOSTS_IMPORT_MAX_BYTES as u64 {
        return Err(import_error(
            "TRUST_IMPORT_FILE_TOO_LARGE",
            "errors.trustImportFileTooLarge",
        ));
    }

    let file = fs::File::open(path)
        .map_err(|_| import_error("TRUST_IMPORT_FILE_INVALID", "errors.trustImportFileInvalid"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(KNOWN_HOSTS_IMPORT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| import_error("TRUST_IMPORT_FILE_INVALID", "errors.trustImportFileInvalid"))?;
    if bytes.len() > KNOWN_HOSTS_IMPORT_MAX_BYTES {
        return Err(import_error(
            "TRUST_IMPORT_FILE_TOO_LARGE",
            "errors.trustImportFileTooLarge",
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        import_error(
            "TRUST_IMPORT_FILE_ENCODING",
            "errors.trustImportFileEncoding",
        )
    })?;
    if text.contains('\0') {
        return Err(import_error(
            "TRUST_IMPORT_FILE_ENCODING",
            "errors.trustImportFileEncoding",
        ));
    }

    let (candidates, warnings) = parse_known_hosts(&text)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "known_hosts".to_owned());
    Ok(KnownHostsImportPreview {
        file_name,
        candidates,
        warnings,
    })
}

fn parse_known_hosts(
    text: &str,
) -> Result<(Vec<KnownHostsImportCandidate>, Vec<KnownHostsImportWarning>), AppError> {
    let mut entries = HashMap::<(String, u16, String), KnownHostsImportCandidate>::new();
    let mut conflicting = HashSet::<(String, u16, String)>::new();
    let mut warning_counts = HashMap::<KnownHostsImportWarningKind, u32>::new();

    for (line_index, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 3 {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::InvalidEntry,
            );
            continue;
        }
        if fields[0].starts_with('@') {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::MarkedEntry,
            );
            continue;
        }

        let declared_algorithm = fields[1];
        if declared_algorithm.ends_with("-cert-v01@openssh.com") {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::UnsupportedKey,
            );
            continue;
        }
        let key_blob = match STANDARD.decode(fields[2]) {
            Ok(blob) if !blob.is_empty() && blob.len() <= SSH_KEY_BLOB_MAX_BYTES => blob,
            _ => {
                add_warning(
                    &mut warning_counts,
                    KnownHostsImportWarningKind::InvalidEntry,
                );
                continue;
            }
        };
        let Some(blob_algorithm) = ssh_blob_algorithm(&key_blob) else {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::InvalidEntry,
            );
            continue;
        };
        if blob_algorithm != declared_algorithm {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::InvalidEntry,
            );
            continue;
        }
        if declared_algorithm.is_empty()
            || declared_algorithm.len() > KEY_ALGORITHM_MAX_BYTES
            || !declared_algorithm.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@' | b'+')
            })
        {
            add_warning(
                &mut warning_counts,
                KnownHostsImportWarningKind::UnsupportedKey,
            );
            continue;
        }

        let fingerprint_sha256 = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(&key_blob))
        );
        for host_pattern in fields[0].split(',') {
            if host_pattern.starts_with('|') {
                add_warning(&mut warning_counts, KnownHostsImportWarningKind::HashedHost);
                continue;
            }
            if host_pattern
                .chars()
                .any(|character| matches!(character, '*' | '?' | '!'))
            {
                add_warning(
                    &mut warning_counts,
                    KnownHostsImportWarningKind::HostPattern,
                );
                continue;
            }
            let Some((host, port)) = parse_host_endpoint(host_pattern) else {
                add_warning(
                    &mut warning_counts,
                    KnownHostsImportWarningKind::InvalidEntry,
                );
                continue;
            };
            let key = (
                host.to_ascii_lowercase(),
                port,
                declared_algorithm.to_owned(),
            );
            if conflicting.contains(&key) {
                continue;
            }
            match entries.get(&key) {
                Some(existing) if existing.fingerprint_sha256 == fingerprint_sha256 => {}
                Some(_) => {
                    entries.remove(&key);
                    conflicting.insert(key);
                    add_warning(
                        &mut warning_counts,
                        KnownHostsImportWarningKind::ConflictingKey,
                    );
                }
                None => {
                    entries.insert(
                        key,
                        KnownHostsImportCandidate {
                            source_line: u32::try_from(line_index + 1).unwrap_or(u32::MAX),
                            host,
                            port,
                            algorithm: declared_algorithm.to_owned(),
                            fingerprint_sha256: fingerprint_sha256.clone(),
                            current_fingerprint_sha256: None,
                        },
                    );
                    if entries.len() + conflicting.len() > KNOWN_HOSTS_IMPORT_MAX_CANDIDATES {
                        return Err(import_error(
                            "TRUST_IMPORT_TOO_MANY",
                            "errors.trustImportTooMany",
                        ));
                    }
                }
            }
        }
    }

    let mut candidates = entries.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.source_line
            .cmp(&right.source_line)
            .then_with(|| left.host.cmp(&right.host))
            .then_with(|| left.port.cmp(&right.port))
            .then_with(|| left.algorithm.cmp(&right.algorithm))
    });
    let mut warnings = Vec::new();
    for kind in [
        KnownHostsImportWarningKind::HashedHost,
        KnownHostsImportWarningKind::HostPattern,
        KnownHostsImportWarningKind::MarkedEntry,
        KnownHostsImportWarningKind::UnsupportedKey,
        KnownHostsImportWarningKind::InvalidEntry,
        KnownHostsImportWarningKind::ConflictingKey,
    ] {
        if let Some(count) = warning_counts.remove(&kind) {
            warnings.push(KnownHostsImportWarning { kind, count });
        }
    }
    Ok((candidates, warnings))
}

fn parse_host_endpoint(token: &str) -> Option<(String, u16)> {
    if let Some(bracketed) = token.strip_prefix('[') {
        let close = bracketed.find(']')?;
        let raw_host = &bracketed[..close];
        let port_text = bracketed[close + 1..].strip_prefix(':')?;
        let port = port_text.parse::<u16>().ok().filter(|port| *port != 0)?;
        return normalize_host(raw_host).map(|host| (host, port));
    }
    if let Ok(address) = token.parse::<Ipv6Addr>() {
        return Some((address.to_string(), 22));
    }
    if token.contains(':') {
        return None;
    }
    normalize_host(token).map(|host| (host, 22))
}

fn normalize_host(host: &str) -> Option<String> {
    if let Ok(address) = host.parse::<Ipv4Addr>() {
        return Some(address.to_string());
    }
    if let Ok(address) = host.parse::<Ipv6Addr>() {
        return Some(address.to_string());
    }
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let valid = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    });
    valid.then(|| host.to_owned())
}

fn ssh_blob_algorithm(blob: &[u8]) -> Option<&str> {
    let length_bytes: [u8; 4] = blob.get(..4)?.try_into().ok()?;
    let length = usize::try_from(u32::from_be_bytes(length_bytes)).ok()?;
    if length == 0 || length > KEY_ALGORITHM_MAX_BYTES {
        return None;
    }
    std::str::from_utf8(blob.get(4..4 + length)?).ok()
}

fn add_warning(
    warning_counts: &mut HashMap<KnownHostsImportWarningKind, u32>,
    kind: KnownHostsImportWarningKind,
) {
    let count = warning_counts.entry(kind).or_default();
    *count = count.saturating_add(1);
}

fn import_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}
