use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    net::IpAddr,
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::remote_ops::{
    DOCKER_LOGS_OUTPUT_BYTES, DOCKER_PROBE_OUTPUT_BYTES, DOCKER_SNAPSHOT_PROBE,
    OPS_PROBE_OUTPUT_BYTES, docker_action_command, docker_action_error, docker_logs_command,
    docker_probe_error, ops_probe_command, parse_docker_logs, parse_docker_snapshot,
    parse_ops_snapshot, posix_signal_flag,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use encoding_rs::Encoding;
use filex_contracts::{
    AppError, AuthenticationMethod, ConflictPolicy, ConnectionProfile, CreateLocalTunnelInput,
    DirectorySyncChangeKind, DirectorySyncEntryKind, DirectorySyncPreview,
    DirectorySyncPreviewEntry, DockerAvailability, DockerContainerAction, DockerLogsSnapshot,
    DockerSnapshot, FileChecksumComparison, HostKeyChallenge, HostTrustEvaluation, MonitorState,
    NetworkEndpoint, NetworkInterface, NetworkPlatform, NetworkSnapshot, OpsCategory, OpsSnapshot,
    ProcessEntry, ProcessPlatform, ProcessSignal, ProcessSnapshot, RemoteDirectoryListing,
    RemoteFileEntry, RemotePermissionScope, RemotePermissionUpdateResult, RemoteState,
    RemoteTextPreview, RemoteTextSaveResult, RouteEntry, SessionConnectionProgress, SessionState,
    SessionSummary, SystemMonitorSnapshot, TransferDirection, TransferTask, TunnelKind,
    TunnelState, TunnelSummary,
};
use filex_core::{HostTrustService, SessionMachine, parse_monitor_probe};
use filex_ssh::{
    ConnectedSshSession, PreparedPrivateKey, PresentedHostKey, RusshEngine, SftpDirectoryReader,
    SshError, TerminalInput, TerminalOutput,
};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, copy};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::{io::copy_bidirectional, net::TcpListener};
use tokio_util::sync::CancellationToken;

const FILE_CHECKSUM_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const FILE_CHECKSUM_BUFFER_BYTES: usize = 64 * 1024;
const FILE_CHECKSUM_TIMEOUT_SECONDS: u64 = 600;
const FILE_CHECKSUM_MAX_CONCURRENT: usize = 2;
const REMOTE_COPY_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const REMOTE_COPY_TIMEOUT_SECONDS: u64 = 600;
const DIRECTORY_SYNC_MAX_ENTRIES: usize = 5_000;
const DIRECTORY_SYNC_MAX_DEPTH: usize = 16;
const DIRECTORY_SYNC_MAX_RESULTS: usize = 1_000;
const DIRECTORY_SYNC_TIMEOUT_SECONDS: u64 = 180;
const TUNNEL_MAX_CONNECTIONS: usize = 64;
const REMOTE_TREE_MAX_ENTRIES: usize = 5_000;
const REMOTE_TREE_MAX_DEPTH: usize = 16;
const EXTERNAL_EDIT_MAX_BYTES: u64 = 32 * 1024 * 1024;
const EXTERNAL_EDIT_SYNC_TIMEOUT_SECONDS: u64 = 60;

pub struct SessionRuntime {
    engine: RwLock<RusshEngine>,
    machines: Mutex<HashMap<String, SessionMachine>>,
    presented_keys: Mutex<HashMap<String, PresentedHostKey>>,
    routes: AsyncMutex<HashMap<String, SessionRouteProgress>>,
    connections: AsyncMutex<HashMap<String, RuntimeConnection>>,
    quick_profiles: Mutex<HashMap<String, ConnectionProfile>>,
    transfer_controls: Mutex<HashMap<String, Arc<TransferControl>>>,
    tunnels: AsyncMutex<HashMap<String, TunnelRuntime>>,
    process_snapshots: Mutex<HashMap<String, CachedProcessSnapshot>>,
    checksum_cancellations: Mutex<HashMap<String, CancellationToken>>,
    sync_preview_cancellations: Mutex<HashMap<String, CancellationToken>>,
}

struct RuntimeConnection {
    session: Arc<ConnectedSshSession>,
    terminal: Arc<AsyncMutex<TerminalInput>>,
    upstream_sessions: Vec<Arc<ConnectedSshSession>>,
}

pub(crate) struct ExternalEditCopy {
    pub path: PathBuf,
    pub revision: String,
    pub bytes: u64,
}

pub(crate) struct ExternalEditUpload {
    pub revision: String,
    pub bytes: u64,
    pub uploaded: bool,
}

#[derive(Clone)]
struct RemoteTreeEntry {
    path: String,
    is_directory: bool,
    is_regular: bool,
    is_symlink: bool,
}

struct SessionRouteProgress {
    profile_ids: Vec<String>,
    profile_snapshots: Vec<RouteProfileSnapshot>,
    current_hop_index: usize,
    upstream_sessions: Vec<Arc<ConnectedSshSession>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RouteProfileSnapshot {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    authentication_method: AuthenticationMethod,
    identity_file: Option<String>,
    proxy_jump_profile_ids: Vec<String>,
}

impl From<&ConnectionProfile> for RouteProfileSnapshot {
    fn from(profile: &ConnectionProfile) -> Self {
        Self {
            id: profile.id.clone(),
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            authentication_method: profile.authentication_method.clone(),
            identity_file: profile.identity_file.clone(),
            proxy_jump_profile_ids: profile.proxy_jump_profile_ids.clone(),
        }
    }
}

impl RouteProfileSnapshot {
    fn matches(&self, profile: &ConnectionProfile) -> bool {
        self == &Self::from(profile)
    }
}

enum RouteAuthentication<'a> {
    Password(&'a str),
    PrivateKey(Option<&'a str>),
    Agent,
}

struct TunnelRuntime {
    summary: Arc<Mutex<TunnelSummary>>,
    cancellation: CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferExecutionState {
    Running,
    Paused,
    Committing,
    Cancelled,
    Finished,
}

struct TransferControl {
    session_id: String,
    state: Mutex<TransferExecutionState>,
    changed: Notify,
    cancellation: CancellationToken,
    bytes_transferred: AtomicU64,
}

#[derive(Clone)]
pub struct CopyOperationControl {
    state: Arc<Mutex<CopyExecutionState>>,
    cancellation: CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyExecutionState {
    Running,
    Cancelled,
    Committing,
    Finished,
}

impl CopyOperationControl {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(CopyExecutionState::Running)),
            cancellation: CancellationToken::new(),
        }
    }

    pub fn cancel(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        match *state {
            CopyExecutionState::Running => {
                *state = CopyExecutionState::Cancelled;
                self.cancellation.cancel();
                Ok(())
            }
            CopyExecutionState::Cancelled => Ok(()),
            CopyExecutionState::Committing | CopyExecutionState::Finished => {
                Err(copy_commit_in_progress_error())
            }
        }
    }

    pub fn check_cancelled(&self) -> Result<(), AppError> {
        if self.cancellation.is_cancelled() {
            Err(transfer_cancelled_error())
        } else {
            Ok(())
        }
    }

    pub fn cancellation_token(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub fn begin_commit(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        match *state {
            CopyExecutionState::Running => {
                *state = CopyExecutionState::Committing;
                Ok(())
            }
            CopyExecutionState::Cancelled => Err(transfer_cancelled_error()),
            CopyExecutionState::Committing | CopyExecutionState::Finished => {
                Err(transfer_control_transition_error())
            }
        }
    }

    pub fn finish(&self) {
        if let Ok(mut state) = self.state.lock()
            && *state != CopyExecutionState::Cancelled
        {
            *state = CopyExecutionState::Finished;
        }
    }
}

impl TransferControl {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            state: Mutex::new(TransferExecutionState::Running),
            changed: Notify::new(),
            cancellation: CancellationToken::new(),
            bytes_transferred: AtomicU64::new(0),
        }
    }

    fn pause(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        match *state {
            TransferExecutionState::Running => {
                *state = TransferExecutionState::Paused;
                Ok(())
            }
            TransferExecutionState::Paused => Ok(()),
            TransferExecutionState::Committing
            | TransferExecutionState::Cancelled
            | TransferExecutionState::Finished => Err(transfer_control_transition_error()),
        }
    }

    fn resume(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        if *state != TransferExecutionState::Paused {
            return Err(transfer_control_transition_error());
        }
        *state = TransferExecutionState::Running;
        self.changed.notify_one();
        Ok(())
    }

    fn cancel(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        match *state {
            TransferExecutionState::Running | TransferExecutionState::Paused => {
                *state = TransferExecutionState::Cancelled;
                self.cancellation.cancel();
                self.changed.notify_one();
                Ok(())
            }
            TransferExecutionState::Cancelled => Ok(()),
            TransferExecutionState::Committing | TransferExecutionState::Finished => {
                Err(transfer_control_transition_error())
            }
        }
    }

    async fn wait_until_running(&self) -> Result<(), AppError> {
        loop {
            let notified = self.changed.notified();
            let wait_for_resume = {
                let state = self.state.lock().map_err(|_| session_lock_error())?;
                match *state {
                    TransferExecutionState::Running => return Ok(()),
                    TransferExecutionState::Paused => true,
                    TransferExecutionState::Cancelled => return Err(transfer_cancelled_error()),
                    TransferExecutionState::Committing | TransferExecutionState::Finished => {
                        return Err(transfer_control_transition_error());
                    }
                }
            };
            if wait_for_resume {
                notified.await;
            }
        }
    }

    async fn begin_commit(&self) -> Result<(), AppError> {
        loop {
            let notified = self.changed.notified();
            let wait_for_resume = {
                let mut state = self.state.lock().map_err(|_| session_lock_error())?;
                match *state {
                    TransferExecutionState::Running => {
                        *state = TransferExecutionState::Committing;
                        return Ok(());
                    }
                    TransferExecutionState::Paused => true,
                    TransferExecutionState::Cancelled => return Err(transfer_cancelled_error()),
                    TransferExecutionState::Committing | TransferExecutionState::Finished => {
                        return Err(transfer_control_transition_error());
                    }
                }
            };
            if wait_for_resume {
                notified.await;
            }
        }
    }

    fn end_commit(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        if *state != TransferExecutionState::Committing {
            return Err(transfer_control_transition_error());
        }
        *state = TransferExecutionState::Running;
        self.changed.notify_one();
        Ok(())
    }

    fn finish(&self) -> Result<(), AppError> {
        let mut state = self.state.lock().map_err(|_| session_lock_error())?;
        if *state != TransferExecutionState::Cancelled {
            *state = TransferExecutionState::Finished;
        }
        self.changed.notify_one();
        Ok(())
    }

    fn is_terminal(&self) -> Result<bool, AppError> {
        let state = self.state.lock().map_err(|_| session_lock_error())?;
        Ok(matches!(
            *state,
            TransferExecutionState::Cancelled | TransferExecutionState::Finished
        ))
    }

    fn bytes_transferred(&self) -> u64 {
        self.bytes_transferred.load(Ordering::Acquire)
    }
}

struct CachedProcessSnapshot {
    id: String,
    platform: ProcessPlatform,
    collected_at_ms: u64,
    identities: HashMap<u32, ProcessIdentity>,
}

struct LocalTransferEntry {
    source_path: PathBuf,
    relative_path: String,
    is_directory: bool,
    size: u64,
}

struct RemoteTransferEntry {
    remote_path: String,
    relative_path: String,
    is_directory: bool,
    size: Option<u64>,
    permissions: Option<u32>,
}

struct ParsedProcesses {
    processes: Vec<ProcessEntry>,
    identities: HashMap<u32, ProcessIdentity>,
    truncated: bool,
}

#[derive(Clone)]
struct DirectorySyncNode {
    kind: DirectorySyncEntryKind,
    size: Option<u64>,
    modified_at_ms: Option<u64>,
}

#[derive(Clone)]
enum ProcessIdentity {
    Posix {
        start_marker_hex: String,
        name_marker_hex: String,
    },
    Windows {
        start_time_ticks: u64,
    },
}

impl Default for SessionRuntime {
    fn default() -> Self {
        Self {
            engine: RwLock::new(RusshEngine::default()),
            machines: Mutex::new(HashMap::new()),
            presented_keys: Mutex::new(HashMap::new()),
            routes: AsyncMutex::new(HashMap::new()),
            connections: AsyncMutex::new(HashMap::new()),
            quick_profiles: Mutex::new(HashMap::new()),
            transfer_controls: Mutex::new(HashMap::new()),
            tunnels: AsyncMutex::new(HashMap::new()),
            process_snapshots: Mutex::new(HashMap::new()),
            checksum_cancellations: Mutex::new(HashMap::new()),
            sync_preview_cancellations: Mutex::new(HashMap::new()),
        }
    }
}

impl SessionRuntime {
    async fn session_handle(&self, session_id: &str) -> Result<Arc<ConnectedSshSession>, AppError> {
        let connections = self.connections.lock().await;
        connections
            .get(session_id)
            .map(|connection| connection.session.clone())
            .ok_or_else(session_not_found_error)
    }

    pub fn configure_ssh(
        &self,
        connect_timeout_seconds: u16,
        keepalive_seconds: u16,
    ) -> Result<(), AppError> {
        let keepalive =
            (keepalive_seconds > 0).then(|| Duration::from_secs(u64::from(keepalive_seconds)));
        *self.engine.write().map_err(|_| session_lock_error())? = RusshEngine::with_options(
            Duration::from_secs(u64::from(connect_timeout_seconds)),
            keepalive,
        );
        Ok(())
    }

    pub fn validate_profile_support(profile: &ConnectionProfile) -> Result<(), AppError> {
        if profile.authentication_method == AuthenticationMethod::PrivateKey
            && profile
                .identity_file
                .as_deref()
                .is_none_or(|path| path.trim().is_empty())
        {
            return Err(private_key_path_required_error());
        }
        if profile.proxy_jump_profile_ids.len() > 4 {
            return Err(proxy_jump_too_many_hops_error());
        }
        let mut seen = HashSet::with_capacity(profile.proxy_jump_profile_ids.len());
        if profile.proxy_jump_profile_ids.iter().any(|profile_id| {
            profile_id.trim().is_empty()
                || profile_id.trim() != profile_id
                || profile_id == &profile.id
                || !seen.insert(profile_id.as_str())
        }) {
            return Err(proxy_jump_route_error());
        }
        if profile
            .proxy_jump
            .as_deref()
            .is_some_and(|proxy_jump| !proxy_jump.trim().is_empty())
            && profile.proxy_jump_profile_ids.is_empty()
        {
            return Err(proxy_jump_mapping_required_error());
        }
        Ok(())
    }

    #[allow(dead_code)]
    fn validate_direct_profile_support(profile: &ConnectionProfile) -> Result<(), AppError> {
        Self::validate_profile_support(profile)?;
        if !profile.proxy_jump_profile_ids.is_empty() {
            return Err(proxy_jump_route_error());
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn probe(
        &self,
        profile: &ConnectionProfile,
        trust_service: &HostTrustService,
    ) -> Result<HostKeyChallenge, AppError> {
        Self::validate_direct_profile_support(profile)?;
        let mut machine = SessionMachine::new(profile);
        machine.start_attempt()?;
        machine.transition(SessionState::Connecting)?;
        machine.transition(SessionState::VerifyingHost)?;
        let session_id = machine.summary().id;
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(session_id.clone(), machine);

        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let presented = match engine.probe_host_key(&profile.host, profile.port).await {
            Ok(presented) => presented,
            Err(error) => {
                self.fail(&session_id, ssh_error(&error))?;
                return Err(ssh_error(&error));
            }
        };
        let trust = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        self.presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(session_id.clone(), presented.clone());
        let next = if trust == HostTrustEvaluation::Trusted {
            SessionState::ReadyToAuthenticate
        } else {
            SessionState::TrustRequired
        };
        let session = self.transition(&session_id, next)?;
        Ok(HostKeyChallenge {
            session,
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            hop_index: 0,
            hop_count: 1,
            algorithm: presented.algorithm,
            fingerprint_sha256: presented.fingerprint_sha256,
            trust,
        })
    }

    #[allow(dead_code)]
    pub async fn reprobe(
        &self,
        session_id: &str,
        profile: &ConnectionProfile,
        trust_service: &HostTrustService,
    ) -> Result<HostKeyChallenge, AppError> {
        Self::validate_direct_profile_support(profile)?;
        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != profile.id {
                return Err(session_not_found_error());
            }
            machine.start_attempt()?;
            machine.transition(SessionState::Connecting)?;
            machine.transition(SessionState::VerifyingHost)?;
        }
        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let presented = match engine.probe_host_key(&profile.host, profile.port).await {
            Ok(presented) => presented,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        let trust = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        self.presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(session_id.to_owned(), presented.clone());
        let next = if trust == HostTrustEvaluation::Trusted {
            SessionState::ReadyToAuthenticate
        } else {
            SessionState::TrustRequired
        };
        let session = self.transition(session_id, next)?;
        Ok(HostKeyChallenge {
            session,
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            hop_index: 0,
            hop_count: 1,
            algorithm: presented.algorithm,
            fingerprint_sha256: presented.fingerprint_sha256,
            trust,
        })
    }

    #[allow(dead_code)]
    pub async fn connect_password(
        &self,
        session_id: &str,
        profile: &ConnectionProfile,
        password: &str,
        trust_service: &HostTrustService,
    ) -> Result<(SessionSummary, TerminalOutput), AppError> {
        Self::validate_direct_profile_support(profile)?;
        if profile.authentication_method != AuthenticationMethod::Password {
            return Err(authentication_method_mismatch_error());
        }
        let presented = self
            .presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned()
            .ok_or_else(session_not_found_error)?;
        let evaluation = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        if evaluation != HostTrustEvaluation::Trusted {
            return Err(host_key_untrusted_error(evaluation));
        }

        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != profile.id {
                return Err(session_not_found_error());
            }
            if machine.summary().state == SessionState::TrustRequired {
                machine.transition(SessionState::ReadyToAuthenticate)?;
            }
            machine.transition(SessionState::Authenticating)?;
        }

        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let connected = match engine
            .connect_password(
                &profile.host,
                profile.port,
                &profile.username,
                password,
                presented,
            )
            .await
        {
            Ok(connected) => connected,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        let (terminal, output) = match connected.open_terminal(120, 32).await {
            Ok(terminal) => terminal,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        self.connections.lock().await.insert(
            session_id.to_owned(),
            RuntimeConnection {
                session: Arc::new(connected),
                terminal: Arc::new(AsyncMutex::new(terminal)),
                upstream_sessions: Vec::new(),
            },
        );
        let summary = self.transition(session_id, SessionState::Connected)?;
        Ok((summary, output))
    }

    #[allow(dead_code)]
    pub async fn connect_private_key(
        &self,
        session_id: &str,
        profile: &ConnectionProfile,
        passphrase: Option<&str>,
        trust_service: &HostTrustService,
    ) -> Result<(SessionSummary, TerminalOutput), AppError> {
        Self::validate_direct_profile_support(profile)?;
        if profile.authentication_method != AuthenticationMethod::PrivateKey {
            return Err(authentication_method_mismatch_error());
        }
        let identity_file = profile
            .identity_file
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(private_key_path_required_error)?;
        let presented = self
            .presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned()
            .ok_or_else(session_not_found_error)?;
        let evaluation = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        if evaluation != HostTrustEvaluation::Trusted {
            return Err(host_key_untrusted_error(evaluation));
        }
        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let key: PreparedPrivateKey = engine
            .load_private_key(identity_file, passphrase)
            .await
            .map_err(|error| ssh_error(&error))?;

        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != profile.id {
                return Err(session_not_found_error());
            }
            if machine.summary().state == SessionState::TrustRequired {
                machine.transition(SessionState::ReadyToAuthenticate)?;
            }
            machine.transition(SessionState::Authenticating)?;
        }

        let connected = match engine
            .connect_private_key(
                &profile.host,
                profile.port,
                &profile.username,
                key,
                presented,
            )
            .await
        {
            Ok(connected) => connected,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        let (terminal, output) = match connected.open_terminal(120, 32).await {
            Ok(terminal) => terminal,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        self.connections.lock().await.insert(
            session_id.to_owned(),
            RuntimeConnection {
                session: Arc::new(connected),
                terminal: Arc::new(AsyncMutex::new(terminal)),
                upstream_sessions: Vec::new(),
            },
        );
        let summary = self.transition(session_id, SessionState::Connected)?;
        Ok((summary, output))
    }

    #[allow(dead_code)]
    pub async fn connect_agent(
        &self,
        session_id: &str,
        profile: &ConnectionProfile,
        trust_service: &HostTrustService,
    ) -> Result<(SessionSummary, TerminalOutput), AppError> {
        Self::validate_direct_profile_support(profile)?;
        if profile.authentication_method != AuthenticationMethod::Agent {
            return Err(authentication_method_mismatch_error());
        }
        let presented = self
            .presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned()
            .ok_or_else(session_not_found_error)?;
        let evaluation = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        if evaluation != HostTrustEvaluation::Trusted {
            return Err(host_key_untrusted_error(evaluation));
        }

        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != profile.id {
                return Err(session_not_found_error());
            }
            if machine.summary().state == SessionState::TrustRequired {
                machine.transition(SessionState::ReadyToAuthenticate)?;
            }
            machine.transition(SessionState::Authenticating)?;
        }

        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let connected = match engine
            .connect_agent(&profile.host, profile.port, &profile.username, presented)
            .await
        {
            Ok(connected) => connected,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        let (terminal, output) = match connected.open_terminal(120, 32).await {
            Ok(terminal) => terminal,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        self.connections.lock().await.insert(
            session_id.to_owned(),
            RuntimeConnection {
                session: Arc::new(connected),
                terminal: Arc::new(AsyncMutex::new(terminal)),
                upstream_sessions: Vec::new(),
            },
        );
        let summary = self.transition(session_id, SessionState::Connected)?;
        Ok((summary, output))
    }

    pub async fn probe_route(
        &self,
        profile: &ConnectionProfile,
        route_profiles: &[ConnectionProfile],
        trust_service: &HostTrustService,
    ) -> Result<HostKeyChallenge, AppError> {
        validate_route_profiles(profile, route_profiles)?;
        let mut machine = SessionMachine::new(profile);
        machine.start_attempt()?;
        machine.transition(SessionState::Connecting)?;
        let session_id = machine.summary().id;
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(session_id.clone(), machine);
        self.routes.lock().await.insert(
            session_id.clone(),
            SessionRouteProgress {
                profile_ids: route_profiles
                    .iter()
                    .map(|route_profile| route_profile.id.clone())
                    .collect(),
                profile_snapshots: route_profiles
                    .iter()
                    .map(RouteProfileSnapshot::from)
                    .collect(),
                current_hop_index: 0,
                upstream_sessions: Vec::new(),
            },
        );
        if let Ok(mut presented) = self.presented_keys.lock() {
            presented.remove(&session_id);
        }
        self.transition(&session_id, SessionState::VerifyingHost)?;
        match self
            .probe_current_route_hop(&session_id, route_profiles, trust_service)
            .await
        {
            Ok(challenge) => Ok(challenge),
            Err(error) => {
                self.abort_route(&session_id).await;
                self.fail(&session_id, error.clone())?;
                self.machines
                    .lock()
                    .map_err(|_| session_lock_error())?
                    .remove(&session_id);
                Err(error)
            }
        }
    }

    pub async fn reprobe_route(
        &self,
        session_id: &str,
        profile: &ConnectionProfile,
        route_profiles: &[ConnectionProfile],
        trust_service: &HostTrustService,
    ) -> Result<HostKeyChallenge, AppError> {
        self.abort_route(session_id).await;
        validate_route_profiles(profile, route_profiles)?;
        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != profile.id {
                return Err(session_not_found_error());
            }
            machine.start_attempt()?;
            machine.transition(SessionState::Connecting)?;
        }
        self.routes.lock().await.insert(
            session_id.to_owned(),
            SessionRouteProgress {
                profile_ids: route_profiles
                    .iter()
                    .map(|route_profile| route_profile.id.clone())
                    .collect(),
                profile_snapshots: route_profiles
                    .iter()
                    .map(RouteProfileSnapshot::from)
                    .collect(),
                current_hop_index: 0,
                upstream_sessions: Vec::new(),
            },
        );
        self.transition(session_id, SessionState::VerifyingHost)?;
        match self
            .probe_current_route_hop(session_id, route_profiles, trust_service)
            .await
        {
            Ok(challenge) => Ok(challenge),
            Err(error) => {
                self.abort_route(session_id).await;
                self.fail(session_id, error.clone())?;
                Err(error)
            }
        }
    }

    pub async fn current_route_profile_id(&self, session_id: &str) -> Result<String, AppError> {
        let routes = self.routes.lock().await;
        let route = routes.get(session_id).ok_or_else(session_not_found_error)?;
        route
            .profile_ids
            .get(route.current_hop_index)
            .cloned()
            .ok_or_else(session_not_found_error)
    }

    pub async fn ensure_current_route_trusted(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        trust_service: &HostTrustService,
    ) -> Result<(), AppError> {
        let destination = route_profiles.last().ok_or_else(proxy_jump_route_error)?;
        if let Err(error) = validate_route_profiles(destination, route_profiles) {
            self.abort_route(session_id).await;
            self.fail(session_id, error.clone())?;
            return Err(error);
        }
        if self.summary(session_id)?.profile_id != destination.id {
            return Err(session_not_found_error());
        }
        let (profile, route_changed) = {
            let routes = self.routes.lock().await;
            let route = routes.get(session_id).ok_or_else(session_not_found_error)?;
            if !route_matches_profiles(route, route_profiles) {
                (None, true)
            } else {
                (route_profiles.get(route.current_hop_index).cloned(), false)
            }
        };
        if route_changed {
            let error = proxy_jump_route_changed_error();
            self.abort_route(session_id).await;
            self.fail(session_id, error.clone())?;
            return Err(error);
        }
        let Some(profile) = profile else {
            return Err(session_not_found_error());
        };
        let presented = self
            .presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned()
            .ok_or_else(session_not_found_error)?;
        let evaluation = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        if evaluation != HostTrustEvaluation::Trusted {
            let error = host_key_untrusted_error(evaluation);
            self.abort_route(session_id).await;
            self.fail(session_id, error.clone())?;
            return Err(error);
        }
        Ok(())
    }

    pub async fn connect_route_password(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        profile: &ConnectionProfile,
        password: &str,
        trust_service: &HostTrustService,
    ) -> Result<(SessionConnectionProgress, Option<TerminalOutput>), AppError> {
        if profile.authentication_method != AuthenticationMethod::Password {
            return Err(authentication_method_mismatch_error());
        }
        self.connect_route_hop(
            session_id,
            route_profiles,
            profile,
            RouteAuthentication::Password(password),
            trust_service,
        )
        .await
    }

    pub async fn connect_route_private_key(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        profile: &ConnectionProfile,
        passphrase: Option<&str>,
        trust_service: &HostTrustService,
    ) -> Result<(SessionConnectionProgress, Option<TerminalOutput>), AppError> {
        if profile.authentication_method != AuthenticationMethod::PrivateKey {
            return Err(authentication_method_mismatch_error());
        }
        self.connect_route_hop(
            session_id,
            route_profiles,
            profile,
            RouteAuthentication::PrivateKey(passphrase),
            trust_service,
        )
        .await
    }

    pub async fn connect_route_agent(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        profile: &ConnectionProfile,
        trust_service: &HostTrustService,
    ) -> Result<(SessionConnectionProgress, Option<TerminalOutput>), AppError> {
        if profile.authentication_method != AuthenticationMethod::Agent {
            return Err(authentication_method_mismatch_error());
        }
        self.connect_route_hop(
            session_id,
            route_profiles,
            profile,
            RouteAuthentication::Agent,
            trust_service,
        )
        .await
    }

    pub async fn cancel_attempt(&self, session_id: &str) -> Result<(), AppError> {
        self.abort_route(session_id).await;
        self.remove_quick_profile(session_id)?;
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .remove(session_id);
        Ok(())
    }

    pub fn bind_quick_profile(
        &self,
        session_id: &str,
        profile: ConnectionProfile,
    ) -> Result<(), AppError> {
        self.quick_profiles
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(session_id.to_owned(), profile);
        Ok(())
    }

    pub fn quick_profile(&self, session_id: &str) -> Result<Option<ConnectionProfile>, AppError> {
        Ok(self
            .quick_profiles
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned())
    }

    fn remove_quick_profile(&self, session_id: &str) -> Result<(), AppError> {
        self.quick_profiles
            .lock()
            .map_err(|_| session_lock_error())?
            .remove(session_id);
        Ok(())
    }

    async fn connect_route_hop(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        profile: &ConnectionProfile,
        authentication: RouteAuthentication<'_>,
        trust_service: &HostTrustService,
    ) -> Result<(SessionConnectionProgress, Option<TerminalOutput>), AppError> {
        let destination = route_profiles.last().ok_or_else(proxy_jump_route_error)?;
        validate_route_profiles(destination, route_profiles)?;
        let (current_index, route_changed) = {
            let routes = self.routes.lock().await;
            let route = routes.get(session_id).ok_or_else(session_not_found_error)?;
            if route.profile_ids.len() != route_profiles.len()
                || !route
                    .profile_ids
                    .iter()
                    .zip(route_profiles)
                    .all(|(id, route_profile)| id == &route_profile.id)
                || !route_matches_profiles(route, route_profiles)
            {
                (None, true)
            } else {
                let index = route.current_hop_index;
                if route.profile_ids.get(index).map(String::as_str) != Some(profile.id.as_str()) {
                    return Err(session_not_found_error());
                }
                (Some(index), false)
            }
        };
        if route_changed {
            let error = proxy_jump_route_changed_error();
            self.abort_route(session_id).await;
            self.fail(session_id, error.clone())?;
            return Err(error);
        }
        let Some(current_index) = current_index else {
            return Err(session_not_found_error());
        };
        let presented = self
            .presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .cloned()
            .ok_or_else(session_not_found_error)?;
        let evaluation = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        if evaluation != HostTrustEvaluation::Trusted {
            let error = host_key_untrusted_error(evaluation);
            self.abort_route(session_id).await;
            self.fail(session_id, error.clone())?;
            return Err(error);
        }

        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let prepared_key = match &authentication {
            RouteAuthentication::PrivateKey(passphrase) => {
                let identity_file = profile
                    .identity_file
                    .as_deref()
                    .filter(|path| !path.trim().is_empty())
                    .ok_or_else(private_key_path_required_error)?;
                Some(
                    engine
                        .load_private_key(identity_file, *passphrase)
                        .await
                        .map_err(|error| ssh_error(&error))?,
                )
            }
            RouteAuthentication::Password(_) | RouteAuthentication::Agent => None,
        };
        {
            let mut machines = self.machines.lock().map_err(|_| session_lock_error())?;
            let machine = machines
                .get_mut(session_id)
                .ok_or_else(session_not_found_error)?;
            if machine.summary().profile_id != destination.id {
                return Err(session_not_found_error());
            }
            if machine.summary().state == SessionState::TrustRequired {
                machine.transition(SessionState::ReadyToAuthenticate)?;
            }
            machine.transition(SessionState::Authenticating)?;
        }

        let stream = if current_index == 0 {
            None
        } else {
            let upstream = {
                let routes = self.routes.lock().await;
                routes
                    .get(session_id)
                    .and_then(|route| route.upstream_sessions.last())
                    .cloned()
                    .ok_or_else(session_not_found_error)?
            };
            match upstream
                .open_direct_tcpip(&profile.host, u32::from(profile.port), "127.0.0.1", 0)
                .await
            {
                Ok(stream) => Some(stream),
                Err(error) => {
                    let app_error = ssh_error(&error);
                    self.abort_route(session_id).await;
                    self.fail(session_id, app_error.clone())?;
                    return Err(app_error);
                }
            }
        };

        let connected_result = match (authentication, stream) {
            (RouteAuthentication::Password(password), None) => {
                engine
                    .connect_password(
                        &profile.host,
                        profile.port,
                        &profile.username,
                        password,
                        presented,
                    )
                    .await
            }
            (RouteAuthentication::Password(password), Some(stream)) => {
                engine
                    .connect_password_stream(stream, &profile.username, password, presented)
                    .await
            }
            (RouteAuthentication::PrivateKey(_), None) => {
                engine
                    .connect_private_key(
                        &profile.host,
                        profile.port,
                        &profile.username,
                        prepared_key.ok_or_else(private_key_path_required_error)?,
                        presented,
                    )
                    .await
            }
            (RouteAuthentication::PrivateKey(_), Some(stream)) => {
                engine
                    .connect_private_key_stream(
                        stream,
                        &profile.username,
                        prepared_key.ok_or_else(private_key_path_required_error)?,
                        presented,
                    )
                    .await
            }
            (RouteAuthentication::Agent, None) => {
                engine
                    .connect_agent(&profile.host, profile.port, &profile.username, presented)
                    .await
            }
            (RouteAuthentication::Agent, Some(stream)) => {
                engine
                    .connect_agent_stream(stream, &profile.username, presented)
                    .await
            }
        };
        let connected = match connected_result {
            Ok(connected) => connected,
            Err(error) => {
                let app_error = ssh_error(&error);
                self.abort_route(session_id).await;
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };

        if current_index + 1 < route_profiles.len() {
            let connected = Arc::new(connected);
            let route_error = {
                let mut routes = self.routes.lock().await;
                match routes.get_mut(session_id) {
                    Some(route) if route_matches_profiles(route, route_profiles) => {
                        route.upstream_sessions.push(connected.clone());
                        route.current_hop_index += 1;
                        None
                    }
                    Some(_) => Some(proxy_jump_route_changed_error()),
                    None => Some(session_not_found_error()),
                }
            };
            if let Some(error) = route_error {
                let _ = connected.disconnect().await;
                self.abort_route(session_id).await;
                let _ = self.fail(session_id, error.clone());
                return Err(error);
            }
            self.transition(session_id, SessionState::Connecting)?;
            self.transition(session_id, SessionState::VerifyingHost)?;
            return match self
                .probe_current_route_hop(session_id, route_profiles, trust_service)
                .await
            {
                Ok(challenge) => Ok((
                    SessionConnectionProgress {
                        session: challenge.session.clone(),
                        challenge: Some(challenge),
                        connected: false,
                    },
                    None,
                )),
                Err(error) => {
                    self.abort_route(session_id).await;
                    self.fail(session_id, error.clone())?;
                    Err(error)
                }
            };
        }

        let (terminal, output) = match connected.open_terminal(120, 32).await {
            Ok(terminal) => terminal,
            Err(error) => {
                let app_error = ssh_error(&error);
                let _ = connected.disconnect().await;
                self.abort_route(session_id).await;
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
        };
        let (route, route_changed) = {
            let mut routes = self.routes.lock().await;
            if routes
                .get(session_id)
                .is_some_and(|route| !route_matches_profiles(route, route_profiles))
            {
                (None, true)
            } else {
                (routes.remove(session_id), false)
            }
        };
        let Some(route) = route else {
            let _ = terminal.close().await;
            let _ = connected.disconnect().await;
            let error = if route_changed {
                proxy_jump_route_changed_error()
            } else {
                session_not_found_error()
            };
            self.abort_route(session_id).await;
            let _ = self.fail(session_id, error.clone());
            return Err(error);
        };
        self.connections.lock().await.insert(
            session_id.to_owned(),
            RuntimeConnection {
                session: Arc::new(connected),
                terminal: Arc::new(AsyncMutex::new(terminal)),
                upstream_sessions: route.upstream_sessions,
            },
        );
        if let Ok(mut presented) = self.presented_keys.lock() {
            presented.remove(session_id);
        }
        let summary = self.transition(session_id, SessionState::Connected)?;
        Ok((
            SessionConnectionProgress {
                session: summary,
                challenge: None,
                connected: true,
            },
            Some(output),
        ))
    }

    async fn probe_current_route_hop(
        &self,
        session_id: &str,
        route_profiles: &[ConnectionProfile],
        trust_service: &HostTrustService,
    ) -> Result<HostKeyChallenge, AppError> {
        let (index, upstream) = {
            let routes = self.routes.lock().await;
            let route = routes.get(session_id).ok_or_else(session_not_found_error)?;
            let index = route.current_hop_index;
            let Some(expected_id) = route.profile_ids.get(index) else {
                return Err(proxy_jump_route_error());
            };
            let Some(profile) = route_profiles.get(index) else {
                return Err(proxy_jump_route_error());
            };
            if expected_id != &profile.id || !route_matches_profiles(route, route_profiles) {
                return Err(proxy_jump_route_error());
            }
            let upstream = if index == 0 {
                None
            } else {
                Some(
                    route
                        .upstream_sessions
                        .last()
                        .cloned()
                        .ok_or_else(session_not_found_error)?,
                )
            };
            (index, upstream)
        };
        let profile = route_profiles
            .get(index)
            .ok_or_else(proxy_jump_route_error)?;
        let stream = match upstream {
            Some(upstream) => Some(
                upstream
                    .open_direct_tcpip(&profile.host, u32::from(profile.port), "127.0.0.1", 0)
                    .await
                    .map_err(|error| ssh_error(&error))?,
            ),
            None => None,
        };
        let engine = self
            .engine
            .read()
            .map_err(|_| session_lock_error())?
            .clone();
        let presented = match stream {
            Some(stream) => engine.probe_host_key_stream(stream).await,
            None => engine.probe_host_key(&profile.host, profile.port).await,
        }
        .map_err(|error| ssh_error(&error))?;
        let trust = trust_service.evaluate(
            &profile.host,
            profile.port,
            &presented.algorithm,
            &presented.fingerprint_sha256,
        )?;
        let session = {
            let routes = self.routes.lock().await;
            let route = routes.get(session_id).ok_or_else(session_not_found_error)?;
            if route.current_hop_index != index || !route_matches_profiles(route, route_profiles) {
                return Err(proxy_jump_route_changed_error());
            }
            self.presented_keys
                .lock()
                .map_err(|_| session_lock_error())?
                .insert(session_id.to_owned(), presented.clone());
            let next = if trust == HostTrustEvaluation::Trusted {
                SessionState::ReadyToAuthenticate
            } else {
                SessionState::TrustRequired
            };
            self.transition(session_id, next)?
        };
        Ok(HostKeyChallenge {
            session,
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            hop_index: u8::try_from(index).unwrap_or(4),
            hop_count: u8::try_from(route_profiles.len()).unwrap_or(5),
            algorithm: presented.algorithm,
            fingerprint_sha256: presented.fingerprint_sha256,
            trust,
        })
    }

    async fn abort_route(&self, session_id: &str) {
        let route = self.routes.lock().await.remove(session_id);
        if let Ok(mut presented) = self.presented_keys.lock() {
            presented.remove(session_id);
        }
        if let Some(route) = route {
            for upstream in route.upstream_sessions.iter().rev() {
                let _ = tokio::time::timeout(Duration::from_secs(2), upstream.disconnect()).await;
            }
        }
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<SessionSummary, AppError> {
        self.transition(session_id, SessionState::Disconnecting)?;
        self.remove_quick_profile(session_id)?;
        self.invalidate_process_snapshot(session_id)?;
        self.cancel_session_transfers(session_id)?;
        self.stop_session_tunnels(session_id).await?;
        let connection = self.connections.lock().await.remove(session_id);
        if let Some(connection) = connection {
            {
                let terminal = connection.terminal.lock().await;
                let _ = terminal.close().await;
            }
            let mut first_error = connection
                .session
                .disconnect()
                .await
                .err()
                .map(|error| ssh_error(&error));
            for upstream in connection.upstream_sessions.iter().rev() {
                match tokio::time::timeout(Duration::from_secs(2), upstream.disconnect()).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) if first_error.is_none() => {
                        first_error = Some(ssh_error(&error));
                    }
                    Err(_) if first_error.is_none() => {
                        first_error = Some(session_shutdown_timeout_error());
                    }
                    _ => {}
                }
            }
            if let Some(app_error) = first_error {
                self.fail(session_id, app_error.clone())?;
                return Err(app_error);
            }
            self.mark_disconnected_remote_tunnels(session_id).await?;
        }
        self.transition(session_id, SessionState::Disconnected)
    }

    pub async fn shutdown(&self) -> Result<(), AppError> {
        let mut first_error = None;
        let session_ids: Vec<String> =
            match tokio::time::timeout(Duration::from_secs(1), self.connections.lock()).await {
                Ok(connections) => connections.keys().cloned().collect(),
                Err(_) => {
                    first_error = Some(session_shutdown_timeout_error());
                    Vec::new()
                }
            };
        let disconnects = session_ids.iter().map(|session_id| async move {
            tokio::time::timeout(Duration::from_secs(4), self.disconnect(session_id)).await
        });
        for result in futures_util::future::join_all(disconnects).await {
            let error = match result {
                Ok(Ok(_)) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some(session_shutdown_timeout_error()),
            };
            if first_error.is_none() {
                first_error = error;
            }
        }

        let pending_route_ids =
            match tokio::time::timeout(Duration::from_secs(1), self.routes.lock()).await {
                Ok(routes) => routes.keys().cloned().collect::<Vec<_>>(),
                Err(_) => {
                    if first_error.is_none() {
                        first_error = Some(session_shutdown_timeout_error());
                    }
                    Vec::new()
                }
            };
        let route_cancellations = pending_route_ids.iter().map(|session_id| async move {
            tokio::time::timeout(Duration::from_secs(9), self.cancel_attempt(session_id)).await
        });
        for result in futures_util::future::join_all(route_cancellations).await {
            let error = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some(session_shutdown_timeout_error()),
            };
            if first_error.is_none() {
                first_error = error;
            }
        }

        self.stop_all_tunnels().await?;
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let has_live_tunnel = self.list_tunnels().await?.iter().any(|tunnel| {
                matches!(
                    &tunnel.state,
                    TunnelState::Starting | TunnelState::Listening | TunnelState::Stopping
                )
            });
            if !has_live_tunnel {
                break;
            }
            if Instant::now() >= deadline {
                if first_error.is_none() {
                    first_error = Some(session_shutdown_timeout_error());
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.quick_profiles
            .lock()
            .map_err(|_| session_lock_error())?
            .clear();

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub async fn write_terminal(
        &self,
        session_id: &str,
        data: Vec<u8>,
        encoding_label: &str,
    ) -> Result<(), AppError> {
        let text = std::str::from_utf8(&data).map_err(|_| terminal_input_invalid_error())?;
        let encoding = terminal_text_encoding(encoding_label)?;
        let (encoded, _, had_errors) = encoding.encode(text);
        if had_errors {
            return Err(terminal_encoding_unrepresentable_error());
        }
        let data = encoded.into_owned();
        let terminal = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.terminal.clone())
                .ok_or_else(session_not_found_error)?
        };
        let terminal = terminal.lock().await;
        terminal
            .write(data)
            .await
            .map_err(|error| ssh_error(&error))
    }

    pub async fn resize_terminal(
        &self,
        session_id: &str,
        columns: u32,
        rows: u32,
    ) -> Result<(), AppError> {
        if columns == 0 || rows == 0 || columns > 1000 || rows > 1000 {
            return Err(invalid_terminal_size_error());
        }
        let terminal = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.terminal.clone())
                .ok_or_else(session_not_found_error)?
        };
        let terminal = terminal.lock().await;
        terminal
            .resize(columns, rows)
            .await
            .map_err(|error| ssh_error(&error))
    }

    pub async fn remote_closed(&self, session_id: &str) -> Result<SessionSummary, AppError> {
        let connection = self.connections.lock().await.remove(session_id);
        if let Some(connection) = connection {
            {
                let terminal = connection.terminal.lock().await;
                let _ = terminal.close().await;
            }
            let _ = connection.session.disconnect().await;
            for upstream in connection.upstream_sessions.iter().rev() {
                let _ = tokio::time::timeout(Duration::from_secs(2), upstream.disconnect()).await;
            }
        }
        self.remove_quick_profile(session_id)?;
        let summary = self.summary(session_id)?;
        if summary.state == SessionState::Connected {
            self.transition(session_id, SessionState::Disconnecting)?;
            return self.transition(session_id, SessionState::Disconnected);
        }
        Ok(summary)
    }

    pub async fn list_remote_directory(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<RemoteDirectoryListing, AppError> {
        if path.is_empty() || path.contains('\0') {
            return Err(invalid_remote_path_error());
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let canonical_path = sftp
            .canonicalize(path)
            .await
            .map_err(|_| ssh_error(&SshError::Sftp))?;
        let entries = sftp
            .read_dir(canonical_path.clone())
            .await
            .map_err(|_| ssh_error(&SshError::Sftp))?;
        let mut result = entries
            .take(10_000)
            .map(|entry| {
                let metadata = entry.metadata();
                let is_symlink = metadata.is_symlink();
                RemoteFileEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    is_directory: metadata.is_dir(),
                    is_symlink,
                    size: metadata.size,
                    modified_at_ms: metadata.mtime.map(|seconds| u64::from(seconds) * 1000),
                    permissions_mode: if is_symlink {
                        None
                    } else {
                        metadata.permissions.map(|mode| mode & 0o7777)
                    },
                    uid: metadata.uid,
                    gid: metadata.gid,
                }
            })
            .collect::<Vec<_>>();
        result.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        let _ = sftp.close().await;
        Ok(RemoteDirectoryListing {
            path: canonical_path,
            entries: result,
        })
    }

    pub async fn create_remote_file(
        &self,
        session_id: &str,
        parent_path: &str,
        name: &str,
    ) -> Result<(), AppError> {
        validate_remote_directory_name(parent_path, name)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let target = join_remote_path(parent_path, name);
        let result = match sftp
            .open_with_flags(
                target,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
        {
            Ok(file) => file.close().await.map_err(|_| remote_create_file_error()),
            Err(_) => Err(remote_create_file_error()),
        };
        let _ = sftp.close().await;
        result
    }

    pub async fn update_remote_entry_mode(
        &self,
        session_id: &str,
        path: &str,
        mode: u32,
    ) -> Result<(), AppError> {
        if path.is_empty() || path.contains('\0') {
            return Err(invalid_remote_path_error());
        }
        if mode > 0o7777 {
            return Err(remote_mode_error("REMOTE_MODE_INVALID"));
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let mut attributes = FileAttributes::empty();
        attributes.permissions = Some(mode);
        let result = sftp.set_metadata(path, attributes).await;
        let _ = sftp.close().await;
        result.map_err(|_| remote_mode_error("REMOTE_MODE_UPDATE_FAILED"))
    }

    pub async fn update_remote_entry_permissions(
        &self,
        session_id: &str,
        input: &filex_contracts::UpdateRemotePermissionsInput,
    ) -> Result<RemotePermissionUpdateResult, AppError> {
        validate_remote_permission_input(input)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let operation = async {
            let root = sftp
                .symlink_metadata(input.path.clone())
                .await
                .map_err(|_| remote_mode_error("REMOTE_MODE_UPDATE_FAILED"))?;
            if root.is_symlink() {
                return Err(remote_mode_error("REMOTE_MODE_UNSUPPORTED"));
            }
            let tree = if input.recursive && root.is_dir() {
                scan_remote_tree(&sftp, &input.path).await?
            } else {
                Vec::new()
            };
            let mut updated_count = 0_u32;
            let mut skipped_symlink_count = 0_u32;
            if permission_scope_matches(&input.scope, root.is_dir(), root.is_regular()) {
                set_remote_permission(&sftp, &input.path, &root, input.mode).await?;
                updated_count = updated_count.saturating_add(1);
            }
            for entry in tree {
                if entry.is_symlink {
                    skipped_symlink_count = skipped_symlink_count.saturating_add(1);
                    continue;
                }
                if permission_scope_matches(&input.scope, entry.is_directory, entry.is_regular) {
                    let metadata = sftp
                        .symlink_metadata(entry.path.clone())
                        .await
                        .map_err(|_| remote_mode_error("REMOTE_MODE_UPDATE_FAILED"))?;
                    set_remote_permission(&sftp, &entry.path, &metadata, input.mode).await?;
                    updated_count = updated_count.saturating_add(1);
                }
            }
            Ok(RemotePermissionUpdateResult {
                updated_count,
                skipped_symlink_count,
            })
        };
        let result = match tokio::time::timeout(
            Duration::from_secs(DIRECTORY_SYNC_TIMEOUT_SECONDS),
            operation,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(remote_mode_error("REMOTE_MODE_UPDATE_TIMEOUT")),
        };
        let _ = sftp.close().await;
        result
    }

    pub async fn delete_remote_entry_recursive(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<u32, AppError> {
        validate_remote_delete_path(path)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let operation = async {
            let root = sftp
                .symlink_metadata(path.to_owned())
                .await
                .map_err(|_| remote_quick_delete_error())?;
            if !root.is_dir() || root.is_symlink() {
                sftp.remove_file(path.to_owned())
                    .await
                    .map_err(|_| remote_quick_delete_error())?;
                return Ok(1);
            }
            let mut descendants = scan_remote_tree(&sftp, path).await?;
            descendants.sort_by(|left, right| {
                right
                    .path
                    .matches('/')
                    .count()
                    .cmp(&left.path.matches('/').count())
                    .then_with(|| right.path.len().cmp(&left.path.len()))
            });
            let mut deleted = 0_u32;
            for entry in descendants {
                let result = if entry.is_directory && !entry.is_symlink {
                    sftp.remove_dir(entry.path).await
                } else {
                    sftp.remove_file(entry.path).await
                };
                result.map_err(|_| remote_quick_delete_error())?;
                deleted = deleted.saturating_add(1);
            }
            sftp.remove_dir(path.to_owned())
                .await
                .map_err(|_| remote_quick_delete_error())?;
            Ok(deleted.saturating_add(1))
        };
        let result = match tokio::time::timeout(
            Duration::from_secs(DIRECTORY_SYNC_TIMEOUT_SECONDS),
            operation,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(remote_quick_delete_error()),
        };
        let _ = sftp.close().await;
        result
    }

    pub async fn preview_remote_text(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<RemoteTextPreview, AppError> {
        if path.is_empty() || path.contains('\0') {
            return Err(invalid_remote_path_error());
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let metadata = sftp.symlink_metadata(path).await.map_err(|_| {
                sftp_preview_error("SFTP_PREVIEW_FAILED", "errors.sftpPreviewFailed")
            })?;
            if metadata.is_symlink() || !metadata.is_regular() {
                return Err(sftp_preview_error(
                    "SFTP_PREVIEW_UNSUPPORTED",
                    "errors.sftpPreviewUnsupported",
                ));
            }

            let file = sftp.open(path).await.map_err(|_| {
                sftp_preview_error("SFTP_PREVIEW_FAILED", "errors.sftpPreviewFailed")
            })?;
            let mut bytes = Vec::with_capacity((REMOTE_TEXT_PREVIEW_MAX_BYTES + 4) as usize);
            let mut bounded = file.take(u64::from(REMOTE_TEXT_PREVIEW_MAX_BYTES) + 4);
            let read_failed = bounded.read_to_end(&mut bytes).await.is_err();
            let file = bounded.into_inner();
            let close_failed = file.close().await.is_err();
            if read_failed || close_failed {
                return Err(sftp_preview_error(
                    "SFTP_PREVIEW_FAILED",
                    "errors.sftpPreviewFailed",
                ));
            }

            let truncated = bytes.len() > REMOTE_TEXT_PREVIEW_MAX_BYTES as usize
                || metadata
                    .size
                    .is_some_and(|size| size > u64::from(REMOTE_TEXT_PREVIEW_MAX_BYTES));
            bytes.truncate(REMOTE_TEXT_PREVIEW_MAX_BYTES as usize);
            let content = match String::from_utf8(bytes) {
                Ok(content) => content,
                Err(error) if error.utf8_error().error_len().is_none() && truncated => {
                    let valid_up_to = error.utf8_error().valid_up_to();
                    String::from_utf8(error.into_bytes()[..valid_up_to].to_vec())
                        .map_err(|_| sftp_preview_encoding_error())?
                }
                Err(_) => return Err(sftp_preview_encoding_error()),
            };
            if content.chars().any(|character| {
                character == '\0'
                    || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            }) {
                return Err(sftp_preview_encoding_error());
            }
            Ok(RemoteTextPreview {
                path: path.to_owned(),
                bytes: u32::try_from(content.len()).unwrap_or(REMOTE_TEXT_PREVIEW_MAX_BYTES),
                revision: text_revision(content.as_bytes()),
                content,
                truncated,
            })
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn create_external_open_copy(
        &self,
        session_id: &str,
        remote_path: &str,
        cache_directory: &std::path::Path,
    ) -> Result<PathBuf, AppError> {
        if remote_path.is_empty()
            || remote_path.contains('\0')
            || remote_path.split('/').any(|component| component == "..")
        {
            return Err(invalid_remote_path_error());
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let mut temporary_for_cleanup = None;
        let result = async {
            let metadata = sftp
                .symlink_metadata(remote_path)
                .await
                .map_err(|_| external_open_error())?;
            if metadata.is_symlink() || !metadata.is_regular() {
                return Err(sftp_preview_error(
                    "SFTP_PREVIEW_UNSUPPORTED",
                    "errors.sftpPreviewUnsupported",
                ));
            }
            if metadata
                .size
                .is_some_and(|size| size > EXTERNAL_OPEN_MAX_BYTES)
            {
                return Err(external_open_too_large_error());
            }

            tokio::fs::create_dir_all(cache_directory)
                .await
                .map_err(|_| external_open_error())?;
            let file_id = uuid::Uuid::new_v4();
            let extension = remote_path
                .rsplit('/')
                .next()
                .and_then(|name| name.rsplit_once('.').map(|(_, extension)| extension))
                .filter(|extension| {
                    !extension.is_empty()
                        && extension.len() <= 16
                        && extension
                            .chars()
                            .all(|character| character.is_ascii_alphanumeric())
                })
                .map(|extension| format!(".{extension}"))
                .unwrap_or_default();
            let temporary_path = cache_directory.join(format!(".filex-open-{file_id}.part"));
            let final_path = cache_directory.join(format!("filex-open-{file_id}{extension}"));
            temporary_for_cleanup = Some(temporary_path.clone());

            let mut local = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .await
                .map_err(|_| external_open_error())?;
            let remote = match sftp.open(remote_path.to_owned()).await {
                Ok(remote) => remote,
                Err(_) => {
                    drop(local);
                    return Err(external_open_error());
                }
            };
            let mut bounded_remote = remote.take(EXTERNAL_OPEN_MAX_BYTES + 1);
            let copy_result = copy(&mut bounded_remote, &mut local).await;
            let remote = bounded_remote.into_inner();
            let close_result = remote.close().await;
            let bytes = copy_result.map_err(|_| external_open_error())?;
            close_result.map_err(|_| external_open_error())?;
            if bytes > EXTERNAL_OPEN_MAX_BYTES {
                return Err(external_open_too_large_error());
            }
            local.flush().await.map_err(|_| external_open_error())?;
            local.sync_all().await.map_err(|_| external_open_error())?;
            drop(local);
            tokio::fs::rename(&temporary_path, &final_path)
                .await
                .map_err(|_| external_open_error())?;
            temporary_for_cleanup = None;
            Ok(final_path)
        }
        .await;
        if let Some(temporary_path) = temporary_for_cleanup {
            let _ = tokio::fs::remove_file(temporary_path).await;
        }
        let _ = sftp.close().await;
        result
    }

    pub(crate) async fn create_external_edit_copy(
        &self,
        session_id: &str,
        remote_path: &str,
        cache_directory: &std::path::Path,
    ) -> Result<ExternalEditCopy, AppError> {
        let path = self
            .create_external_open_copy(session_id, remote_path, cache_directory)
            .await?;
        let local = read_external_edit_local(&path, None).await;
        match local {
            Ok((bytes, revision)) => Ok(ExternalEditCopy {
                path,
                revision,
                bytes: bytes.len() as u64,
            }),
            Err(error) => {
                let _ = tokio::fs::remove_file(path).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn sync_external_edit_file(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &std::path::Path,
        last_local_revision: &str,
        expected_remote_revision: &str,
    ) -> Result<ExternalEditUpload, AppError> {
        if remote_path.is_empty()
            || remote_path.contains('\0')
            || remote_path.split('/').any(|component| component == "..")
        {
            return Err(invalid_remote_path_error());
        }
        let operation = async {
            let (local_bytes, local_revision) =
                read_external_edit_local(local_path, Some(last_local_revision)).await?;
            if local_revision == last_local_revision {
                return Ok(ExternalEditUpload {
                    revision: local_revision,
                    bytes: local_bytes.len() as u64,
                    uploaded: false,
                });
            }
            let session = self.session_handle(session_id).await?;
            let sftp = session
                .open_sftp()
                .await
                .map_err(|error| ssh_error(&error))?;
            let result = async {
                let (remote_revision, metadata) =
                    read_external_edit_remote(&sftp, remote_path).await?;
                if remote_revision != expected_remote_revision {
                    return Err(external_edit_remote_changed_error());
                }
                if local_revision == remote_revision {
                    return Ok(ExternalEditUpload {
                        revision: remote_revision,
                        bytes: local_bytes.len() as u64,
                        uploaded: false,
                    });
                }
                replace_external_edit_remote(
                    &sftp,
                    remote_path,
                    &metadata,
                    &local_bytes,
                    expected_remote_revision,
                )
                .await
            }
            .await;
            let _ = sftp.close().await;
            result
        };
        match tokio::time::timeout(
            Duration::from_secs(EXTERNAL_EDIT_SYNC_TIMEOUT_SECONDS),
            operation,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(external_edit_sync_error()),
        }
    }

    pub async fn save_remote_text(
        &self,
        session_id: &str,
        path: &str,
        content: &str,
        expected_revision: &str,
    ) -> Result<RemoteTextSaveResult, AppError> {
        validate_remote_delete_path(path)?;
        if content.len() > REMOTE_TEXT_PREVIEW_MAX_BYTES as usize {
            return Err(sftp_preview_too_large_error());
        }
        if !is_supported_preview_text(content) {
            return Err(sftp_preview_encoding_error());
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let metadata = sftp
                .symlink_metadata(path)
                .await
                .map_err(|_| sftp_save_error())?;
            if metadata.is_symlink() || !metadata.is_regular() {
                return Err(sftp_preview_error(
                    "SFTP_PREVIEW_UNSUPPORTED",
                    "errors.sftpPreviewUnsupported",
                ));
            }

            let current = read_bounded_remote_text(&sftp, path).await?;
            if current.revision != expected_revision {
                return Err(sftp_preview_conflict_error());
            }

            let (parent_path, source_name) = split_remote_parent(path)?;
            let parent = sftp
                .canonicalize(parent_path)
                .await
                .map_err(|_| sftp_save_error())?;
            let source_path = join_remote_path(&parent, source_name);
            let temporary_path =
                join_remote_path(&parent, &format!(".filex-part-{}", uuid::Uuid::new_v4()));
            let backup_path = join_remote_path(
                &parent,
                &format!(".filex-recovery-{}", uuid::Uuid::new_v4()),
            );

            let mut temporary = sftp
                .open_with_flags(
                    temporary_path.clone(),
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                )
                .await
                .map_err(|_| sftp_save_error())?;
            if temporary.write_all(content.as_bytes()).await.is_err() {
                let _ = temporary.close().await;
                let _ = sftp.remove_file(temporary_path).await;
                return Err(sftp_save_error());
            }
            let flush_failed = temporary.shutdown().await.is_err();
            let close_failed = temporary.close().await.is_err();
            if flush_failed || close_failed {
                let _ = sftp.remove_file(temporary_path).await;
                return Err(sftp_save_error());
            }
            if let Some(permissions) = metadata.permissions {
                let mut replacement_metadata = FileAttributes::empty();
                replacement_metadata.permissions = Some(permissions);
                if sftp
                    .set_metadata(temporary_path.clone(), replacement_metadata)
                    .await
                    .is_err()
                {
                    let _ = sftp.remove_file(temporary_path).await;
                    return Err(sftp_save_error());
                }
            }
            let latest = match read_bounded_remote_text(&sftp, &source_path).await {
                Ok(latest) => latest,
                Err(error) => {
                    let _ = sftp.remove_file(temporary_path.clone()).await;
                    return Err(error);
                }
            };
            if latest.revision != expected_revision {
                let _ = sftp.remove_file(temporary_path).await;
                return Err(sftp_preview_conflict_error());
            }

            if sftp
                .rename(source_path.clone(), backup_path.clone())
                .await
                .is_err()
            {
                let _ = sftp.remove_file(temporary_path).await;
                if sftp.symlink_metadata(backup_path.clone()).await.is_ok() {
                    return Err(sftp_save_rollback_error(&backup_path));
                }
                return Err(sftp_save_error());
            }

            match read_bounded_remote_text(&sftp, &backup_path).await {
                Ok(backed_up) if backed_up.revision == expected_revision => {}
                backed_up_result => {
                    if sftp
                        .rename(backup_path.clone(), source_path.clone())
                        .await
                        .is_err()
                    {
                        let _ = sftp.remove_file(temporary_path).await;
                        return Err(sftp_save_rollback_error(&backup_path));
                    }
                    let _ = sftp.remove_file(temporary_path).await;
                    return match backed_up_result {
                        Ok(_) => Err(sftp_preview_conflict_error()),
                        Err(error) => Err(error),
                    };
                }
            }

            if sftp.symlink_metadata(source_path.clone()).await.is_ok() {
                let _ = sftp.remove_file(temporary_path).await;
                return Err(sftp_save_target_appeared_error(&backup_path));
            }

            if sftp
                .rename(temporary_path.clone(), source_path.clone())
                .await
                .is_err()
            {
                if sftp
                    .rename(backup_path.clone(), source_path.clone())
                    .await
                    .is_err()
                {
                    let _ = sftp.remove_file(temporary_path).await;
                    return Err(sftp_save_rollback_error(&backup_path));
                }
                let _ = sftp.remove_file(temporary_path).await;
                return Err(sftp_save_error());
            }

            let revision = text_revision(content.as_bytes());
            let recovery_copy_path = if sftp.remove_file(backup_path.clone()).await.is_err() {
                Some(backup_path)
            } else {
                None
            };
            Ok(RemoteTextSaveResult {
                path: path.to_owned(),
                bytes: u32::try_from(content.len()).unwrap_or(REMOTE_TEXT_PREVIEW_MAX_BYTES),
                revision,
                recovery_copy_path,
            })
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn delete_remote_entry(&self, session_id: &str, path: &str) -> Result<(), AppError> {
        validate_remote_delete_path(path)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let metadata = sftp
                .symlink_metadata(path)
                .await
                .map_err(|_| remote_delete_error())?;
            if metadata.is_symlink() || metadata.is_regular() {
                sftp.remove_file(path)
                    .await
                    .map_err(|_| remote_delete_error())
            } else if metadata.is_dir() {
                sftp.remove_dir(path)
                    .await
                    .map_err(|_| remote_delete_error())
            } else {
                Err(remote_delete_error())
            }
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn create_remote_directory(
        &self,
        session_id: &str,
        parent_path: &str,
        name: &str,
    ) -> Result<(), AppError> {
        validate_remote_directory_name(parent_path, name)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let parent = sftp
                .canonicalize(parent_path)
                .await
                .map_err(|_| remote_create_directory_error())?;
            let path = if parent == "/" {
                format!("/{name}")
            } else {
                format!("{}/{name}", parent.trim_end_matches('/'))
            };
            sftp.create_dir(path)
                .await
                .map_err(|_| remote_create_directory_error())
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn rename_remote_entry(
        &self,
        session_id: &str,
        source_path: &str,
        target_name: &str,
    ) -> Result<(), AppError> {
        validate_remote_delete_path(source_path)?;
        validate_remote_directory_name(".", target_name)?;
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let trimmed = source_path.trim_end_matches('/');
            let (parent_path, source_name) = match trimmed.rsplit_once('/') {
                Some(("", name)) => ("/", name),
                Some((parent, name)) => (parent, name),
                None => (".", trimmed),
            };
            if source_name == target_name {
                return Ok(());
            }
            let parent = sftp
                .canonicalize(parent_path)
                .await
                .map_err(|_| remote_rename_error())?;
            let source = if parent == "/" {
                format!("/{source_name}")
            } else {
                format!("{}/{source_name}", parent.trim_end_matches('/'))
            };
            let target = if parent == "/" {
                format!("/{target_name}")
            } else {
                format!("{}/{target_name}", parent.trim_end_matches('/'))
            };
            sftp.symlink_metadata(source.clone())
                .await
                .map_err(|_| remote_rename_error())?;
            sftp.rename(source, target)
                .await
                .map_err(|_| remote_rename_error())
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn move_remote_entry(
        &self,
        session_id: &str,
        source_path: &str,
        target_directory: &str,
    ) -> Result<(), AppError> {
        validate_remote_delete_path(source_path)?;
        if target_directory.is_empty()
            || target_directory.len() > 4_096
            || target_directory.contains('\0')
            || target_directory
                .split('/')
                .any(|component| component == "..")
        {
            return Err(invalid_remote_path_error());
        }
        let session = self.session_handle(session_id).await?;
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let result = async {
            let trimmed = source_path.trim_end_matches('/');
            let (source_parent_path, source_name) = match trimmed.rsplit_once('/') {
                Some(("", name)) => ("/", name),
                Some((parent, name)) => (parent, name),
                None => (".", trimmed),
            };
            let source_parent = sftp
                .canonicalize(source_parent_path)
                .await
                .map_err(|_| remote_move_error())?;
            let destination_parent = sftp
                .canonicalize(target_directory)
                .await
                .map_err(|_| remote_move_error())?;
            let destination_metadata = sftp
                .metadata(destination_parent.clone())
                .await
                .map_err(|_| remote_move_error())?;
            if !destination_metadata.is_dir() {
                return Err(remote_move_error());
            }
            let source = if source_parent == "/" {
                format!("/{source_name}")
            } else {
                format!("{}/{source_name}", source_parent.trim_end_matches('/'))
            };
            let target = if destination_parent == "/" {
                format!("/{source_name}")
            } else {
                format!("{}/{source_name}", destination_parent.trim_end_matches('/'))
            };
            if target.len() > 4_096 || source == target {
                return Err(remote_move_error());
            }
            let source_metadata = sftp
                .symlink_metadata(source.clone())
                .await
                .map_err(|_| remote_move_error())?;
            if !source_metadata.is_regular()
                && !source_metadata.is_dir()
                && !source_metadata.is_symlink()
            {
                return Err(remote_move_error());
            }
            if source_metadata.is_dir()
                && !source_metadata.is_symlink()
                && (destination_parent == source
                    || destination_parent
                        .starts_with(&format!("{}/", source.trim_end_matches('/'))))
            {
                return Err(invalid_remote_path_error());
            }
            if remote_entry_exists(&sftp, target.clone()).await? {
                return Err(remote_move_target_exists_error());
            }
            sftp.rename(source, target)
                .await
                .map_err(|_| remote_move_error())
        }
        .await;
        let _ = sftp.close().await;
        result
    }

    pub async fn copy_remote_entry(
        &self,
        session_id: &str,
        source_path: &str,
        target_directory: &str,
        target_name: &str,
        copy_control: &CopyOperationControl,
    ) -> Result<(), AppError> {
        copy_control.check_cancelled()?;
        validate_remote_delete_path(source_path)?;
        validate_remote_directory_name(target_directory, target_name)?;
        if source_path.len() > 4_096 || target_directory.len() > 4_096 {
            return Err(invalid_remote_path_error());
        }

        let session = self.session_handle(session_id).await?;
        let sftp = tokio::time::timeout(Duration::from_secs(8), session.open_sftp())
            .await
            .map_err(|_| remote_copy_timeout_error())?
            .map_err(|error| ssh_error(&error))?;
        let mut temporary_for_cleanup: Option<(String, bool)> = None;
        let operation = async {
            let (source_parent_path, source_name) = split_remote_parent(source_path)?;
            let source_parent = sftp
                .canonicalize(source_parent_path)
                .await
                .map_err(|_| remote_copy_error())?;
            let source = join_remote_path(&source_parent, source_name);
            let source_metadata = sftp
                .symlink_metadata(source.clone())
                .await
                .map_err(|_| remote_copy_error())?;
            if source_metadata.is_symlink() {
                return Err(remote_copy_unsupported_error());
            }
            if source_metadata.is_dir() {
                let source = sftp
                    .canonicalize(source.clone())
                    .await
                    .map_err(|_| remote_copy_error())?;
                let directory_reader = session
                    .open_sftp_directory_reader()
                    .await
                    .map_err(|_| remote_copy_error())?;
                let scan_result =
                    scan_remote_transfer_tree(&directory_reader, &source, None, Some(copy_control))
                        .await;
                let reader_close_result = directory_reader.close();
                let entries = scan_result?;
                reader_close_result.map_err(|_| remote_copy_error())?;
                let known_size = entries
                    .iter()
                    .filter(|entry| !entry.is_directory)
                    .filter_map(|entry| entry.size)
                    .try_fold(0_u64, |total, size| {
                        total
                            .checked_add(size)
                            .ok_or_else(remote_copy_too_large_error)
                    })?;
                if known_size > REMOTE_COPY_MAX_BYTES {
                    return Err(remote_copy_too_large_error());
                }

                let destination_parent = sftp
                    .canonicalize(target_directory)
                    .await
                    .map_err(|_| remote_copy_error())?;
                let destination_metadata = sftp
                    .metadata(destination_parent.clone())
                    .await
                    .map_err(|_| remote_copy_error())?;
                if !destination_metadata.is_dir() {
                    return Err(remote_copy_error());
                }
                if remote_path_is_same_or_child(&destination_parent, &source) {
                    return Err(remote_copy_unsupported_error());
                }
                let target = join_remote_path(&destination_parent, target_name);
                if target.len() > 4_096 {
                    return Err(invalid_remote_path_error());
                }
                if remote_entry_exists(&sftp, target.clone()).await? {
                    return Err(remote_move_target_exists_error());
                }
                let temporary_path = join_remote_path(
                    &destination_parent,
                    &format!(".filex-copy-{}", uuid::Uuid::new_v4()),
                );
                if temporary_path.len() > 4_096 {
                    return Err(invalid_remote_path_error());
                }
                sftp.create_dir(temporary_path.clone())
                    .await
                    .map_err(|_| remote_copy_error())?;
                temporary_for_cleanup = Some((temporary_path.clone(), true));

                for entry in entries.iter().filter(|entry| entry.is_directory) {
                    copy_control.check_cancelled()?;
                    let target_path =
                        remote_transfer_child_path(&temporary_path, &entry.relative_path);
                    if target_path.len() > 4_096 {
                        return Err(invalid_remote_path_error());
                    }
                    sftp.create_dir(target_path)
                        .await
                        .map_err(|_| remote_copy_error())?;
                }
                let mut copied_total = 0_u64;
                for entry in entries.iter().filter(|entry| !entry.is_directory) {
                    copy_control.check_cancelled()?;
                    let source_metadata = remote_transfer_metadata(&sftp, &entry.remote_path)
                        .await?
                        .ok_or_else(remote_copy_error)?;
                    if source_metadata.is_symlink() || !source_metadata.is_regular() {
                        return Err(remote_copy_unsupported_error());
                    }
                    let target_path =
                        remote_transfer_child_path(&temporary_path, &entry.relative_path);
                    if target_path.len() > 4_096 {
                        return Err(invalid_remote_path_error());
                    }
                    let source_file = sftp
                        .open(entry.remote_path.clone())
                        .await
                        .map_err(|_| remote_copy_error())?;
                    let mut target_file = sftp
                        .open_with_flags(
                            target_path.clone(),
                            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        )
                        .await
                        .map_err(|_| remote_copy_error())?;
                    let remaining = REMOTE_COPY_MAX_BYTES.saturating_sub(copied_total);
                    let mut bounded_source = source_file.take(remaining.saturating_add(1));
                    let copy_result = copy_stream_cancellable(
                        &mut bounded_source,
                        &mut target_file,
                        copy_control.cancellation_token(),
                    )
                    .await;
                    let source_file = bounded_source.into_inner();
                    let source_close_failed = source_file.close().await.is_err();
                    let target_flush_failed = target_file.shutdown().await.is_err();
                    let target_close_failed = target_file.close().await.is_err();
                    let copied = match copy_result {
                        Ok(bytes)
                            if bytes <= remaining
                                && !source_close_failed
                                && !target_flush_failed
                                && !target_close_failed =>
                        {
                            bytes
                        }
                        Ok(bytes) if bytes > remaining => return Err(remote_copy_too_large_error()),
                        Err(_) if copy_control.cancellation_token().is_cancelled() => {
                            return Err(transfer_cancelled_error());
                        }
                        _ => return Err(remote_copy_error()),
                    };
                    if let Some(permissions) = source_metadata.permissions {
                        let mut attributes = FileAttributes::empty();
                        attributes.permissions = Some(permissions);
                        sftp.set_metadata(target_path, attributes)
                            .await
                            .map_err(|_| remote_copy_error())?;
                    }
                    copied_total = copied_total
                        .checked_add(copied)
                        .ok_or_else(remote_copy_too_large_error)?;
                }
                for entry in entries.iter().rev().filter(|entry| entry.is_directory) {
                    if let Some(permissions) = entry.permissions {
                        let target_path =
                            remote_transfer_child_path(&temporary_path, &entry.relative_path);
                        let mut attributes = FileAttributes::empty();
                        attributes.permissions = Some(permissions);
                        sftp.set_metadata(target_path, attributes)
                            .await
                            .map_err(|_| remote_copy_error())?;
                    }
                }
                if let Some(permissions) = source_metadata.permissions {
                    let mut attributes = FileAttributes::empty();
                    attributes.permissions = Some(permissions);
                    sftp.set_metadata(temporary_path.clone(), attributes)
                        .await
                        .map_err(|_| remote_copy_error())?;
                }
                copy_control.begin_commit()?;
                if remote_entry_exists(&sftp, target.clone()).await? {
                    return Err(remote_move_target_exists_error());
                }
                sftp.rename(temporary_path.clone(), target.clone())
                    .await
                    .map_err(|_| remote_copy_error())?;
                temporary_for_cleanup = None;
                return Ok(());
            }
            if !source_metadata.is_regular() {
                return Err(remote_copy_unsupported_error());
            }
            if source_metadata
                .size
                .is_some_and(|size| size > REMOTE_COPY_MAX_BYTES)
            {
                return Err(remote_copy_too_large_error());
            }

            let destination_parent = sftp
                .canonicalize(target_directory)
                .await
                .map_err(|_| remote_copy_error())?;
            let destination_metadata = sftp
                .metadata(destination_parent.clone())
                .await
                .map_err(|_| remote_copy_error())?;
            if !destination_metadata.is_dir() {
                return Err(remote_copy_error());
            }
            let target = join_remote_path(&destination_parent, target_name);
            if target.len() > 4_096 {
                return Err(invalid_remote_path_error());
            }
            if remote_entry_exists(&sftp, target.clone()).await? {
                return Err(remote_move_target_exists_error());
            }

            let temporary_path = join_remote_path(
                &destination_parent,
                &format!(".filex-copy-{}.part", uuid::Uuid::new_v4()),
            );
            if temporary_path.len() > 4_096 {
                return Err(invalid_remote_path_error());
            }
            let source_file = sftp.open(source).await.map_err(|_| remote_copy_error())?;
            let mut temporary = sftp
                .open_with_flags(
                    temporary_path.clone(),
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                )
                .await
                .map_err(|_| remote_copy_error())?;
            temporary_for_cleanup = Some((temporary_path.clone(), false));

            let mut bounded_source = source_file.take(REMOTE_COPY_MAX_BYTES + 1);
            let copy_result = copy_stream_cancellable(
                &mut bounded_source,
                &mut temporary,
                copy_control.cancellation_token(),
            )
            .await;
            let source_file = bounded_source.into_inner();
            let source_close_failed = source_file.close().await.is_err();
            match copy_result {
                Ok(bytes) if bytes <= REMOTE_COPY_MAX_BYTES && !source_close_failed => {}
                Ok(bytes) if bytes > REMOTE_COPY_MAX_BYTES => {
                    let _ = temporary.close().await;
                    return Err(remote_copy_too_large_error());
                }
                Err(_) if copy_control.cancellation_token().is_cancelled() => {
                    let _ = temporary.close().await;
                    return Err(transfer_cancelled_error());
                }
                _ => {
                    let _ = temporary.close().await;
                    return Err(remote_copy_error());
                }
            }

            let flush_failed = temporary.shutdown().await.is_err();
            let close_failed = temporary.close().await.is_err();
            if flush_failed || close_failed {
                return Err(remote_copy_error());
            }
            if let Some(permissions) = source_metadata.permissions {
                let mut attributes = FileAttributes::empty();
                attributes.permissions = Some(permissions);
                if sftp
                    .set_metadata(temporary_path.clone(), attributes)
                    .await
                    .is_err()
                {
                    return Err(remote_copy_error());
                }
            }
            copy_control.begin_commit()?;
            if remote_entry_exists(&sftp, target.clone()).await? {
                return Err(remote_move_target_exists_error());
            }
            if sftp
                .rename(temporary_path.clone(), target.clone())
                .await
                .is_err()
            {
                return match remote_entry_exists(&sftp, target).await {
                    Ok(true) => Err(remote_move_target_exists_error()),
                    Ok(false) => Err(remote_copy_error()),
                    Err(error) => Err(error),
                };
            }
            temporary_for_cleanup = None;
            Ok(())
        };
        let result =
            match tokio::time::timeout(Duration::from_secs(REMOTE_COPY_TIMEOUT_SECONDS), operation)
                .await
            {
                Ok(result) => result,
                Err(_) => Err(remote_copy_timeout_error()),
            };
        if let Some((temporary_path, is_directory)) = temporary_for_cleanup {
            if is_directory {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    remove_remote_tree(&session, &sftp, &temporary_path),
                )
                .await;
            } else {
                let _ =
                    tokio::time::timeout(Duration::from_secs(5), sftp.remove_file(temporary_path))
                        .await;
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.close()).await;
        result
    }

    pub fn prepare_transfer(&self, task_id: &str, session_id: &str) -> Result<(), AppError> {
        if task_id.trim().is_empty() || session_id.trim().is_empty() {
            return Err(transfer_control_transition_error());
        }
        let mut controls = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?;
        if controls.contains_key(task_id) {
            return Err(transfer_control_transition_error());
        }
        controls.insert(
            task_id.to_owned(),
            Arc::new(TransferControl::new(session_id.to_owned())),
        );
        Ok(())
    }

    pub fn finish_transfer(&self, task_id: &str) -> Result<(), AppError> {
        self.transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .remove(task_id);
        Ok(())
    }

    pub async fn prepare_transfer_resume(
        &self,
        task_id: &str,
        session_id: &str,
    ) -> Result<bool, AppError> {
        let control = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .get(task_id)
            .cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        if control.session_id == session_id {
            let state = control.state.lock().map_err(|_| session_lock_error())?;
            match *state {
                TransferExecutionState::Paused => return Ok(true),
                TransferExecutionState::Running | TransferExecutionState::Committing => {
                    return Err(transfer_control_transition_error());
                }
                TransferExecutionState::Cancelled | TransferExecutionState::Finished => {}
            }
        } else if !control.is_terminal()? {
            control.cancel()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let still_registered = self
                .transfer_controls
                .lock()
                .map_err(|_| session_lock_error())?
                .contains_key(task_id);
            if !still_registered {
                return Ok(false);
            }
            if Instant::now() >= deadline {
                return Err(transfer_control_transition_error());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn resume_transfer_control(
        &self,
        task_id: &str,
        session_id: &str,
    ) -> Result<bool, AppError> {
        let control = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .get(task_id)
            .cloned();
        let Some(control) = control else {
            return Ok(false);
        };
        if control.session_id != session_id {
            return Ok(false);
        }
        control.resume()?;
        Ok(true)
    }

    pub fn pause_transfer(&self, task_id: &str) -> Result<Option<u64>, AppError> {
        let control = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .get(task_id)
            .cloned();
        let Some(control) = control else {
            return Ok(None);
        };
        control.pause()?;
        Ok(Some(control.bytes_transferred()))
    }

    pub async fn execute_transfer<F>(
        &self,
        session_id: &str,
        task: &TransferTask,
        on_progress: F,
    ) -> Result<u64, AppError>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let control = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .get(&task.id)
            .cloned()
            .filter(|control| control.session_id == session_id)
            .ok_or_else(transfer_control_transition_error)?;
        let result = async {
            let session = {
                let connections = self.connections.lock().await;
                connections
                    .get(session_id)
                    .map(|connection| connection.session.clone())
                    .ok_or_else(session_not_found_error)?
            };
            let sftp = session
                .open_sftp()
                .await
                .map_err(|error| ssh_error(&error))?;
            let transfer_result = match task.direction {
                TransferDirection::Upload => {
                    upload(&session, &sftp, task, &control, &on_progress).await
                }
                TransferDirection::Download => {
                    download(&sftp, &session, task, &control, &on_progress).await
                }
            };
            let _ = sftp.close().await;
            transfer_result
        }
        .await;
        control.finish()?;
        result
    }

    pub async fn collect_monitor(
        &self,
        session_id: &str,
    ) -> Result<SystemMonitorSnapshot, AppError> {
        let session = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.session.clone())
                .ok_or_else(session_not_found_error)?
        };
        let windows_command = windows_monitor_command();
        let windows_output = session
            .execute_bounded(&windows_command, 64 * 1024, Duration::from_secs(8))
            .await
            .map_err(|error| ssh_error(&error))?;
        let windows_text = String::from_utf8_lossy(&windows_output.stdout);
        if windows_text
            .lines()
            .any(|line| line.trim() == "PLATFORM=WINDOWS")
        {
            if windows_output.exit_status.is_some_and(|status| status != 0) {
                return Err(monitor_probe_error());
            }
            return Ok(parse_monitor_probe(&windows_text, now_ms()?));
        }
        let output = session
            .execute_bounded(MONITOR_PROBE, 64 * 1024, Duration::from_secs(8))
            .await
            .map_err(|error| ssh_error(&error))?;
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(monitor_probe_error());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(parse_monitor_probe(&text, now_ms()?))
    }

    pub async fn collect_process_snapshot(
        &self,
        session_id: &str,
    ) -> Result<ProcessSnapshot, AppError> {
        self.invalidate_process_snapshot(session_id)?;
        let session = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.session.clone())
                .ok_or_else(session_not_found_error)?
        };
        let windows_output = session
            .execute_bounded(
                &windows_process_command(),
                64 * 1024,
                Duration::from_secs(8),
            )
            .await
            .map_err(|error| ssh_error(&error))?;
        let windows_text = String::from_utf8_lossy(&windows_output.stdout);
        if windows_text
            .lines()
            .any(|line| line.trim() == "PLATFORM=WINDOWS")
        {
            if windows_output.exit_status.is_some_and(|status| status != 0) {
                return Err(process_probe_error());
            }
            let parsed = parse_windows_process_output(&windows_text)?;
            return self.save_process_snapshot(session_id, ProcessPlatform::Windows, parsed);
        }

        let output = session
            .execute_bounded(PROCESS_LIST_PROBE, 64 * 1024, Duration::from_secs(8))
            .await
            .map_err(|error| ssh_error(&error))?;
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(process_probe_error());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        if text
            .lines()
            .any(|line| line.trim() == "PLATFORM=UNSUPPORTED")
        {
            self.invalidate_process_snapshot(session_id)?;
            return Ok(ProcessSnapshot {
                state: MonitorState::Unsupported,
                platform: None,
                collected_at_ms: now_ms()?,
                snapshot_id: None,
                processes: Vec::new(),
                truncated: false,
            });
        }
        let parsed = parse_posix_process_output(&text, now_ms()?)?;
        self.save_process_snapshot(session_id, ProcessPlatform::Posix, parsed)
    }

    pub async fn collect_network_snapshot(
        &self,
        session_id: &str,
    ) -> Result<NetworkSnapshot, AppError> {
        let session = self.session_handle(session_id).await?;
        let windows_output = session
            .execute_bounded(
                &windows_network_command(),
                256 * 1024,
                Duration::from_secs(12),
            )
            .await
            .map_err(|error| ssh_error(&error))?;
        let windows_text = String::from_utf8_lossy(&windows_output.stdout);
        if windows_text
            .lines()
            .any(|line| line.trim() == "PLATFORM=WINDOWS")
        {
            if windows_output.exit_status.is_some_and(|status| status != 0) {
                return Err(network_probe_error());
            }
            return parse_windows_network_output(&windows_text, now_ms()?);
        }

        let output = session
            .execute_bounded(
                NETWORK_INSPECTION_PROBE,
                256 * 1024,
                Duration::from_secs(12),
            )
            .await
            .map_err(|error| ssh_error(&error))?;
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(network_probe_error());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        parse_linux_network_output(&text, now_ms()?)
    }

    pub async fn collect_docker_snapshot(
        &self,
        session_id: &str,
    ) -> Result<DockerSnapshot, AppError> {
        let session = self.session_handle(session_id).await?;
        let output = session
            .execute_bounded(
                DOCKER_SNAPSHOT_PROBE,
                DOCKER_PROBE_OUTPUT_BYTES,
                Duration::from_secs(12),
            )
            .await
            .map_err(|error| ssh_error(&error))?;
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.lines().any(|line| line.starts_with("DOCKER="))
            && output.exit_status.is_some_and(|status| status != 0)
        {
            return Ok(DockerSnapshot {
                availability: DockerAvailability::Unsupported,
                collected_at_ms: now_ms()?,
                server_version: None,
                containers: Vec::new(),
                images: Vec::new(),
                truncated: false,
                detail_note: None,
            });
        }
        parse_docker_snapshot(&text, now_ms()?)
    }

    pub async fn collect_docker_logs(
        &self,
        session_id: &str,
        container_id: &str,
        tail_lines: Option<u32>,
    ) -> Result<DockerLogsSnapshot, AppError> {
        let command = docker_logs_command(container_id, tail_lines)?;
        let session = self.session_handle(session_id).await?;
        let output = session
            .execute_bounded(&command, DOCKER_LOGS_OUTPUT_BYTES, Duration::from_secs(10))
            .await
            .map_err(|error| ssh_error(&error))?;
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(docker_probe_error());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(parse_docker_logs(container_id.trim().to_owned(), &text))
    }

    pub async fn run_docker_container_action(
        &self,
        session_id: &str,
        container_id: &str,
        action: DockerContainerAction,
    ) -> Result<(), AppError> {
        let command = docker_action_command(container_id, action)?;
        let session = self.session_handle(session_id).await?;
        let output = session
            .execute_bounded(&command, 16 * 1024, Duration::from_secs(20))
            .await
            .map_err(|error| ssh_error(&error))?;
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(docker_action_error());
        }
        Ok(())
    }

    pub async fn collect_ops_snapshot(
        &self,
        session_id: &str,
        category: OpsCategory,
    ) -> Result<OpsSnapshot, AppError> {
        let session = self.session_handle(session_id).await?;
        let output = session
            .execute_bounded(
                ops_probe_command(category),
                OPS_PROBE_OUTPUT_BYTES,
                Duration::from_secs(10),
            )
            .await
            .map_err(|error| ssh_error(&error))?;
        let text = String::from_utf8_lossy(&output.stdout);
        if !text.lines().any(|line| line.trim() == "OPS_PLATFORM=POSIX")
            && output.exit_status.is_some_and(|status| status != 0)
        {
            return Ok(OpsSnapshot {
                state: MonitorState::Unsupported,
                collected_at_ms: now_ms()?,
                category,
                hostname: None,
                kernel: None,
                os_release: None,
                sections: Vec::new(),
            });
        }
        parse_ops_snapshot(category, &text, now_ms()?)
    }

    pub async fn compare_file_checksums(
        &self,
        operation_id: &str,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<FileChecksumComparison, AppError> {
        if !valid_checksum_operation_id(operation_id)
            || local_path.is_empty()
            || local_path.contains('\0')
            || remote_path.is_empty()
            || remote_path.contains('\0')
        {
            return Err(checksum_target_invalid_error());
        }
        let cancellation = CancellationToken::new();
        {
            let mut operations = self
                .checksum_cancellations
                .lock()
                .map_err(|_| session_lock_error())?;
            if operations.len() >= FILE_CHECKSUM_MAX_CONCURRENT
                || operations.contains_key(operation_id)
            {
                return Err(checksum_busy_error());
            }
            operations.insert(operation_id.to_owned(), cancellation.clone());
        }

        let operation = self.compare_file_checksums_inner(
            session_id,
            local_path,
            remote_path,
            cancellation.clone(),
        );
        tokio::pin!(operation);
        let deadline = tokio::time::sleep(Duration::from_secs(FILE_CHECKSUM_TIMEOUT_SECONDS));
        tokio::pin!(deadline);
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(checksum_cancelled_error()),
            result = &mut operation => result,
            () = &mut deadline => {
                cancellation.cancel();
                Err(checksum_timeout_error())
            }
        };
        if let Ok(mut operations) = self.checksum_cancellations.lock() {
            operations.remove(operation_id);
        }
        result
    }

    pub fn cancel_file_checksum(&self, operation_id: &str) -> Result<(), AppError> {
        if !valid_checksum_operation_id(operation_id) {
            return Err(checksum_target_invalid_error());
        }
        let operations = self
            .checksum_cancellations
            .lock()
            .map_err(|_| session_lock_error())?;
        operations
            .get(operation_id)
            .ok_or_else(checksum_not_running_error)?
            .cancel();
        Ok(())
    }

    async fn compare_file_checksums_inner(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        cancellation: CancellationToken,
    ) -> Result<FileChecksumComparison, AppError> {
        let local_path = PathBuf::from(local_path);
        let local_path_metadata = tokio::fs::symlink_metadata(&local_path)
            .await
            .map_err(|_| checksum_read_error())?;
        if local_path_metadata.file_type().is_symlink() || !local_path_metadata.is_file() {
            return Err(checksum_target_unsupported_error());
        }
        if local_path_metadata.len() > FILE_CHECKSUM_MAX_BYTES {
            return Err(checksum_too_large_error());
        }
        let mut local_file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|_| checksum_read_error())?;
        let local_before = local_file
            .metadata()
            .await
            .map_err(|_| checksum_read_error())?;
        if !local_before.is_file() {
            return Err(checksum_target_unsupported_error());
        }
        if local_metadata_changed(&local_path_metadata, &local_before) {
            return Err(checksum_target_changed_error());
        }
        if local_before.len() > FILE_CHECKSUM_MAX_BYTES {
            return Err(checksum_too_large_error());
        }
        let (local_sha256, local_bytes) = hash_reader(&mut local_file, &cancellation).await?;
        let local_after = local_file
            .metadata()
            .await
            .map_err(|_| checksum_read_error())?;
        let local_path_after = tokio::fs::symlink_metadata(&local_path)
            .await
            .map_err(|_| checksum_target_changed_error())?;
        if local_metadata_changed(&local_before, &local_after)
            || local_metadata_changed(&local_path_metadata, &local_path_after)
            || local_path_after.file_type().is_symlink()
            || !local_path_after.is_file()
            || local_bytes != local_before.len()
        {
            return Err(checksum_target_changed_error());
        }
        drop(local_file);

        let session = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.session.clone())
                .ok_or_else(session_not_found_error)?
        };
        let sftp = session
            .open_sftp()
            .await
            .map_err(|error| ssh_error(&error))?;
        let comparison = async {
            let remote_before = sftp
                .symlink_metadata(remote_path)
                .await
                .map_err(|_| checksum_read_error())?;
            if remote_before.is_symlink() || !remote_before.is_regular() {
                return Err(checksum_target_unsupported_error());
            }
            if remote_before
                .size
                .is_some_and(|size| size > FILE_CHECKSUM_MAX_BYTES)
            {
                return Err(checksum_too_large_error());
            }
            let mut remote_file = sftp
                .open(remote_path.to_owned())
                .await
                .map_err(|_| checksum_read_error())?;
            let remote_hash = hash_reader(&mut remote_file, &cancellation).await;
            let remote_close = remote_file.close().await;
            let (remote_sha256, remote_bytes) = remote_hash?;
            remote_close.map_err(|_| checksum_read_error())?;
            let remote_after = sftp
                .symlink_metadata(remote_path)
                .await
                .map_err(|_| checksum_target_changed_error())?;
            if remote_metadata_changed(&remote_before, &remote_after)
                || remote_after.is_symlink()
                || !remote_after.is_regular()
                || remote_before.size.is_some_and(|size| size != remote_bytes)
            {
                return Err(checksum_target_changed_error());
            }
            Ok(FileChecksumComparison {
                local_bytes,
                remote_bytes,
                equal: local_bytes == remote_bytes && local_sha256 == remote_sha256,
                local_sha256,
                remote_sha256,
            })
        }
        .await;
        let _ = sftp.close().await;
        comparison
    }

    pub async fn preview_directory_sync(
        &self,
        operation_id: &str,
        session_id: &str,
        local_root: &str,
        remote_root: &str,
    ) -> Result<DirectorySyncPreview, AppError> {
        if !valid_checksum_operation_id(operation_id)
            || local_root.is_empty()
            || local_root.len() > 4_096
            || local_root.contains('\0')
            || remote_root.is_empty()
            || remote_root.len() > 4_096
            || remote_root.contains('\0')
            || remote_root.split('/').any(|component| component == "..")
        {
            return Err(sync_preview_invalid_target_error());
        }

        let cancellation = CancellationToken::new();
        {
            let mut operations = self
                .sync_preview_cancellations
                .lock()
                .map_err(|_| session_lock_error())?;
            if !operations.is_empty() || operations.contains_key(operation_id) {
                return Err(sync_preview_busy_error());
            }
            operations.insert(operation_id.to_owned(), cancellation.clone());
        }

        let operation = self.preview_directory_sync_inner(
            session_id,
            local_root,
            remote_root,
            cancellation.clone(),
        );
        tokio::pin!(operation);
        let deadline = tokio::time::sleep(Duration::from_secs(DIRECTORY_SYNC_TIMEOUT_SECONDS));
        tokio::pin!(deadline);
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = (&mut operation).await;
                Err(sync_preview_cancelled_error())
            }
            result = &mut operation => result,
            () = &mut deadline => {
                cancellation.cancel();
                let _ = (&mut operation).await;
                Err(sync_preview_timeout_error())
            }
        };
        if let Ok(mut operations) = self.sync_preview_cancellations.lock() {
            operations.remove(operation_id);
        }
        result
    }

    pub fn cancel_directory_sync_preview(&self, operation_id: &str) -> Result<(), AppError> {
        if !valid_checksum_operation_id(operation_id) {
            return Err(sync_preview_invalid_target_error());
        }
        let operations = self
            .sync_preview_cancellations
            .lock()
            .map_err(|_| session_lock_error())?;
        operations
            .get(operation_id)
            .ok_or_else(sync_preview_not_running_error)?
            .cancel();
        Ok(())
    }

    async fn preview_directory_sync_inner(
        &self,
        session_id: &str,
        local_root: &str,
        remote_root: &str,
        cancellation: CancellationToken,
    ) -> Result<DirectorySyncPreview, AppError> {
        let requested_local_root = PathBuf::from(local_root);
        let local_root_metadata = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
            result = tokio::fs::symlink_metadata(&requested_local_root) => {
                result.map_err(|_| sync_preview_failed_error())?
            }
        };
        if local_root_metadata.file_type().is_symlink() || !local_root_metadata.is_dir() {
            return Err(sync_preview_unsupported_root_error());
        }
        let local_root = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
            result = tokio::fs::canonicalize(&requested_local_root) => {
                result.map_err(|_| sync_preview_failed_error())?
            }
        };
        if local_root.to_str().is_none() {
            return Err(sync_preview_path_unsupported_error());
        }
        let local_entries = scan_local_directory_tree(&local_root, &cancellation).await?;

        let session = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.session.clone())
                .ok_or_else(session_not_found_error)?
        };
        let sftp = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
            result = session.open_sftp() => result.map_err(|error| ssh_error(&error))?,
        };
        let directory_reader = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = sftp.close().await;
                return Err(sync_preview_cancelled_error());
            }
            result = session.open_sftp_directory_reader() => match result {
                Ok(reader) => reader,
                Err(error) => {
                    let _ = sftp.close().await;
                    return Err(ssh_error(&error));
                }
            },
        };
        let remote_result = async {
            let root_metadata = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
                result = sftp.symlink_metadata(remote_root) => {
                    result.map_err(|_| sync_preview_failed_error())?
                }
            };
            if root_metadata.is_symlink() || !root_metadata.is_dir() {
                return Err(sync_preview_unsupported_root_error());
            }
            let canonical_remote_root = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
                result = sftp.canonicalize(remote_root) => {
                    result.map_err(|_| sync_preview_failed_error())?
                }
            };
            if canonical_remote_root.len() > 4_096 {
                return Err(sync_preview_invalid_target_error());
            }

            let mut remote_entries = BTreeMap::new();
            let mut directories = vec![(canonical_remote_root, String::new(), 0_usize)];
            while let Some((directory_path, relative_parent, depth)) = directories.pop() {
                let remaining = DIRECTORY_SYNC_MAX_ENTRIES.saturating_sub(remote_entries.len());
                let entries = directory_reader
                    .read_dir_limited(&directory_path, remaining, cancellation.cancelled())
                    .await
                    .map_err(|error| match error {
                        SshError::DirectoryEntryLimit => sync_preview_limit_error(),
                        SshError::Cancelled => sync_preview_cancelled_error(),
                        _ => sync_preview_failed_error(),
                    })?;
                for entry in entries {
                    if cancellation.is_cancelled() {
                        return Err(sync_preview_cancelled_error());
                    }
                    let name = entry.name;
                    if name == "." || name == ".." {
                        continue;
                    }
                    if !valid_directory_sync_segment(&name) {
                        return Err(sync_preview_path_unsupported_error());
                    }
                    let relative_path = join_relative_sync_path(&relative_parent, &name);
                    if relative_path.len() > 4_096 {
                        return Err(sync_preview_limit_error());
                    }
                    if remote_entries.len() >= DIRECTORY_SYNC_MAX_ENTRIES {
                        return Err(sync_preview_limit_error());
                    }
                    let attributes = entry.attributes;
                    let kind = if attributes.is_symlink() {
                        DirectorySyncEntryKind::Symlink
                    } else if attributes.is_dir() {
                        DirectorySyncEntryKind::Directory
                    } else if attributes.is_regular() {
                        DirectorySyncEntryKind::File
                    } else {
                        DirectorySyncEntryKind::Special
                    };
                    let is_directory = kind == DirectorySyncEntryKind::Directory;
                    let size = if kind == DirectorySyncEntryKind::File {
                        attributes.size
                    } else {
                        None
                    };
                    let node = DirectorySyncNode {
                        kind,
                        size,
                        modified_at_ms: if size.is_some() {
                            attributes.mtime.map(|seconds| u64::from(seconds) * 1_000)
                        } else {
                            None
                        },
                    };
                    remote_entries.insert(relative_path.clone(), node);
                    if is_directory {
                        if depth >= DIRECTORY_SYNC_MAX_DEPTH {
                            return Err(sync_preview_limit_error());
                        }
                        let child_path = join_remote_directory_path(&directory_path, &name);
                        directories.push((child_path, relative_path, depth + 1));
                    }
                }
            }
            if cancellation.is_cancelled() {
                return Err(sync_preview_cancelled_error());
            }
            Ok(remote_entries)
        }
        .await;
        let _ = directory_reader.close();
        let _ = sftp.close().await;
        let remote_entries = remote_result?;
        if cancellation.is_cancelled() {
            return Err(sync_preview_cancelled_error());
        }

        let preview = compare_directory_sync_trees(local_entries, remote_entries);
        if cancellation.is_cancelled() {
            return Err(sync_preview_cancelled_error());
        }
        Ok(preview)
    }

    pub async fn terminate_remote_process(
        &self,
        session_id: &str,
        snapshot_id: &str,
        pid: u32,
        signal: ProcessSignal,
    ) -> Result<(), AppError> {
        if pid <= 1 {
            return Err(process_target_invalid_error());
        }
        let (platform, identity) = {
            let now = now_ms()?;
            let snapshots = self
                .process_snapshots
                .lock()
                .map_err(|_| session_lock_error())?;
            let snapshot = snapshots
                .get(session_id)
                .filter(|snapshot| snapshot.id == snapshot_id)
                .ok_or_else(process_snapshot_stale_error)?;
            if now.saturating_sub(snapshot.collected_at_ms) > 60_000 {
                return Err(process_snapshot_stale_error());
            }
            let identity = snapshot
                .identities
                .get(&pid)
                .cloned()
                .ok_or_else(process_snapshot_stale_error)?;
            (snapshot.platform.clone(), identity)
        };
        let command = match (&platform, &identity) {
            (
                ProcessPlatform::Posix,
                ProcessIdentity::Posix {
                    start_marker_hex,
                    name_marker_hex,
                },
            ) if is_hex_marker(start_marker_hex, 512)
                && is_hex_marker(name_marker_hex, 256)
                && !start_marker_hex.is_empty()
                && !name_marker_hex.is_empty() =>
            {
                posix_terminate_command(pid, start_marker_hex, name_marker_hex, signal)
            }
            (ProcessPlatform::Windows, ProcessIdentity::Windows { start_time_ticks })
                if *start_time_ticks > 0
                    && matches!(signal, ProcessSignal::Sigterm | ProcessSignal::Sigkill) =>
            {
                windows_terminate_command(pid, *start_time_ticks)
            }
            (ProcessPlatform::Windows, _) => return Err(process_target_invalid_error()),
            _ => return Err(process_snapshot_stale_error()),
        };
        self.invalidate_process_snapshot(session_id)?;
        let session = {
            let connections = self.connections.lock().await;
            connections
                .get(session_id)
                .map(|connection| connection.session.clone())
                .ok_or_else(session_not_found_error)?
        };
        let output = session
            .execute_bounded(&command, 8 * 1024, Duration::from_secs(8))
            .await
            .map_err(|error| ssh_error(&error))?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.lines().any(|line| {
            matches!(
                line.trim(),
                "PROCESS_IDENTITY_CHANGED" | "PROCESS_TARGET_MISSING"
            )
        }) {
            return Err(process_snapshot_stale_error());
        }
        if output.exit_status.is_some_and(|status| status != 0) {
            return Err(process_termination_error());
        }
        if text
            .lines()
            .any(|line| line.trim() == "PROCESS_SIGNAL_SENT")
        {
            return Ok(());
        }
        Err(process_termination_error())
    }

    fn save_process_snapshot(
        &self,
        session_id: &str,
        platform: ProcessPlatform,
        parsed: ParsedProcesses,
    ) -> Result<ProcessSnapshot, AppError> {
        let collected_at_ms = now_ms()?;
        let snapshot_id = uuid::Uuid::new_v4().to_string();
        let can_terminate = parsed.identities.keys().copied().collect::<HashSet<_>>();
        let processes = parsed
            .processes
            .into_iter()
            .map(|mut process| {
                process.can_terminate = can_terminate.contains(&process.pid);
                process
            })
            .collect();
        self.process_snapshots
            .lock()
            .map_err(|_| session_lock_error())?
            .insert(
                session_id.to_owned(),
                CachedProcessSnapshot {
                    id: snapshot_id.clone(),
                    platform: platform.clone(),
                    collected_at_ms,
                    identities: parsed.identities,
                },
            );
        Ok(ProcessSnapshot {
            state: MonitorState::Live,
            platform: Some(platform),
            collected_at_ms,
            snapshot_id: Some(snapshot_id),
            processes,
            truncated: parsed.truncated,
        })
    }

    async fn register_tunnel(
        &self,
        id: String,
        summary: Arc<Mutex<TunnelSummary>>,
        cancellation: CancellationToken,
    ) -> Result<(), AppError> {
        self.tunnels.lock().await.insert(
            id,
            TunnelRuntime {
                summary,
                cancellation,
            },
        );
        Ok(())
    }

    pub async fn start_local_tunnel(
        &self,
        input: CreateLocalTunnelInput,
    ) -> Result<TunnelSummary, AppError> {
        validate_tunnel_input(&input)?;
        let session_summary = self.summary(&input.session_id)?;
        if session_summary.profile_id != input.profile_id {
            return Err(session_not_found_error());
        }
        let session = self.session_handle(&input.session_id).await?;
        if matches!(&input.kind, TunnelKind::Remote) {
            return self.start_remote_tunnel(input, session).await;
        }
        let listener = TcpListener::bind((input.bind_host.as_str(), input.bind_port))
            .await
            .map_err(|_| tunnel_bind_error())?;
        let local_address = listener.local_addr().map_err(|_| tunnel_bind_error())?;
        let id = uuid::Uuid::new_v4().to_string();
        let summary = Arc::new(Mutex::new(TunnelSummary {
            id: id.clone(),
            session_id: input.session_id,
            profile_id: input.profile_id,
            name: input.name.trim().to_owned(),
            kind: input.kind.clone(),
            bind_host: local_address.ip().to_string(),
            bind_port: local_address.port(),
            target_host: input.target_host,
            target_port: input.target_port,
            state: TunnelState::Listening,
            last_error: None,
        }));
        let cancellation = CancellationToken::new();
        self.register_tunnel(id, summary.clone(), cancellation.clone())
            .await?;
        let worker_summary = summary.clone();
        tauri::async_runtime::spawn(async move {
            let mut accept_error = None;
            let mut active_connections = tokio::task::JoinSet::new();
            loop {
                let accepted = tokio::select! {
                    () = cancellation.cancelled() => break,
                    result = active_connections.join_next(), if !active_connections.is_empty() => {
                        let _ = result;
                        continue;
                    }
                    accepted = listener.accept() => accepted,
                };
                let (mut local, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(_) => {
                        accept_error = Some(tunnel_accept_error());
                        break;
                    }
                };
                if active_connections.len() >= TUNNEL_MAX_CONNECTIONS {
                    continue;
                }
                let forwarded_session = session.clone();
                let (kind, target_host, target_port) = worker_summary
                    .lock()
                    .ok()
                    .map(|summary| {
                        (
                            summary.kind.clone(),
                            summary.target_host.clone(),
                            summary.target_port,
                        )
                    })
                    .unwrap_or((TunnelKind::Local, None, None));
                active_connections.spawn(async move {
                    match kind {
                        TunnelKind::Local => {
                            if let (Some(target_host), Some(target_port)) =
                                (target_host, target_port)
                            {
                                if let Ok(mut remote) = forwarded_session
                                    .open_direct_tcpip(
                                        &target_host,
                                        u32::from(target_port),
                                        &peer.ip().to_string(),
                                        u32::from(peer.port()),
                                    )
                                    .await
                                {
                                    let _ = copy_bidirectional(&mut local, &mut remote).await;
                                }
                            }
                        }
                        TunnelKind::Dynamic => {
                            let _ = serve_socks5(local, forwarded_session, peer).await;
                        }
                        TunnelKind::Remote => {}
                    }
                });
            }
            drop(listener);
            active_connections.abort_all();
            while active_connections.join_next().await.is_some() {}
            if let Ok(mut summary) = worker_summary.lock() {
                if summary.state == TunnelState::Stopping {
                    summary.state = TunnelState::Stopped;
                    summary.last_error = None;
                } else if let Some(error) = accept_error {
                    summary.state = TunnelState::Failed;
                    summary.last_error = Some(error);
                }
            }
        });
        summary
            .lock()
            .map(|summary| summary.clone())
            .map_err(|_| session_lock_error())
    }

    async fn start_remote_tunnel(
        &self,
        input: CreateLocalTunnelInput,
        session: Arc<ConnectedSshSession>,
    ) -> Result<TunnelSummary, AppError> {
        let target_host = input
            .target_host
            .clone()
            .ok_or_else(tunnel_validation_error)?;
        let target_port = input.target_port.ok_or_else(tunnel_validation_error)?;
        let address = input.bind_host.clone();
        let (bound_port, mut forwarded_channels) = session
            .request_remote_forward(&address, input.bind_port)
            .await
            .map_err(|error| ssh_error(&error))?;
        let id = uuid::Uuid::new_v4().to_string();
        let summary = Arc::new(Mutex::new(TunnelSummary {
            id: id.clone(),
            session_id: input.session_id,
            profile_id: input.profile_id,
            name: input.name.trim().to_owned(),
            kind: TunnelKind::Remote,
            bind_host: input.bind_host.clone(),
            bind_port: bound_port,
            target_host: Some(target_host.clone()),
            target_port: Some(target_port),
            state: TunnelState::Listening,
            last_error: None,
        }));
        let cancellation = CancellationToken::new();
        if let Err(error) = self
            .register_tunnel(id, summary.clone(), cancellation.clone())
            .await
        {
            let cleanup_session = session.clone();
            let cleanup_address = address.clone();
            tauri::async_runtime::spawn(async move {
                let _ = cleanup_session
                    .cancel_remote_forward(&cleanup_address, bound_port)
                    .await;
            });
            return Err(error);
        }
        let worker_summary = summary.clone();
        tauri::async_runtime::spawn(async move {
            let mut accept_error = None;
            let mut active_connections = tokio::task::JoinSet::new();
            loop {
                let incoming = tokio::select! {
                    () = cancellation.cancelled() => break,
                    result = active_connections.join_next(), if !active_connections.is_empty() => {
                        let _ = result;
                        continue;
                    }
                    incoming = forwarded_channels.recv() => incoming,
                };
                let Some(mut forwarded) = incoming else {
                    if let Ok(mut state) = worker_summary.lock()
                        && matches!(&state.state, TunnelState::Starting | TunnelState::Listening)
                    {
                        state.state = TunnelState::Stopping;
                    }
                    accept_error = Some(tunnel_accept_error());
                    break;
                };
                if active_connections.len() >= TUNNEL_MAX_CONNECTIONS {
                    continue;
                }
                let target_host = target_host.clone();
                active_connections.spawn(async move {
                    let connected = tokio::time::timeout(
                        Duration::from_secs(10),
                        tokio::net::TcpStream::connect((target_host.as_str(), target_port)),
                    )
                    .await;
                    if let Ok(Ok(mut local_target)) = connected {
                        let _ = copy_bidirectional(&mut local_target, &mut forwarded).await;
                    }
                });
            }
            drop(forwarded_channels);
            active_connections.abort_all();
            while active_connections.join_next().await.is_some() {}
            let cancellation_result = session.cancel_remote_forward(&address, bound_port).await;
            if let Ok(mut state) = worker_summary.lock()
                && state.state == TunnelState::Stopping
            {
                match cancellation_result {
                    Ok(()) => {
                        if let Some(error) = accept_error {
                            state.state = TunnelState::Failed;
                            state.last_error = Some(error);
                        } else {
                            state.state = TunnelState::Stopped;
                            state.last_error = None;
                        }
                    }
                    Err(error) => {
                        state.state = TunnelState::Failed;
                        state.last_error = Some(ssh_error(&error));
                    }
                }
            }
        });
        summary
            .lock()
            .map(|summary| summary.clone())
            .map_err(|_| session_lock_error())
    }

    pub async fn list_tunnels(&self) -> Result<Vec<TunnelSummary>, AppError> {
        let tunnels = self.tunnels.lock().await;
        tunnels
            .values()
            .map(|tunnel| {
                tunnel
                    .summary
                    .lock()
                    .map(|summary| summary.clone())
                    .map_err(|_| session_lock_error())
            })
            .collect()
    }

    pub async fn stop_tunnel(&self, tunnel_id: &str) -> Result<TunnelSummary, AppError> {
        let (summary, cancellation) = {
            let tunnels = self.tunnels.lock().await;
            let tunnel = tunnels.get(tunnel_id).ok_or_else(tunnel_not_found_error)?;
            (tunnel.summary.clone(), tunnel.cancellation.clone())
        };
        {
            let mut state = summary.lock().map_err(|_| session_lock_error())?;
            if matches!(&state.state, TunnelState::Starting | TunnelState::Listening) {
                state.state = TunnelState::Stopping;
            }
        }
        cancellation.cancel();

        let stopped = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                let current = summary.lock().map_err(|_| session_lock_error())?.clone();
                if matches!(&current.state, TunnelState::Stopped | TunnelState::Failed) {
                    return Ok(current);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        match stopped {
            Ok(result) => result,
            Err(_) => summary
                .lock()
                .map(|current| current.clone())
                .map_err(|_| session_lock_error()),
        }
    }

    pub fn cancel_transfer(&self, task_id: &str) -> Result<(), AppError> {
        let control = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .get(task_id)
            .cloned();
        if let Some(control) = control {
            control.cancel()?;
        }
        Ok(())
    }

    fn cancel_session_transfers(&self, session_id: &str) -> Result<(), AppError> {
        let controls = self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .values()
            .filter(|control| control.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        for control in controls {
            let _ = control.cancel();
        }
        Ok(())
    }

    async fn stop_session_tunnels(&self, session_id: &str) -> Result<(), AppError> {
        let tunnels = self.tunnels.lock().await;
        for tunnel in tunnels.values() {
            let mut summary = tunnel.summary.lock().map_err(|_| session_lock_error())?;
            if summary.session_id == session_id {
                if matches!(
                    &summary.state,
                    TunnelState::Starting | TunnelState::Listening
                ) {
                    summary.state = TunnelState::Stopping;
                }
                tunnel.cancellation.cancel();
            }
        }
        Ok(())
    }

    async fn stop_all_tunnels(&self) -> Result<(), AppError> {
        let tunnels = self.tunnels.lock().await;
        for tunnel in tunnels.values() {
            let mut summary = tunnel.summary.lock().map_err(|_| session_lock_error())?;
            if matches!(
                &summary.state,
                TunnelState::Starting | TunnelState::Listening
            ) {
                summary.state = TunnelState::Stopping;
            }
            tunnel.cancellation.cancel();
        }
        Ok(())
    }

    async fn mark_disconnected_remote_tunnels(&self, session_id: &str) -> Result<(), AppError> {
        let tunnels = self.tunnels.lock().await;
        for tunnel in tunnels.values() {
            let mut summary = tunnel.summary.lock().map_err(|_| session_lock_error())?;
            if summary.session_id != session_id || !matches!(&summary.kind, TunnelKind::Remote) {
                continue;
            }

            let cancellation_failed = summary.last_error.as_ref().is_some_and(|error| {
                matches!(
                    error.code.as_str(),
                    "SSH_REMOTE_FORWARD_CANCEL_DENIED" | "SSH_REMOTE_FORWARD_CANCEL_FAILED"
                )
            });
            if matches!(&summary.state, TunnelState::Stopping) || cancellation_failed {
                summary.state = TunnelState::Stopped;
                summary.last_error = None;
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>, AppError> {
        Ok(self
            .machines
            .lock()
            .map_err(|_| session_lock_error())?
            .values()
            .map(SessionMachine::summary)
            .collect())
    }

    pub fn has_active_sessions(&self) -> Result<bool, AppError> {
        Ok(self
            .machines
            .lock()
            .map_err(|_| session_lock_error())?
            .values()
            .map(SessionMachine::summary)
            .any(|summary| {
                !matches!(
                    summary.state,
                    SessionState::Idle
                        | SessionState::Disconnected
                        | SessionState::Failed
                        | SessionState::Closed
                )
            }))
    }

    pub async fn is_restore_busy(&self) -> Result<bool, AppError> {
        if self.has_active_sessions()? || !self.connections.lock().await.is_empty() {
            return Ok(true);
        }
        Ok(!self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .is_empty())
    }

    pub async fn reset_after_backup_restore(&self) -> Result<(), AppError> {
        if !self.connections.lock().await.is_empty() {
            return Err(restore_runtime_busy_error());
        }
        for tunnel in self.tunnels.lock().await.values() {
            tunnel.cancellation.cancel();
        }
        self.tunnels.lock().await.clear();
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .clear();
        self.presented_keys
            .lock()
            .map_err(|_| session_lock_error())?
            .clear();
        for control in self
            .transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .values()
        {
            let _ = control.cancel();
        }
        self.transfer_controls
            .lock()
            .map_err(|_| session_lock_error())?
            .clear();
        self.quick_profiles
            .lock()
            .map_err(|_| session_lock_error())?
            .clear();
        Ok(())
    }

    pub fn summary(&self, session_id: &str) -> Result<SessionSummary, AppError> {
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .get(session_id)
            .map(SessionMachine::summary)
            .ok_or_else(session_not_found_error)
    }

    fn transition(&self, session_id: &str, next: SessionState) -> Result<SessionSummary, AppError> {
        self.machines
            .lock()
            .map_err(|_| session_lock_error())?
            .get_mut(session_id)
            .ok_or_else(session_not_found_error)?
            .transition(next)
    }

    fn fail(&self, session_id: &str, error: AppError) -> Result<SessionSummary, AppError> {
        self.remove_quick_profile(session_id)?;
        let summary = self
            .machines
            .lock()
            .map_err(|_| session_lock_error())?
            .get_mut(session_id)
            .ok_or_else(session_not_found_error)?
            .fail(error);
        self.invalidate_process_snapshot(session_id)?;
        Ok(summary)
    }

    fn invalidate_process_snapshot(&self, session_id: &str) -> Result<(), AppError> {
        self.process_snapshots
            .lock()
            .map_err(|_| session_lock_error())?
            .remove(session_id);
        Ok(())
    }
}

fn ssh_error(error: &SshError) -> AppError {
    let (code, message_key, retryable) = match error {
        SshError::Timeout => ("SSH_CONNECT_TIMEOUT", "errors.sshConnectTimeout", true),
        SshError::HostKeyMissing => ("SSH_HOST_KEY_MISSING", "errors.sshHostKeyMissing", false),
        SshError::HostKeyRejected => ("SSH_HOST_KEY_CHANGED", "errors.sshHostKeyChanged", false),
        SshError::AuthenticationRejected => (
            "SSH_AUTHENTICATION_REJECTED",
            "errors.sshAuthenticationRejected",
            true,
        ),
        SshError::AgentUnavailable => ("SSH_AGENT_UNAVAILABLE", "errors.sshAgentUnavailable", true),
        SshError::AgentTimeout => ("SSH_AGENT_TIMEOUT", "errors.sshAgentTimeout", true),
        SshError::AgentSessionBindingUnavailable => (
            "SSH_AGENT_SESSION_BINDING_UNAVAILABLE",
            "errors.sshAgentSessionBindingUnavailable",
            false,
        ),
        SshError::AgentIdentityListFailed => (
            "SSH_AGENT_IDENTITY_LIST_FAILED",
            "errors.sshAgentIdentityListFailed",
            true,
        ),
        SshError::AgentNoIdentities => (
            "SSH_AGENT_NO_IDENTITIES",
            "errors.sshAgentNoIdentities",
            false,
        ),
        SshError::AgentIdentityLimitExceeded => (
            "SSH_AGENT_IDENTITY_LIMIT_EXCEEDED",
            "errors.sshAgentIdentityLimitExceeded",
            false,
        ),
        SshError::AgentSigningFailed => (
            "SSH_AGENT_SIGNING_FAILED",
            "errors.sshAgentSigningFailed",
            true,
        ),
        SshError::PrivateKeyFileUnavailable => (
            "SSH_PRIVATE_KEY_FILE_UNAVAILABLE",
            "errors.privateKeyFileUnavailable",
            true,
        ),
        SshError::PrivateKeyTooLarge => (
            "SSH_PRIVATE_KEY_TOO_LARGE",
            "errors.privateKeyTooLarge",
            false,
        ),
        SshError::PrivateKeyPassphraseRequired => (
            "SSH_PRIVATE_KEY_PASSPHRASE_REQUIRED",
            "errors.privateKeyPassphraseRequired",
            false,
        ),
        SshError::PrivateKeyInvalid => {
            ("SSH_PRIVATE_KEY_INVALID", "errors.privateKeyInvalid", true)
        }
        SshError::Sftp => ("SFTP_FAILED", "errors.sftpFailed", true),
        SshError::DirectoryEntryLimit => (
            "SFTP_DIRECTORY_ENTRY_LIMIT",
            "errors.syncPreviewLimitExceeded",
            false,
        ),
        SshError::Cancelled => (
            "SFTP_OPERATION_CANCELLED",
            "errors.syncPreviewCancelled",
            true,
        ),
        SshError::RemoteForwardDenied => (
            "SSH_REMOTE_FORWARD_DENIED",
            "errors.remoteForwardDenied",
            false,
        ),
        SshError::RemoteForwardCancelDenied => (
            "SSH_REMOTE_FORWARD_CANCEL_DENIED",
            "errors.remoteForwardCancelDenied",
            false,
        ),
        SshError::RemoteForwardCancelFailed => (
            "SSH_REMOTE_FORWARD_CANCEL_FAILED",
            "errors.remoteForwardCancelFailed",
            false,
        ),
        SshError::RemoteForwardUnavailable => (
            "SSH_REMOTE_FORWARD_UNAVAILABLE",
            "errors.remoteForwardUnavailable",
            true,
        ),
        SshError::OutputLimit => ("REMOTE_OUTPUT_LIMIT", "errors.remoteOutputLimit", false),
        SshError::Transport(_) => ("SSH_TRANSPORT_FAILED", "errors.sshTransportFailed", true),
    };
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn host_key_untrusted_error(evaluation: HostTrustEvaluation) -> AppError {
    let (code, message_key) = match evaluation {
        HostTrustEvaluation::Changed => ("SSH_HOST_KEY_CHANGED", "errors.sshHostKeyChanged"),
        HostTrustEvaluation::Unknown => ("SSH_HOST_KEY_UNKNOWN", "errors.sshHostKeyUnknown"),
        HostTrustEvaluation::Trusted => unreachable!("trusted keys are accepted above"),
    };
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn private_key_path_required_error() -> AppError {
    AppError {
        code: "SSH_PRIVATE_KEY_PATH_REQUIRED".to_owned(),
        message_key: "profile.privateKeyPathRequired".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("identityFile".to_owned()),
    }
}

fn authentication_method_mismatch_error() -> AppError {
    AppError {
        code: "SSH_AUTH_METHOD_MISMATCH".to_owned(),
        message_key: "errors.sshAuthMethodMismatch".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn validate_route_profiles(
    destination: &ConnectionProfile,
    route_profiles: &[ConnectionProfile],
) -> Result<(), AppError> {
    SessionRuntime::validate_profile_support(destination)?;
    if route_profiles.is_empty() || route_profiles.len() > 5 {
        return Err(proxy_jump_route_error());
    }
    if route_profiles.last().map(|profile| profile.id.as_str()) != Some(destination.id.as_str())
        || destination.proxy_jump_profile_ids.len() + 1 != route_profiles.len()
    {
        return Err(proxy_jump_route_error());
    }

    let mut seen = HashSet::with_capacity(route_profiles.len());
    for (index, route_profile) in route_profiles.iter().enumerate() {
        if !seen.insert(route_profile.id.as_str()) {
            return Err(proxy_jump_route_error());
        }
        if index < route_profiles.len() - 1 {
            if destination.proxy_jump_profile_ids.get(index) != Some(&route_profile.id) {
                return Err(proxy_jump_route_error());
            }
            if !route_profile.proxy_jump_profile_ids.is_empty()
                || route_profile
                    .proxy_jump
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(proxy_jump_nested_profile_error());
            }
            SessionRuntime::validate_profile_support(route_profile)?;
        }
    }
    Ok(())
}

fn route_matches_profiles(
    route: &SessionRouteProgress,
    route_profiles: &[ConnectionProfile],
) -> bool {
    route.profile_snapshots.len() == route_profiles.len()
        && route
            .profile_snapshots
            .iter()
            .zip(route_profiles)
            .all(|(snapshot, profile)| snapshot.matches(profile))
}

fn proxy_jump_mapping_required_error() -> AppError {
    AppError {
        code: "SSH_PROXY_JUMP_MAPPING_REQUIRED".to_owned(),
        message_key: "profile.proxyJumpMappingRequired".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn proxy_jump_route_error() -> AppError {
    AppError {
        code: "SSH_PROXY_JUMP_ROUTE_INVALID".to_owned(),
        message_key: "profile.proxyJumpRouteInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn proxy_jump_route_changed_error() -> AppError {
    AppError {
        code: "SSH_PROXY_JUMP_ROUTE_CHANGED".to_owned(),
        message_key: "profile.proxyJumpRouteChanged".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn proxy_jump_too_many_hops_error() -> AppError {
    AppError {
        code: "SSH_PROXY_JUMP_TOO_MANY_HOPS".to_owned(),
        message_key: "profile.proxyJumpTooManyHops".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn proxy_jump_nested_profile_error() -> AppError {
    AppError {
        code: "SSH_PROXY_JUMP_NESTED_PROFILE".to_owned(),
        message_key: "profile.proxyJumpNestedProfile".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn session_not_found_error() -> AppError {
    AppError {
        code: "SESSION_NOT_FOUND".to_owned(),
        message_key: "errors.sessionNotFound".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn session_lock_error() -> AppError {
    AppError {
        code: "SESSION_RUNTIME_LOCKED".to_owned(),
        message_key: "errors.sessionRuntimeUnavailable".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn session_shutdown_timeout_error() -> AppError {
    AppError {
        code: "SESSION_SHUTDOWN_TIMEOUT".to_owned(),
        message_key: "errors.sessionShutdownTimeout".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn restore_runtime_busy_error() -> AppError {
    AppError {
        code: "BACKUP_RESTORE_BUSY".to_owned(),
        message_key: "errors.backupRestoreBusy".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn invalid_terminal_size_error() -> AppError {
    AppError {
        code: "TERMINAL_SIZE_INVALID".to_owned(),
        message_key: "errors.terminalSizeInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn terminal_text_encoding(label: &str) -> Result<&'static Encoding, AppError> {
    match label {
        "utf-8" => Ok(encoding_rs::UTF_8),
        "gbk" => Ok(encoding_rs::GBK),
        "big5" => Ok(encoding_rs::BIG5),
        "shift_jis" => Ok(encoding_rs::SHIFT_JIS),
        "windows-1252" => Ok(encoding_rs::WINDOWS_1252),
        _ => Err(terminal_encoding_invalid_error()),
    }
}

fn terminal_input_invalid_error() -> AppError {
    AppError {
        code: "TERMINAL_INPUT_INVALID".to_owned(),
        message_key: "errors.terminalInputInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn terminal_encoding_invalid_error() -> AppError {
    AppError {
        code: "TERMINAL_ENCODING_INVALID".to_owned(),
        message_key: "errors.terminalEncodingInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("terminalEncoding".to_owned()),
    }
}

fn terminal_encoding_unrepresentable_error() -> AppError {
    AppError {
        code: "TERMINAL_ENCODING_UNREPRESENTABLE".to_owned(),
        message_key: "errors.terminalEncodingUnrepresentable".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn invalid_remote_path_error() -> AppError {
    AppError {
        code: "REMOTE_PATH_INVALID".to_owned(),
        message_key: "errors.remotePathInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("path".to_owned()),
    }
}

const REMOTE_TEXT_PREVIEW_MAX_BYTES: u32 = 1024 * 1024;
const EXTERNAL_OPEN_MAX_BYTES: u64 = 32 * 1024 * 1024;

fn remote_mode_error(code: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: match code {
            "REMOTE_MODE_INVALID" => "errors.remoteModeInvalid",
            "REMOTE_MODE_UNSUPPORTED" => "errors.remoteModeUnsupported",
            "REMOTE_MODE_UPDATE_TIMEOUT" => "errors.remoteModeUpdateTimeout",
            _ => "errors.remoteModeUpdateFailed",
        }
        .to_owned(),
        retryable: matches!(
            code,
            "REMOTE_MODE_UPDATE_FAILED" | "REMOTE_MODE_UPDATE_TIMEOUT"
        ),
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_create_file_error() -> AppError {
    AppError {
        code: "SFTP_CREATE_FILE_FAILED".to_owned(),
        message_key: "errors.sftpCreateFileFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("name".to_owned()),
    }
}

fn remote_tree_error() -> AppError {
    AppError {
        code: "REMOTE_TREE_OPERATION_FAILED".to_owned(),
        message_key: "errors.remoteTreeOperationFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_tree_limit_error() -> AppError {
    AppError {
        code: "REMOTE_TREE_LIMIT".to_owned(),
        message_key: "errors.remoteTreeLimit".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("path".to_owned()),
    }
}

fn external_edit_sync_error() -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_SYNC_FAILED".to_owned(),
        message_key: "errors.externalEditSyncFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn external_edit_unsupported_error() -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_UNSUPPORTED".to_owned(),
        message_key: "errors.externalEditUnsupported".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn external_edit_too_large_error() -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_TOO_LARGE".to_owned(),
        message_key: "errors.externalEditTooLarge".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn external_edit_local_changing_error() -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_LOCAL_CHANGING".to_owned(),
        message_key: "errors.externalEditLocalChanging".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn external_edit_remote_changed_error() -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_REMOTE_CHANGED".to_owned(),
        message_key: "errors.externalEditRemoteChanged".to_owned(),
        retryable: false,
        remote_state: RemoteState::Changed,
        field: None,
    }
}

fn external_edit_recovery_error(backup_path: String) -> AppError {
    AppError {
        code: "EXTERNAL_EDIT_RECOVERY_REQUIRED".to_owned(),
        message_key: "errors.externalEditRecovery".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some(backup_path),
    }
}

fn sftp_preview_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: code == "SFTP_PREVIEW_FAILED",
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn sftp_preview_encoding_error() -> AppError {
    sftp_preview_error("SFTP_PREVIEW_NOT_TEXT", "errors.sftpPreviewNotText")
}

fn sftp_preview_too_large_error() -> AppError {
    sftp_preview_error("SFTP_PREVIEW_TOO_LARGE", "errors.sftpPreviewTooLarge")
}

fn is_supported_preview_text(content: &str) -> bool {
    !content.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    })
}

struct BoundedRemoteText {
    revision: String,
}

async fn read_bounded_remote_text(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<BoundedRemoteText, AppError> {
    let metadata = sftp
        .symlink_metadata(path)
        .await
        .map_err(|_| sftp_save_error())?;
    if metadata.is_symlink() || !metadata.is_regular() {
        return Err(sftp_preview_error(
            "SFTP_PREVIEW_UNSUPPORTED",
            "errors.sftpPreviewUnsupported",
        ));
    }
    let file = sftp
        .open(path.to_owned())
        .await
        .map_err(|_| sftp_save_error())?;
    let mut bytes = Vec::with_capacity((REMOTE_TEXT_PREVIEW_MAX_BYTES + 1) as usize);
    let mut bounded = file.take(u64::from(REMOTE_TEXT_PREVIEW_MAX_BYTES) + 1);
    let read_failed = bounded.read_to_end(&mut bytes).await.is_err();
    let file = bounded.into_inner();
    let close_failed = file.close().await.is_err();
    if read_failed || close_failed {
        return Err(sftp_save_error());
    }
    if bytes.len() > REMOTE_TEXT_PREVIEW_MAX_BYTES as usize {
        return Err(sftp_preview_too_large_error());
    }
    let text = String::from_utf8(bytes).map_err(|_| sftp_preview_encoding_error())?;
    if !is_supported_preview_text(&text) {
        return Err(sftp_preview_encoding_error());
    }
    Ok(BoundedRemoteText {
        revision: text_revision(text.as_bytes()),
    })
}

pub(crate) fn text_revision(bytes: &[u8]) -> String {
    let mut revision = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        revision.push_str(&format!("{byte:02x}"));
    }
    revision
}

fn split_remote_parent(path: &str) -> Result<(&str, &str), AppError> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", name)) if !name.is_empty() => Ok(("/", name)),
        Some((parent, name)) if !name.is_empty() => Ok((parent, name)),
        None if !trimmed.is_empty() => Ok((".", trimmed)),
        _ => Err(invalid_remote_path_error()),
    }
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn validate_remote_permission_input(
    input: &filex_contracts::UpdateRemotePermissionsInput,
) -> Result<(), AppError> {
    if input.path.is_empty()
        || input.path.contains('\0')
        || input.path.split('/').any(|component| component == "..")
        || input.mode > 0o7777
    {
        Err(remote_mode_error("REMOTE_MODE_INVALID"))
    } else {
        Ok(())
    }
}

fn permission_scope_matches(
    scope: &RemotePermissionScope,
    is_directory: bool,
    is_regular: bool,
) -> bool {
    match scope {
        RemotePermissionScope::All => is_directory || is_regular,
        RemotePermissionScope::Files => is_regular,
        RemotePermissionScope::Directories => is_directory,
    }
}

async fn set_remote_permission(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    _metadata: &FileAttributes,
    mode: u32,
) -> Result<(), AppError> {
    let mut attributes = FileAttributes::empty();
    attributes.permissions = Some(mode);
    sftp.set_metadata(path.to_owned(), attributes)
        .await
        .map_err(|_| remote_mode_error("REMOTE_MODE_UPDATE_FAILED"))
}

async fn scan_remote_tree(
    sftp: &russh_sftp::client::SftpSession,
    root: &str,
) -> Result<Vec<RemoteTreeEntry>, AppError> {
    let mut directories = vec![(root.to_owned(), 0_usize)];
    let mut entries = Vec::new();
    while let Some((directory, depth)) = directories.pop() {
        let children = sftp
            .read_dir(directory.clone())
            .await
            .map_err(|_| remote_tree_error())?;
        for child in children {
            let metadata = child.metadata();
            let name = child.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if entries.len() >= REMOTE_TREE_MAX_ENTRIES {
                return Err(remote_tree_limit_error());
            }
            let path = join_remote_path(&directory, &name);
            if path.len() > 4_096 {
                return Err(remote_tree_limit_error());
            }
            let is_symlink = metadata.is_symlink();
            let is_directory = !is_symlink && metadata.is_dir();
            let is_regular = !is_symlink && metadata.is_regular();
            entries.push(RemoteTreeEntry {
                path: path.clone(),
                is_directory,
                is_regular,
                is_symlink,
            });
            if is_directory {
                if depth + 1 > REMOTE_TREE_MAX_DEPTH {
                    return Err(remote_tree_limit_error());
                }
                directories.push((path, depth + 1));
            }
        }
    }
    Ok(entries)
}

async fn read_external_edit_local(
    path: &std::path::Path,
    _last_revision: Option<&str>,
) -> Result<(Vec<u8>, String), AppError> {
    let before = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| external_edit_sync_error())?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(external_edit_unsupported_error());
    }
    if before.len() > EXTERNAL_EDIT_MAX_BYTES {
        return Err(external_edit_too_large_error());
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| external_edit_sync_error())?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    let mut bounded = file.take(EXTERNAL_EDIT_MAX_BYTES + 1);
    bounded
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| external_edit_sync_error())?;
    let opened_after = bounded
        .get_ref()
        .metadata()
        .await
        .map_err(|_| external_edit_sync_error())?;
    let path_after = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| external_edit_local_changing_error())?;
    if bytes.len() as u64 > EXTERNAL_EDIT_MAX_BYTES {
        return Err(external_edit_too_large_error());
    }
    if path_after.file_type().is_symlink()
        || !path_after.is_file()
        || before.len() != opened_after.len()
        || before.len() != path_after.len()
        || before.modified().ok() != opened_after.modified().ok()
        || before.modified().ok() != path_after.modified().ok()
        || bytes.len() as u64 != path_after.len()
    {
        return Err(external_edit_local_changing_error());
    }
    let revision = text_revision(&bytes);
    Ok((bytes, revision))
}

async fn read_external_edit_remote(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(String, FileAttributes), AppError> {
    let before = sftp
        .symlink_metadata(path.to_owned())
        .await
        .map_err(|_| external_edit_sync_error())?;
    if before.is_symlink() || !before.is_regular() {
        return Err(external_edit_unsupported_error());
    }
    if before
        .size
        .is_some_and(|size| size > EXTERNAL_EDIT_MAX_BYTES)
    {
        return Err(external_edit_too_large_error());
    }
    let file = sftp
        .open(path.to_owned())
        .await
        .map_err(|_| external_edit_sync_error())?;
    let mut bytes = Vec::with_capacity(before.size.unwrap_or_default() as usize);
    let mut bounded = file.take(EXTERNAL_EDIT_MAX_BYTES + 1);
    let read_failed = bounded.read_to_end(&mut bytes).await.is_err();
    let file = bounded.into_inner();
    let close_failed = file.close().await.is_err();
    if read_failed || close_failed {
        return Err(external_edit_sync_error());
    }
    if bytes.len() as u64 > EXTERNAL_EDIT_MAX_BYTES {
        return Err(external_edit_too_large_error());
    }
    let after = sftp
        .symlink_metadata(path.to_owned())
        .await
        .map_err(|_| external_edit_remote_changed_error())?;
    if after.is_symlink()
        || !after.is_regular()
        || before.size != after.size
        || before.mtime != after.mtime
        || before.size.is_some_and(|size| size != bytes.len() as u64)
    {
        return Err(external_edit_remote_changed_error());
    }
    Ok((text_revision(&bytes), before))
}

async fn replace_external_edit_remote(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    metadata: &FileAttributes,
    bytes: &[u8],
    expected_revision: &str,
) -> Result<ExternalEditUpload, AppError> {
    let (parent, _) = split_remote_parent(remote_path)?;
    let id = uuid::Uuid::new_v4();
    let temporary_path = join_remote_path(parent, &format!(".filex-edit-{id}.part"));
    let backup_path = join_remote_path(parent, &format!(".filex-edit-{id}.backup"));
    let mut attributes = FileAttributes::empty();
    attributes.permissions = metadata.permissions;
    let mut temporary = sftp
        .open_with_flags_and_attributes(
            temporary_path.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            attributes,
        )
        .await
        .map_err(|_| external_edit_sync_error())?;
    let write_result = temporary.write_all(bytes).await;
    let close_result = temporary.close().await;
    if write_result.is_err() || close_result.is_err() {
        let _ = sftp.remove_file(temporary_path).await;
        return Err(external_edit_sync_error());
    }

    let (current_revision, _) = match read_external_edit_remote(sftp, remote_path).await {
        Ok(result) => result,
        Err(error) => {
            let _ = sftp.remove_file(temporary_path).await;
            return Err(error);
        }
    };
    if current_revision != expected_revision {
        let _ = sftp.remove_file(temporary_path).await;
        return Err(external_edit_remote_changed_error());
    }
    if sftp
        .rename(remote_path.to_owned(), backup_path.clone())
        .await
        .is_err()
    {
        let _ = sftp.remove_file(temporary_path).await;
        return Err(external_edit_remote_changed_error());
    }
    if sftp
        .rename(temporary_path.clone(), remote_path.to_owned())
        .await
        .is_err()
    {
        if sftp
            .rename(backup_path.clone(), remote_path.to_owned())
            .await
            .is_err()
        {
            return Err(external_edit_recovery_error(backup_path));
        }
        let _ = sftp.remove_file(temporary_path).await;
        return Err(external_edit_sync_error());
    }
    let _ = sftp.remove_file(backup_path).await;
    Ok(ExternalEditUpload {
        revision: text_revision(bytes),
        bytes: bytes.len() as u64,
        uploaded: true,
    })
}

fn sftp_save_error() -> AppError {
    AppError {
        code: "SFTP_SAVE_FAILED".to_owned(),
        message_key: "errors.sftpSaveFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn sftp_preview_conflict_error() -> AppError {
    AppError {
        code: "SFTP_PREVIEW_CONFLICT".to_owned(),
        message_key: "errors.sftpPreviewConflict".to_owned(),
        retryable: false,
        remote_state: RemoteState::Changed,
        field: None,
    }
}

fn sftp_save_rollback_error(backup_path: &str) -> AppError {
    AppError {
        code: "SFTP_SAVE_ROLLBACK_FAILED".to_owned(),
        message_key: "errors.sftpSaveRollbackFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some(backup_path.to_owned()),
    }
}

fn sftp_save_target_appeared_error(backup_path: &str) -> AppError {
    AppError {
        code: "SFTP_SAVE_TARGET_APPEARED".to_owned(),
        message_key: "errors.sftpSaveTargetAppeared".to_owned(),
        retryable: false,
        remote_state: RemoteState::Changed,
        field: Some(backup_path.to_owned()),
    }
}

fn external_open_error() -> AppError {
    AppError {
        code: "SFTP_EXTERNAL_OPEN_FAILED".to_owned(),
        message_key: "errors.sftpExternalOpenFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn external_open_too_large_error() -> AppError {
    AppError {
        code: "SFTP_EXTERNAL_OPEN_TOO_LARGE".to_owned(),
        message_key: "errors.sftpExternalOpenTooLarge".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn validate_remote_delete_path(path: &str) -> Result<(), AppError> {
    let trimmed = path.trim_end_matches('/');
    let leaf = trimmed.rsplit('/').next().unwrap_or_default();
    if path.is_empty()
        || path.contains('\0')
        || path.split('/').any(|component| component == "..")
        || leaf.is_empty()
        || leaf == "."
        || leaf == ".."
    {
        return Err(invalid_remote_path_error());
    }
    Ok(())
}

fn remote_delete_error() -> AppError {
    AppError {
        code: "SFTP_DELETE_FAILED".to_owned(),
        message_key: "errors.sftpDeleteFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn remote_quick_delete_error() -> AppError {
    AppError {
        code: "SFTP_QUICK_DELETE_FAILED".to_owned(),
        message_key: "errors.sftpQuickDeleteFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn validate_remote_directory_name(parent_path: &str, name: &str) -> Result<(), AppError> {
    if parent_path.is_empty()
        || parent_path.contains('\0')
        || parent_path.split('/').any(|component| component == "..")
        || name.trim().is_empty()
        || name.len() > 255
        || name.contains('/')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err(invalid_remote_path_error());
    }
    Ok(())
}

fn remote_create_directory_error() -> AppError {
    AppError {
        code: "SFTP_CREATE_DIRECTORY_FAILED".to_owned(),
        message_key: "errors.sftpCreateDirectoryFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("name".to_owned()),
    }
}

fn remote_rename_error() -> AppError {
    AppError {
        code: "SFTP_RENAME_FAILED".to_owned(),
        message_key: "errors.sftpRenameFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("name".to_owned()),
    }
}

fn remote_move_error() -> AppError {
    AppError {
        code: "SFTP_MOVE_FAILED".to_owned(),
        message_key: "errors.sftpMoveFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

async fn remote_entry_exists(
    sftp: &russh_sftp::client::SftpSession,
    path: String,
) -> Result<bool, AppError> {
    match sftp.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            Ok(false)
        }
        Err(_) => Err(remote_entry_check_error()),
    }
}

fn remote_entry_check_error() -> AppError {
    AppError {
        code: "SFTP_STAT_FAILED".to_owned(),
        message_key: "errors.sftpFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

fn remote_move_target_exists_error() -> AppError {
    AppError {
        code: "SFTP_TARGET_EXISTS".to_owned(),
        message_key: "errors.sftpTargetExists".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("path".to_owned()),
    }
}

fn remote_copy_error() -> AppError {
    AppError {
        code: "SFTP_COPY_FAILED".to_owned(),
        message_key: "errors.sftpCopyFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

fn remote_copy_unsupported_error() -> AppError {
    AppError {
        code: "SFTP_COPY_UNSUPPORTED".to_owned(),
        message_key: "errors.sftpCopyUnsupported".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("path".to_owned()),
    }
}

fn remote_copy_too_large_error() -> AppError {
    AppError {
        code: "SFTP_COPY_TOO_LARGE".to_owned(),
        message_key: "errors.sftpCopyTooLarge".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

fn remote_copy_timeout_error() -> AppError {
    AppError {
        code: "SFTP_COPY_TIMEOUT".to_owned(),
        message_key: "errors.sftpCopyTimeout".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

const MONITOR_PROBE: &str = r#"LC_ALL=C; export LC_ALL
HOST=$(hostname 2>/dev/null || true)
KERNEL=$(uname -s 2>/dev/null || true)
OS=$(uname -srm 2>/dev/null || true)
printf 'HOST=%s\nOS=%s\n' "$HOST" "$OS"
case "$KERNEL" in
  Linux*)
    awk '{print "UPTIME="$1}' /proc/uptime 2>/dev/null || true
    awk '{print "LOAD1="$1; print "LOAD5="$2; print "LOAD15="$3}' /proc/loadavg 2>/dev/null || true
    awk '/^MemTotal:/ {print "MEM_TOTAL="$2} /^MemAvailable:/ {print "MEM_AVAILABLE="$2} /^SwapTotal:/ {swap_total=$2; print "SWAP_TOTAL="$2; seen_total=1} /^SwapFree:/ {swap_free=$2; seen_free=1} END {if (seen_total && seen_free) printf "SWAP_USED=%.0f\n", swap_total-swap_free}' /proc/meminfo 2>/dev/null || true
    cpu_sample() {
      awk '/^cpu / {total=0; for (i=2; i<=NF && i<=9; i++) total+=$i; idle=$5+$6; printf "%.0f %.0f\n", total, idle}' /proc/stat 2>/dev/null
    }
    network_sample() {
      awk -F: 'NR > 2 {name=$1; gsub(/[[:space:]]/, "", name); data=$2; gsub(/^[[:space:]]+/, "", data); if (name != "lo") {split(data, counters, /[[:space:]]+/); rx+=counters[1]; tx+=counters[9]}} END {if (NR > 2) printf "%.0f %.0f\n", rx, tx}' /proc/net/dev 2>/dev/null
    }
    CPU_BEFORE=$(cpu_sample || true)
    NET_BEFORE=$(network_sample || true)
    sleep 1
    CPU_AFTER=$(cpu_sample || true)
    NET_AFTER=$(network_sample || true)
    awk -v cpu_before="$CPU_BEFORE" -v cpu_after="$CPU_AFTER" -v net_before="$NET_BEFORE" -v net_after="$NET_AFTER" '
      BEGIN {
        if (split(cpu_before, c1, /[[:space:]]+/) == 2 && split(cpu_after, c2, /[[:space:]]+/) == 2) {
          total=c2[1]-c1[1]; idle=c2[2]-c1[2];
          if (total > 0 && idle >= 0 && idle <= total) printf "CPU_PERCENT=%.2f\n", (total-idle)*100/total
        }
        if (split(net_before, n1, /[[:space:]]+/) == 2 && split(net_after, n2, /[[:space:]]+/) == 2) {
          rx=n2[1]-n1[1]; tx=n2[2]-n1[2];
          if (rx >= 0 && tx >= 0) printf "NET_RX_BPS=%.0f\nNET_TX_BPS=%.0f\n", rx, tx
        }
      }'
    ;;
  Darwin*)
    BOOT_TIME=$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\1/')
    NOW=$(date +%s 2>/dev/null || true)
    if [ -n "$BOOT_TIME" ] && [ -n "$NOW" ]; then
      awk -v now="$NOW" -v boot="$BOOT_TIME" 'BEGIN {if (now >= boot) printf "UPTIME=%.0f\n", now-boot}'
    fi
    sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{if ($1 ~ /^[0-9]+([.][0-9]+)?$/ && $2 ~ /^[0-9]+([.][0-9]+)?$/ && $3 ~ /^[0-9]+([.][0-9]+)?$/) {print "LOAD1="$1; print "LOAD5="$2; print "LOAD15="$3}}'
    TOTAL_BYTES=$(sysctl -n hw.memsize 2>/dev/null || true)
    PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null || true)
    if [ -n "$TOTAL_BYTES" ]; then
      awk -v bytes="$TOTAL_BYTES" 'BEGIN {if (bytes > 0) printf "MEM_TOTAL=%.0f\n", bytes/1024}'
    fi
    if [ -n "$PAGE_SIZE" ]; then
      vm_stat 2>/dev/null | awk -v page_size="$PAGE_SIZE" '
        /Pages free:/ {gsub(/[^0-9]/, "", $3); pages += $3}
        /Pages inactive:/ {gsub(/[^0-9]/, "", $3); pages += $3}
        /Pages speculative:/ {gsub(/[^0-9]/, "", $3); pages += $3}
        END {if (page_size > 0 && pages > 0) printf "MEM_AVAILABLE=%.0f\n", pages*page_size/1024}
      '
    fi
    sysctl -n vm.swapusage 2>/dev/null | awk '
      function to_kib(value, number, unit) {
        unit=substr(value, length(value), 1)
        number=substr(value, 1, length(value)-1)+0
        if (unit == "G") return number*1048576
        if (unit == "M") return number*1024
        if (unit == "K") return number
        return 0
      }
      {for (i=1; i<=NF; i++) {if ($i == "total") total=to_kib($(i+2)); if ($i == "used") used=to_kib($(i+2))}}
      END {if (total > 0) {printf "SWAP_TOTAL=%.0f\n", total; printf "SWAP_USED=%.0f\n", used}}
    '
    NET_BEFORE=$(netstat -ibn 2>/dev/null | awk 'NR > 1 && $1 != "lo0" && $3 ~ /^<Link#/ {rx+=$7; tx+=$10} END {if (NR > 1) printf "%.0f %.0f\n", rx, tx}')
    CPU_PERCENT=$(top -l 2 -s 1 -n 0 2>/dev/null | awk '/CPU usage:/ {line=$0; sub(/^.*CPU usage:[[:space:]]*/, "", line); split(line, parts, ","); user=parts[1]; sys_pct=parts[2]; gsub(/[^0-9.]/, "", user); gsub(/[^0-9.]/, "", sys_pct); if (user != "" && sys_pct != "") value=user+sys_pct} END {if (value != "") printf "%.2f\n", value}')
    NET_AFTER=$(netstat -ibn 2>/dev/null | awk 'NR > 1 && $1 != "lo0" && $3 ~ /^<Link#/ {rx+=$7; tx+=$10} END {if (NR > 1) printf "%.0f %.0f\n", rx, tx}')
    [ -n "$CPU_PERCENT" ] && printf 'CPU_PERCENT=%s\n' "$CPU_PERCENT"
    awk -v before="$NET_BEFORE" -v after="$NET_AFTER" 'BEGIN {if (split(before, a, /[[:space:]]+/)==2 && split(after, b, /[[:space:]]+/)==2) {rx=b[1]-a[1]; tx=b[2]-a[2]; if (rx>=0 && tx>=0) printf "NET_RX_BPS=%.0f\nNET_TX_BPS=%.0f\n", rx, tx}}'
    ;;
esac
df -Pk / 2>/dev/null | awk 'NR==2 {print "ROOT_TOTAL="$2; print "ROOT_AVAILABLE="$4}' || true
df -Pk 2>/dev/null | awk 'NR>1 && n<12 { total=$2; avail=$4; line=$0; sub(/^[^ ]+[[:space:]]+[^ ]+[[:space:]]+[^ ]+[[:space:]]+[^ ]+[[:space:]]+[^ ]+[[:space:]]+/, "", line); if (total ~ /^[0-9]+$/ && avail ~ /^[0-9]+$/ && line != "" && index(line, "|") == 0) { printf "MOUNT=%s|%s|%s\n", line, total, avail; n++ } }' || true"#;

const WINDOWS_MONITOR_SCRIPT: &str = r#"if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 42 }
Write-Output 'PLATFORM=WINDOWS'
$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq $env:SystemDrive | Select-Object -First 1
$uptime = [math]::Max(0, [math]::Floor(((Get-Date) - $os.LastBootUpTime).TotalSeconds))
Write-Output "HOST=$env:COMPUTERNAME"
Write-Output "OS=$($os.Caption) $($os.Version)"
Write-Output "UPTIME=$uptime"
Write-Output "MEM_TOTAL=$($os.TotalVisibleMemorySize)"
Write-Output "MEM_AVAILABLE=$($os.FreePhysicalMemory)"
if ($null -ne $disk.Size) { Write-Output "ROOT_TOTAL=$([math]::Floor($disk.Size / 1024))" }
if ($null -ne $disk.FreeSpace) { Write-Output "ROOT_AVAILABLE=$([math]::Floor($disk.FreeSpace / 1024))" }
try {
  $localDisks = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DriveType -eq 3 -and $null -ne $_.Size -and $_.Size -gt 0 } | Select-Object -First 12)
  foreach ($localDisk in $localDisks) {
    $mountPath = "$($localDisk.DeviceID)\"
    if ($mountPath.IndexOf('|') -lt 0) {
      Write-Output "MOUNT=$mountPath|$([math]::Floor($localDisk.Size / 1024))|$([math]::Floor($localDisk.FreeSpace / 1024))"
    }
  }
} catch {}
try {
  $processors = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
  $cpuLoad = $processors | Measure-Object -Property LoadPercentage -Average
  if ($null -ne $cpuLoad.Average) { Write-Output "CPU_PERCENT=$(([double]$cpuLoad.Average).ToString('0.##', $culture))" }
} catch {}
try {
  $pageFiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop)
  if ($pageFiles.Count -gt 0) {
    $swapTotal = [double](($pageFiles | Measure-Object -Property AllocatedBaseSize -Sum).Sum) * 1024
    $swapUsed = [double](($pageFiles | Measure-Object -Property CurrentUsage -Sum).Sum) * 1024
    Write-Output "SWAP_TOTAL=$([math]::Round($swapTotal).ToString('0', $culture))"
    Write-Output "SWAP_USED=$([math]::Round($swapUsed).ToString('0', $culture))"
  }
} catch {}
function Get-NetworkTotals {
  try {
    $rows = @(Get-NetAdapterStatistics -ErrorAction Stop | Where-Object { $_.Name -notmatch 'loopback|teredo|isatap' })
    if ($rows.Count -eq 0) { return $null }
    $received = [double](($rows | Measure-Object -Property ReceivedBytes -Sum).Sum)
    $sent = [double](($rows | Measure-Object -Property SentBytes -Sum).Sum)
    return [pscustomobject]@{ Received = $received; Sent = $sent }
  } catch { return $null }
}
$networkWatch = [Diagnostics.Stopwatch]::StartNew()
$networkBefore = Get-NetworkTotals
Start-Sleep -Milliseconds 1000
$networkAfter = Get-NetworkTotals
$networkWatch.Stop()
if ($null -ne $networkBefore -and $null -ne $networkAfter -and $networkWatch.Elapsed.TotalSeconds -gt 0) {
  $receivedDelta = $networkAfter.Received - $networkBefore.Received
  $sentDelta = $networkAfter.Sent - $networkBefore.Sent
  if ($receivedDelta -ge 0) { Write-Output "NET_RX_BPS=$([math]::Round($receivedDelta / $networkWatch.Elapsed.TotalSeconds).ToString('0', $culture))" }
  if ($sentDelta -ge 0) { Write-Output "NET_TX_BPS=$([math]::Round($sentDelta / $networkWatch.Elapsed.TotalSeconds).ToString('0', $culture))" }
}
"#;

const NETWORK_INSPECTION_PROBE: &str = r#"LC_ALL=C; export LC_ALL
if [ ! -d /sys/class/net ] || ! command -v ip >/dev/null 2>&1 || ! command -v od >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1; then
  printf 'PLATFORM=UNSUPPORTED\n'
  exit 0
fi
hex() { printf '%s' "$1" | od -An -tx1 | tr -d ' \012'; }
printf 'PLATFORM=LINUX\n'
interface_count=0
for directory in /sys/class/net/*; do
  [ -e "$directory" ] || continue
  interface_count=$((interface_count + 1))
  [ "$interface_count" -le 128 ] || break
  name=${directory##*/}
  state=$(cat "$directory/operstate" 2>/dev/null | tr -d '\012\015')
  mtu=$(cat "$directory/mtu" 2>/dev/null | tr -d '\012\015')
  received=$(cat "$directory/statistics/rx_bytes" 2>/dev/null | tr -d '\012\015')
  transmitted=$(cat "$directory/statistics/tx_bytes" 2>/dev/null | tr -d '\012\015')
  addresses=$(ip -o addr show dev "$name" 2>/dev/null | awk '{print $4}' | paste -sd, -)
  loopback=0
  [ "$name" = lo ] && loopback=1
  printf 'I\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(hex "$name")" "$(hex "$state")" "$(hex "$addresses")" "$mtu" "$received" "$transmitted" "$loopback"
done
if command -v ss >/dev/null 2>&1; then
  ss -H -tunap 2>/dev/null | head -n 501 | while read -r protocol state recvq sendq local_endpoint remote_endpoint details; do
    [ -n "$protocol" ] || continue
    printf 'E\t%s\t%s\t%s\t%s\t%s\n' "$(hex "$protocol")" "$(hex "$state")" "$(hex "$local_endpoint")" "$(hex "$remote_endpoint")" "$(hex "$details")"
  done
fi
ip -o route show table all 2>/dev/null | head -n 501 | while IFS= read -r route; do
  [ -n "$route" ] || continue
  set -- $route
  destination=$1
  gateway=''
  interface=''
  metric=''
  protocol=''
  previous=''
  for token in "$@"; do
    case "$previous" in
      via) gateway=$token ;;
      dev) interface=$token ;;
      metric) metric=$token ;;
      proto) protocol=$token ;;
    esac
    previous=$token
  done
  printf 'T\t%s\t%s\t%s\t%s\t%s\n' "$(hex "$destination")" "$(hex "$gateway")" "$(hex "$interface")" "$metric" "$(hex "$protocol")"
done"#;

const WINDOWS_NETWORK_SCRIPT: &str = r#"if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 42 }
Write-Output 'PLATFORM=WINDOWS'
$ErrorActionPreference = 'Continue'
function Encode-Text([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return '' }
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
}
$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Sort-Object -Property ifIndex | Select-Object -First 128)
foreach ($adapter in $adapters) {
  $addresses = @((Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -ErrorAction SilentlyContinue | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })) -join ','
  $received = ''
  $transmitted = ''
  try {
    $statistics = Get-NetAdapterStatistics -InterfaceIndex $adapter.ifIndex -ErrorAction Stop
    $received = [uint64]$statistics.ReceivedBytes
    $transmitted = [uint64]$statistics.SentBytes
  } catch {}
  $loopback = if ($adapter.InterfaceDescription -match 'Loopback') { 1 } else { 0 }
  Write-Output ("I`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f (Encode-Text $adapter.Name), (Encode-Text ([string]$adapter.Status)), (Encode-Text $addresses), $adapter.MtuSize, $received, $transmitted, $loopback)
}
$processNames = @{}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $processNames[[uint32]$_.Id] = [string]$_.ProcessName }
function Process-Name([uint32]$processId) {
  if ($processId -eq 0) { return '' }
  if ($processNames.ContainsKey($processId)) { return $processNames[$processId] }
  return ''
}
$tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object -First 501)
foreach ($endpoint in $tcp) {
  Write-Output ("E`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}" -f (Encode-Text 'tcp'), (Encode-Text ([string]$endpoint.State)), (Encode-Text $endpoint.LocalAddress), $endpoint.LocalPort, (Encode-Text $endpoint.RemoteAddress), $endpoint.RemotePort, $endpoint.OwningProcess, (Encode-Text (Process-Name $endpoint.OwningProcess)))
}
$remaining = [Math]::Max(0, 501 - $tcp.Count)
if ($remaining -gt 0) {
  $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object -First $remaining)
  foreach ($endpoint in $udp) {
    Write-Output ("E`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}" -f (Encode-Text 'udp'), (Encode-Text 'UNCONN'), (Encode-Text $endpoint.LocalAddress), $endpoint.LocalPort, '', '', $endpoint.OwningProcess, (Encode-Text (Process-Name $endpoint.OwningProcess)))
  }
}
$routes = @(Get-NetRoute -ErrorAction SilentlyContinue | Sort-Object -Property RouteMetric | Select-Object -First 501)
foreach ($route in $routes) {
  $alias = ''
  try { $alias = [string](Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -IncludeHidden -ErrorAction Stop).Name } catch {}
  Write-Output ("T`t{0}`t{1}`t{2}`t{3}`t{4}" -f (Encode-Text $route.DestinationPrefix), (Encode-Text $route.NextHop), (Encode-Text $alias), $route.RouteMetric, (Encode-Text ([string]$route.Protocol)))
}"#;

fn windows_network_command() -> String {
    powershell_script_command(WINDOWS_NETWORK_SCRIPT)
}

const PROCESS_LIST_PROBE: &str = r#"LC_ALL=C; export LC_ALL
if ! command -v ps >/dev/null 2>&1 || ! command -v od >/dev/null 2>&1 || ! command -v cut >/dev/null 2>&1 || ! command -v tr >/dev/null 2>&1 || ! command -v sort >/dev/null 2>&1 || ! command -v head >/dev/null 2>&1; then
  printf 'PLATFORM=UNSUPPORTED\n'
  exit 0
fi
printf 'PLATFORM=POSIX\n'
ps -e -o pid=,ppid=,user=,pcpu=,time=,rss=,stat= 2>/dev/null | sort -k4,4nr | head -n 101 | while read -r pid ppid user cpu cpu_time rss state; do
  case "$pid" in ''|*[!0-9]*) continue;; esac
  name=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '\012\015')
  name=${name##*/}
  name=$(printf '%s' "$name" | cut -c 1-128)
  start=$(ps -p "$pid" -o lstart= 2>/dev/null | tr -d '\012\015')
  elapsed=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' \012\015')
  [ -n "$name" ] || continue
  name_hex=$(printf '%s' "$name" | od -An -tx1 | tr -d ' \012')
  user_hex=$(printf '%s' "$user" | cut -c 1-128 | od -An -tx1 | tr -d ' \012')
  start_hex=$(printf '%s' "$start" | od -An -tx1 | tr -d ' \012')
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$ppid" "$user_hex" "$cpu" "$cpu_time" "$rss" "$state" "$start_hex" "$elapsed" "$name_hex"
done"#;

const WINDOWS_PROCESS_SCRIPT: &str = r#"if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 42 }
Write-Output 'PLATFORM=WINDOWS'
$ErrorActionPreference = 'Continue'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$items = Get-Process -ErrorAction SilentlyContinue | Sort-Object -Property CPU -Descending | Select-Object -First 101
foreach ($process in $items) {
  $cpu = ''
  $memory = ''
  $start = 0
  $startMs = ''
  $parent = ''
  try { if ($null -ne $process.CPU) { $cpu = ([double]$process.CPU).ToString('0.###', $culture) } } catch {}
  try { $memory = [int64]$process.WorkingSet64 } catch {}
  try { $start = [int64]($process.StartTime.ToUniversalTime().Ticks) } catch {}
  try { $startMs = [DateTimeOffset]::new($process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch {}
  try { if ($null -ne $process.Parent) { $parent = [int64]$process.Parent.Id } } catch {}
  $name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$process.ProcessName))
  Write-Output ("P`t{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $process.Id, $parent, $cpu, $memory, $start, $startMs, $name)
}"#;

fn windows_process_command() -> String {
    powershell_script_command(WINDOWS_PROCESS_SCRIPT)
}

fn windows_terminate_command(pid: u32, start_time_ticks: u64) -> String {
    let script = format!(
        r#"if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {{ exit 42 }}
$ErrorActionPreference = 'Stop'
try {{
  $process = Get-Process -Id {pid} -ErrorAction Stop
  $start = [int64]($process.StartTime.ToUniversalTime().Ticks)
}} catch {{ Write-Output 'PROCESS_TARGET_MISSING'; exit 44 }}
if ($start -ne {start_time_ticks}) {{ Write-Output 'PROCESS_IDENTITY_CHANGED'; exit 44 }}
try {{ Stop-Process -Id {pid} -ErrorAction Stop }} catch {{ exit 45 }}
Write-Output 'PROCESS_SIGNAL_SENT'"#
    );
    powershell_script_command(&script)
}

fn powershell_script_command(script: &str) -> String {
    let script_utf16le = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        BASE64_STANDARD.encode(script_utf16le)
    )
}

fn posix_terminate_command(
    pid: u32,
    start_marker_hex: &str,
    name_marker_hex: &str,
    signal: ProcessSignal,
) -> String {
    let signal_flag = posix_signal_flag(signal);
    format!(
        r#"LC_ALL=C; export LC_ALL
current_start_hex=$(ps -p {pid} -o lstart= 2>/dev/null | tr -d '\012\015' | od -An -tx1 | tr -d ' \012')
current_name=$(ps -p {pid} -o comm= 2>/dev/null | tr -d '\012\015')
current_name=${{current_name##*/}}
current_name_hex=$(printf '%s' "$current_name" | cut -c 1-128 | od -An -tx1 | tr -d ' \012')
if [ -z "$current_start_hex" ] || [ -z "$current_name_hex" ]; then printf 'PROCESS_TARGET_MISSING\n'; exit 44; fi
if [ "$current_start_hex" != "{start_marker_hex}" ] || [ "$current_name_hex" != "{name_marker_hex}" ]; then printf 'PROCESS_IDENTITY_CHANGED\n'; exit 44; fi
kill -{signal_flag} {pid} 2>/dev/null || exit 45
printf 'PROCESS_SIGNAL_SENT\n'"#
    )
}

fn parse_posix_process_output(
    output: &str,
    collected_at_ms: u64,
) -> Result<ParsedProcesses, AppError> {
    if !output.lines().any(|line| line.trim() == "PLATFORM=POSIX") {
        return Err(process_probe_error());
    }
    let records = output
        .lines()
        .filter(|line| line.starts_with("P\t"))
        .collect::<Vec<_>>();
    let truncated = records.len() > 100;
    let mut processes = Vec::with_capacity(records.len().min(100));
    let mut identities = HashMap::new();
    for record in records.into_iter().take(100) {
        let fields = record.split('\t').collect::<Vec<_>>();
        if fields.len() != 11 {
            continue;
        }
        let Ok(pid) = fields[1].parse::<u32>() else {
            continue;
        };
        let name_marker_hex = fields[10];
        let start_marker_hex = fields[8];
        let name =
            decode_process_name(name_marker_hex, true).unwrap_or_else(|| "unknown".to_owned());
        let identity_valid = pid > 1
            && is_hex_marker(start_marker_hex, 512)
            && !start_marker_hex.is_empty()
            && is_hex_marker(name_marker_hex, 256)
            && !name_marker_hex.is_empty();
        if identity_valid {
            identities.insert(
                pid,
                ProcessIdentity::Posix {
                    start_marker_hex: start_marker_hex.to_owned(),
                    name_marker_hex: name_marker_hex.to_owned(),
                },
            );
        }
        let memory_bytes = fields[6]
            .parse::<u64>()
            .ok()
            .and_then(|kib| kib.checked_mul(1024));
        processes.push(ProcessEntry {
            pid,
            parent_pid: fields[2].parse::<u32>().ok(),
            name,
            user: decode_process_name(fields[3], true),
            cpu_percent: parse_process_float(fields[4]),
            cpu_time_seconds: parse_posix_cpu_time(fields[5]),
            memory_bytes,
            state: sanitize_process_state(fields[7]),
            started_at_ms: fields[9]
                .parse::<u64>()
                .ok()
                .and_then(|seconds| seconds.checked_mul(1_000))
                .and_then(|milliseconds| collected_at_ms.checked_sub(milliseconds)),
            can_terminate: identity_valid,
        });
    }
    Ok(ParsedProcesses {
        processes,
        identities,
        truncated,
    })
}

fn parse_windows_process_output(output: &str) -> Result<ParsedProcesses, AppError> {
    if !output.lines().any(|line| line.trim() == "PLATFORM=WINDOWS") {
        return Err(process_probe_error());
    }
    let records = output
        .lines()
        .filter(|line| line.starts_with("P\t"))
        .collect::<Vec<_>>();
    let truncated = records.len() > 100;
    let mut processes = Vec::with_capacity(records.len().min(100));
    let mut identities = HashMap::new();
    for record in records.into_iter().take(100) {
        let fields = record.split('\t').collect::<Vec<_>>();
        if fields.len() != 8 {
            continue;
        }
        let Ok(pid) = fields[1].parse::<u32>() else {
            continue;
        };
        let name = decode_process_name(fields[7], false).unwrap_or_else(|| "unknown".to_owned());
        let start_time_ticks = fields[5].parse::<u64>().unwrap_or_default();
        let identity_valid = pid > 1 && start_time_ticks > 0;
        if identity_valid {
            identities.insert(pid, ProcessIdentity::Windows { start_time_ticks });
        }
        processes.push(ProcessEntry {
            pid,
            parent_pid: fields[2].parse::<u32>().ok(),
            name,
            user: None,
            cpu_percent: None,
            cpu_time_seconds: parse_process_float(fields[3]),
            memory_bytes: fields[4].parse::<u64>().ok(),
            state: None,
            started_at_ms: fields[6].parse::<u64>().ok(),
            can_terminate: identity_valid,
        });
    }
    Ok(ParsedProcesses {
        processes,
        identities,
        truncated,
    })
}

fn parse_process_float(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1_000_000.0)
}

fn parse_posix_cpu_time(value: &str) -> Option<f64> {
    let (days, time) = if let Some((days, time)) = value.split_once('-') {
        (days.parse::<f64>().ok()?, time)
    } else {
        (0.0, value)
    };
    let components = time.split(':').collect::<Vec<_>>();
    let seconds = match components.as_slice() {
        [minutes, seconds] => minutes.parse::<f64>().ok()? * 60.0 + seconds.parse::<f64>().ok()?,
        [hours, minutes, seconds] => {
            hours.parse::<f64>().ok()? * 3600.0
                + minutes.parse::<f64>().ok()? * 60.0
                + seconds.parse::<f64>().ok()?
        }
        _ => return None,
    };
    let total = days * 86_400.0 + seconds;
    (total.is_finite() && total >= 0.0).then_some(total)
}

fn sanitize_process_state(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 8
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-+?<>".contains(&byte))
    {
        return None;
    }
    Some(value.to_owned())
}

fn decode_process_name(value: &str, hexadecimal: bool) -> Option<String> {
    let bytes = if hexadecimal {
        decode_hex_marker(value, 256)?
    } else {
        BASE64_STANDARD
            .decode(value)
            .ok()?
            .into_iter()
            .take(128)
            .collect()
    };
    let decoded = String::from_utf8_lossy(&bytes);
    let basename = decoded.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name = String::new();
    for character in basename.chars().take(96) {
        if character.is_control() || character == '\n' || character == '\r' {
            name.push(' ');
        } else {
            name.push(character);
        }
    }
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn is_hex_marker(value: &str, maximum_length: usize) -> bool {
    value.len() <= maximum_length
        && value.len() % 2 == 0
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode_hex_marker(value: &str, maximum_length: usize) -> Option<Vec<u8>> {
    if !is_hex_marker(value, maximum_length) {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            Some(((high << 4) | low) as u8)
        })
        .collect()
}

fn decode_probe_text(value: &str, hexadecimal: bool, maximum_bytes: usize) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let bytes = if hexadecimal {
        decode_hex_marker(value, maximum_bytes.saturating_mul(2))?
    } else {
        BASE64_STANDARD.decode(value).ok()?
    };
    let mut decoded = String::new();
    for character in String::from_utf8_lossy(&bytes).chars().take(maximum_bytes) {
        if character.is_control() {
            decoded.push(' ');
        } else {
            decoded.push(character);
        }
    }
    let decoded = decoded.trim();
    (!decoded.is_empty()).then(|| decoded.to_owned())
}

fn parse_linux_network_output(
    output: &str,
    collected_at_ms: u64,
) -> Result<NetworkSnapshot, AppError> {
    if output
        .lines()
        .any(|line| line.trim() == "PLATFORM=UNSUPPORTED")
    {
        return Ok(NetworkSnapshot {
            state: MonitorState::Unsupported,
            platform: None,
            collected_at_ms,
            interfaces: Vec::new(),
            endpoints: Vec::new(),
            routes: Vec::new(),
            endpoints_truncated: false,
            routes_truncated: false,
        });
    }
    if !output.lines().any(|line| line.trim() == "PLATFORM=LINUX") {
        return Err(network_probe_error());
    }

    let interfaces = output
        .lines()
        .filter(|line| line.starts_with("I\t"))
        .take(128)
        .filter_map(|line| parse_network_interface(line, true))
        .collect::<Vec<_>>();
    let endpoint_records = output
        .lines()
        .filter(|line| line.starts_with("E\t"))
        .collect::<Vec<_>>();
    let route_records = output
        .lines()
        .filter(|line| line.starts_with("T\t"))
        .collect::<Vec<_>>();
    Ok(NetworkSnapshot {
        state: MonitorState::Live,
        platform: Some(NetworkPlatform::Linux),
        collected_at_ms,
        interfaces,
        endpoints: endpoint_records
            .iter()
            .take(500)
            .filter_map(|line| parse_linux_endpoint(line))
            .collect(),
        routes: route_records
            .iter()
            .take(500)
            .filter_map(|line| parse_route_entry(line, true))
            .collect(),
        endpoints_truncated: endpoint_records.len() > 500,
        routes_truncated: route_records.len() > 500,
    })
}

fn parse_windows_network_output(
    output: &str,
    collected_at_ms: u64,
) -> Result<NetworkSnapshot, AppError> {
    if !output.lines().any(|line| line.trim() == "PLATFORM=WINDOWS") {
        return Err(network_probe_error());
    }
    let interfaces = output
        .lines()
        .filter(|line| line.starts_with("I\t"))
        .take(128)
        .filter_map(|line| parse_network_interface(line, false))
        .collect::<Vec<_>>();
    let endpoint_records = output
        .lines()
        .filter(|line| line.starts_with("E\t"))
        .collect::<Vec<_>>();
    let route_records = output
        .lines()
        .filter(|line| line.starts_with("T\t"))
        .collect::<Vec<_>>();
    Ok(NetworkSnapshot {
        state: MonitorState::Live,
        platform: Some(NetworkPlatform::Windows),
        collected_at_ms,
        interfaces,
        endpoints: endpoint_records
            .iter()
            .take(500)
            .filter_map(|line| parse_windows_endpoint(line))
            .collect(),
        routes: route_records
            .iter()
            .take(500)
            .filter_map(|line| parse_route_entry(line, false))
            .collect(),
        endpoints_truncated: endpoint_records.len() > 500,
        routes_truncated: route_records.len() > 500,
    })
}

fn parse_network_interface(line: &str, hexadecimal: bool) -> Option<NetworkInterface> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 8 {
        return None;
    }
    let name = decode_probe_text(fields[1], hexadecimal, 128)?;
    let addresses = decode_probe_text(fields[3], hexadecimal, 1_024)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(32)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Some(NetworkInterface {
        name,
        state: decode_probe_text(fields[2], hexadecimal, 64),
        addresses,
        mtu: fields[4].parse::<u64>().ok(),
        received_bytes: fields[5].parse::<u64>().ok(),
        transmitted_bytes: fields[6].parse::<u64>().ok(),
        loopback: fields[7] == "1",
    })
}

fn parse_linux_endpoint(line: &str) -> Option<NetworkEndpoint> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 6 {
        return None;
    }
    let protocol = decode_probe_text(fields[1], true, 16)?;
    let state = decode_probe_text(fields[2], true, 32);
    let local = decode_probe_text(fields[3], true, 256)?;
    let remote = decode_probe_text(fields[4], true, 256);
    let details = decode_probe_text(fields[5], true, 512).unwrap_or_default();
    let (local_address, local_port) = split_network_endpoint(&local);
    let (remote_address, remote_port) = remote
        .as_deref()
        .map(split_network_endpoint)
        .unwrap_or((String::new(), None));
    let pid = details.split("pid=").nth(1).and_then(|value| {
        value
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .ok()
    });
    let process_name = details
        .split("((\"")
        .nth(1)
        .and_then(|value| value.split('\"').next())
        .and_then(|value| sanitize_probe_label(value, 128));
    Some(NetworkEndpoint {
        protocol,
        local_address,
        local_port,
        remote_address: (!remote_address.is_empty() && remote_address != "*")
            .then_some(remote_address),
        remote_port,
        state,
        pid,
        process_name,
    })
}

fn parse_windows_endpoint(line: &str) -> Option<NetworkEndpoint> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 9 {
        return None;
    }
    Some(NetworkEndpoint {
        protocol: decode_probe_text(fields[1], false, 16)?,
        state: decode_probe_text(fields[2], false, 32),
        local_address: decode_probe_text(fields[3], false, 256)?,
        local_port: fields[4].parse::<u16>().ok(),
        remote_address: decode_probe_text(fields[5], false, 256)
            .filter(|value| value != "0.0.0.0" && value != "::" && value != "*"),
        remote_port: fields[6].parse::<u16>().ok().filter(|port| *port > 0),
        pid: fields[7].parse::<u32>().ok().filter(|pid| *pid > 0),
        process_name: decode_probe_text(fields[8], false, 128),
    })
}

fn parse_route_entry(line: &str, hexadecimal: bool) -> Option<RouteEntry> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 6 {
        return None;
    }
    Some(RouteEntry {
        destination: decode_probe_text(fields[1], hexadecimal, 256)?,
        gateway: decode_probe_text(fields[2], hexadecimal, 256)
            .filter(|value| value != "0.0.0.0" && value != "::"),
        interface_name: decode_probe_text(fields[3], hexadecimal, 128),
        metric: fields[4].parse::<u32>().ok(),
        protocol: decode_probe_text(fields[5], hexadecimal, 64),
    })
}

fn split_network_endpoint(value: &str) -> (String, Option<u16>) {
    let Some((address, port)) = value.rsplit_once(':') else {
        return (value.trim_matches(['[', ']']).to_owned(), None);
    };
    (
        address.trim_matches(['[', ']']).to_owned(),
        port.parse::<u16>().ok(),
    )
}

fn sanitize_probe_label(value: &str, maximum_characters: usize) -> Option<String> {
    let sanitized = value
        .chars()
        .take(maximum_characters)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_owned())
}

async fn hash_reader<R>(
    reader: &mut R,
    cancellation: &CancellationToken,
) -> Result<(String, u64), AppError>
where
    R: AsyncRead + Unpin,
{
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; FILE_CHECKSUM_BUFFER_BYTES];
    let mut total_bytes = 0_u64;
    loop {
        let read = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(checksum_cancelled_error()),
            result = reader.read(&mut buffer) => result.map_err(|_| checksum_read_error())?,
        };
        if read == 0 {
            break;
        }
        total_bytes = total_bytes
            .checked_add(read as u64)
            .filter(|total| *total <= FILE_CHECKSUM_MAX_BYTES)
            .ok_or_else(checksum_too_large_error)?;
        hasher.update(&buffer[..read]);
    }
    Ok((sha256_digest_hex(&hasher.finalize()), total_bytes))
}

fn sha256_digest_hex(digest: &[u8]) -> String {
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn local_metadata_changed(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    before.len() != after.len() || before.modified().ok() != after.modified().ok()
}

fn remote_metadata_changed(before: &FileAttributes, after: &FileAttributes) -> bool {
    before.size != after.size || before.mtime != after.mtime
}

async fn scan_local_directory_tree(
    root: &std::path::Path,
    cancellation: &CancellationToken,
) -> Result<BTreeMap<String, DirectorySyncNode>, AppError> {
    let mut entries = BTreeMap::new();
    let mut directories = vec![(root.to_path_buf(), String::new(), 0_usize)];

    while let Some((directory_path, relative_parent, depth)) = directories.pop() {
        let mut directory = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
            result = tokio::fs::read_dir(&directory_path) => {
                result.map_err(|_| sync_preview_failed_error())?
            }
        };
        loop {
            let next = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
                result = directory.next_entry() => result.map_err(|_| sync_preview_failed_error())?,
            };
            let Some(entry) = next else {
                break;
            };
            let file_name = entry.file_name();
            let name = file_name
                .to_str()
                .map(str::to_owned)
                .ok_or_else(sync_preview_path_unsupported_error)?;
            if !valid_directory_sync_segment(&name) {
                return Err(sync_preview_path_unsupported_error());
            }
            let relative_path = join_relative_sync_path(&relative_parent, &name);
            if relative_path.len() > 4_096 {
                return Err(sync_preview_limit_error());
            }
            if entries.len() >= DIRECTORY_SYNC_MAX_ENTRIES {
                return Err(sync_preview_limit_error());
            }
            let path = entry.path();
            let metadata = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(sync_preview_cancelled_error()),
                result = tokio::fs::symlink_metadata(&path) => {
                    result.map_err(|_| sync_preview_target_changed_error())?
                }
            };
            let file_type = metadata.file_type();
            let kind = if file_type.is_symlink() {
                DirectorySyncEntryKind::Symlink
            } else if file_type.is_dir() {
                DirectorySyncEntryKind::Directory
            } else if file_type.is_file() {
                DirectorySyncEntryKind::File
            } else {
                DirectorySyncEntryKind::Special
            };
            let is_directory = kind == DirectorySyncEntryKind::Directory;
            let modified_at_ms = (kind == DirectorySyncEntryKind::File)
                .then(|| metadata.modified().ok())
                .flatten()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64);
            let node = DirectorySyncNode {
                size: (kind == DirectorySyncEntryKind::File).then_some(metadata.len()),
                kind,
                modified_at_ms,
            };
            entries.insert(relative_path.clone(), node);
            if is_directory {
                if depth >= DIRECTORY_SYNC_MAX_DEPTH {
                    return Err(sync_preview_limit_error());
                }
                directories.push((path, relative_path, depth + 1));
            }
        }
    }
    if cancellation.is_cancelled() {
        return Err(sync_preview_cancelled_error());
    }
    Ok(entries)
}

fn compare_directory_sync_trees(
    local_entries: BTreeMap<String, DirectorySyncNode>,
    remote_entries: BTreeMap<String, DirectorySyncNode>,
) -> DirectorySyncPreview {
    let local_entry_count = local_entries.len();
    let remote_entry_count = remote_entries.len();
    let paths = local_entries
        .keys()
        .chain(remote_entries.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut preview = DirectorySyncPreview {
        local_entry_count,
        remote_entry_count,
        local_only_count: 0,
        remote_only_count: 0,
        metadata_different_count: 0,
        type_conflict_count: 0,
        unsupported_count: 0,
        unchanged_count: 0,
        entries: Vec::with_capacity(DIRECTORY_SYNC_MAX_RESULTS),
        truncated: false,
    };
    let mut changed_count = 0_usize;

    for relative_path in paths {
        let local = local_entries.get(&relative_path);
        let remote = remote_entries.get(&relative_path);
        let change_kind = match (local, remote) {
            (Some(local), Some(remote))
                if is_unsupported_directory_sync_node(local)
                    || is_unsupported_directory_sync_node(remote) =>
            {
                Some(DirectorySyncChangeKind::Unsupported)
            }
            (Some(local), Some(remote)) if local.kind != remote.kind => {
                Some(DirectorySyncChangeKind::TypeConflict)
            }
            (Some(local), Some(remote))
                if local.kind == DirectorySyncEntryKind::File
                    && !directory_sync_file_metadata_matches(local, remote) =>
            {
                Some(DirectorySyncChangeKind::MetadataDifferent)
            }
            (Some(_), Some(_)) => None,
            (Some(local), None) if is_unsupported_directory_sync_node(local) => {
                Some(DirectorySyncChangeKind::Unsupported)
            }
            (Some(_), None) => Some(DirectorySyncChangeKind::LocalOnly),
            (None, Some(remote)) if is_unsupported_directory_sync_node(remote) => {
                Some(DirectorySyncChangeKind::Unsupported)
            }
            (None, Some(_)) => Some(DirectorySyncChangeKind::RemoteOnly),
            (None, None) => None,
        };

        let Some(change_kind) = change_kind else {
            preview.unchanged_count += 1;
            continue;
        };
        changed_count += 1;
        match change_kind {
            DirectorySyncChangeKind::LocalOnly => preview.local_only_count += 1,
            DirectorySyncChangeKind::RemoteOnly => preview.remote_only_count += 1,
            DirectorySyncChangeKind::MetadataDifferent => preview.metadata_different_count += 1,
            DirectorySyncChangeKind::TypeConflict => preview.type_conflict_count += 1,
            DirectorySyncChangeKind::Unsupported => preview.unsupported_count += 1,
        }
        if preview.entries.len() < DIRECTORY_SYNC_MAX_RESULTS {
            preview.entries.push(DirectorySyncPreviewEntry {
                relative_path,
                change_kind,
                local_kind: local.map(|node| node.kind.clone()),
                remote_kind: remote.map(|node| node.kind.clone()),
                local_size: local.and_then(|node| node.size),
                remote_size: remote.and_then(|node| node.size),
                local_modified_at_ms: local.and_then(|node| node.modified_at_ms),
                remote_modified_at_ms: remote.and_then(|node| node.modified_at_ms),
            });
        }
    }
    preview.truncated = changed_count > preview.entries.len();
    preview
}

fn is_unsupported_directory_sync_node(node: &DirectorySyncNode) -> bool {
    match &node.kind {
        DirectorySyncEntryKind::Symlink | DirectorySyncEntryKind::Special => true,
        DirectorySyncEntryKind::File => node.size.is_none() || node.modified_at_ms.is_none(),
        DirectorySyncEntryKind::Directory => false,
    }
}

fn directory_sync_file_metadata_matches(
    local: &DirectorySyncNode,
    remote: &DirectorySyncNode,
) -> bool {
    local.size.is_some()
        && local.size == remote.size
        && matches!(
            (local.modified_at_ms, remote.modified_at_ms),
            (Some(local_time), Some(remote_time)) if local_time / 1_000 == remote_time / 1_000
        )
}

fn valid_directory_sync_segment(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
    {
        return false;
    }
    let windows_base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(
        windows_base.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn join_relative_sync_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn join_remote_directory_path(parent: &str, name: &str) -> String {
    let parent = parent.trim_end_matches('/');
    if parent.is_empty() {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn remote_path_is_same_or_child(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.starts_with('/');
    }
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

fn valid_checksum_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.len() <= 128
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn windows_monitor_command() -> String {
    powershell_script_command(WINDOWS_MONITOR_SCRIPT)
}

fn now_ms() -> Result<u64, AppError> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| monitor_probe_error())?
            .as_millis(),
    )
    .map_err(|_| monitor_probe_error())
}

fn validate_tunnel_input(input: &CreateLocalTunnelInput) -> Result<(), AppError> {
    if input.name.trim().is_empty()
        || input.bind_host.parse::<IpAddr>().is_err()
        || (!input
            .bind_host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
            && !input.allow_non_loopback)
        || match &input.kind {
            TunnelKind::Local => {
                input.target_host.as_deref().is_none_or(|host| {
                    host.trim().is_empty() || host.len() > 253 || host.contains(char::is_whitespace)
                }) || input.target_port.is_none_or(|port| port == 0)
            }
            TunnelKind::Remote => {
                input.bind_port == 0
                    || input.target_host.as_deref().is_none_or(|host| {
                        host.trim().is_empty()
                            || host.len() > 253
                            || host.contains(char::is_whitespace)
                    })
                    || input.target_port.is_none_or(|port| port == 0)
            }
            TunnelKind::Dynamic => input.target_host.is_some() || input.target_port.is_some(),
        }
    {
        return Err(tunnel_validation_error());
    }
    Ok(())
}

async fn serve_socks5(
    mut local: tokio::net::TcpStream,
    session: Arc<ConnectedSshSession>,
    peer: std::net::SocketAddr,
) -> Result<(), AppError> {
    let mut greeting = [0_u8; 2];
    local
        .read_exact(&mut greeting)
        .await
        .map_err(|_| tunnel_validation_error())?;
    if greeting[0] != 5 || greeting[1] == 0 {
        let _ = local.write_all(&[5, 255]).await;
        return Err(tunnel_validation_error());
    }
    let mut methods = vec![0; usize::from(greeting[1]).min(255)];
    local
        .read_exact(&mut methods)
        .await
        .map_err(|_| tunnel_validation_error())?;
    if !methods.contains(&0) {
        let _ = local.write_all(&[5, 255]).await;
        return Err(tunnel_validation_error());
    }
    local
        .write_all(&[5, 0])
        .await
        .map_err(|_| tunnel_validation_error())?;

    let mut request = [0_u8; 4];
    local
        .read_exact(&mut request)
        .await
        .map_err(|_| tunnel_validation_error())?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        let _ = local.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(tunnel_validation_error());
    }
    let target_host = match request[3] {
        1 => {
            let mut address = [0_u8; 4];
            local
                .read_exact(&mut address)
                .await
                .map_err(|_| tunnel_validation_error())?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        3 => {
            let mut length = [0_u8; 1];
            local
                .read_exact(&mut length)
                .await
                .map_err(|_| tunnel_validation_error())?;
            let mut domain = vec![0_u8; usize::from(length[0])];
            if domain.is_empty() {
                let _ = local.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(tunnel_validation_error());
            }
            local
                .read_exact(&mut domain)
                .await
                .map_err(|_| tunnel_validation_error())?;
            String::from_utf8(domain).map_err(|_| tunnel_validation_error())?
        }
        4 => {
            let mut address = [0_u8; 16];
            local
                .read_exact(&mut address)
                .await
                .map_err(|_| tunnel_validation_error())?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => {
            let _ = local.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(tunnel_validation_error());
        }
    };
    let mut port_bytes = [0_u8; 2];
    local
        .read_exact(&mut port_bytes)
        .await
        .map_err(|_| tunnel_validation_error())?;
    let target_port = u16::from_be_bytes(port_bytes);
    if target_port == 0 || target_host.len() > 253 || target_host.contains(char::is_whitespace) {
        let _ = local.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(tunnel_validation_error());
    }
    let mut remote = match session
        .open_direct_tcpip(
            &target_host,
            u32::from(target_port),
            &peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await
    {
        Ok(remote) => remote,
        Err(error) => {
            let _ = local.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(ssh_error(&error));
        }
    };
    local
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|_| tunnel_validation_error())?;
    copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(|_| tunnel_accept_error())?;
    Ok(())
}

fn monitor_probe_error() -> AppError {
    AppError {
        code: "MONITOR_PROBE_FAILED".to_owned(),
        message_key: "errors.monitorProbeFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn process_probe_error() -> AppError {
    AppError {
        code: "PROCESS_PROBE_FAILED".to_owned(),
        message_key: "errors.processProbeFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn network_probe_error() -> AppError {
    AppError {
        code: "NETWORK_PROBE_FAILED".to_owned(),
        message_key: "errors.networkProbeFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn process_snapshot_stale_error() -> AppError {
    AppError {
        code: "PROCESS_SNAPSHOT_STALE".to_owned(),
        message_key: "errors.processSnapshotStale".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn process_target_invalid_error() -> AppError {
    AppError {
        code: "PROCESS_TARGET_INVALID".to_owned(),
        message_key: "errors.processTargetInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn process_termination_error() -> AppError {
    AppError {
        code: "PROCESS_TERMINATION_FAILED".to_owned(),
        message_key: "errors.processTerminationFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn checksum_error(
    code: &str,
    message_key: &str,
    retryable: bool,
    remote_state: RemoteState,
) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable,
        remote_state,
        field: None,
    }
}

fn checksum_target_invalid_error() -> AppError {
    checksum_error(
        "CHECKSUM_TARGET_INVALID",
        "errors.checksumTargetInvalid",
        false,
        RemoteState::NotApplicable,
    )
}

fn checksum_target_unsupported_error() -> AppError {
    checksum_error(
        "CHECKSUM_TARGET_UNSUPPORTED",
        "errors.checksumTargetUnsupported",
        false,
        RemoteState::Unchanged,
    )
}

fn checksum_too_large_error() -> AppError {
    checksum_error(
        "CHECKSUM_FILE_TOO_LARGE",
        "errors.checksumFileTooLarge",
        false,
        RemoteState::Unchanged,
    )
}

fn checksum_target_changed_error() -> AppError {
    checksum_error(
        "CHECKSUM_TARGET_CHANGED",
        "errors.checksumTargetChanged",
        true,
        RemoteState::Unknown,
    )
}

fn checksum_read_error() -> AppError {
    checksum_error(
        "CHECKSUM_FAILED",
        "errors.checksumFailed",
        true,
        RemoteState::Unchanged,
    )
}

fn checksum_busy_error() -> AppError {
    checksum_error(
        "CHECKSUM_BUSY",
        "errors.checksumBusy",
        true,
        RemoteState::Unchanged,
    )
}

fn checksum_not_running_error() -> AppError {
    checksum_error(
        "CHECKSUM_NOT_RUNNING",
        "errors.checksumNotRunning",
        false,
        RemoteState::Unchanged,
    )
}

fn checksum_cancelled_error() -> AppError {
    checksum_error(
        "CHECKSUM_CANCELLED",
        "errors.checksumCancelled",
        false,
        RemoteState::Unchanged,
    )
}

fn checksum_timeout_error() -> AppError {
    checksum_error(
        "CHECKSUM_TIMEOUT",
        "errors.checksumTimeout",
        true,
        RemoteState::Unchanged,
    )
}

fn sync_preview_error(
    code: &str,
    message_key: &str,
    retryable: bool,
    remote_state: RemoteState,
) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable,
        remote_state,
        field: None,
    }
}

fn sync_preview_invalid_target_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_TARGET_INVALID",
        "errors.syncPreviewInvalidTarget",
        false,
        RemoteState::NotApplicable,
    )
}

fn sync_preview_unsupported_root_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_ROOT_UNSUPPORTED",
        "errors.syncPreviewUnsupportedRoot",
        false,
        RemoteState::Unchanged,
    )
}

fn sync_preview_path_unsupported_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_PATH_UNSUPPORTED",
        "errors.syncPreviewPathUnsupported",
        false,
        RemoteState::Unchanged,
    )
}

fn sync_preview_limit_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_LIMIT_EXCEEDED",
        "errors.syncPreviewLimitExceeded",
        false,
        RemoteState::Unchanged,
    )
}

fn sync_preview_target_changed_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_TARGET_CHANGED",
        "errors.syncPreviewTargetChanged",
        true,
        RemoteState::Unknown,
    )
}

fn sync_preview_failed_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_FAILED",
        "errors.syncPreviewFailed",
        true,
        RemoteState::Unknown,
    )
}

fn sync_preview_busy_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_BUSY",
        "errors.syncPreviewBusy",
        true,
        RemoteState::Unchanged,
    )
}

fn sync_preview_not_running_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_NOT_RUNNING",
        "errors.syncPreviewNotRunning",
        false,
        RemoteState::Unchanged,
    )
}

fn sync_preview_cancelled_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_CANCELLED",
        "errors.syncPreviewCancelled",
        false,
        RemoteState::Unchanged,
    )
}

fn sync_preview_timeout_error() -> AppError {
    sync_preview_error(
        "SYNC_PREVIEW_TIMEOUT",
        "errors.syncPreviewTimeout",
        true,
        RemoteState::Unchanged,
    )
}

fn tunnel_validation_error() -> AppError {
    AppError {
        code: "TUNNEL_VALIDATION_FAILED".to_owned(),
        message_key: "errors.tunnelValidationFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn tunnel_bind_error() -> AppError {
    AppError {
        code: "TUNNEL_BIND_FAILED".to_owned(),
        message_key: "errors.tunnelBindFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: Some("bindPort".to_owned()),
    }
}

fn tunnel_accept_error() -> AppError {
    AppError {
        code: "TUNNEL_ACCEPT_FAILED".to_owned(),
        message_key: "errors.tunnelAcceptFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn tunnel_not_found_error() -> AppError {
    AppError {
        code: "TUNNEL_NOT_FOUND".to_owned(),
        message_key: "errors.tunnelNotFound".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

async fn upload(
    session: &ConnectedSshSession,
    sftp: &russh_sftp::client::SftpSession,
    task: &TransferTask,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    if task.local_path.is_empty() || task.local_path.len() > 4_096 || task.remote_path.len() > 4_096
    {
        return Err(directory_tree_limit_error());
    }
    let source_path = PathBuf::from(&task.local_path);
    let metadata = tokio::fs::symlink_metadata(&source_path)
        .await
        .map_err(|_| transfer_io_error("LOCAL_FILE_READ_FAILED", "errors.localFileReadFailed"))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(directory_tree_unsupported_error());
    }
    if file_type.is_file() {
        on_progress(control.bytes_transferred(), Some(metadata.len()));
        return upload_regular_file(sftp, task, control, on_progress).await;
    }
    if file_type.is_dir() {
        return upload_directory(session, sftp, task, &source_path, control, on_progress).await;
    }
    Err(directory_tree_unsupported_error())
}

async fn upload_regular_file(
    sftp: &russh_sftp::client::SftpSession,
    task: &TransferTask,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    let mut target = task.remote_path.clone();
    if target.is_empty() || target.contains('\0') {
        return Err(invalid_remote_path_error());
    }
    let exists = sftp
        .try_exists(target.clone())
        .await
        .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
    if exists {
        match task.conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite => {}
            ConflictPolicy::Rename => {
                target = unique_remote_path(sftp, &target).await?;
            }
        }
    }
    let mut local = tokio::fs::File::open(&task.local_path)
        .await
        .map_err(|_| transfer_io_error("LOCAL_FILE_READ_FAILED", "errors.localFileReadFailed"))?;
    let temporary = format!("{target}.filex-part-{}", uuid::Uuid::new_v4());
    let mut remote = sftp
        .create(temporary.clone())
        .await
        .map_err(|_| transfer_io_error("SFTP_CREATE_FAILED", "errors.sftpFailed"))?;
    let bytes = match copy_transfer_stream(&mut local, &mut remote, control, on_progress, 0).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = tokio::time::timeout(Duration::from_secs(2), remote.close()).await;
            let _ = tokio::time::timeout(Duration::from_secs(3), sftp.remove_file(temporary)).await;
            return Err(error);
        }
    };
    if let Err(error) = control.begin_commit().await {
        let _ = tokio::time::timeout(Duration::from_secs(2), remote.close()).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), sftp.remove_file(temporary)).await;
        return Err(error);
    }
    remote
        .shutdown()
        .await
        .map_err(|_| transfer_io_error("SFTP_FLUSH_FAILED", "errors.sftpFailed"))?;
    remote
        .close()
        .await
        .map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;
    if exists && task.conflict_policy == ConflictPolicy::Overwrite {
        sftp.remove_file(target.clone())
            .await
            .map_err(|_| transfer_io_error("SFTP_REPLACE_FAILED", "errors.sftpFailed"))?;
    }
    sftp.rename(temporary, target)
        .await
        .map_err(|_| transfer_io_error("SFTP_COMMIT_FAILED", "errors.sftpFailed"))?;
    Ok(bytes)
}

async fn upload_directory(
    session: &ConnectedSshSession,
    sftp: &russh_sftp::client::SftpSession,
    task: &TransferTask,
    source_root: &std::path::Path,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    let mut target_root = canonical_remote_transfer_target(sftp, &task.remote_path).await?;
    let root_metadata = remote_transfer_metadata(sftp, &target_root).await?;
    let mut merge_existing = false;
    if let Some(metadata) = root_metadata.as_ref() {
        if metadata.is_symlink() {
            return Err(directory_tree_unsupported_error());
        }
        match task.conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite if metadata.is_dir() => merge_existing = true,
            ConflictPolicy::Overwrite => return Err(directory_tree_unsupported_error()),
            ConflictPolicy::Rename => {
                target_root = unique_remote_path(sftp, &target_root).await?;
            }
        }
    }
    let entries = scan_local_transfer_tree(source_root, control).await?;
    let total_size = entries
        .iter()
        .filter(|entry| !entry.is_directory)
        .try_fold(0_u64, |total, entry| {
            total
                .checked_add(entry.size)
                .ok_or_else(directory_tree_limit_error)
        })?;
    on_progress(control.bytes_transferred(), Some(total_size));
    let staging_root = if merge_existing {
        None
    } else {
        let (parent, _) = split_remote_parent(&target_root)?;
        let path = join_remote_directory_path(
            parent,
            &format!(".filex-transfer-{}", uuid::Uuid::new_v4()),
        );
        if path.len() > 4_096 {
            return Err(directory_tree_limit_error());
        }
        if remote_transfer_metadata(sftp, &path).await?.is_some() {
            return Err(transfer_conflict_error());
        }
        Some(path)
    };
    let working_root = staging_root.as_deref().unwrap_or(&target_root);
    validate_remote_transfer_destinations(
        sftp,
        working_root,
        &entries,
        &task.conflict_policy,
        control,
    )
    .await?;
    control.wait_until_running().await?;

    let transfer_result = async {
        ensure_remote_transfer_directory(sftp, working_root).await?;
        let mut total_bytes = 0_u64;
        for entry in entries.iter().filter(|entry| entry.is_directory) {
            control.wait_until_running().await?;
            let target = remote_transfer_child_path(working_root, &entry.relative_path);
            ensure_remote_transfer_directory(sftp, &target).await?;
        }
        for entry in entries.iter().filter(|entry| !entry.is_directory) {
            control.wait_until_running().await?;
            let target = remote_transfer_child_path(working_root, &entry.relative_path);
            let copied = upload_directory_file(
                sftp,
                &entry.source_path,
                &target,
                &task.conflict_policy,
                control,
                on_progress,
                total_bytes,
            )
            .await?;
            total_bytes = total_bytes
                .checked_add(copied)
                .ok_or_else(directory_tree_limit_error)?;
        }
        if let Some(staging_root) = staging_root.as_ref() {
            control.begin_commit().await?;
            let commit_result = async {
                if remote_transfer_metadata(sftp, &target_root)
                    .await?
                    .is_some()
                {
                    return Err(transfer_conflict_error());
                }
                sftp.rename(staging_root.clone(), target_root.clone())
                    .await
                    .map_err(|_| transfer_io_error("SFTP_COMMIT_FAILED", "errors.sftpFailed"))
            }
            .await;
            if commit_result.is_err() {
                let _ = control.end_commit();
            }
            commit_result?;
        }
        Ok(total_bytes)
    }
    .await;
    if transfer_result.is_err() {
        if let Some(staging_root) = staging_root.as_ref() {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                remove_remote_tree(session, sftp, staging_root),
            )
            .await;
        }
    }
    transfer_result
}

async fn upload_directory_file(
    sftp: &russh_sftp::client::SftpSession,
    source_path: &std::path::Path,
    requested_target: &str,
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    base_bytes: u64,
) -> Result<u64, AppError> {
    let source_metadata = tokio::fs::symlink_metadata(source_path)
        .await
        .map_err(|_| transfer_io_error("LOCAL_FILE_READ_FAILED", "errors.localFileReadFailed"))?;
    if !source_metadata.file_type().is_file() {
        return Err(directory_tree_unsupported_error());
    }
    let mut target = requested_target.to_owned();
    let existing = remote_transfer_metadata(sftp, &target).await?;
    if let Some(metadata) = existing.as_ref() {
        if metadata.is_symlink() || !metadata.is_regular() {
            return Err(directory_tree_unsupported_error());
        }
        match conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite => {}
            ConflictPolicy::Rename => target = unique_remote_path(sftp, &target).await?,
        }
    }
    let temporary = format!("{target}.filex-part-{}", uuid::Uuid::new_v4());
    if temporary.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    let mut local = tokio::fs::File::open(source_path)
        .await
        .map_err(|_| transfer_io_error("LOCAL_FILE_READ_FAILED", "errors.localFileReadFailed"))?;
    let mut remote = sftp
        .open_with_flags(
            temporary.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await
        .map_err(|_| transfer_io_error("SFTP_CREATE_FAILED", "errors.sftpFailed"))?;
    let bytes =
        match copy_transfer_stream(&mut local, &mut remote, control, on_progress, base_bytes).await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = tokio::time::timeout(Duration::from_secs(2), remote.close()).await;
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), sftp.remove_file(temporary)).await;
                return Err(error);
            }
        };
    if let Err(error) = control.begin_commit().await {
        let _ = tokio::time::timeout(Duration::from_secs(2), remote.close()).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), sftp.remove_file(temporary)).await;
        return Err(error);
    }
    let commit_result = async {
        remote
            .shutdown()
            .await
            .map_err(|_| transfer_io_error("SFTP_FLUSH_FAILED", "errors.sftpFailed"))?;
        remote
            .close()
            .await
            .map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;
        let backup = if existing.is_some() && *conflict_policy == ConflictPolicy::Overwrite {
            let path = format!("{target}.filex-backup-{}", uuid::Uuid::new_v4());
            if path.len() > 4_096 {
                return Err(directory_tree_limit_error());
            }
            sftp.rename(target.clone(), path.clone())
                .await
                .map_err(|_| transfer_io_error("SFTP_REPLACE_FAILED", "errors.sftpFailed"))?;
            Some(path)
        } else {
            None
        };
        if sftp
            .rename(temporary.clone(), target.clone())
            .await
            .is_err()
        {
            if let Some(backup) = backup.as_ref() {
                let _ = sftp.rename(backup.clone(), target.clone()).await;
            }
            return Err(transfer_io_error("SFTP_COMMIT_FAILED", "errors.sftpFailed"));
        }
        if let Some(backup) = backup {
            let _ = sftp.remove_file(backup).await;
        }
        Ok(())
    }
    .await;
    let end_result = control.end_commit();
    if commit_result.is_err() {
        let _ = tokio::time::timeout(Duration::from_secs(3), sftp.remove_file(temporary)).await;
    }
    end_result?;
    commit_result?;
    Ok(bytes)
}

async fn download(
    sftp: &russh_sftp::client::SftpSession,
    session: &ConnectedSshSession,
    task: &TransferTask,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    if task.remote_path.is_empty()
        || task.remote_path.len() > 4_096
        || task.remote_path.contains('\0')
        || task.local_path.is_empty()
        || task.local_path.len() > 4_096
    {
        return Err(invalid_remote_path_error());
    }
    let metadata = sftp
        .symlink_metadata(task.remote_path.clone())
        .await
        .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
    if metadata.is_symlink() {
        return Err(directory_tree_unsupported_error());
    }
    if metadata.is_regular() {
        if let Some(total_bytes) = metadata.size {
            on_progress(control.bytes_transferred(), Some(total_bytes));
        }
        return download_regular_file(sftp, task, control, on_progress).await;
    }
    if metadata.is_dir() {
        return download_directory(sftp, session, task, control, on_progress).await;
    }
    Err(directory_tree_unsupported_error())
}

async fn download_regular_file(
    sftp: &russh_sftp::client::SftpSession,
    task: &TransferTask,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    let mut target = std::path::PathBuf::from(&task.local_path);
    if target.as_os_str().is_empty() {
        return Err(transfer_io_error(
            "LOCAL_PATH_INVALID",
            "errors.localPathInvalid",
        ));
    }
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        match task.conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite => {}
            ConflictPolicy::Rename => target = unique_local_path(&target).await?,
        }
    }
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| transfer_io_error("LOCAL_PATH_INVALID", "errors.localPathInvalid"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileWriteFailed"))?;
    let temporary = parent.join(format!(".filex-part-{}", uuid::Uuid::new_v4()));
    let transfer_result = async {
        let mut remote = sftp
            .open(task.remote_path.clone())
            .await
            .map_err(|_| transfer_io_error("SFTP_OPEN_FAILED", "errors.sftpFailed"))?;
        let mut local = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| {
                transfer_io_error("LOCAL_FILE_WRITE_FAILED", "errors.localFileWriteFailed")
            })?;
        let bytes = copy_transfer_stream(&mut remote, &mut local, control, on_progress, 0).await?;
        control.begin_commit().await?;
        local.flush().await.map_err(|_| {
            transfer_io_error("LOCAL_FILE_FLUSH_FAILED", "errors.localFileWriteFailed")
        })?;
        local.sync_all().await.map_err(|_| {
            transfer_io_error("LOCAL_FILE_SYNC_FAILED", "errors.localFileWriteFailed")
        })?;
        remote
            .close()
            .await
            .map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;
        drop(local);
        if tokio::fs::try_exists(&target).await.unwrap_or(false) {
            tokio::fs::remove_file(&target).await.map_err(|_| {
                transfer_io_error("LOCAL_REPLACE_FAILED", "errors.localFileWriteFailed")
            })?;
        }
        tokio::fs::rename(&temporary, &target)
            .await
            .map_err(|_| transfer_io_error("LOCAL_COMMIT_FAILED", "errors.localFileWriteFailed"))?;
        Ok(bytes)
    }
    .await;
    if transfer_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    transfer_result
}

async fn download_directory(
    sftp: &russh_sftp::client::SftpSession,
    session: &ConnectedSshSession,
    task: &TransferTask,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
) -> Result<u64, AppError> {
    let source_root = sftp
        .canonicalize(task.remote_path.clone())
        .await
        .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
    let directory_reader = session
        .open_sftp_directory_reader()
        .await
        .map_err(|error| ssh_error(&error))?;
    let scan_result =
        scan_remote_transfer_tree(&directory_reader, &source_root, Some(control), None).await;
    let close_result = directory_reader.close();
    let entries = scan_result?;
    close_result.map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;
    let mut target_root = PathBuf::from(&task.local_path);
    if target_root.as_os_str().is_empty() || target_root.to_string_lossy().len() > 4_096 {
        return Err(transfer_io_error(
            "LOCAL_PATH_INVALID",
            "errors.localPathInvalid",
        ));
    }
    let root_metadata = local_transfer_metadata(&target_root).await?;
    let mut merge_existing = false;
    if let Some(metadata) = root_metadata.as_ref() {
        if metadata.file_type().is_symlink() {
            return Err(directory_tree_unsupported_error());
        }
        match task.conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite if metadata.is_dir() => merge_existing = true,
            ConflictPolicy::Overwrite => return Err(directory_tree_unsupported_error()),
            ConflictPolicy::Rename => target_root = unique_local_path(&target_root).await?,
        }
    }
    if !target_root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(valid_directory_sync_segment)
    {
        return Err(directory_tree_unsupported_error());
    }
    let mut total_size = Some(0_u64);
    for entry in entries.iter().filter(|entry| !entry.is_directory) {
        total_size = match (total_size, entry.size) {
            (Some(total), Some(size)) => Some(
                total
                    .checked_add(size)
                    .ok_or_else(directory_tree_limit_error)?,
            ),
            _ => None,
        };
    }
    if let Some(total_size) = total_size {
        on_progress(control.bytes_transferred(), Some(total_size));
    }
    let parent = target_root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| transfer_io_error("LOCAL_PATH_INVALID", "errors.localPathInvalid"))?;
    let staging_root = if merge_existing {
        None
    } else {
        let path = parent.join(format!(".filex-transfer-{}", uuid::Uuid::new_v4()));
        if path.to_string_lossy().len() > 4_096 {
            return Err(directory_tree_limit_error());
        }
        if local_transfer_metadata(&path).await?.is_some() {
            return Err(transfer_conflict_error());
        }
        Some(path)
    };
    let working_root = staging_root.as_deref().unwrap_or(&target_root);
    validate_local_transfer_destinations(working_root, &entries, &task.conflict_policy, control)
        .await?;
    control.wait_until_running().await?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileWriteFailed"))?;

    let transfer_result = async {
        ensure_local_transfer_directory(working_root).await?;
        let mut total_bytes = 0_u64;
        for entry in entries.iter().filter(|entry| entry.is_directory) {
            control.wait_until_running().await?;
            let target = local_transfer_child_path(working_root, &entry.relative_path);
            ensure_local_transfer_directory(&target).await?;
        }
        for entry in entries.iter().filter(|entry| !entry.is_directory) {
            control.wait_until_running().await?;
            let target = local_transfer_child_path(working_root, &entry.relative_path);
            let copied = download_directory_file(
                sftp,
                &entry.remote_path,
                &target,
                &task.conflict_policy,
                control,
                on_progress,
                total_bytes,
            )
            .await?;
            total_bytes = total_bytes
                .checked_add(copied)
                .ok_or_else(directory_tree_limit_error)?;
        }
        if let Some(staging_root) = staging_root.as_ref() {
            control.begin_commit().await?;
            let commit_result = async {
                if local_transfer_metadata(&target_root).await?.is_some() {
                    return Err(transfer_conflict_error());
                }
                tokio::fs::rename(staging_root, &target_root)
                    .await
                    .map_err(|_| {
                        transfer_io_error("LOCAL_COMMIT_FAILED", "errors.localFileWriteFailed")
                    })
            }
            .await;
            if commit_result.is_err() {
                let _ = control.end_commit();
            }
            commit_result?;
        }
        Ok(total_bytes)
    }
    .await;
    if transfer_result.is_err() {
        if let Some(staging_root) = staging_root.as_ref() {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                remove_local_transfer_tree(staging_root),
            )
            .await;
        }
    }
    transfer_result
}

async fn validate_remote_transfer_destinations(
    sftp: &russh_sftp::client::SftpSession,
    target_root: &str,
    entries: &[LocalTransferEntry],
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
) -> Result<(), AppError> {
    for entry in entries {
        control.wait_until_running().await?;
        let target = remote_transfer_child_path(target_root, &entry.relative_path);
        if target.len() > 4_096 {
            return Err(directory_tree_limit_error());
        }
        let metadata = tokio::select! {
            biased;
            () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
            result = remote_transfer_metadata(sftp, &target) => result?,
        };
        let Some(metadata) = metadata else {
            continue;
        };
        if metadata.is_symlink() {
            return Err(directory_tree_unsupported_error());
        }
        if entry.is_directory {
            if !metadata.is_dir() {
                return Err(directory_tree_unsupported_error());
            }
        } else {
            if !metadata.is_regular() {
                return Err(directory_tree_unsupported_error());
            }
            if *conflict_policy == ConflictPolicy::Ask {
                return Err(transfer_conflict_error());
            }
        }
    }
    Ok(())
}

async fn validate_local_transfer_destinations(
    target_root: &std::path::Path,
    entries: &[RemoteTransferEntry],
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
) -> Result<(), AppError> {
    for entry in entries {
        control.wait_until_running().await?;
        let target = local_transfer_child_path(target_root, &entry.relative_path);
        if target.to_string_lossy().len() > 4_096 {
            return Err(directory_tree_limit_error());
        }
        let metadata = tokio::select! {
            biased;
            () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
            result = local_transfer_metadata(&target) => result?,
        };
        let Some(metadata) = metadata else {
            continue;
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(directory_tree_unsupported_error());
        }
        if entry.is_directory {
            if !file_type.is_dir() {
                return Err(directory_tree_unsupported_error());
            }
        } else {
            if !file_type.is_file() {
                return Err(directory_tree_unsupported_error());
            }
            if *conflict_policy == ConflictPolicy::Ask {
                return Err(transfer_conflict_error());
            }
        }
    }
    Ok(())
}

async fn ensure_remote_transfer_directory(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), AppError> {
    if path.is_empty() || path.len() > 4_096 || path.contains('\0') {
        return Err(directory_tree_limit_error());
    }
    if let Some(metadata) = remote_transfer_metadata(sftp, path).await? {
        if metadata.is_dir() && !metadata.is_symlink() {
            return Ok(());
        }
        return Err(directory_tree_unsupported_error());
    }
    sftp.create_dir(path.to_owned())
        .await
        .map_err(|_| transfer_io_error("SFTP_CREATE_FAILED", "errors.sftpFailed"))
}

async fn ensure_local_transfer_directory(path: &std::path::Path) -> Result<(), AppError> {
    if path.as_os_str().is_empty() || path.to_string_lossy().len() > 4_096 {
        return Err(transfer_io_error(
            "LOCAL_PATH_INVALID",
            "errors.localPathInvalid",
        ));
    }
    if let Some(metadata) = local_transfer_metadata(path).await? {
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            return Ok(());
        }
        return Err(directory_tree_unsupported_error());
    }
    tokio::fs::create_dir(path)
        .await
        .map_err(|_| transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileWriteFailed"))
}

async fn download_directory_file(
    sftp: &russh_sftp::client::SftpSession,
    source_path: &str,
    requested_target: &std::path::Path,
    conflict_policy: &ConflictPolicy,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    base_bytes: u64,
) -> Result<u64, AppError> {
    let source_metadata = remote_transfer_metadata(sftp, source_path)
        .await?
        .ok_or_else(|| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
    if source_metadata.is_symlink() || !source_metadata.is_regular() {
        return Err(directory_tree_unsupported_error());
    }
    let mut target = requested_target.to_path_buf();
    let existing = local_transfer_metadata(&target).await?;
    if let Some(metadata) = existing.as_ref() {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(directory_tree_unsupported_error());
        }
        match conflict_policy {
            ConflictPolicy::Ask => return Err(transfer_conflict_error()),
            ConflictPolicy::Skip => return Ok(0),
            ConflictPolicy::Overwrite => {}
            ConflictPolicy::Rename => target = unique_local_path(&target).await?,
        }
    }
    if target.to_string_lossy().len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| transfer_io_error("LOCAL_PATH_INVALID", "errors.localPathInvalid"))?;
    let temporary = parent.join(format!(".filex-part-{}", uuid::Uuid::new_v4()));
    if temporary.to_string_lossy().len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    let transfer_result = async {
        let mut remote = sftp
            .open(source_path.to_owned())
            .await
            .map_err(|_| transfer_io_error("SFTP_OPEN_FAILED", "errors.sftpFailed"))?;
        let mut local = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| {
                transfer_io_error("LOCAL_FILE_WRITE_FAILED", "errors.localFileWriteFailed")
            })?;
        let bytes =
            copy_transfer_stream(&mut remote, &mut local, control, on_progress, base_bytes).await?;
        control.begin_commit().await?;
        let commit_result = async {
            local.flush().await.map_err(|_| {
                transfer_io_error("LOCAL_FILE_FLUSH_FAILED", "errors.localFileWriteFailed")
            })?;
            local.sync_all().await.map_err(|_| {
                transfer_io_error("LOCAL_FILE_SYNC_FAILED", "errors.localFileWriteFailed")
            })?;
            remote
                .close()
                .await
                .map_err(|_| transfer_io_error("SFTP_CLOSE_FAILED", "errors.sftpFailed"))?;
            drop(local);
            let backup = if existing.is_some() && *conflict_policy == ConflictPolicy::Overwrite {
                let backup = parent.join(format!(".filex-backup-{}", uuid::Uuid::new_v4()));
                if backup.to_string_lossy().len() > 4_096 {
                    return Err(directory_tree_limit_error());
                }
                tokio::fs::rename(&target, &backup).await.map_err(|_| {
                    transfer_io_error("LOCAL_REPLACE_FAILED", "errors.localFileWriteFailed")
                })?;
                Some(backup)
            } else {
                None
            };
            if tokio::fs::rename(&temporary, &target).await.is_err() {
                if let Some(backup) = backup.as_ref() {
                    let _ = tokio::fs::rename(backup, &target).await;
                }
                return Err(transfer_io_error(
                    "LOCAL_COMMIT_FAILED",
                    "errors.localFileWriteFailed",
                ));
            }
            if let Some(backup) = backup {
                let _ = tokio::fs::remove_file(backup).await;
            }
            Ok(())
        }
        .await;
        let end_result = control.end_commit();
        end_result?;
        commit_result?;
        Ok(bytes)
    }
    .await;
    if transfer_result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    transfer_result
}

async fn scan_local_transfer_tree(
    root: &std::path::Path,
    control: &TransferControl,
) -> Result<Vec<LocalTransferEntry>, AppError> {
    let mut entries = Vec::new();
    let mut directories = vec![(root.to_path_buf(), String::new(), 0_usize)];

    while let Some((directory_path, relative_parent, depth)) = directories.pop() {
        control.wait_until_running().await?;
        let mut directory = tokio::select! {
            biased;
            () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
            result = tokio::fs::read_dir(&directory_path) => {
                result.map_err(|_| transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileReadFailed"))?
            }
        };
        let mut child_directories = Vec::new();
        loop {
            control.wait_until_running().await?;
            let next = tokio::select! {
                biased;
                () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
                result = directory.next_entry() => {
                    result.map_err(|_| transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileReadFailed"))?
                },
            };
            let Some(entry) = next else {
                break;
            };
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| directory_tree_unsupported_error())?;
            if !valid_directory_sync_segment(&name) {
                return Err(directory_tree_unsupported_error());
            }
            let relative_path = join_relative_sync_path(&relative_parent, &name);
            if relative_path.len() > 4_096 || entries.len() >= DIRECTORY_SYNC_MAX_ENTRIES {
                return Err(directory_tree_limit_error());
            }
            let source_path = entry.path();
            if source_path.to_string_lossy().len() > 4_096 {
                return Err(directory_tree_limit_error());
            }
            let metadata = tokio::select! {
                biased;
                () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
                result = tokio::fs::symlink_metadata(&source_path) => {
                    result.map_err(|_| transfer_io_error("LOCAL_FILE_READ_FAILED", "errors.localFileReadFailed"))?
                },
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
                return Err(directory_tree_unsupported_error());
            }
            let is_directory = file_type.is_dir();
            entries.push(LocalTransferEntry {
                source_path: source_path.clone(),
                relative_path: relative_path.clone(),
                is_directory,
                size: if is_directory { 0 } else { metadata.len() },
            });
            if is_directory {
                if depth >= DIRECTORY_SYNC_MAX_DEPTH {
                    return Err(directory_tree_limit_error());
                }
                child_directories.push((source_path, relative_path, depth + 1));
            }
        }
        child_directories.sort_by(|left, right| right.1.cmp(&left.1));
        directories.extend(child_directories);
    }
    entries.sort_by(|left, right| {
        left.relative_path
            .matches('/')
            .count()
            .cmp(&right.relative_path.matches('/').count())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(entries)
}

async fn scan_remote_transfer_tree(
    directory_reader: &SftpDirectoryReader,
    root: &str,
    control: Option<&TransferControl>,
    copy_control: Option<&CopyOperationControl>,
) -> Result<Vec<RemoteTransferEntry>, AppError> {
    if root.is_empty() || root.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    let mut entries = Vec::new();
    let mut directories = vec![(root.to_owned(), String::new(), 0_usize)];

    while let Some((directory_path, relative_parent, depth)) = directories.pop() {
        if let Some(control) = control {
            control.wait_until_running().await?;
        }
        if let Some(copy_control) = copy_control {
            copy_control.check_cancelled()?;
        }
        let remaining = DIRECTORY_SYNC_MAX_ENTRIES.saturating_sub(entries.len());
        let listed = if let Some(control) = control {
            directory_reader
                .read_dir_limited(&directory_path, remaining, control.cancellation.cancelled())
                .await
                .map_err(map_transfer_directory_read_error)?
        } else if let Some(copy_control) = copy_control {
            directory_reader
                .read_dir_limited(
                    &directory_path,
                    remaining,
                    copy_control.cancellation_token().cancelled(),
                )
                .await
                .map_err(map_transfer_directory_read_error)?
        } else {
            directory_reader
                .read_dir_limited(&directory_path, remaining, std::future::pending::<()>())
                .await
                .map_err(map_transfer_directory_read_error)?
        };
        let mut child_directories = Vec::new();
        for entry in listed {
            if let Some(control) = control {
                control.wait_until_running().await?;
                if control.cancellation.is_cancelled() {
                    return Err(transfer_cancelled_error());
                }
            }
            if let Some(copy_control) = copy_control {
                copy_control.check_cancelled()?;
            }
            let name = entry.name;
            if name == "." || name == ".." {
                continue;
            }
            if !valid_directory_sync_segment(&name) {
                return Err(directory_tree_unsupported_error());
            }
            let relative_path = join_relative_sync_path(&relative_parent, &name);
            if relative_path.len() > 4_096 || entries.len() >= DIRECTORY_SYNC_MAX_ENTRIES {
                return Err(directory_tree_limit_error());
            }
            let remote_path = join_remote_directory_path(&directory_path, &name);
            if remote_path.len() > 4_096 {
                return Err(directory_tree_limit_error());
            }
            let metadata = entry.attributes;
            let is_directory = metadata.is_dir();
            if metadata.is_symlink() || (!is_directory && !metadata.is_regular()) {
                return Err(directory_tree_unsupported_error());
            }
            entries.push(RemoteTransferEntry {
                remote_path: remote_path.clone(),
                relative_path: relative_path.clone(),
                is_directory,
                size: if is_directory { Some(0) } else { metadata.size },
                permissions: metadata.permissions,
            });
            if is_directory {
                if depth >= DIRECTORY_SYNC_MAX_DEPTH {
                    return Err(directory_tree_limit_error());
                }
                child_directories.push((remote_path, relative_path, depth + 1));
            }
        }
        child_directories.sort_by(|left, right| right.1.cmp(&left.1));
        directories.extend(child_directories);
    }
    entries.sort_by(|left, right| {
        left.relative_path
            .matches('/')
            .count()
            .cmp(&right.relative_path.matches('/').count())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(entries)
}

fn map_transfer_directory_read_error(error: SshError) -> AppError {
    match error {
        SshError::DirectoryEntryLimit => directory_tree_limit_error(),
        SshError::Cancelled => transfer_cancelled_error(),
        _ => transfer_io_error("SFTP_LIST_FAILED", "errors.sftpFailed"),
    }
}

async fn copy_stream_cancellable<R, W>(
    reader: &mut R,
    writer: &mut W,
    cancellation: &CancellationToken,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut buffer = [0_u8; 64 * 1024];
    let mut copied = 0_u64;
    loop {
        let read = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "copy cancelled"));
            }
            result = reader.read(&mut buffer) => result?,
        };
        if read == 0 {
            return Ok(copied);
        }
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "copy cancelled"));
            }
            result = writer.write_all(&buffer[..read]) => result?,
        }
        copied = copied.checked_add(read as u64).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "copy byte count overflow")
        })?;
    }
}

async fn remote_transfer_metadata(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<Option<FileAttributes>, AppError> {
    match sftp.symlink_metadata(path.to_owned()).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
        {
            Ok(None)
        }
        Err(_) => Err(transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed")),
    }
}

async fn remove_remote_tree(
    session: &ConnectedSshSession,
    sftp: &russh_sftp::client::SftpSession,
    root: &str,
) -> Result<(), AppError> {
    if root.is_empty() || root.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    let directory_reader = session
        .open_sftp_directory_reader()
        .await
        .map_err(|_| remote_copy_error())?;
    let cleanup_result = async {
        let mut pending = vec![(root.to_owned(), 0_usize, false)];
        let mut visited_entries = 0_usize;
        while let Some((path, depth, remove_directory)) = pending.pop() {
            if remove_directory {
                sftp.remove_dir(path)
                    .await
                    .map_err(|_| remote_copy_error())?;
                continue;
            }
            let Some(metadata) = remote_transfer_metadata(sftp, &path).await? else {
                continue;
            };
            if metadata.is_symlink() || metadata.is_regular() {
                sftp.remove_file(path)
                    .await
                    .map_err(|_| remote_copy_error())?;
                continue;
            }
            if !metadata.is_dir() || depth > DIRECTORY_SYNC_MAX_DEPTH {
                return Err(directory_tree_limit_error());
            }
            if let Some(permissions) = metadata.permissions {
                let mut attributes = FileAttributes::empty();
                attributes.permissions = Some(permissions | 0o700);
                let _ = sftp.set_metadata(path.clone(), attributes).await;
            }
            let remaining = DIRECTORY_SYNC_MAX_ENTRIES.saturating_sub(visited_entries);
            let entries = directory_reader
                .read_dir_limited(&path, remaining, std::future::pending::<()>())
                .await
                .map_err(map_transfer_directory_read_error)?;
            pending.push((path.clone(), depth, true));
            for entry in entries {
                let name = entry.name;
                if !valid_directory_sync_segment(&name) {
                    return Err(directory_tree_unsupported_error());
                }
                visited_entries = visited_entries.saturating_add(1);
                if visited_entries > DIRECTORY_SYNC_MAX_ENTRIES {
                    return Err(directory_tree_limit_error());
                }
                let child_path = join_remote_directory_path(&path, &name);
                if child_path.len() > 4_096 {
                    return Err(directory_tree_limit_error());
                }
                pending.push((child_path, depth + 1, false));
            }
        }
        Ok(())
    }
    .await;
    let close_result = directory_reader.close();
    cleanup_result?;
    close_result.map_err(|_| remote_copy_error())?;
    Ok(())
}

async fn canonical_remote_transfer_target(
    sftp: &russh_sftp::client::SftpSession,
    requested_path: &str,
) -> Result<String, AppError> {
    if requested_path.is_empty() || requested_path.len() > 4_096 || requested_path.contains('\0') {
        return Err(invalid_remote_path_error());
    }
    let (requested_parent, name) = split_remote_parent(requested_path)?;
    if !valid_directory_sync_segment(name) {
        return Err(invalid_remote_path_error());
    }
    let parent = sftp
        .canonicalize(requested_parent.to_owned())
        .await
        .map_err(|_| invalid_remote_path_error())?;
    let metadata = sftp
        .metadata(parent.clone())
        .await
        .map_err(|_| invalid_remote_path_error())?;
    if !metadata.is_dir() {
        return Err(invalid_remote_path_error());
    }
    let target = join_remote_directory_path(&parent, name);
    if target.len() > 4_096 {
        return Err(directory_tree_limit_error());
    }
    Ok(target)
}

async fn local_transfer_metadata(
    path: &std::path::Path,
) -> Result<Option<std::fs::Metadata>, AppError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(transfer_io_error(
            "LOCAL_PATH_INVALID",
            "errors.localPathInvalid",
        )),
    }
}

async fn remove_local_transfer_tree(root: &std::path::Path) -> Result<(), AppError> {
    let mut pending = vec![(root.to_path_buf(), 0_usize, false)];
    let mut visited_entries = 0_usize;
    while let Some((path, depth, remove_directory)) = pending.pop() {
        if remove_directory {
            tokio::fs::remove_dir(&path).await.map_err(|_| {
                transfer_io_error("LOCAL_FILE_WRITE_FAILED", "errors.localFileWriteFailed")
            })?;
            continue;
        }
        let metadata = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(transfer_io_error(
                    "LOCAL_PATH_INVALID",
                    "errors.localPathInvalid",
                ));
            }
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() || file_type.is_file() {
            tokio::fs::remove_file(&path).await.map_err(|_| {
                transfer_io_error("LOCAL_FILE_WRITE_FAILED", "errors.localFileWriteFailed")
            })?;
        } else if file_type.is_dir() {
            if depth > DIRECTORY_SYNC_MAX_DEPTH {
                return Err(directory_tree_limit_error());
            }
            let mut directory = tokio::fs::read_dir(&path).await.map_err(|_| {
                transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileWriteFailed")
            })?;
            pending.push((path, depth, true));
            while let Some(entry) = directory.next_entry().await.map_err(|_| {
                transfer_io_error("LOCAL_DIRECTORY_FAILED", "errors.localFileWriteFailed")
            })? {
                visited_entries = visited_entries.saturating_add(1);
                if visited_entries > DIRECTORY_SYNC_MAX_ENTRIES {
                    return Err(directory_tree_limit_error());
                }
                pending.push((entry.path(), depth + 1, false));
            }
        } else {
            return Err(directory_tree_unsupported_error());
        }
    }
    Ok(())
}

fn remote_transfer_child_path(root: &str, relative_path: &str) -> String {
    if relative_path.is_empty() {
        root.to_owned()
    } else {
        join_remote_directory_path(root, relative_path)
    }
}

fn local_transfer_child_path(root: &std::path::Path, relative_path: &str) -> PathBuf {
    root.join(relative_path)
}

async fn copy_transfer_stream<R, W>(
    reader: &mut R,
    writer: &mut W,
    control: &TransferControl,
    on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    base_bytes: u64,
) -> Result<u64, AppError>
where
    R: AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    const BUFFER_BYTES: usize = 64 * 1024;
    const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

    let mut buffer = vec![0_u8; BUFFER_BYTES];
    let mut copied = 0_u64;
    let mut reported_bytes = base_bytes;
    let mut last_reported_at = Instant::now();

    loop {
        control.wait_until_running().await?;
        let read = tokio::select! {
            result = reader.read(&mut buffer) => result
                .map_err(|_| transfer_io_error("TRANSFER_STREAM_FAILED", "errors.transferStreamFailed"))?,
            () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
        };
        if read == 0 {
            break;
        }

        control.wait_until_running().await?;
        tokio::select! {
            result = writer.write_all(&buffer[..read]) => result
                .map_err(|_| transfer_io_error("TRANSFER_STREAM_FAILED", "errors.transferStreamFailed"))?,
            () = control.cancellation.cancelled() => return Err(transfer_cancelled_error()),
        }

        copied = copied.saturating_add(read as u64);
        let aggregate = base_bytes.saturating_add(copied);
        control
            .bytes_transferred
            .store(aggregate, Ordering::Release);
        if last_reported_at.elapsed() >= PROGRESS_INTERVAL {
            on_progress(aggregate, None);
            reported_bytes = aggregate;
            last_reported_at = Instant::now();
        }
    }

    let aggregate = base_bytes.saturating_add(copied);
    if aggregate != reported_bytes {
        control
            .bytes_transferred
            .store(aggregate, Ordering::Release);
        on_progress(aggregate, None);
    }
    Ok(copied)
}

async fn unique_remote_path(
    sftp: &russh_sftp::client::SftpSession,
    original: &str,
) -> Result<String, AppError> {
    for suffix in 1..=1000 {
        let candidate = format!("{original}.copy-{suffix}");
        let exists = sftp
            .try_exists(candidate.clone())
            .await
            .map_err(|_| transfer_io_error("SFTP_STAT_FAILED", "errors.sftpFailed"))?;
        if !exists {
            return Ok(candidate);
        }
    }
    Err(transfer_io_error(
        "TRANSFER_RENAME_EXHAUSTED",
        "errors.transferConflict",
    ))
}

async fn unique_local_path(original: &std::path::Path) -> Result<std::path::PathBuf, AppError> {
    for suffix in 1..=1000 {
        let candidate = original.with_extension(format!(
            "{}.copy-{suffix}",
            original
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        ));
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return Ok(candidate);
        }
    }
    Err(transfer_io_error(
        "TRANSFER_RENAME_EXHAUSTED",
        "errors.transferConflict",
    ))
}

fn directory_tree_limit_error() -> AppError {
    AppError {
        code: "DIRECTORY_TREE_LIMIT_EXCEEDED".to_owned(),
        message_key: "errors.directoryTreeLimit".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("path".to_owned()),
    }
}

fn directory_tree_unsupported_error() -> AppError {
    AppError {
        code: "DIRECTORY_TREE_UNSUPPORTED".to_owned(),
        message_key: "errors.directoryTreeUnsupported".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unknown,
        field: Some("path".to_owned()),
    }
}

fn transfer_conflict_error() -> AppError {
    transfer_io_error("TRANSFER_CONFLICT", "errors.transferConflict")
}

fn transfer_cancelled_error() -> AppError {
    AppError {
        code: "TRANSFER_CANCELLED".to_owned(),
        message_key: "errors.transferCancelled".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn copy_commit_in_progress_error() -> AppError {
    AppError {
        code: "FILE_COPY_COMMIT_IN_PROGRESS".to_owned(),
        message_key: "errors.fileCopyCommitInProgress".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

fn transfer_control_transition_error() -> AppError {
    AppError {
        code: "TRANSFER_INVALID_TRANSITION".to_owned(),
        message_key: "errors.transferInvalidTransition".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn transfer_io_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::{
        AuthenticationMethod, ConnectionProfile, ConnectionState, EnvironmentKind,
    };

    use super::{
        SessionRuntime, parse_linux_network_output, parse_posix_process_output,
        permission_scope_matches, validate_remote_permission_input,
    };

    fn hex(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn profile(
        authentication_method: AuthenticationMethod,
        proxy_jump: Option<&str>,
    ) -> ConnectionProfile {
        let identity_file = if authentication_method == AuthenticationMethod::PrivateKey {
            Some("fixture-private-key".to_owned())
        } else {
            None
        };
        ConnectionProfile {
            id: "profile-1".to_owned(),
            name: "test-host".to_owned(),
            group: "test".to_owned(),
            host: "example.com".to_owned(),
            port: 22,
            username: "operator".to_owned(),
            environment: EnvironmentKind::Development,
            favorite: false,
            tags: Vec::new(),
            authentication_method,
            identity_file,
            proxy_jump: proxy_jump.map(str::to_owned),
            proxy_jump_profile_ids: Vec::new(),
            credential_ref: None,
            state: ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
        }
    }

    #[test]
    fn allows_password_profiles_without_a_jump_host() {
        let profile = profile(AuthenticationMethod::Password, None);

        assert!(SessionRuntime::validate_profile_support(&profile).is_ok());
    }

    #[test]
    fn allows_private_key_and_agent_authentication() {
        let private_key = profile(AuthenticationMethod::PrivateKey, None);
        assert!(SessionRuntime::validate_profile_support(&private_key).is_ok());

        let agent = profile(AuthenticationMethod::Agent, None);
        assert!(SessionRuntime::validate_profile_support(&agent).is_ok());

        let mut missing_key = private_key;
        missing_key.identity_file = None;
        let path_error = SessionRuntime::validate_profile_support(&missing_key)
            .expect_err("private-key profiles require an identity file");
        assert_eq!(path_error.code, "SSH_PRIVATE_KEY_PATH_REQUIRED");

        let jump_host = profile(AuthenticationMethod::Password, Some("bastion.internal"));
        let jump_error = SessionRuntime::validate_profile_support(&jump_host)
            .expect_err("unmapped ProxyJump must not fall back to a direct connection");
        assert_eq!(jump_error.code, "SSH_PROXY_JUMP_MAPPING_REQUIRED");
    }

    #[test]
    fn permission_scope_distinguishes_files_and_directories() {
        use filex_contracts::RemotePermissionScope;

        assert!(permission_scope_matches(
            &RemotePermissionScope::All,
            false,
            true,
        ));
        assert!(permission_scope_matches(
            &RemotePermissionScope::All,
            true,
            false,
        ));
        assert!(!permission_scope_matches(
            &RemotePermissionScope::Files,
            true,
            false,
        ));
        assert!(!permission_scope_matches(
            &RemotePermissionScope::Directories,
            false,
            true,
        ));
    }

    #[test]
    fn recursive_permission_input_rejects_unsafe_paths_and_modes() {
        use filex_contracts::{RemotePermissionScope, UpdateRemotePermissionsInput};

        let mut input = UpdateRemotePermissionsInput {
            path: "/srv/app".to_owned(),
            mode: 0o750,
            recursive: true,
            scope: RemotePermissionScope::Files,
        };
        assert!(validate_remote_permission_input(&input).is_ok());
        input.path = "/srv/../etc".to_owned();
        assert!(validate_remote_permission_input(&input).is_err());
        input.path = "/srv/app".to_owned();
        input.mode = 0o10000;
        assert!(validate_remote_permission_input(&input).is_err());
    }

    #[test]
    fn parses_safe_process_detail_metadata() {
        let output = format!(
            "PLATFORM=POSIX\nP\t42\t1\t{}\t12.5\t00:01:02\t2048\tS\t{}\t120\t{}\n",
            hex("root"),
            hex("Mon Nov 10 10:00:00 2026"),
            hex("sshd"),
        );

        let parsed = parse_posix_process_output(&output, 1_700_000_000_000)
            .expect("process fixture should parse");
        assert_eq!(parsed.processes.len(), 1);
        let process = &parsed.processes[0];
        assert_eq!(process.pid, 42);
        assert_eq!(process.parent_pid, Some(1));
        assert_eq!(process.user.as_deref(), Some("root"));
        assert_eq!(process.name, "sshd");
        assert_eq!(process.memory_bytes, Some(2 * 1024 * 1024));
        assert_eq!(process.started_at_ms, Some(1_699_999_880_000));
        assert!(process.can_terminate);
    }

    #[test]
    fn parses_bounded_linux_interfaces_endpoints_and_routes() {
        let output = format!(
            "PLATFORM=LINUX\nI\t{}\t{}\t{}\t1500\t1000\t2000\t0\nE\t{}\t{}\t{}\t{}\t{}\nT\t{}\t{}\t{}\t100\t{}\n",
            hex("eth0"),
            hex("up"),
            hex("10.0.0.2/24,fe80::1/64"),
            hex("tcp"),
            hex("LISTEN"),
            hex("0.0.0.0:22"),
            hex("*:*"),
            hex("users:((\"sshd\",pid=123,fd=3))"),
            hex("default"),
            hex("10.0.0.1"),
            hex("eth0"),
            hex("dhcp"),
        );

        let snapshot =
            parse_linux_network_output(&output, 1234).expect("network fixture should parse");
        assert_eq!(snapshot.interfaces[0].name, "eth0");
        assert_eq!(snapshot.interfaces[0].addresses.len(), 2);
        assert_eq!(snapshot.endpoints[0].local_port, Some(22));
        assert_eq!(snapshot.endpoints[0].pid, Some(123));
        assert_eq!(snapshot.endpoints[0].process_name.as_deref(), Some("sshd"));
        assert_eq!(snapshot.routes[0].destination, "default");
        assert_eq!(snapshot.routes[0].gateway.as_deref(), Some("10.0.0.1"));
    }
}
