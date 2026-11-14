use std::{
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use filex_contracts::HostTrustEvaluation;
use russh::{
    Channel, ChannelMsg, ChannelOpenFailure, ChannelReadHalf, ChannelWriteHalf, Disconnect,
    client::{self, ChannelOpenHandle, Config, Handler, Session},
    keys::{
        HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate,
        agent::{
            AgentIdentity,
            client::{AgentClient, AgentStream},
        },
    },
};
use russh_sftp::{
    client::{RawSftpSession, error::Error as SftpClientError},
    protocol::{FileAttributes, StatusCode},
};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

const PRIVATE_KEY_MAX_BYTES: usize = 1024 * 1024;
const MAX_AGENT_AUTH_ATTEMPTS: usize = 6;

type RemoteForwardRoutes =
    Arc<Mutex<std::collections::HashMap<(String, u32), mpsc::Sender<Channel<client::Msg>>>>>;
type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedHostKey {
    pub algorithm: String,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone)]
pub struct HostKeyProbeResult {
    pub presented: PresentedHostKey,
    pub trust: HostTrustEvaluation,
}

#[derive(Error, Debug)]
pub enum SshError {
    #[error("SSH operation timed out")]
    Timeout,
    #[error("the server did not present a host key")]
    HostKeyMissing,
    #[error("the presented host key was rejected")]
    HostKeyRejected,
    #[error("SSH authentication was rejected")]
    AuthenticationRejected,
    #[error("a compatible local SSH agent is unavailable")]
    AgentUnavailable,
    #[error("SSH agent authentication timed out")]
    AgentTimeout,
    #[error("the SSH agent does not support secure session binding")]
    AgentSessionBindingUnavailable,
    #[error("the SSH agent could not return its identity list")]
    AgentIdentityListFailed,
    #[error("the SSH agent has no identities loaded")]
    AgentNoIdentities,
    #[error("the SSH agent has more identities than FILEX will try for one connection")]
    AgentIdentityLimitExceeded,
    #[error("the SSH agent could not sign an authentication request")]
    AgentSigningFailed,
    #[error("private key file could not be read")]
    PrivateKeyFileUnavailable,
    #[error("private key file exceeds the configured size limit")]
    PrivateKeyTooLarge,
    #[error("private key requires a passphrase")]
    PrivateKeyPassphraseRequired,
    #[error("private key is invalid or its passphrase is incorrect")]
    PrivateKeyInvalid,
    #[error("SFTP subsystem failed")]
    Sftp,
    #[error("remote TCP/IP forwarding is unavailable")]
    RemoteForwardUnavailable,
    #[error("the SSH server denied remote TCP/IP forwarding")]
    RemoteForwardDenied,
    #[error("the SSH server denied cancellation of remote TCP/IP forwarding")]
    RemoteForwardCancelDenied,
    #[error("remote TCP/IP forwarding cancellation was not confirmed")]
    RemoteForwardCancelFailed,
    #[error("remote command output exceeded its configured bound")]
    OutputLimit,
    #[error("remote directory entry limit exceeded")]
    DirectoryEntryLimit,
    #[error("SFTP operation was cancelled")]
    Cancelled,
    #[error("SSH transport failed")]
    Transport(#[from] russh::Error),
}

#[derive(Clone)]
struct HostKeyHandler {
    expected: Option<PresentedHostKey>,
    presented: Arc<Mutex<Option<PresentedHostKey>>>,
    remote_forward_routes: RemoteForwardRoutes,
}

impl Handler for HostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public_key = server_public_key.public_key();
        let presented = PresentedHostKey {
            algorithm: public_key.algorithm().to_string(),
            fingerprint_sha256: public_key.fingerprint(HashAlg::Sha256).to_string(),
        };
        let accepted = self
            .expected
            .as_ref()
            .is_none_or(|expected| expected == &presented);
        if let Ok(mut slot) = self.presented.lock() {
            *slot = Some(presented);
        }
        Ok(accepted)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let route = self.remote_forward_routes.lock().ok().and_then(|routes| {
            routes
                .get(&(connected_address.to_owned(), connected_port))
                .cloned()
        });
        match route.map(|sender| sender.try_send(channel)) {
            Some(Ok(())) => reply.accept().await,
            Some(Err(mpsc::error::TrySendError::Full(_))) => {
                reply.reject(ChannelOpenFailure::ResourceShortage).await;
            }
            Some(Err(mpsc::error::TrySendError::Closed(_))) => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
            _ => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
        }
        Ok(())
    }
}

pub struct ConnectedSshSession {
    handle: client::Handle<HostKeyHandler>,
    remote_forward_routes: RemoteForwardRoutes,
    connect_timeout: Duration,
}

pub struct PreparedPrivateKey {
    key: Arc<russh::keys::PrivateKey>,
}

pub struct RemoteForwardReceiver {
    receiver: mpsc::Receiver<Channel<client::Msg>>,
}

impl RemoteForwardReceiver {
    pub async fn recv(&mut self) -> Option<russh::ChannelStream<client::Msg>> {
        self.receiver.recv().await.map(Channel::into_stream)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}

pub struct TerminalInput {
    channel: ChannelWriteHalf<client::Msg>,
}

pub struct TerminalOutput {
    channel: ChannelReadHalf,
}

pub struct SftpDirectoryEntry {
    pub name: String,
    pub attributes: FileAttributes,
}

pub struct SftpDirectoryReader {
    session: RawSftpSession,
}

impl SftpDirectoryReader {
    pub async fn read_dir_limited<F>(
        &self,
        path: &str,
        max_entries: usize,
        cancellation: F,
    ) -> Result<Vec<SftpDirectoryEntry>, SshError>
    where
        F: Future<Output = ()>,
    {
        tokio::pin!(cancellation);
        let handle = tokio::select! {
            biased;
            () = &mut cancellation => return Err(SshError::Cancelled),
            result = self.session.opendir(path.to_owned()) => result.map_err(|_| SshError::Sftp)?,
        };
        let result = async {
            let mut entries = Vec::with_capacity(max_entries.min(1_024));
            loop {
                let batch = tokio::select! {
                    biased;
                    () = &mut cancellation => Err(SshError::Cancelled),
                    result = self.session.readdir(handle.handle.clone()) => {
                        match result {
                            Ok(batch) => Ok(Some(batch)),
                            Err(SftpClientError::Status(status))
                                if status.status_code == StatusCode::Eof => Ok(None),
                            Err(_) => Err(SshError::Sftp),
                        }
                    }
                };
                let Some(batch) = batch? else {
                    break;
                };
                if batch.files.is_empty() {
                    return Err(SshError::Sftp);
                }
                for entry in batch.files {
                    if matches!(entry.filename.as_str(), "." | "..") {
                        continue;
                    }
                    if entries.len() >= max_entries {
                        return Err(SshError::DirectoryEntryLimit);
                    }
                    entries.push(SftpDirectoryEntry {
                        name: entry.filename,
                        attributes: entry.attrs,
                    });
                }
            }
            Ok(entries)
        }
        .await;
        let close_result = self.session.close(handle.handle).await;
        match result {
            Err(error) => {
                let _ = close_result;
                Err(error)
            }
            Ok(entries) => {
                close_result.map_err(|_| SshError::Sftp)?;
                Ok(entries)
            }
        }
    }

    pub fn close(&self) -> Result<(), SshError> {
        self.session.close_session().map_err(|_| SshError::Sftp)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalOutputEvent {
    Data(Vec<u8>),
    Exit(u32),
    Closed,
}

impl TerminalInput {
    pub async fn write(&self, data: Vec<u8>) -> Result<(), SshError> {
        self.channel.data_bytes(data).await?;
        Ok(())
    }

    pub async fn resize(&self, columns: u32, rows: u32) -> Result<(), SshError> {
        self.channel.window_change(columns, rows, 0, 0).await?;
        Ok(())
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.channel.close().await?;
        Ok(())
    }
}

impl TerminalOutput {
    pub async fn next(&mut self) -> TerminalOutputEvent {
        loop {
            match self.channel.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    return TerminalOutputEvent::Data(data.to_vec());
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    return TerminalOutputEvent::Exit(exit_status);
                }
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                    return TerminalOutputEvent::Closed;
                }
                Some(_) => {}
            }
        }
    }
}

impl ConnectedSshSession {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn open_terminal(
        &self,
        columns: u32,
        rows: u32,
    ) -> Result<(TerminalInput, TerminalOutput), SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", columns, rows, 0, 0, &[])
            .await?;
        // Best-effort color/UTF-8 locale hints; restricted OpenSSH AcceptEnv hosts may ignore SetEnv.
        let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
        let _ = channel.set_env(false, "LANG", "C.UTF-8").await;
        channel.request_shell(true).await?;
        let (read_half, write_half) = channel.split();
        Ok((
            TerminalInput {
                channel: write_half,
            },
            TerminalOutput { channel: read_half },
        ))
    }

    pub async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(SshError::Transport)?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|_| SshError::Sftp)
    }

    pub async fn open_sftp_directory_reader(&self) -> Result<SftpDirectoryReader, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(SshError::Transport)?;
        let session = RawSftpSession::new(channel.into_stream());
        session.init().await.map_err(|_| SshError::Sftp)?;
        Ok(SftpDirectoryReader { session })
    }

    pub async fn execute_bounded(
        &self,
        command: &str,
        max_output_bytes: usize,
        timeout: Duration,
    ) -> Result<CommandOutput, SshError> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command.as_bytes()).await?;
        let operation = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_status = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus {
                        exit_status: status,
                    } => exit_status = Some(status),
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
                if stdout.len().saturating_add(stderr.len()) > max_output_bytes {
                    let _ = channel.close().await;
                    return Err(SshError::OutputLimit);
                }
            }
            Ok(CommandOutput {
                stdout,
                stderr,
                exit_status,
            })
        };
        tokio::time::timeout(timeout, operation)
            .await
            .map_err(|_| SshError::Timeout)?
    }

    pub async fn open_direct_tcpip(
        &self,
        target_host: &str,
        target_port: u32,
        originator_host: &str,
        originator_port: u32,
    ) -> Result<russh::ChannelStream<client::Msg>, SshError> {
        let channel = tokio::time::timeout(
            self.connect_timeout,
            self.handle.channel_open_direct_tcpip(
                target_host,
                target_port,
                originator_host,
                originator_port,
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        Ok(channel.into_stream())
    }

    pub async fn request_remote_forward(
        &self,
        address: &str,
        port: u16,
    ) -> Result<(u16, RemoteForwardReceiver), SshError> {
        if port == 0 {
            return Err(SshError::RemoteForwardUnavailable);
        }
        let (sender, receiver) = mpsc::channel(64);
        let requested_key = (address.to_owned(), u32::from(port));
        self.reserve_remote_forward_route(requested_key.clone(), sender)?;

        match self.handle.tcpip_forward(address, u32::from(port)).await {
            // A zero port here means the server echoed no port back: per RFC 4254
            // the REQUEST_SUCCESS body is empty when a specific port was
            // requested, and russh maps that empty reply to 0. The requested
            // port was accepted.
            Ok(actual_port) if actual_port == u32::from(port) || actual_port == 0 => {
                Ok((port, RemoteForwardReceiver { receiver }))
            }
            Ok(actual_port) => {
                self.release_remote_forward_route(&requested_key);
                if actual_port > 0 && actual_port <= u32::from(u16::MAX) {
                    let _ = self.handle.cancel_tcpip_forward(address, actual_port).await;
                }
                Err(SshError::RemoteForwardUnavailable)
            }
            Err(error) => {
                self.release_remote_forward_route(&requested_key);
                Err(remote_forward_request_error(error))
            }
        }
    }

    fn reserve_remote_forward_route(
        &self,
        key: (String, u32),
        sender: mpsc::Sender<Channel<client::Msg>>,
    ) -> Result<(), SshError> {
        let mut routes = self
            .remote_forward_routes
            .lock()
            .map_err(|_| SshError::RemoteForwardUnavailable)?;
        if routes.contains_key(&key) {
            return Err(SshError::RemoteForwardUnavailable);
        }
        routes.insert(key, sender);
        Ok(())
    }

    fn release_remote_forward_route(&self, key: &(String, u32)) {
        if let Ok(mut routes) = self.remote_forward_routes.lock() {
            routes.remove(key);
        }
    }

    pub async fn cancel_remote_forward(&self, address: &str, port: u16) -> Result<(), SshError> {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle.cancel_tcpip_forward(address, u32::from(port)),
        )
        .await;
        if let Ok(mut routes) = self.remote_forward_routes.lock() {
            routes.remove(&(address.to_owned(), u32::from(port)));
        }
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(remote_forward_cancel_error(error)),
            Err(_) => Err(SshError::RemoteForwardCancelFailed),
        }
    }

    pub async fn disconnect(&self) -> Result<(), SshError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "FILEX session closed", "en")
            .await?;
        Ok(())
    }
}

fn remote_forward_request_error(error: russh::Error) -> SshError {
    match error {
        russh::Error::RequestDenied => SshError::RemoteForwardDenied,
        error => SshError::Transport(error),
    }
}

fn remote_forward_cancel_error(error: russh::Error) -> SshError {
    match error {
        russh::Error::RequestDenied => SshError::RemoteForwardCancelDenied,
        _ => SshError::RemoteForwardCancelFailed,
    }
}

#[derive(Debug, Clone)]
pub struct RusshEngine {
    connect_timeout: Duration,
    keepalive_interval: Option<Duration>,
}

impl Default for RusshEngine {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(15),
            keepalive_interval: Some(Duration::from_secs(30)),
        }
    }
}

impl RusshEngine {
    pub fn with_timeout(connect_timeout: Duration) -> Self {
        Self {
            connect_timeout,
            ..Self::default()
        }
    }

    pub fn with_options(connect_timeout: Duration, keepalive_interval: Option<Duration>) -> Self {
        Self {
            connect_timeout,
            keepalive_interval,
        }
    }

    pub async fn probe_host_key(
        &self,
        host: &str,
        port: u16,
    ) -> Result<PresentedHostKey, SshError> {
        let presented = Arc::new(Mutex::new(None));
        let handler = HostKeyHandler {
            expected: None,
            presented: presented.clone(),
            remote_forward_routes: Arc::new(Mutex::new(std::collections::HashMap::new())),
        };
        let handle = tokio::time::timeout(
            self.connect_timeout,
            client::connect(
                client_config(self.keepalive_interval),
                (host, port),
                handler,
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        self.finish_host_key_probe(handle, presented).await
    }

    pub async fn probe_host_key_stream<S>(&self, stream: S) -> Result<PresentedHostKey, SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let presented = Arc::new(Mutex::new(None));
        let handler = HostKeyHandler {
            expected: None,
            presented: presented.clone(),
            remote_forward_routes: Arc::new(Mutex::new(std::collections::HashMap::new())),
        };
        let handle = tokio::time::timeout(
            self.connect_timeout,
            client::connect_stream(client_config(self.keepalive_interval), stream, handler),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        self.finish_host_key_probe(handle, presented).await
    }

    async fn finish_host_key_probe(
        &self,
        handle: client::Handle<HostKeyHandler>,
        presented: Arc<Mutex<Option<PresentedHostKey>>>,
    ) -> Result<PresentedHostKey, SshError> {
        handle
            .disconnect(
                Disconnect::ByApplication,
                "FILEX host-key probe complete",
                "en",
            )
            .await?;
        presented
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .ok_or(SshError::HostKeyMissing)
    }

    pub async fn connect_password(
        &self,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError> {
        let (mut handle, remote_forward_routes) =
            self.open_handle(host, port, expected_host_key).await?;
        let auth = tokio::time::timeout(
            self.connect_timeout,
            handle.authenticate_password(username.to_owned(), password.to_owned()),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !auth.success() {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "FILEX authentication rejected",
                    "en",
                )
                .await;
            return Err(SshError::AuthenticationRejected);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    pub async fn connect_password_stream<S>(
        &self,
        stream: S,
        username: &str,
        password: &str,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut handle, remote_forward_routes) =
            self.open_handle_stream(stream, expected_host_key).await?;
        let auth = tokio::time::timeout(
            self.connect_timeout,
            handle.authenticate_password(username.to_owned(), password.to_owned()),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !auth.success() {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "FILEX authentication rejected",
                    "en",
                )
                .await;
            return Err(SshError::AuthenticationRejected);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    pub async fn load_private_key(
        &self,
        path: &str,
        passphrase: Option<&str>,
    ) -> Result<PreparedPrivateKey, SshError> {
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
        let source_text =
            std::str::from_utf8(source.as_slice()).map_err(|_| SshError::PrivateKeyInvalid)?;
        let key = russh::keys::decode_secret_key(source_text, passphrase).map_err(|error| {
            if matches!(error, russh::keys::Error::KeyIsEncrypted) && passphrase.is_none() {
                SshError::PrivateKeyPassphraseRequired
            } else {
                SshError::PrivateKeyInvalid
            }
        })?;
        Ok(PreparedPrivateKey { key: Arc::new(key) })
    }

    pub async fn connect_private_key(
        &self,
        host: &str,
        port: u16,
        username: &str,
        key: PreparedPrivateKey,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError> {
        let (mut handle, remote_forward_routes) =
            self.open_handle(host, port, expected_host_key).await?;
        let rsa_hash = tokio::time::timeout(self.connect_timeout, handle.best_supported_rsa_hash())
            .await
            .map_err(|_| SshError::Timeout)??
            .flatten();
        let auth = tokio::time::timeout(
            self.connect_timeout,
            handle.authenticate_publickey(
                username.to_owned(),
                PrivateKeyWithHashAlg::new(key.key, rsa_hash),
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !auth.success() {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "FILEX public-key authentication rejected",
                    "en",
                )
                .await;
            return Err(SshError::AuthenticationRejected);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    pub async fn connect_private_key_stream<S>(
        &self,
        stream: S,
        username: &str,
        key: PreparedPrivateKey,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut handle, remote_forward_routes) =
            self.open_handle_stream(stream, expected_host_key).await?;
        let rsa_hash = tokio::time::timeout(self.connect_timeout, handle.best_supported_rsa_hash())
            .await
            .map_err(|_| SshError::Timeout)??
            .flatten();
        let auth = tokio::time::timeout(
            self.connect_timeout,
            handle.authenticate_publickey(
                username.to_owned(),
                PrivateKeyWithHashAlg::new(key.key, rsa_hash),
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)??;
        if !auth.success() {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "FILEX public-key authentication rejected",
                    "en",
                )
                .await;
            return Err(SshError::AuthenticationRejected);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    pub async fn connect_agent(
        &self,
        host: &str,
        port: u16,
        username: &str,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError> {
        let (mut handle, remote_forward_routes) =
            self.open_handle(host, port, expected_host_key).await?;
        let auth_result = match tokio::time::timeout(
            self.connect_timeout,
            authenticate_with_agent(&mut handle, username),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(SshError::AgentTimeout),
        };
        if let Err(error) = auth_result {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                handle.disconnect(
                    Disconnect::ByApplication,
                    "FILEX agent authentication failed",
                    "en",
                ),
            )
            .await;
            return Err(error);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    pub async fn connect_agent_stream<S>(
        &self,
        stream: S,
        username: &str,
        expected_host_key: PresentedHostKey,
    ) -> Result<ConnectedSshSession, SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut handle, remote_forward_routes) =
            self.open_handle_stream(stream, expected_host_key).await?;
        let auth_result = match tokio::time::timeout(
            self.connect_timeout,
            authenticate_with_agent(&mut handle, username),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(SshError::AgentTimeout),
        };
        if let Err(error) = auth_result {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                handle.disconnect(
                    Disconnect::ByApplication,
                    "FILEX agent authentication failed",
                    "en",
                ),
            )
            .await;
            return Err(error);
        }
        Ok(ConnectedSshSession {
            handle,
            remote_forward_routes,
            connect_timeout: self.connect_timeout,
        })
    }

    async fn open_handle(
        &self,
        host: &str,
        port: u16,
        expected_host_key: PresentedHostKey,
    ) -> Result<(client::Handle<HostKeyHandler>, RemoteForwardRoutes), SshError> {
        let presented = Arc::new(Mutex::new(None));
        let remote_forward_routes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let handler = HostKeyHandler {
            expected: Some(expected_host_key.clone()),
            presented: presented.clone(),
            remote_forward_routes: remote_forward_routes.clone(),
        };
        let connect_result = tokio::time::timeout(
            self.connect_timeout,
            client::connect(
                client_config(self.keepalive_interval),
                (host, port),
                handler,
            ),
        )
        .await
        .map_err(|_| SshError::Timeout)?;
        let handle = match connect_result {
            Ok(handle) => handle,
            Err(error) => {
                let actual = presented.lock().ok().and_then(|slot| slot.clone());
                if actual.is_some_and(|actual| actual != expected_host_key) {
                    return Err(SshError::HostKeyRejected);
                }
                return Err(SshError::Transport(error));
            }
        };
        Ok((handle, remote_forward_routes))
    }

    async fn open_handle_stream<S>(
        &self,
        stream: S,
        expected_host_key: PresentedHostKey,
    ) -> Result<(client::Handle<HostKeyHandler>, RemoteForwardRoutes), SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let presented = Arc::new(Mutex::new(None));
        let remote_forward_routes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let handler = HostKeyHandler {
            expected: Some(expected_host_key.clone()),
            presented: presented.clone(),
            remote_forward_routes: remote_forward_routes.clone(),
        };
        let connect_result = tokio::time::timeout(
            self.connect_timeout,
            client::connect_stream(client_config(self.keepalive_interval), stream, handler),
        )
        .await
        .map_err(|_| SshError::Timeout)?;
        let handle = match connect_result {
            Ok(handle) => handle,
            Err(error) => {
                let actual = presented.lock().ok().and_then(|slot| slot.clone());
                if actual.is_some_and(|actual| actual != expected_host_key) {
                    return Err(SshError::HostKeyRejected);
                }
                return Err(SshError::Transport(error));
            }
        };
        Ok((handle, remote_forward_routes))
    }
}

async fn authenticate_with_agent(
    handle: &mut client::Handle<HostKeyHandler>,
    username: &str,
) -> Result<(), SshError> {
    let mut agent = connect_agent_client().await?;
    let binding = handle
        .agent_session_binding()
        .cloned()
        .ok_or(SshError::AgentSessionBindingUnavailable)?;
    agent
        .bind_session(&binding, false)
        .await
        .map_err(|_| SshError::AgentSessionBindingUnavailable)?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| SshError::AgentIdentityListFailed)?;
    if identities.is_empty() {
        return Err(SshError::AgentNoIdentities);
    }
    let has_untried_identities = identities.len() > MAX_AGENT_AUTH_ATTEMPTS;
    let rsa_hash = handle.best_supported_rsa_hash().await?.flatten();

    for identity in identities.into_iter().take(MAX_AGENT_AUTH_ATTEMPTS) {
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                handle
                    .authenticate_publickey_with(username.to_owned(), key, rsa_hash, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(
                        username.to_owned(),
                        certificate,
                        rsa_hash,
                        &mut agent,
                    )
                    .await
            }
        }
        .map_err(|_| SshError::AgentSigningFailed)?;
        if result.success() {
            return Ok(());
        }
    }

    if has_untried_identities {
        Err(SshError::AgentIdentityLimitExceeded)
    } else {
        Err(SshError::AuthenticationRejected)
    }
}

fn erase_agent_client<S>(client: AgentClient<S>) -> DynamicAgentClient
where
    S: AgentStream + Send + Unpin + 'static,
{
    client.dynamic()
}

async fn connect_agent_client() -> Result<DynamicAgentClient, SshError> {
    #[cfg(unix)]
    {
        let client = AgentClient::connect_env()
            .await
            .map_err(|_| SshError::AgentUnavailable)?;
        Ok(erase_agent_client(client))
    }
    #[cfg(windows)]
    {
        let client = if let Some(endpoint) = std::env::var_os("SSH_AUTH_SOCK") {
            AgentClient::connect_named_pipe(endpoint)
                .await
                .map_err(|_| SshError::AgentUnavailable)?
        } else {
            AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
                .map_err(|_| SshError::AgentUnavailable)?
        };
        Ok(erase_agent_client(client))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(SshError::AgentUnavailable)
    }
}

fn client_config(keepalive_interval: Option<Duration>) -> Arc<Config> {
    Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        keepalive_interval,
        keepalive_max: 3,
        ..Config::default()
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
    use russh::{Channel, ChannelId};
    use tokio::io::AsyncReadExt;

    use super::{
        PresentedHostKey, RusshEngine, SshError, TerminalOutputEvent, remote_forward_cancel_error,
        remote_forward_request_error,
    };

    type ForwardRoute = (String, u32, russh::server::Handle);

    struct LifecycleFixtureServer {
        forward: Arc<tokio::sync::Mutex<Option<ForwardRoute>>>,
    }

    struct LifecycleFixtureHandler {
        forward: Arc<tokio::sync::Mutex<Option<ForwardRoute>>>,
    }

    impl russh::server::Server for LifecycleFixtureServer {
        type Handler = LifecycleFixtureHandler;

        fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
            LifecycleFixtureHandler {
                forward: self.forward.clone(),
            }
        }
    }

    impl russh::server::Handler for LifecycleFixtureHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            username: &str,
            password: &str,
        ) -> Result<Auth, Self::Error> {
            if username == "fixture-user" && password == "fixture-password" {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::reject())
            }
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            _col_width: u32,
            _row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, b"fixture-ready\r\n".to_vec())?;
            Ok(())
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            let forward = if data == b"trigger-forward" {
                self.forward.lock().await.clone()
            } else {
                None
            };
            if let Some((address, port, handle)) = forward {
                tokio::spawn(async move {
                    if let Ok(channel) = handle
                        .channel_open_forwarded_tcpip(address, port, "127.0.0.1", 42_424)
                        .await
                    {
                        let _ = channel.data(&b"forwarded-fixture"[..]).await;
                        let _ = channel.eof().await;
                    }
                });
            }
            session.data(channel, data.to_vec())?;
            Ok(())
        }

        async fn tcpip_forward(
            &mut self,
            address: &str,
            port: &mut u32,
            session: &mut Session,
        ) -> Result<bool, Self::Error> {
            *self.forward.lock().await = Some((address.to_owned(), *port, session.handle()));
            Ok(true)
        }

        async fn cancel_tcpip_forward(
            &mut self,
            _address: &str,
            _port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            let _ = self.forward.lock().await.take();
            Ok(true)
        }
    }

    #[test]
    fn distinguishes_server_forwarding_policy_denial_from_transport_failure() {
        let error = remote_forward_request_error(russh::Error::RequestDenied);

        assert!(matches!(error, SshError::RemoteForwardDenied));
    }

    #[test]
    fn distinguishes_remote_forward_cancel_denial_from_transport_failure() {
        assert!(matches!(
            remote_forward_cancel_error(russh::Error::RequestDenied),
            SshError::RemoteForwardCancelDenied
        ));
        assert!(matches!(
            remote_forward_cancel_error(russh::Error::Disconnect),
            SshError::RemoteForwardCancelFailed
        ));
    }

    #[tokio::test]
    async fn connection_timeout_is_bounded() {
        let engine = RusshEngine::with_timeout(Duration::from_millis(50));
        let result = engine.probe_host_key("192.0.2.1", 22).await;
        assert!(matches!(
            result,
            Err(SshError::Timeout) | Err(SshError::Transport(_))
        ));
    }

    #[tokio::test]
    async fn local_ssh_fixture_covers_session_and_remote_forward_lifecycle() {
        let host_key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .expect("generate fixture host key");
        let config = Arc::new(russh::server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: Some(Duration::from_secs(15)),
            keys: vec![host_key],
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local SSH fixture");
        let address = listener.local_addr().expect("read fixture address");
        let mut fixture = LifecycleFixtureServer {
            forward: Arc::new(tokio::sync::Mutex::new(None)),
        };
        let server = fixture.run_on_socket(config, &listener);
        let server_handle = server.handle();
        tokio::pin!(server);

        let engine = RusshEngine::with_timeout(Duration::from_secs(3));
        let presented_host_key = tokio::select! {
            result = engine.probe_host_key("127.0.0.1", address.port()) => {
                result.expect("probe fixture host key")
            }
            result = &mut server => panic!("fixture server exited during host-key probe: {result:?}"),
        };
        let wrong_host_key = PresentedHostKey {
            algorithm: presented_host_key.algorithm.clone(),
            fingerprint_sha256: "SHA256:fixture-mismatch".to_owned(),
        };
        let rejected = tokio::select! {
            result = engine.connect_password(
                "127.0.0.1",
                address.port(),
                "fixture-user",
                "fixture-password",
                wrong_host_key,
            ) => result,
            result = &mut server => panic!("fixture server exited during fingerprint check: {result:?}"),
        };
        assert!(matches!(rejected, Err(SshError::HostKeyRejected)));
        let session = tokio::select! {
            result = engine.connect_password(
                "127.0.0.1",
                address.port(),
                "fixture-user",
                "fixture-password",
                presented_host_key.clone(),
            ) => result.expect("authenticate to fixture SSH server"),
            result = &mut server => panic!("fixture server exited during authentication: {result:?}"),
        };

        let (input, mut output) = session
            .open_terminal(100, 30)
            .await
            .expect("open fixture PTY");
        let greeting = tokio::time::timeout(Duration::from_secs(2), output.next())
            .await
            .expect("receive fixture greeting");
        assert_eq!(
            greeting,
            TerminalOutputEvent::Data(b"fixture-ready\r\n".to_vec())
        );
        input
            .write(b"terminal-roundtrip".to_vec())
            .await
            .expect("write fixture PTY input");
        let echo = tokio::time::timeout(Duration::from_secs(2), output.next())
            .await
            .expect("receive fixture PTY echo");
        assert_eq!(
            echo,
            TerminalOutputEvent::Data(b"terminal-roundtrip".to_vec())
        );

        let (bound_port, mut forwarded_channels) = session
            .request_remote_forward("127.0.0.1", 42_001)
            .await
            .expect("request remote forward");
        assert_eq!(bound_port, 42_001);
        input
            .write(b"trigger-forward".to_vec())
            .await
            .expect("trigger fixture forwarded connection");
        let forward_trigger_echo = tokio::time::timeout(Duration::from_secs(2), output.next())
            .await
            .expect("receive forwarded-connection trigger echo");
        assert_eq!(
            forward_trigger_echo,
            TerminalOutputEvent::Data(b"trigger-forward".to_vec())
        );
        let mut forwarded = tokio::time::timeout(Duration::from_secs(2), forwarded_channels.recv())
            .await
            .expect("receive forwarded channel")
            .expect("fixture opened forwarded channel");
        let mut forwarded_payload = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(2),
            forwarded.read_to_end(&mut forwarded_payload),
        )
        .await
        .expect("read forwarded payload")
        .expect("forwarded stream closes cleanly");
        assert_eq!(forwarded_payload, b"forwarded-fixture".to_vec());
        session
            .cancel_remote_forward("127.0.0.1", bound_port)
            .await
            .expect("cancel remote forward");
        session
            .disconnect()
            .await
            .expect("disconnect fixture session");

        server_handle.shutdown("fixture completed".to_owned());
        tokio::time::timeout(Duration::from_secs(2), &mut server)
            .await
            .expect("stop fixture server")
            .expect("fixture server exits cleanly");
    }
}
