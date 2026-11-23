use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

use filex_contracts::{
    AppError, AuthenticationMethod, ConnectionProfile, ConnectionState, EnvironmentKind,
    ExternalLaunchEvent, ExternalLaunchRequest, RemoteState,
};
use filex_core::{CliLaunchOutcome, CliLaunchProtocol, ParsedCliLaunch, parse_cli_launch_args};
use zeroize::Zeroizing;

pub(crate) const EXTERNAL_LAUNCH_EVENT_NAME: &str = "external-launch";
const MAX_PENDING_LAUNCHES: usize = 16;
const LAUNCH_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct PendingLaunchQueue {
    ready: bool,
    events: VecDeque<ExternalLaunchEvent>,
}

struct StoredExternalLaunch {
    request: ExternalLaunchRequest,
    preset_password: Option<Zeroizing<String>>,
    created_at: Instant,
}

#[derive(Default)]
pub(crate) struct ExternalLaunchRuntime {
    queue: Mutex<PendingLaunchQueue>,
    launches: Mutex<HashMap<String, StoredExternalLaunch>>,
}

impl ExternalLaunchRuntime {
    pub(crate) fn ingest_args(
        &self,
        args: &[String],
        cwd: Option<&Path>,
    ) -> Option<ExternalLaunchEvent> {
        let outcome = parse_cli_launch_args(args, cwd);
        self.ingest_outcome(outcome)
    }

    fn ingest_outcome(&self, outcome: CliLaunchOutcome) -> Option<ExternalLaunchEvent> {
        let event = match outcome {
            CliLaunchOutcome::None => return None,
            CliLaunchOutcome::Error(error) => ExternalLaunchEvent::Error { error },
            CliLaunchOutcome::Launch(parsed) => {
                let request = self.store_launch(parsed);
                ExternalLaunchEvent::Launch { request }
            }
        };

        let Ok(mut queue) = self.queue.lock() else {
            return None;
        };
        if queue.ready {
            return Some(event);
        }
        while queue.events.len() >= MAX_PENDING_LAUNCHES {
            if let Some(ExternalLaunchEvent::Launch { request }) = queue.events.pop_front() {
                self.discard(&request.launch_id);
            }
        }
        queue.events.push_back(event);
        None
    }

    fn store_launch(&self, parsed: ParsedCliLaunch) -> ExternalLaunchRequest {
        let launch_id = uuid::Uuid::new_v4().to_string();
        let has_preset_password = parsed.password.is_some();
        let authentication_method = if parsed.identity_file.is_some() {
            AuthenticationMethod::PrivateKey
        } else {
            AuthenticationMethod::Password
        };
        let request = ExternalLaunchRequest {
            launch_id: launch_id.clone(),
            host: parsed.host,
            port: parsed.port,
            username: parsed.username.unwrap_or_default(),
            display_name: parsed.display_name,
            authentication_method,
            identity_file: parsed.identity_file,
            has_preset_password,
            open_sftp: parsed.protocol == CliLaunchProtocol::Sftp,
        };
        let preset_password = parsed.password.map(Zeroizing::new);
        if let Ok(mut launches) = self.launches.lock() {
            prune_expired_launches(&mut launches);
            while launches.len() >= MAX_PENDING_LAUNCHES {
                if let Some(oldest_key) = launches
                    .iter()
                    .min_by_key(|(_, entry)| entry.created_at)
                    .map(|(key, _)| key.clone())
                {
                    launches.remove(&oldest_key);
                } else {
                    break;
                }
            }
            launches.insert(
                launch_id,
                StoredExternalLaunch {
                    request: request.clone(),
                    preset_password,
                    created_at: Instant::now(),
                },
            );
        }
        request
    }

    pub(crate) fn drain_pending(&self) -> Vec<ExternalLaunchEvent> {
        let Ok(mut queue) = self.queue.lock() else {
            return Vec::new();
        };
        queue.ready = true;
        queue.events.drain(..).collect()
    }

    fn take(&self, launch_id: &str) -> Result<StoredExternalLaunch, AppError> {
        let mut launches = self
            .launches
            .lock()
            .map_err(|_| external_launch_expired_error())?;
        prune_expired_launches(&mut launches);
        launches
            .remove(launch_id)
            .ok_or_else(external_launch_expired_error)
    }

    pub(crate) fn discard(&self, launch_id: &str) {
        if let Ok(mut launches) = self.launches.lock() {
            launches.remove(launch_id);
        }
    }

    pub(crate) fn clear_all(&self) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.events.clear();
        }
        if let Ok(mut launches) = self.launches.lock() {
            launches.clear();
        }
    }
}

fn prune_expired_launches(launches: &mut HashMap<String, StoredExternalLaunch>) {
    launches.retain(|_, entry| entry.created_at.elapsed() < LAUNCH_TTL);
}

fn external_launch_profile(request: &ExternalLaunchRequest) -> Result<ConnectionProfile, AppError> {
    let host = request.host.trim().to_owned();
    let username = request.username.trim().to_owned();
    if host.is_empty() || request.port == 0 || username.is_empty() {
        return Err(external_launch_invalid_error());
    }
    let name = request
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| value.chars().count() >= 2)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{username}@{host}"));
    Ok(ConnectionProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        group: String::new(),
        host,
        port: request.port,
        username,
        environment: EnvironmentKind::Development,
        favorite: false,
        tags: Vec::new(),
        authentication_method: request.authentication_method.clone(),
        identity_file: request.identity_file.clone(),
        key_id: None,
        proxy_jump: None,
        proxy_jump_profile_ids: Vec::new(),
        proxy_profile_id: None,
        credential_ref: None,
        state: ConnectionState::Idle,
        latency_ms: None,
        last_used_at: None,
    })
}

fn external_launch_expired_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_EXPIRED".to_owned(),
        message_key: "errors.cliLaunchExpired".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn external_launch_invalid_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_INVALID_TARGET".to_owned(),
        message_key: "errors.cliLaunchInvalidTarget".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

pub(crate) mod commands {
    use filex_contracts::{
        AuthenticationMethod, ExternalLaunchEvent, HostKeyChallenge, OperationResult,
        SessionConnectionProgress,
    };
    use filex_core::{HostTrustService, SettingsService};
    use tauri::State;
    use zeroize::Zeroizing;

    use super::{ExternalLaunchRuntime, external_launch_profile};
    use crate::session_runtime::SessionRuntime;

    #[tauri::command]
    pub(crate) fn drain_external_launch_events(
        launches: State<'_, ExternalLaunchRuntime>,
    ) -> OperationResult<Vec<ExternalLaunchEvent>> {
        OperationResult::success(launches.drain_pending())
    }

    #[tauri::command]
    pub(crate) fn discard_external_launch(
        launch_id: String,
        launches: State<'_, ExternalLaunchRuntime>,
    ) -> OperationResult<()> {
        launches.discard(&launch_id);
        OperationResult::success(())
    }

    #[tauri::command]
    pub(crate) async fn probe_external_launch_host_key(
        launch_id: String,
        launches: State<'_, ExternalLaunchRuntime>,
        trust: State<'_, HostTrustService>,
        settings: State<'_, SettingsService>,
        sessions: State<'_, SessionRuntime>,
    ) -> Result<OperationResult<HostKeyChallenge>, ()> {
        if let Ok(settings) = settings.load() {
            let _ = sessions.configure_ssh(
                settings.connection_timeout_seconds,
                settings.keepalive_seconds,
            );
        }
        let stored = match launches.take(&launch_id) {
            Ok(stored) => stored,
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        let profile = match external_launch_profile(&stored.request) {
            Ok(profile) => profile,
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        match sessions.probe_external_route(&profile, &trust).await {
            Ok(challenge) => {
                let session_id = challenge.session.id.clone();
                if let Err(error) = sessions.bind_quick_profile(&session_id, profile) {
                    let _ = sessions.cancel_attempt(&session_id).await;
                    return Ok(OperationResult::failure(error));
                }
                if let Some(secret) = stored.preset_password
                    && let Err(error) = sessions.bind_quick_secret(&session_id, secret)
                {
                    let _ = sessions.cancel_attempt(&session_id).await;
                    return Ok(OperationResult::failure(error));
                }
                Ok(OperationResult::success(challenge))
            }
            Err(error) => Ok(OperationResult::failure(error)),
        }
    }

    #[tauri::command]
    pub(crate) async fn connect_external_launch_session(
        app: tauri::AppHandle,
        session_id: String,
        passphrase: Option<String>,
        sessions: State<'_, SessionRuntime>,
        trust: State<'_, HostTrustService>,
        settings: State<'_, SettingsService>,
    ) -> Result<OperationResult<SessionConnectionProgress>, ()> {
        if let Ok(settings) = settings.load() {
            let _ = sessions.configure_ssh(
                settings.connection_timeout_seconds,
                settings.keepalive_seconds,
            );
        }
        let profile = match sessions.quick_profile(&session_id) {
            Ok(Some(profile)) => profile,
            Ok(None) => return Ok(OperationResult::failure(crate::session_not_found_error())),
            Err(error) => return Ok(OperationResult::failure(error)),
        };
        let route = vec![profile.clone()];
        if let Err(error) = sessions
            .ensure_current_route_trusted(&session_id, &route, &trust)
            .await
        {
            return Ok(OperationResult::failure(error));
        }

        let result = match profile.authentication_method {
            AuthenticationMethod::Password => {
                let secret = match sessions.take_quick_secret(&session_id) {
                    Ok(Some(secret)) => secret,
                    Ok(None) => {
                        let error = crate::credential_error("CREDENTIAL_NOT_CONFIGURED", false);
                        return Ok(OperationResult::failure(error));
                    }
                    Err(error) => return Ok(OperationResult::failure(error)),
                };
                sessions
                    .connect_route_password(
                        &session_id,
                        &route,
                        &profile,
                        secret.as_str(),
                        None,
                        &trust,
                    )
                    .await
            }
            AuthenticationMethod::PrivateKey => {
                let passphrase = passphrase.map(Zeroizing::new);
                if passphrase
                    .as_ref()
                    .is_some_and(|secret| secret.len() > crate::PRIVATE_KEY_PASSPHRASE_MAX_BYTES)
                {
                    let error = crate::private_key_passphrase_size_error();
                    return Ok(OperationResult::failure(error));
                }
                sessions
                    .connect_route_private_key(
                        &session_id,
                        &route,
                        &profile,
                        passphrase.as_deref().map(String::as_str),
                        None,
                        &trust,
                    )
                    .await
            }
            AuthenticationMethod::Agent => {
                let error = crate::authentication_method_mismatch_error();
                return Ok(OperationResult::failure(error));
            }
        };

        match result {
            Ok((progress, output)) => {
                if let Some(output) = output {
                    crate::spawn_terminal_output(app, session_id, output);
                }
                Ok(OperationResult::success(progress))
            }
            Err(error) => Ok(OperationResult::failure(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use filex_contracts::ExternalLaunchEvent;

    use super::ExternalLaunchRuntime;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn queues_cold_start_and_emits_after_ready_without_leaking_password() {
        let runtime = ExternalLaunchRuntime::default();
        let cold = runtime.ingest_args(
            &args(&[
                "filex-desktop.exe",
                "-newtab",
                "天玥网关",
                "-url",
                "ssh://ops:one-time-secret@10.0.0.10:5107",
            ]),
            None,
        );
        assert!(cold.is_none());

        let drained = runtime.drain_pending();
        assert_eq!(drained.len(), 1);
        let serialized = serde_json::to_string(&drained).expect("serialize launch event");
        assert!(!serialized.contains("one-time-secret"));

        let ExternalLaunchEvent::Launch { request } = &drained[0] else {
            panic!("expected launch event");
        };
        assert_eq!(request.host, "10.0.0.10");
        assert_eq!(request.port, 5107);
        assert_eq!(request.username, "ops");
        assert_eq!(request.display_name.as_deref(), Some("天玥网关"));
        assert!(request.has_preset_password);

        let stored = runtime
            .take(&request.launch_id)
            .expect("take stored launch");
        assert_eq!(
            stored.preset_password.as_deref().map(String::as_str),
            Some("one-time-secret")
        );
        assert!(runtime.take(&request.launch_id).is_err());

        let warm = runtime
            .ingest_args(
                &args(&["filex-desktop.exe", "-url", "ssh://admin@10.0.0.11:22"]),
                None,
            )
            .expect("warm launch returns event directly");
        let ExternalLaunchEvent::Launch { request: warm_req } = warm else {
            panic!("expected warm launch event");
        };
        assert!(!warm_req.has_preset_password);
        runtime.clear_all();
        assert!(runtime.take(&warm_req.launch_id).is_err());
    }
}
