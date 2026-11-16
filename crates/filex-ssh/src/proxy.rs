use std::{
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    time::{Duration, Instant},
};

use filex_contracts::{ProxyPreflightResult, SshKeyMetadataInspection};
use russh::keys::{HashAlg, PrivateKey};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use zeroize::Zeroizing;

use crate::{PRIVATE_KEY_MAX_BYTES, SshError};

const MAX_HTTP_CONNECT_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyProtocolKind {
    Socks5,
    HttpConnect,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProxyConnectionSpec {
    pub kind: ProxyProtocolKind,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
}

impl fmt::Debug for ProxyConnectionSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProxyConnectionSpec")
            .field("kind", &self.kind)
            .field("proxy_host", &self.proxy_host)
            .field("proxy_port", &self.proxy_port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub async fn inspect_private_key_file(
    path: &str,
    passphrase: Option<&str>,
) -> Result<SshKeyMetadataInspection, SshError> {
    let file = tokio::fs::File::open(Path::new(path))
        .await
        .map_err(|_| SshError::PrivateKeyFileUnavailable)?;
    let mut bounded_file = file.take((PRIVATE_KEY_MAX_BYTES + 1) as u64);
    let mut source = Zeroizing::new(Vec::with_capacity(64 * 1024));
    bounded_file
        .read_to_end(&mut source)
        .await
        .map_err(|_| SshError::PrivateKeyFileUnavailable)?;
    if source.len() > PRIVATE_KEY_MAX_BYTES {
        return Err(SshError::PrivateKeyTooLarge);
    }
    let Ok(source_text) = std::str::from_utf8(source.as_slice()) else {
        return Ok(unsupported_key_inspection());
    };

    let provided_passphrase = passphrase.filter(|value| !value.is_empty());
    match russh::keys::decode_secret_key(source_text, None) {
        Ok(key) => Ok(key_inspection_from_public(key.public_key(), false)),
        Err(russh::keys::Error::KeyIsEncrypted) => {
            if let Some(secret) = provided_passphrase {
                let decrypted = russh::keys::decode_secret_key(source_text, Some(secret))
                    .map_err(|_| SshError::PrivateKeyInvalid)?;
                return Ok(key_inspection_from_public(decrypted.public_key(), true));
            }
            if let Ok(parsed) = PrivateKey::from_openssh(source_text) {
                return Ok(key_inspection_from_public(parsed.public_key(), true));
            }
            Err(SshError::PrivateKeyPassphraseRequired)
        }
        Err(_) => Ok(unsupported_key_inspection()),
    }
}

fn key_inspection_from_public(
    public_key: &russh::keys::PublicKey,
    encrypted: bool,
) -> SshKeyMetadataInspection {
    SshKeyMetadataInspection {
        algorithm: public_key.algorithm().to_string(),
        fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
        encrypted,
        supported: true,
    }
}

fn unsupported_key_inspection() -> SshKeyMetadataInspection {
    SshKeyMetadataInspection {
        algorithm: "unsupported".to_owned(),
        fingerprint_sha256: String::new(),
        encrypted: false,
        supported: false,
    }
}

pub async fn connect_via_proxy(
    spec: &ProxyConnectionSpec,
    target_host: &str,
    target_port: u16,
    timeout: Duration,
) -> Result<TcpStream, SshError> {
    let target_host = target_host.trim();
    if target_host.is_empty()
        || target_host.len() > 253
        || target_port == 0
        || spec.proxy_host.trim().is_empty()
        || spec.proxy_port == 0
    {
        return Err(SshError::ProxyHandshakeFailed);
    }

    tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect((spec.proxy_host.trim(), spec.proxy_port))
            .await
            .map_err(|_| SshError::ProxyConnectFailed)?;
        let _ = stream.set_nodelay(true);
        match spec.kind {
            ProxyProtocolKind::Socks5 => {
                handshake_socks5(&mut stream, spec, target_host, target_port).await?;
            }
            ProxyProtocolKind::HttpConnect => {
                handshake_http_connect(&mut stream, spec, target_host, target_port).await?;
            }
        }
        Ok(stream)
    })
    .await
    .map_err(|_| SshError::ProxyTimeout)?
}

pub async fn probe_proxy_endpoint(
    spec: &ProxyConnectionSpec,
    timeout: Duration,
) -> Result<ProxyPreflightResult, SshError> {
    if spec.proxy_host.trim().is_empty() || spec.proxy_port == 0 {
        return Err(SshError::ProxyHandshakeFailed);
    }
    let started = Instant::now();
    let result = tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect((spec.proxy_host.trim(), spec.proxy_port))
            .await
            .map_err(|_| SshError::ProxyConnectFailed)?;
        let _ = stream.set_nodelay(true);
        match spec.kind {
            ProxyProtocolKind::Socks5 => {
                negotiate_socks5_auth(&mut stream, spec).await?;
                Ok::<&'static str, SshError>(if spec.username.is_some() {
                    "proxy.reachableSocks5Auth"
                } else {
                    "proxy.reachableSocks5"
                })
            }
            ProxyProtocolKind::HttpConnect => Ok::<&'static str, SshError>("proxy.reachableTcp"),
        }
    })
    .await
    .map_err(|_| SshError::ProxyTimeout)??;

    Ok(ProxyPreflightResult {
        ok: true,
        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        detail_code: result.to_owned(),
    })
}

async fn negotiate_socks5_auth(
    stream: &mut TcpStream,
    spec: &ProxyConnectionSpec,
) -> Result<(), SshError> {
    let username = spec
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let methods: &[u8] = if username.is_some() { &[0x02] } else { &[0x00] };

    let mut greeting = Vec::with_capacity(2 + methods.len());
    greeting.push(0x05);
    greeting.push(u8::try_from(methods.len()).map_err(|_| SshError::ProxyHandshakeFailed)?);
    greeting.extend_from_slice(methods);
    stream
        .write_all(&greeting)
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;
    stream
        .flush()
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;

    let mut method_reply = [0_u8; 2];
    stream
        .read_exact(&mut method_reply)
        .await
        .map_err(|_| SshError::ProxyHandshakeFailed)?;
    if method_reply[0] != 0x05 {
        return Err(SshError::ProxyHandshakeFailed);
    }
    match method_reply[1] {
        0x00 if username.is_none() => Ok(()),
        0x02 => {
            let user = username.ok_or(SshError::ProxyAuthenticationFailed)?;
            let password = spec
                .password
                .as_ref()
                .map(|secret| secret.as_str())
                .filter(|secret| !secret.is_empty())
                .ok_or(SshError::ProxyAuthenticationFailed)?;
            let user_bytes = user.as_bytes();
            let pass_bytes = password.as_bytes();
            if user_bytes.len() > 255 || pass_bytes.len() > 255 {
                return Err(SshError::ProxyAuthenticationFailed);
            }
            let mut auth_packet =
                Zeroizing::new(Vec::with_capacity(3 + user_bytes.len() + pass_bytes.len()));
            auth_packet.push(0x01);
            auth_packet.push(user_bytes.len() as u8);
            auth_packet.extend_from_slice(user_bytes);
            auth_packet.push(pass_bytes.len() as u8);
            auth_packet.extend_from_slice(pass_bytes);
            stream
                .write_all(&auth_packet)
                .await
                .map_err(|_| SshError::ProxyConnectFailed)?;
            stream
                .flush()
                .await
                .map_err(|_| SshError::ProxyConnectFailed)?;

            let mut auth_reply = [0_u8; 2];
            stream
                .read_exact(&mut auth_reply)
                .await
                .map_err(|_| SshError::ProxyHandshakeFailed)?;
            if auth_reply[0] != 0x01 {
                return Err(SshError::ProxyHandshakeFailed);
            }
            if auth_reply[1] != 0x00 {
                return Err(SshError::ProxyAuthenticationFailed);
            }
            Ok(())
        }
        0xFF => Err(SshError::ProxyAuthenticationFailed),
        _ => Err(SshError::ProxyHandshakeFailed),
    }
}

async fn handshake_socks5(
    stream: &mut TcpStream,
    spec: &ProxyConnectionSpec,
    target_host: &str,
    target_port: u16,
) -> Result<(), SshError> {
    negotiate_socks5_auth(stream, spec).await?;

    let mut request = Vec::with_capacity(6 + target_host.len());
    request.extend_from_slice(&[0x05, 0x01, 0x00]);
    if let Ok(ip) = target_host.parse::<Ipv4Addr>() {
        request.push(0x01);
        request.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = target_host.parse::<Ipv6Addr>() {
        request.push(0x04);
        request.extend_from_slice(&ip.octets());
    } else {
        let host_bytes = target_host.as_bytes();
        if host_bytes.is_empty() || host_bytes.len() > 255 {
            return Err(SshError::ProxyHandshakeFailed);
        }
        request.push(0x03);
        request.push(host_bytes.len() as u8);
        request.extend_from_slice(host_bytes);
    }
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;
    stream
        .flush()
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;

    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|_| SshError::ProxyHandshakeFailed)?;
    if header[0] != 0x05 {
        return Err(SshError::ProxyHandshakeFailed);
    }
    let atyp = header[3];
    let discard_len = match atyp {
        0x01 => 4 + 2,
        0x04 => 16 + 2,
        0x03 => {
            let mut domain_len = [0_u8; 1];
            stream
                .read_exact(&mut domain_len)
                .await
                .map_err(|_| SshError::ProxyHandshakeFailed)?;
            usize::from(domain_len[0]) + 2
        }
        _ => return Err(SshError::ProxyHandshakeFailed),
    };
    let mut discard = vec![0_u8; discard_len];
    stream
        .read_exact(&mut discard)
        .await
        .map_err(|_| SshError::ProxyHandshakeFailed)?;
    if header[1] != 0x00 {
        return Err(SshError::ProxyTargetRejected);
    }
    Ok(())
}

async fn handshake_http_connect(
    stream: &mut TcpStream,
    spec: &ProxyConnectionSpec,
    target_host: &str,
    target_port: u16,
) -> Result<(), SshError> {
    if target_host
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(SshError::ProxyHandshakeFailed);
    }
    let authority = match target_host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{target_host}]:{target_port}"),
        _ => format!("{target_host}:{target_port}"),
    };

    let mut request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n"
    ));
    if let Some(username) = spec
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if username.chars().any(char::is_control) {
            return Err(SshError::ProxyAuthenticationFailed);
        }
        let password = spec
            .password
            .as_ref()
            .map(|secret| secret.as_str())
            .unwrap_or("");
        if password.chars().any(char::is_control) {
            return Err(SshError::ProxyAuthenticationFailed);
        }
        let raw_credentials = Zeroizing::new(format!("{username}:{password}"));
        let encoded = Zeroizing::new(encode_base64(raw_credentials.as_bytes()));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;
    stream
        .flush()
        .await
        .map_err(|_| SshError::ProxyConnectFailed)?;

    // Read byte-by-byte until header terminator so SSH greeting bytes stay in the TCP buffer.
    let mut header_bytes = Vec::with_capacity(256);
    let mut single = [0_u8; 1];
    loop {
        if header_bytes.len() >= MAX_HTTP_CONNECT_RESPONSE_BYTES {
            return Err(SshError::ProxyHandshakeFailed);
        }
        let n = stream
            .read(&mut single)
            .await
            .map_err(|_| SshError::ProxyHandshakeFailed)?;
        if n == 0 {
            return Err(SshError::ProxyHandshakeFailed);
        }
        header_bytes.push(single[0]);
        if header_bytes.ends_with(b"\r\n\r\n") || header_bytes.ends_with(b"\n\n") {
            break;
        }
    }

    let header_text =
        std::str::from_utf8(&header_bytes).map_err(|_| SshError::ProxyHandshakeFailed)?;
    let status_line = header_text
        .lines()
        .next()
        .ok_or(SshError::ProxyHandshakeFailed)?;
    let mut parts = status_line.split_whitespace();
    let version = parts.next().ok_or(SshError::ProxyHandshakeFailed)?;
    if !version.starts_with("HTTP/1.") {
        return Err(SshError::ProxyHandshakeFailed);
    }
    let status: u16 = parts
        .next()
        .and_then(|code| code.parse().ok())
        .ok_or(SshError::ProxyHandshakeFailed)?;
    match status {
        200..=299 => Ok(()),
        407 => Err(SshError::ProxyAuthenticationFailed),
        _ => Err(SshError::ProxyTargetRejected),
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    use russh::keys::{HashAlg, PrivateKey, ssh_key::LineEnding};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    use zeroize::Zeroizing;

    use super::{
        ProxyConnectionSpec, ProxyProtocolKind, connect_via_proxy, encode_base64,
        inspect_private_key_file, probe_proxy_endpoint,
    };
    use crate::{RusshEngine, SshError, tests::RunningFixture};

    struct TempDirGuard(PathBuf);

    impl TempDirGuard {
        fn create() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(1);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("filex-ssh-proxy-test-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn spawn_socks5_proxy(expected_auth: Option<(&'static str, &'static str)>) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("socks5 proxy binds");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let expected_auth = expected_auth;
                tokio::spawn(async move {
                    let mut greeting = [0_u8; 2];
                    if client.read_exact(&mut greeting).await.is_err() || greeting[0] != 0x05 {
                        return;
                    }
                    let mut methods = vec![0_u8; usize::from(greeting[1])];
                    if client.read_exact(&mut methods).await.is_err() {
                        return;
                    }
                    let chosen = match expected_auth {
                        Some(_) if methods.contains(&0x02) => 0x02,
                        None if methods.contains(&0x00) => 0x00,
                        _ => {
                            let _ = client.write_all(&[0x05, 0xFF]).await;
                            return;
                        }
                    };
                    if client.write_all(&[0x05, chosen]).await.is_err() {
                        return;
                    }
                    if chosen == 0x02 {
                        let (expected_user, expected_pass) = expected_auth.expect("auth");
                        let mut hdr = [0_u8; 2];
                        if client.read_exact(&mut hdr).await.is_err() {
                            return;
                        }
                        let mut user = vec![0_u8; usize::from(hdr[1])];
                        if client.read_exact(&mut user).await.is_err() {
                            return;
                        }
                        let mut plen = [0_u8; 1];
                        if client.read_exact(&mut plen).await.is_err() {
                            return;
                        }
                        let mut pass = vec![0_u8; usize::from(plen[0])];
                        if client.read_exact(&mut pass).await.is_err() {
                            return;
                        }
                        let valid =
                            user == expected_user.as_bytes() && pass == expected_pass.as_bytes();
                        let _ = client
                            .write_all(&[0x01, if valid { 0x00 } else { 0x01 }])
                            .await;
                        if !valid {
                            return;
                        }
                    }

                    let mut req = [0_u8; 4];
                    if client.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let target_host = match req[3] {
                        0x01 => {
                            let mut ip = [0_u8; 4];
                            if client.read_exact(&mut ip).await.is_err() {
                                return;
                            }
                            std::net::Ipv4Addr::from(ip).to_string()
                        }
                        0x03 => {
                            let mut len = [0_u8; 1];
                            if client.read_exact(&mut len).await.is_err() {
                                return;
                            }
                            let mut host = vec![0_u8; usize::from(len[0])];
                            if client.read_exact(&mut host).await.is_err() {
                                return;
                            }
                            String::from_utf8_lossy(&host).into_owned()
                        }
                        _ => return,
                    };
                    let mut pbytes = [0_u8; 2];
                    if client.read_exact(&mut pbytes).await.is_err() {
                        return;
                    }
                    let target_port = u16::from_be_bytes(pbytes);
                    match TcpStream::connect((target_host.as_str(), target_port)).await {
                        Ok(mut upstream) => {
                            let _ = client
                                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0])
                                .await;
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                        }
                        Err(_) => {
                            let _ = client
                                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                                .await;
                        }
                    }
                });
            }
        });
        port
    }

    async fn spawn_http_connect_proxy(expected_auth: Option<(&'static str, &'static str)>) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("http proxy binds");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let expected_auth = expected_auth;
                tokio::spawn(async move {
                    let mut req_buf = Vec::new();
                    let mut byte = [0_u8; 1];
                    while !req_buf.ends_with(b"\r\n\r\n") {
                        if client.read_exact(&mut byte).await.is_err() {
                            return;
                        }
                        req_buf.push(byte[0]);
                    }
                    let text = String::from_utf8_lossy(&req_buf);
                    let mut lines = text.lines();
                    let request_line = lines.next().unwrap_or("");
                    let authority = request_line.split_whitespace().nth(1).unwrap_or("");
                    if let Some((u, p)) = expected_auth {
                        let expected_header =
                            format!("Basic {}", encode_base64(format!("{u}:{p}").as_bytes()));
                        let authorized = text.lines().any(|line| {
                            line.to_ascii_lowercase()
                                .starts_with("proxy-authorization:")
                                && line.contains(&expected_header)
                        });
                        if !authorized {
                            let _ = client
                                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
                                .await;
                            return;
                        }
                    }
                    match TcpStream::connect(authority).await {
                        Ok(mut upstream) => {
                            let _ = client
                                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                                .await;
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                        }
                        Err(_) => {
                            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                        }
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn inspects_unencrypted_and_encrypted_openssh_keys() {
        let dir = TempDirGuard::create();
        let raw_key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("generate ed25519 key");
        let expected_fp = raw_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();

        let plain_path = dir.0.join("id_plain");
        tokio::fs::write(
            &plain_path,
            raw_key
                .to_openssh(LineEnding::LF)
                .expect("openssh encode")
                .as_bytes(),
        )
        .await
        .expect("write plain key");
        let plain_info = inspect_private_key_file(plain_path.to_str().expect("utf8"), None)
            .await
            .expect("inspect plain");
        assert!(plain_info.supported);
        assert!(!plain_info.encrypted);
        assert_eq!(plain_info.fingerprint_sha256, expected_fp);

        let encrypted = raw_key
            .encrypt(&mut rand::rng(), "passphrase-42")
            .expect("encrypt key");
        let enc_path = dir.0.join("id_enc");
        tokio::fs::write(
            &enc_path,
            encrypted
                .to_openssh(LineEnding::LF)
                .expect("enc encode")
                .as_bytes(),
        )
        .await
        .expect("write enc key");

        let enc_no_pass = inspect_private_key_file(enc_path.to_str().expect("utf8"), None)
            .await
            .expect("inspect encrypted metadata without passphrase");
        assert!(enc_no_pass.supported);
        assert!(enc_no_pass.encrypted);
        assert_eq!(enc_no_pass.fingerprint_sha256, expected_fp);

        let wrong_pass =
            inspect_private_key_file(enc_path.to_str().expect("utf8"), Some("wrong")).await;
        assert!(matches!(wrong_pass, Err(SshError::PrivateKeyInvalid)));

        let ok_pass =
            inspect_private_key_file(enc_path.to_str().expect("utf8"), Some("passphrase-42"))
                .await
                .expect("inspect encrypted with valid passphrase");
        assert!(ok_pass.encrypted);
        assert_eq!(ok_pass.fingerprint_sha256, expected_fp);

        let garbage_path = dir.0.join("not_a_key.txt");
        tokio::fs::write(&garbage_path, b"not a valid openssh key")
            .await
            .expect("write garbage");
        let garbage = inspect_private_key_file(garbage_path.to_str().expect("utf8"), None)
            .await
            .expect("unsupported result");
        assert!(!garbage.supported);
    }

    #[tokio::test]
    async fn tunnels_ssh_through_socks5_and_http_connect_proxies() {
        let server = RunningFixture::spawn().await;
        let engine = RusshEngine::with_options(Duration::from_secs(5), None);
        let timeout = Duration::from_secs(5);

        let socks_port = spawn_socks5_proxy(Some(("alice", "s3cr3t"))).await;
        let bad_socks = ProxyConnectionSpec {
            kind: ProxyProtocolKind::Socks5,
            proxy_host: "127.0.0.1".to_owned(),
            proxy_port: socks_port,
            username: Some("alice".to_owned()),
            password: Some(Zeroizing::new("wrong".to_owned())),
        };
        assert!(matches!(
            probe_proxy_endpoint(&bad_socks, timeout).await,
            Err(SshError::ProxyAuthenticationFailed)
        ));

        let good_socks = ProxyConnectionSpec {
            password: Some(Zeroizing::new("s3cr3t".to_owned())),
            ..bad_socks
        };
        let preflight = probe_proxy_endpoint(&good_socks, timeout)
            .await
            .expect("socks5 preflight");
        assert!(preflight.ok);
        assert_eq!(preflight.detail_code, "proxy.reachableSocks5Auth");

        let probe_stream = connect_via_proxy(&good_socks, "127.0.0.1", server.port, timeout)
            .await
            .expect("dial ssh via socks5 for probe");
        let host_key = engine
            .probe_host_key_stream(probe_stream)
            .await
            .expect("probe host key through socks5");

        let ssh_stream = connect_via_proxy(&good_socks, "127.0.0.1", server.port, timeout)
            .await
            .expect("dial ssh via socks5");
        let session = engine
            .connect_password_stream(
                ssh_stream,
                "fixture-user",
                "fixture-password",
                host_key.clone(),
            )
            .await
            .expect("ssh password auth via socks5");
        let result = session
            .execute_bounded_with_stdin("echo socks-ok", b"", 4096, Duration::from_secs(5))
            .await
            .expect("exec via socks5");
        assert_eq!(result.stdout, b"cmd=echo socks-ok;stdin=");
        let _ = session.disconnect().await;

        let http_port = spawn_http_connect_proxy(Some(("bob", "hunter2"))).await;
        let bad_http = ProxyConnectionSpec {
            kind: ProxyProtocolKind::HttpConnect,
            proxy_host: "127.0.0.1".to_owned(),
            proxy_port: http_port,
            username: Some("bob".to_owned()),
            password: Some(Zeroizing::new("nope".to_owned())),
        };
        assert!(matches!(
            connect_via_proxy(&bad_http, "127.0.0.1", server.port, timeout).await,
            Err(SshError::ProxyAuthenticationFailed)
        ));

        let good_http = ProxyConnectionSpec {
            password: Some(Zeroizing::new("hunter2".to_owned())),
            ..bad_http
        };
        let http_probe_stream = connect_via_proxy(&good_http, "127.0.0.1", server.port, timeout)
            .await
            .expect("dial ssh via http connect for probe");
        let http_key = engine
            .probe_host_key_stream(http_probe_stream)
            .await
            .expect("probe host key through http connect");
        assert_eq!(http_key, host_key);

        let http_ssh_stream = connect_via_proxy(&good_http, "127.0.0.1", server.port, timeout)
            .await
            .expect("dial ssh via http connect");
        let http_session = engine
            .connect_password_stream(
                http_ssh_stream,
                "fixture-user",
                "fixture-password",
                http_key,
            )
            .await
            .expect("ssh auth via http connect");
        let result2 = http_session
            .execute_bounded_with_stdin("echo http-ok", b"", 4096, Duration::from_secs(5))
            .await
            .expect("exec via http connect");
        assert_eq!(result2.stdout, b"cmd=echo http-ok;stdin=");
        let _ = http_session.disconnect().await;

        server.shutdown().await;
    }
}
