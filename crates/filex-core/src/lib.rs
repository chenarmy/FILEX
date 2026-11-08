use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use filex_contracts::{
    AppError, AuthenticationMethod, ConnectionProfile, ConnectionProfilesExport, ConnectionState,
    CreateConnectionProfileInput, CreateTransferInput, CreateTunnelRuleInput, DiskMount,
    HostTrustEvaluation, HostTrustRecord, ImportKnownHostsInput, ImportKnownHostsResult,
    KeyboardShortcuts, MonitorState, PortableConnectionProfile, PortableConnectionRouteHop,
    RecordHostTrustInput, RemoteState, SafeSettings, SessionState, SessionSummary,
    SshConfigImportCandidate, SystemMonitorSnapshot, TransferState, TransferTask, TunnelKind,
    TunnelRule, UpdateConnectionProfileInput, UpdateTunnelRuleInput,
};

pub const PORTABLE_PROFILE_EXPORT_MAX_PROFILES: usize = 10_000;

pub trait SettingsRepository: Send + Sync {
    fn load(&self) -> Result<Option<SafeSettings>, AppError>;
    fn save(&self, settings: &SafeSettings) -> Result<(), AppError>;
}

pub struct SettingsService {
    repository: Arc<dyn SettingsRepository>,
}

const LEGACY_UI_FONT_FAMILY: &str = "Inter, system-ui, sans-serif";
pub const DEFAULT_UI_FONT_FAMILY: &str = "\"HarmonyOS Sans SC\", \"HarmonyOS Sans\", \"PingFang SC\", \"Microsoft YaHei UI\", \"Noto Sans CJK SC\", sans-serif";

impl SettingsService {
    pub fn new(repository: Arc<dyn SettingsRepository>) -> Self {
        Self { repository }
    }

    pub fn load(&self) -> Result<SafeSettings, AppError> {
        let Some(mut settings) = self.repository.load()? else {
            return Ok(default_safe_settings());
        };
        let mut migrated = false;
        if settings.ui_font_family == LEGACY_UI_FONT_FAMILY {
            settings.ui_font_family = DEFAULT_UI_FONT_FAMILY.to_owned();
            migrated = true;
        }
        match settings.terminal_theme.as_str() {
            "dark" => {
                settings.terminal_theme = "filex-dark".to_owned();
                migrated = true;
            }
            "light" => {
                settings.terminal_theme = "filex-light".to_owned();
                migrated = true;
            }
            _ => {}
        }
        if migrated {
            self.repository.save(&settings)?;
        }
        Ok(settings)
    }

    pub fn save(&self, settings: SafeSettings) -> Result<SafeSettings, AppError> {
        validate_safe_settings(&settings)?;
        self.repository.save(&settings)?;
        Ok(settings)
    }
}

pub fn default_safe_settings() -> SafeSettings {
    SafeSettings {
        theme: "system".to_owned(),
        locale: "zh-CN".to_owned(),
        ui_font_family: DEFAULT_UI_FONT_FAMILY.to_owned(),
        ui_font_size: 14,
        terminal_font_family: "JetBrains Mono, Consolas, monospace".to_owned(),
        terminal_font_size: 13,
        terminal_theme: "match".to_owned(),
        terminal_encoding: "utf-8".to_owned(),
        terminal_scrollback: 10_000,
        paste_protection: true,
        connection_timeout_seconds: 15,
        keepalive_seconds: 30,
        reconnect_attempts: 3,
        monitor_interval_seconds: 30,
        reduce_motion: false,
        inspector_tab: "files".to_owned(),
        dual_pane_sftp: false,
        task_tab: "transfers".to_owned(),
        task_drawer_open: true,
        connections_pane_width: 244,
        inspector_pane_width: 286,
        assistant_pane_width: 360,
        task_drawer_height: 156,
        host_panel_open: true,
        file_browser_open: true,
        follow_terminal_cwd: false,
        focus_mode: false,
        details_pane_open: false,
        host_panel_width: 280,
        file_browser_height: 260,
        terminal_logging: false,
        backup_schedule: "daily".to_owned(),
        update_channel: "stable".to_owned(),
        shortcuts: KeyboardShortcuts::default(),
    }
}

fn validate_safe_settings(settings: &SafeSettings) -> Result<(), AppError> {
    let valid = ["system", "dark", "light"].contains(&settings.theme.as_str())
        && ["zh-CN", "en-US"].contains(&settings.locale.as_str())
        && (11..=20).contains(&settings.ui_font_size)
        && (11..=24).contains(&settings.terminal_font_size)
        && [
            "match",
            "filex-dark",
            "one-dark",
            "dracula",
            "nord",
            "tokyo-night",
            "gruvbox-dark",
            "solarized-dark",
            "monokai",
            "github-dark",
            "filex-light",
            "solarized-light",
            "github-light",
            "catppuccin-latte",
            "dark",
            "light",
        ]
        .contains(&settings.terminal_theme.as_str())
        && ["utf-8", "gbk", "big5", "shift_jis", "windows-1252"]
            .contains(&settings.terminal_encoding.as_str())
        && [5_000, 10_000, 25_000].contains(&settings.terminal_scrollback)
        && [10, 15, 30, 60].contains(&settings.connection_timeout_seconds)
        && [0, 15, 30, 60].contains(&settings.keepalive_seconds)
        && settings.reconnect_attempts <= 5
        && [15, 30, 60].contains(&settings.monitor_interval_seconds)
        && ["files", "monitor", "session"].contains(&settings.inspector_tab.as_str())
        && ["transfers", "tunnels", "events"].contains(&settings.task_tab.as_str())
        && (180..=420).contains(&settings.connections_pane_width)
        && (220..=760).contains(&settings.inspector_pane_width)
        && (300..=520).contains(&settings.assistant_pane_width)
        && (96..=360).contains(&settings.task_drawer_height)
        && (200..=420).contains(&settings.host_panel_width)
        && (160..=480).contains(&settings.file_browser_height)
        && ["off", "daily", "weekly"].contains(&settings.backup_schedule.as_str())
        && ["stable", "beta"].contains(&settings.update_channel.as_str())
        && !settings.ui_font_family.trim().is_empty()
        && settings.ui_font_family.len() <= 160
        && !settings.terminal_font_family.trim().is_empty()
        && settings.terminal_font_family.len() <= 160
        && valid_keyboard_shortcuts(&settings.shortcuts);
    if valid {
        Ok(())
    } else {
        Err(validation_error("errors.settingsInvalid", "settings"))
    }
}

fn valid_keyboard_shortcuts(shortcuts: &KeyboardShortcuts) -> bool {
    let bindings = [
        shortcuts.quick_connect.as_str(),
        shortcuts.new_session.as_str(),
        shortcuts.close_active_tab.as_str(),
        shortcuts.next_session.as_str(),
        shortcuts.previous_session.as_str(),
        shortcuts.terminal_search.as_str(),
        shortcuts.toggle_files.as_str(),
        shortcuts.toggle_focus_mode.as_str(),
        shortcuts.toggle_task_drawer.as_str(),
        shortcuts.command_palette.as_str(),
        shortcuts.toggle_assistant.as_str(),
        shortcuts.focus_connections.as_str(),
        shortcuts.focus_terminal.as_str(),
        shortcuts.focus_inspector.as_str(),
        shortcuts.open_settings.as_str(),
        shortcuts.show_events.as_str(),
    ];
    let mut unique = HashSet::with_capacity(bindings.len());
    bindings
        .into_iter()
        .all(|binding| valid_keyboard_shortcut(binding) && unique.insert(binding))
}

fn valid_keyboard_shortcut(binding: &str) -> bool {
    if binding.is_empty() || binding.len() > 32 || !binding.is_ascii() {
        return false;
    }
    let parts = binding.split('+').collect::<Vec<_>>();
    if !(2..=4).contains(&parts.len()) || parts.first() != Some(&"mod") {
        return false;
    }
    let mut modifier_rank = 0_u8;
    for modifier in &parts[1..parts.len() - 1] {
        let next_rank = match *modifier {
            "alt" => 1,
            "shift" => 2,
            _ => return false,
        };
        if next_rank <= modifier_rank {
            return false;
        }
        modifier_rank = next_rank;
    }
    let Some(key) = parts.last().copied() else {
        return false;
    };
    let alphanumeric_key = key.len() == 1
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    let named_key = matches!(
        key,
        "comma"
            | "period"
            | "slash"
            | "backslash"
            | "space"
            | "tab"
            | "left"
            | "right"
            | "up"
            | "down"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
    );
    let function_key = key
        .strip_prefix('f')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (1..=12).contains(&number));
    if !(alphanumeric_key || named_key || function_key) {
        return false;
    }
    !matches!(
        binding,
        "mod+a"
            | "mod+c"
            | "mod+v"
            | "mod+x"
            | "mod+z"
            | "mod+q"
            | "mod+r"
            | "mod+shift+c"
            | "mod+shift+q"
            | "mod+shift+v"
    )
}

pub trait ProfileRepository: Send + Sync {
    fn list(&self) -> Result<Vec<ConnectionProfile>, AppError>;
    fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, AppError>;
    fn insert(&self, profile: &ConnectionProfile) -> Result<(), AppError>;
    fn update(&self, profile: &ConnectionProfile) -> Result<(), AppError>;
    fn delete(&self, id: &str) -> Result<bool, AppError>;
    fn set_credential_ref(&self, id: &str, credential_ref: Option<&str>) -> Result<bool, AppError>;
    fn mark_used(&self, id: &str) -> Result<bool, AppError>;
}

pub trait TransferRepository: Send + Sync {
    fn list(&self) -> Result<Vec<TransferTask>, AppError>;
    fn get(&self, id: &str) -> Result<Option<TransferTask>, AppError>;
    fn insert(&self, task: &TransferTask) -> Result<(), AppError>;
    fn update(&self, task: &TransferTask) -> Result<(), AppError>;
}

pub trait TunnelRuleRepository: Send + Sync {
    fn list_tunnel_rules(&self) -> Result<Vec<TunnelRule>, AppError>;
    fn get_tunnel_rule(&self, id: &str) -> Result<Option<TunnelRule>, AppError>;
    fn insert_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError>;
    fn update_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError>;
    fn delete_tunnel_rule(&self, id: &str) -> Result<bool, AppError>;
}

pub struct TunnelRuleService {
    repository: Arc<dyn TunnelRuleRepository>,
}

impl TunnelRuleService {
    pub fn new(repository: Arc<dyn TunnelRuleRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<TunnelRule>, AppError> {
        self.repository.list_tunnel_rules()
    }

    pub fn create(&self, input: CreateTunnelRuleInput) -> Result<TunnelRule, AppError> {
        validate_tunnel_rule(
            &input.profile_id,
            &input.name,
            &input.kind,
            &input.bind_host,
            input.bind_port,
            input.target_host.as_deref(),
            input.target_port,
            input.auto_start,
        )?;
        let rule = TunnelRule {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: input.profile_id.trim().to_owned(),
            name: input.name.trim().to_owned(),
            kind: input.kind,
            bind_host: input.bind_host.trim().to_owned(),
            bind_port: input.bind_port,
            target_host: input.target_host.map(|host| host.trim().to_owned()),
            target_port: input.target_port,
            auto_start: input.auto_start,
        };
        self.repository.insert_tunnel_rule(&rule)?;
        Ok(rule)
    }

    pub fn update(&self, input: UpdateTunnelRuleInput) -> Result<TunnelRule, AppError> {
        validate_tunnel_rule(
            &input.profile_id,
            &input.name,
            &input.kind,
            &input.bind_host,
            input.bind_port,
            input.target_host.as_deref(),
            input.target_port,
            input.auto_start,
        )?;
        if self.repository.get_tunnel_rule(&input.id)?.is_none() {
            return Err(not_found_error(
                "TUNNEL_RULE_NOT_FOUND",
                "errors.tunnelRuleNotFound",
            ));
        }
        let rule = TunnelRule {
            id: input.id,
            profile_id: input.profile_id.trim().to_owned(),
            name: input.name.trim().to_owned(),
            kind: input.kind,
            bind_host: input.bind_host.trim().to_owned(),
            bind_port: input.bind_port,
            target_host: input.target_host.map(|host| host.trim().to_owned()),
            target_port: input.target_port,
            auto_start: input.auto_start,
        };
        self.repository.update_tunnel_rule(&rule)?;
        Ok(rule)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        if self.repository.delete_tunnel_rule(id)? {
            Ok(())
        } else {
            Err(not_found_error(
                "TUNNEL_RULE_NOT_FOUND",
                "errors.tunnelRuleNotFound",
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)] // mirrors the persisted TunnelRule fields
fn validate_tunnel_rule(
    profile_id: &str,
    name: &str,
    kind: &TunnelKind,
    bind_host: &str,
    bind_port: u16,
    target_host: Option<&str>,
    target_port: Option<u16>,
    auto_start: bool,
) -> Result<(), AppError> {
    let parsed_bind = bind_host.parse::<std::net::IpAddr>().ok();
    let valid_bind = parsed_bind.is_some();
    let valid_auto_start = !auto_start
        || (!matches!(kind, TunnelKind::Remote)
            && parsed_bind.is_some_and(|address| address.is_loopback()));
    let valid_target = match kind {
        TunnelKind::Local => {
            target_host
                .is_some_and(|host| !host.trim().is_empty() && !host.contains(char::is_whitespace))
                && target_port.is_some_and(|port| port > 0)
        }
        TunnelKind::Remote => {
            target_host
                .is_some_and(|host| !host.trim().is_empty() && !host.contains(char::is_whitespace))
                && target_port.is_some_and(|port| port > 0)
        }
        TunnelKind::Dynamic => target_host.is_none() && target_port.is_none(),
    };
    if profile_id.trim().is_empty()
        || name.trim().is_empty()
        || name.chars().count() > 120
        || bind_host.len() > 64
        || (matches!(kind, TunnelKind::Remote) && bind_port == 0)
        || !valid_bind
        || !valid_auto_start
        || !valid_target
        || target_host.is_some_and(|host| host.len() > 253)
    {
        return Err(validation_error(
            "errors.tunnelValidationFailed",
            "tunnelRule",
        ));
    }
    Ok(())
}

pub struct TransferService {
    repository: Arc<dyn TransferRepository>,
}

impl TransferService {
    pub fn new(repository: Arc<dyn TransferRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<TransferTask>, AppError> {
        self.repository.list()
    }

    pub fn get(&self, id: &str) -> Result<TransferTask, AppError> {
        self.task(id)
    }

    pub fn enqueue(&self, input: CreateTransferInput) -> Result<TransferTask, AppError> {
        if input.profile_id.trim().is_empty()
            || input.local_path.trim().is_empty()
            || input.remote_path.trim().is_empty()
        {
            return Err(validation_error("transfer.pathRequired", "path"));
        }
        let now = now_ms()?;
        let task = TransferTask {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: input.profile_id,
            session_id: None,
            direction: input.direction,
            local_path: input.local_path,
            remote_path: input.remote_path,
            state: TransferState::Queued,
            bytes_transferred: 0,
            total_bytes: input.total_bytes,
            conflict_policy: input.conflict_policy,
            error: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.repository.insert(&task)?;
        Ok(task)
    }

    pub fn cancel(&self, id: &str) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if matches!(
            task.state,
            TransferState::Completed | TransferState::Cancelled
        ) {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Cancelled;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn pause(&self, id: &str, bytes_transferred: u64) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if !matches!(task.state, TransferState::Queued | TransferState::Running) {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Paused;
        task.bytes_transferred = bytes_transferred;
        task.error = None;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn resume(&self, id: &str) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if task.state != TransferState::Paused {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Running;
        task.error = None;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn retry(&self, id: &str) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if !matches!(
            task.state,
            TransferState::Failed | TransferState::Cancelled | TransferState::Paused
        ) {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Queued;
        task.bytes_transferred = 0;
        task.session_id = None;
        task.error = None;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn start(&self, id: &str, session_id: &str) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if task.state != TransferState::Queued || session_id.trim().is_empty() {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Running;
        task.session_id = Some(session_id.to_owned());
        task.error = None;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn complete(&self, id: &str, bytes_transferred: u64) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if task.state != TransferState::Running {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Completed;
        task.bytes_transferred = bytes_transferred;
        task.error = None;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn progress(&self, id: &str, bytes_transferred: u64) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if task.state != TransferState::Running || bytes_transferred < task.bytes_transferred {
            return Err(transfer_transition_error());
        }
        task.bytes_transferred = bytes_transferred;
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn set_total_bytes(&self, id: &str, total_bytes: u64) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if task.state != TransferState::Running || total_bytes < task.bytes_transferred {
            return Err(transfer_transition_error());
        }
        task.total_bytes = Some(total_bytes);
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn fail(&self, id: &str, error: AppError) -> Result<TransferTask, AppError> {
        let mut task = self.task(id)?;
        if !matches!(task.state, TransferState::Running | TransferState::Paused) {
            return Err(transfer_transition_error());
        }
        task.state = TransferState::Failed;
        task.error = Some(error);
        task.updated_at_ms = now_ms()?;
        self.repository.update(&task)?;
        Ok(task)
    }

    pub fn recover_interrupted(&self) -> Result<Vec<TransferTask>, AppError> {
        let mut recovered = Vec::new();
        for mut task in self.repository.list()? {
            if task.state == TransferState::Running {
                task.state = TransferState::Paused;
                task.session_id = None;
                task.error = Some(AppError {
                    code: "TRANSFER_INTERRUPTED".to_owned(),
                    message_key: "errors.transferInterrupted".to_owned(),
                    retryable: true,
                    remote_state: RemoteState::Unknown,
                    field: None,
                });
                task.updated_at_ms = now_ms()?;
                self.repository.update(&task)?;
                recovered.push(task);
            }
        }
        Ok(recovered)
    }

    fn task(&self, id: &str) -> Result<TransferTask, AppError> {
        self.repository
            .get(id)?
            .ok_or_else(|| not_found_error("TRANSFER_NOT_FOUND", "errors.transferNotFound"))
    }
}

fn now_ms() -> Result<u64, AppError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| internal_error("CLOCK_UNAVAILABLE", "errors.clockUnavailable"))?
        .as_millis();
    u64::try_from(milliseconds)
        .map_err(|_| internal_error("CLOCK_UNAVAILABLE", "errors.clockUnavailable"))
}

fn transfer_transition_error() -> AppError {
    AppError {
        code: "TRANSFER_INVALID_TRANSITION".to_owned(),
        message_key: "errors.transferInvalidTransition".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

pub fn parse_monitor_probe(output: &str, collected_at_ms: u64) -> SystemMonitorSnapshot {
    let mut values = std::collections::HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim(), value.trim());
        }
    }
    let hostname = nonempty(values.get("HOST").copied());
    let os_name = nonempty(values.get("OS").copied());
    let uptime_seconds = values
        .get("UPTIME")
        .and_then(|value| value.split('.').next())
        .and_then(|value| value.parse().ok());
    let load_one = values
        .get("LOAD1")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0);
    let load_five = values
        .get("LOAD5")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0);
    let load_fifteen = values
        .get("LOAD15")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0);
    let mounts = parse_disk_mounts(output);
    let cpu_percent = parse_monitor_float(&values, "CPU_PERCENT").filter(|value| *value <= 100.0);
    let memory_total_kib = parse_u64(&values, "MEM_TOTAL");
    let memory_available_kib = parse_u64(&values, "MEM_AVAILABLE");
    let swap_total_kib = parse_u64(&values, "SWAP_TOTAL");
    let swap_used_kib = parse_u64(&values, "SWAP_USED");
    let root_total_kib = parse_u64(&values, "ROOT_TOTAL");
    let root_available_kib = parse_u64(&values, "ROOT_AVAILABLE");
    let network_receive_bytes_per_second = parse_monitor_float(&values, "NET_RX_BPS");
    let network_transmit_bytes_per_second = parse_monitor_float(&values, "NET_TX_BPS");
    let state = if uptime_seconds.is_some()
        || load_one.is_some()
        || cpu_percent.is_some()
        || memory_total_kib.is_some()
        || swap_total_kib.is_some()
        || root_total_kib.is_some()
        || !mounts.is_empty()
        || network_receive_bytes_per_second.is_some()
        || network_transmit_bytes_per_second.is_some()
    {
        MonitorState::Live
    } else {
        MonitorState::Unsupported
    };
    SystemMonitorSnapshot {
        state,
        collected_at_ms,
        hostname,
        os_name,
        uptime_seconds,
        load_one,
        load_five,
        load_fifteen,
        cpu_percent,
        memory_total_kib,
        memory_available_kib,
        swap_total_kib,
        swap_used_kib,
        root_total_kib,
        root_available_kib,
        mounts,
        network_receive_bytes_per_second,
        network_transmit_bytes_per_second,
    }
}

/// Parses bounded `MOUNT=<path>|<total_kib>|<available_kib>` probe lines into a
/// mount list capped at 12 entries. Malformed, empty, zero-size or
/// separator-containing entries are skipped instead of guessed.
pub fn parse_disk_mounts(output: &str) -> Vec<DiskMount> {
    let mut mounts = Vec::new();
    for line in output.lines() {
        if mounts.len() >= 12 {
            break;
        }
        let Some(rest) = line.trim().strip_prefix("MOUNT=") else {
            continue;
        };
        let mut parts = rest.split('|');
        let (Some(path), Some(total_kib), Some(available_kib)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if parts.next().is_some() || path.is_empty() || path.len() > 256 {
            continue;
        }
        let (Ok(total_kib), Ok(available_kib)) =
            (total_kib.parse::<u64>(), available_kib.parse::<u64>())
        else {
            continue;
        };
        if total_kib == 0 || available_kib > total_kib {
            continue;
        }
        mounts.push(DiskMount {
            path: path.to_owned(),
            total_kib,
            available_kib,
        });
    }
    mounts
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_owned)
}

fn parse_u64(values: &std::collections::HashMap<&str, &str>, key: &str) -> Option<u64> {
    values.get(key).and_then(|value| value.parse().ok())
}

fn parse_monitor_float(values: &std::collections::HashMap<&str, &str>, key: &str) -> Option<f64> {
    values
        .get(key)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 1_000_000_000_000.0)
}

pub struct ProfileService {
    repository: Arc<dyn ProfileRepository>,
}

impl ProfileService {
    pub fn new(repository: Arc<dyn ProfileRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        self.repository.list()
    }

    pub fn portable_export(
        &self,
        exported_at_ms: u64,
    ) -> Result<ConnectionProfilesExport, AppError> {
        let mut profiles = self.repository.list()?;
        if profiles.len() > PORTABLE_PROFILE_EXPORT_MAX_PROFILES {
            return Err(profile_export_limit_error());
        }
        profiles.sort_by(|left, right| {
            left.group
                .cmp(&right.group)
                .then_with(|| left.name.cmp(&right.name))
        });
        let profiles_by_id: HashMap<String, &ConnectionProfile> = profiles
            .iter()
            .map(|profile| (profile.id.clone(), profile))
            .collect();
        let mut portable_profiles = Vec::with_capacity(profiles.len());
        for profile in &profiles {
            let mut proxy_jump_route = Vec::with_capacity(profile.proxy_jump_profile_ids.len());
            for jump_profile_id in &profile.proxy_jump_profile_ids {
                let jump_profile = profiles_by_id
                    .get(jump_profile_id)
                    .ok_or_else(profile_export_route_integrity_error)?;
                proxy_jump_route.push(PortableConnectionRouteHop {
                    name: jump_profile.name.clone(),
                    host: jump_profile.host.clone(),
                    port: jump_profile.port,
                    username: jump_profile.username.clone(),
                });
            }
            portable_profiles.push(PortableConnectionProfile {
                name: profile.name.clone(),
                group: profile.group.clone(),
                host: profile.host.clone(),
                port: profile.port,
                username: profile.username.clone(),
                environment: profile.environment.clone(),
                favorite: profile.favorite,
                tags: profile.tags.clone(),
                authentication_method: profile.authentication_method.clone(),
                proxy_jump: profile.proxy_jump.clone(),
                proxy_jump_route,
            });
        }
        Ok(ConnectionProfilesExport {
            format: "filex.connection-profiles".to_owned(),
            schema_version: 2,
            exported_at_ms,
            profiles: portable_profiles,
        })
    }

    pub fn get(&self, id: &str) -> Result<ConnectionProfile, AppError> {
        self.repository
            .get(id)?
            .ok_or_else(|| not_found_error("PROFILE_NOT_FOUND", "errors.profileNotFound"))
    }

    pub fn create(
        &self,
        input: CreateConnectionProfileInput,
    ) -> Result<ConnectionProfile, AppError> {
        validate_profile(&input)?;
        let existing_profiles = self.repository.list()?;
        validate_jump_profile_ids(&input.proxy_jump_profile_ids, None, &existing_profiles)?;
        let profile = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name.trim().to_owned(),
            group: normalized_group(&input.group),
            host: input.host.trim().to_owned(),
            port: input.port,
            username: input.username.trim().to_owned(),
            environment: input.environment,
            favorite: false,
            tags: normalize_tags(input.tags),
            authentication_method: input.authentication_method,
            identity_file: normalize_optional(input.identity_file),
            proxy_jump: normalize_optional(input.proxy_jump),
            proxy_jump_profile_ids: input.proxy_jump_profile_ids,
            credential_ref: None,
            state: ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
        };
        self.repository.insert(&profile)?;
        Ok(profile)
    }

    pub fn update(
        &self,
        id: &str,
        input: UpdateConnectionProfileInput,
    ) -> Result<ConnectionProfile, AppError> {
        validate_profile(&CreateConnectionProfileInput {
            name: input.name.clone(),
            group: input.group.clone(),
            host: input.host.clone(),
            port: input.port,
            username: input.username.clone(),
            environment: input.environment.clone(),
            tags: input.tags.clone(),
            authentication_method: input.authentication_method.clone(),
            identity_file: input.identity_file.clone(),
            proxy_jump: input.proxy_jump.clone(),
            proxy_jump_profile_ids: input.proxy_jump_profile_ids.clone(),
        })?;
        let existing = self
            .repository
            .get(id)?
            .ok_or_else(|| not_found_error("PROFILE_NOT_FOUND", "errors.profileNotFound"))?;
        let existing_profiles = self.repository.list()?;
        validate_jump_profile_ids(&input.proxy_jump_profile_ids, Some(id), &existing_profiles)?;
        if profile_is_used_as_jump(&existing_profiles, id)
            && (!input.proxy_jump_profile_ids.is_empty()
                || normalize_optional(input.proxy_jump.clone()).is_some())
        {
            return Err(proxy_jump_nested_profile_error());
        }
        let identity_file = normalize_optional(input.identity_file);
        let credential_context_unchanged = existing.authentication_method
            == input.authentication_method
            && (input.authentication_method != AuthenticationMethod::PrivateKey
                || existing.identity_file == identity_file);
        let updated = ConnectionProfile {
            id: existing.id,
            name: input.name.trim().to_owned(),
            group: normalized_group(&input.group),
            host: input.host.trim().to_owned(),
            port: input.port,
            username: input.username.trim().to_owned(),
            environment: input.environment,
            favorite: input.favorite,
            tags: normalize_tags(input.tags),
            authentication_method: input.authentication_method,
            identity_file,
            proxy_jump: normalize_optional(input.proxy_jump),
            proxy_jump_profile_ids: input.proxy_jump_profile_ids,
            credential_ref: credential_context_unchanged
                .then_some(existing.credential_ref)
                .flatten(),
            state: existing.state,
            latency_ms: existing.latency_ms,
            last_used_at: existing.last_used_at,
        };
        self.repository.update(&updated)?;
        Ok(updated)
    }

    pub fn duplicate(&self, id: &str) -> Result<ConnectionProfile, AppError> {
        let source = self
            .repository
            .get(id)?
            .ok_or_else(|| not_found_error("PROFILE_NOT_FOUND", "errors.profileNotFound"))?;
        let duplicate = ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: format!("{} Copy", source.name),
            favorite: false,
            state: ConnectionState::Idle,
            latency_ms: None,
            last_used_at: None,
            credential_ref: None,
            ..source
        };
        self.repository.insert(&duplicate)?;
        Ok(duplicate)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        let profiles = self.repository.list()?;
        if profile_is_used_as_jump(&profiles, id) {
            return Err(profile_used_as_jump_error());
        }
        if self.repository.delete(id)? {
            Ok(())
        } else {
            Err(not_found_error(
                "PROFILE_NOT_FOUND",
                "errors.profileNotFound",
            ))
        }
    }

    pub fn mark_used(&self, id: &str) -> Result<(), AppError> {
        if self.repository.mark_used(id)? {
            Ok(())
        } else {
            Err(not_found_error(
                "PROFILE_NOT_FOUND",
                "errors.profileNotFound",
            ))
        }
    }

    pub fn bind_credential(&self, id: &str, credential_ref: &str) -> Result<(), AppError> {
        if credential_ref.trim().is_empty() {
            return Err(validation_error(
                "credentials.invalidReference",
                "credentialRef",
            ));
        }
        if self
            .repository
            .set_credential_ref(id, Some(credential_ref))?
        {
            Ok(())
        } else {
            Err(not_found_error(
                "PROFILE_NOT_FOUND",
                "errors.profileNotFound",
            ))
        }
    }
}

#[derive(Default)]
pub struct InMemoryProfileRepository {
    profiles: RwLock<Vec<ConnectionProfile>>,
}

impl InMemoryProfileRepository {
    pub fn with_seed(profiles: Vec<ConnectionProfile>) -> Self {
        Self {
            profiles: RwLock::new(profiles),
        }
    }
}

impl ProfileRepository for InMemoryProfileRepository {
    fn list(&self) -> Result<Vec<ConnectionProfile>, AppError> {
        self.profiles
            .read()
            .map(|profiles| profiles.clone())
            .map_err(|_| {
                internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageUnavailable")
            })
    }

    fn insert(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        self.profiles
            .write()
            .map_err(|_| {
                internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
            })?
            .push(profile.clone());
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<ConnectionProfile>, AppError> {
        Ok(self
            .profiles
            .read()
            .map_err(|_| {
                internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageUnavailable")
            })?
            .iter()
            .find(|profile| profile.id == id)
            .cloned())
    }

    fn update(&self, profile: &ConnectionProfile) -> Result<(), AppError> {
        let mut profiles = self.profiles.write().map_err(|_| {
            internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
        })?;
        let Some(existing) = profiles
            .iter_mut()
            .find(|candidate| candidate.id == profile.id)
        else {
            return Err(not_found_error(
                "PROFILE_NOT_FOUND",
                "errors.profileNotFound",
            ));
        };
        *existing = profile.clone();
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<bool, AppError> {
        let mut profiles = self.profiles.write().map_err(|_| {
            internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
        })?;
        let before = profiles.len();
        profiles.retain(|profile| profile.id != id);
        Ok(profiles.len() != before)
    }

    fn set_credential_ref(&self, id: &str, credential_ref: Option<&str>) -> Result<bool, AppError> {
        let mut profiles = self.profiles.write().map_err(|_| {
            internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
        })?;
        let Some(profile) = profiles.iter_mut().find(|profile| profile.id == id) else {
            return Ok(false);
        };
        profile.credential_ref = credential_ref.map(str::to_owned);
        Ok(true)
    }

    fn mark_used(&self, id: &str) -> Result<bool, AppError> {
        let mut profiles = self.profiles.write().map_err(|_| {
            internal_error("PROFILE_STORAGE_LOCKED", "errors.profileStorageWriteFailed")
        })?;
        let Some(profile) = profiles.iter_mut().find(|profile| profile.id == id) else {
            return Ok(false);
        };
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| internal_error("CLOCK_UNAVAILABLE", "errors.clockUnavailable"))?
            .as_millis();
        profile.last_used_at = Some(timestamp.to_string());
        Ok(true)
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
    if input.authentication_method == AuthenticationMethod::PrivateKey
        && normalize_optional(input.identity_file.clone()).is_none()
    {
        return Err(validation_error(
            "profile.privateKeyPathRequired",
            "identityFile",
        ));
    }
    Ok(())
}

fn validate_jump_profile_ids(
    route: &[String],
    destination_profile_id: Option<&str>,
    profiles: &[ConnectionProfile],
) -> Result<(), AppError> {
    if route.len() > 4 {
        return Err(proxy_jump_route_error(
            "PROFILE_PROXY_JUMP_TOO_MANY_HOPS",
            "profile.proxyJumpTooManyHops",
        ));
    }

    let mut seen = HashSet::with_capacity(route.len());
    for jump_profile_id in route {
        if jump_profile_id.trim().is_empty()
            || jump_profile_id.trim() != jump_profile_id
            || destination_profile_id == Some(jump_profile_id.as_str())
            || !seen.insert(jump_profile_id.as_str())
        {
            return Err(proxy_jump_route_error(
                "PROFILE_PROXY_JUMP_ROUTE_INVALID",
                "profile.proxyJumpRouteInvalid",
            ));
        }
        let Some(jump_profile) = profiles
            .iter()
            .find(|profile| profile.id.as_str() == jump_profile_id.as_str())
        else {
            return Err(proxy_jump_route_error(
                "PROFILE_PROXY_JUMP_PROFILE_NOT_FOUND",
                "profile.proxyJumpProfileNotFound",
            ));
        };
        if !jump_profile.proxy_jump_profile_ids.is_empty()
            || jump_profile
                .proxy_jump
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(proxy_jump_nested_profile_error());
        }
    }
    Ok(())
}

fn profile_is_used_as_jump(profiles: &[ConnectionProfile], target_id: &str) -> bool {
    profiles.iter().any(|profile| {
        profile
            .proxy_jump_profile_ids
            .iter()
            .any(|jump_profile_id| jump_profile_id == target_id)
    })
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

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for tag in tags {
        let tag = tag.trim().to_owned();
        if !tag.is_empty() && !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    normalized
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn parse_ssh_config(source: &str) -> (Vec<SshConfigImportCandidate>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    let mut current: Option<SshConfigImportCandidate> = None;

    for (line_index, raw_line) in source.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((directive, value)) = split_directive(line) else {
            warnings.push(format!("line {}: malformed directive", line_index + 1));
            continue;
        };
        if directive.eq_ignore_ascii_case("host") {
            if let Some(candidate) = current.take() {
                candidates.push(candidate);
            }
            if value.contains(['*', '!', '?']) || value.split_whitespace().count() != 1 {
                warnings.push(format!(
                    "line {}: skipped pattern Host {value}",
                    line_index + 1
                ));
                current = None;
            } else {
                current = Some(SshConfigImportCandidate {
                    alias: value.to_owned(),
                    host: value.to_owned(),
                    port: 22,
                    username: String::new(),
                    identity_file: None,
                    proxy_jump: None,
                    warnings: Vec::new(),
                });
            }
            continue;
        }
        let Some(candidate) = current.as_mut() else {
            continue;
        };
        match directive.to_ascii_lowercase().as_str() {
            "hostname" => candidate.host = value.to_owned(),
            "user" => candidate.username = value.to_owned(),
            "port" => match value.parse::<u16>() {
                Ok(port) if port > 0 => candidate.port = port,
                _ => candidate.warnings.push(format!("invalid Port {value}")),
            },
            "identityfile" => candidate.identity_file = Some(value.to_owned()),
            "proxyjump" => candidate.proxy_jump = Some(value.to_owned()),
            "include" | "match" | "proxycommand" => candidate
                .warnings
                .push(format!("unsupported directive {directive}")),
            _ => {}
        }
    }
    if let Some(candidate) = current {
        candidates.push(candidate);
    }
    for candidate in &mut candidates {
        if candidate.username.is_empty() {
            candidate.warnings.push("User is missing".to_owned());
        }
    }
    (candidates, warnings)
}

fn split_directive(line: &str) -> Option<(&str, &str)> {
    if let Some((key, value)) = line.split_once('=') {
        return Some((key.trim(), value.trim()));
    }
    let index = line.find(char::is_whitespace)?;
    Some((&line[..index], line[index..].trim()))
}

pub trait HostTrustRepository: Send + Sync {
    fn list(&self) -> Result<Vec<HostTrustRecord>, AppError>;
    fn latest(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
    ) -> Result<Option<HostTrustRecord>, AppError>;
    fn insert(&self, record: &HostTrustRecord) -> Result<(), AppError>;
    fn import_many_if_current(
        &self,
        expected: &[HostTrustImportExpectation],
        records: &[HostTrustRecord],
    ) -> Result<bool, AppError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostTrustImportExpectation {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub current_fingerprint_sha256: Option<String>,
}

pub struct HostTrustService {
    repository: Arc<dyn HostTrustRepository>,
}

#[derive(Debug, Clone)]
pub struct SessionMachine {
    summary: SessionSummary,
}

impl SessionMachine {
    pub fn new(profile: &ConnectionProfile) -> Self {
        Self {
            summary: SessionSummary {
                id: uuid::Uuid::new_v4().to_string(),
                generation: 0,
                profile_id: profile.id.clone(),
                state: SessionState::Idle,
                host: profile.host.clone(),
                port: profile.port,
                username: profile.username.clone(),
                last_error: None,
            },
        }
    }

    pub fn summary(&self) -> SessionSummary {
        self.summary.clone()
    }

    pub fn start_attempt(&mut self) -> Result<SessionSummary, AppError> {
        match &self.summary.state {
            SessionState::Idle | SessionState::Disconnected | SessionState::Failed => {
                self.summary.generation += 1;
                self.summary.last_error = None;
                self.transition(SessionState::Resolving)
            }
            _ => Err(invalid_transition_error()),
        }
    }

    pub fn transition(&mut self, next: SessionState) -> Result<SessionSummary, AppError> {
        if !valid_session_transition(&self.summary.state, &next) {
            return Err(invalid_transition_error());
        }
        self.summary.state = next;
        Ok(self.summary())
    }

    pub fn fail(&mut self, error: AppError) -> SessionSummary {
        self.summary.state = SessionState::Failed;
        self.summary.last_error = Some(error);
        self.summary()
    }
}

fn valid_session_transition(current: &SessionState, next: &SessionState) -> bool {
    matches!(
        (current, next),
        (SessionState::Idle, SessionState::Resolving)
            | (SessionState::Disconnected, SessionState::Resolving)
            | (SessionState::Failed, SessionState::Resolving)
            | (SessionState::Resolving, SessionState::Connecting)
            | (SessionState::Connecting, SessionState::VerifyingHost)
            | (SessionState::VerifyingHost, SessionState::TrustRequired)
            | (
                SessionState::VerifyingHost,
                SessionState::ReadyToAuthenticate
            )
            | (
                SessionState::TrustRequired,
                SessionState::ReadyToAuthenticate
            )
            | (
                SessionState::ReadyToAuthenticate,
                SessionState::Authenticating
            )
            | (SessionState::Authenticating, SessionState::Connecting)
            | (SessionState::Authenticating, SessionState::Connected)
            | (SessionState::Connected, SessionState::Reconnecting)
            | (SessionState::Reconnecting, SessionState::Connecting)
            | (SessionState::Connected, SessionState::Disconnecting)
            | (SessionState::Reconnecting, SessionState::Disconnecting)
            | (SessionState::Disconnecting, SessionState::Disconnected)
            | (SessionState::Disconnected, SessionState::Closed)
            | (SessionState::Failed, SessionState::Closed)
            | (SessionState::Idle, SessionState::Closed)
    )
}

impl HostTrustService {
    pub fn new(repository: Arc<dyn HostTrustRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self) -> Result<Vec<HostTrustRecord>, AppError> {
        self.repository.list()
    }

    pub fn latest(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
    ) -> Result<Option<HostTrustRecord>, AppError> {
        self.repository.latest(host, port, algorithm)
    }

    pub fn evaluate(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
    ) -> Result<HostTrustEvaluation, AppError> {
        let Some(record) = self.repository.latest(host, port, algorithm)? else {
            return Ok(HostTrustEvaluation::Unknown);
        };
        if record.fingerprint_sha256 == fingerprint {
            Ok(HostTrustEvaluation::Trusted)
        } else {
            Ok(HostTrustEvaluation::Changed)
        }
    }

    pub fn record(&self, input: RecordHostTrustInput) -> Result<HostTrustRecord, AppError> {
        if input.host.trim().is_empty()
            || input.algorithm.trim().is_empty()
            || !input.fingerprint_sha256.starts_with("SHA256:")
        {
            return Err(validation_error("trust.invalidRecord", "fingerprintSha256"));
        }
        let existing =
            self.repository
                .latest(input.host.trim(), input.port, input.algorithm.trim())?;
        let previous_fingerprint_sha256 = existing.as_ref().and_then(|record| {
            (record.fingerprint_sha256 != input.fingerprint_sha256)
                .then(|| record.fingerprint_sha256.clone())
        });
        let record = HostTrustRecord {
            id: uuid::Uuid::new_v4().to_string(),
            host: input.host.trim().to_owned(),
            port: input.port,
            algorithm: input.algorithm.trim().to_owned(),
            fingerprint_sha256: input.fingerprint_sha256,
            previous_fingerprint_sha256,
            source: input.source,
            first_seen_at: existing.as_ref().map_or_else(
                || input.observed_at.clone(),
                |record| record.first_seen_at.clone(),
            ),
            last_seen_at: input.observed_at,
        };
        self.repository.insert(&record)?;
        Ok(record)
    }

    pub fn import_known_hosts(
        &self,
        input: ImportKnownHostsInput,
    ) -> Result<ImportKnownHostsResult, AppError> {
        if input.candidates.is_empty() {
            return Err(trust_import_error(
                "TRUST_IMPORT_EMPTY",
                "errors.trustImportEmpty",
            ));
        }
        if input.candidates.len() > 5_000 {
            return Err(trust_import_error(
                "TRUST_IMPORT_TOO_MANY",
                "errors.trustImportTooMany",
            ));
        }
        if input.observed_at.trim().is_empty()
            || input.observed_at.len() > 64
            || input.observed_at.chars().any(char::is_control)
        {
            return Err(trust_import_error(
                "TRUST_IMPORT_INVALID",
                "errors.trustImportInvalid",
            ));
        }

        let mut seen = HashSet::with_capacity(input.candidates.len());
        let mut expectations = Vec::with_capacity(input.candidates.len());
        let mut records = Vec::with_capacity(input.candidates.len());
        let mut changed_count = 0_u32;
        let mut unchanged_count = 0_u32;
        for candidate in input.candidates {
            if candidate.source_line == 0
                || candidate.port == 0
                || !valid_host(&candidate.host)
                || !valid_host_key_algorithm(&candidate.algorithm)
                || !valid_sha256_fingerprint(&candidate.fingerprint_sha256)
                || candidate
                    .current_fingerprint_sha256
                    .as_deref()
                    .is_some_and(|fingerprint| !valid_sha256_fingerprint(fingerprint))
            {
                return Err(trust_import_error(
                    "TRUST_IMPORT_INVALID",
                    "errors.trustImportInvalid",
                ));
            }
            let key = (
                candidate.host.to_ascii_lowercase(),
                candidate.port,
                candidate.algorithm.clone(),
            );
            if !seen.insert(key) {
                return Err(trust_import_error(
                    "TRUST_IMPORT_INVALID",
                    "errors.trustImportInvalid",
                ));
            }

            expectations.push(HostTrustImportExpectation {
                host: candidate.host.clone(),
                port: candidate.port,
                algorithm: candidate.algorithm.clone(),
                current_fingerprint_sha256: candidate.current_fingerprint_sha256.clone(),
            });

            let existing =
                self.repository
                    .latest(&candidate.host, candidate.port, &candidate.algorithm)?;
            let existing_fingerprint = existing
                .as_ref()
                .map(|record| record.fingerprint_sha256.as_str());
            if existing_fingerprint != candidate.current_fingerprint_sha256.as_deref() {
                return Err(trust_import_error(
                    "TRUST_IMPORT_STALE",
                    "errors.trustImportStale",
                ));
            }
            if existing_fingerprint == Some(candidate.fingerprint_sha256.as_str()) {
                unchanged_count += 1;
                continue;
            }
            if existing.is_some() {
                changed_count += 1;
            }
            records.push(HostTrustRecord {
                id: uuid::Uuid::new_v4().to_string(),
                host: candidate.host,
                port: candidate.port,
                algorithm: candidate.algorithm,
                fingerprint_sha256: candidate.fingerprint_sha256,
                previous_fingerprint_sha256: existing
                    .as_ref()
                    .map(|record| record.fingerprint_sha256.clone()),
                source: filex_contracts::HostTrustSource::ImportedKnownHosts,
                first_seen_at: existing.as_ref().map_or_else(
                    || input.observed_at.clone(),
                    |record| record.first_seen_at.clone(),
                ),
                last_seen_at: input.observed_at.clone(),
            });
        }

        if !self
            .repository
            .import_many_if_current(&expectations, &records)?
        {
            return Err(trust_import_error(
                "TRUST_IMPORT_STALE",
                "errors.trustImportStale",
            ));
        }
        Ok(ImportKnownHostsResult {
            imported_count: records.len() as u32,
            changed_count,
            unchanged_count,
        })
    }
}

fn valid_host_key_algorithm(algorithm: &str) -> bool {
    !algorithm.is_empty()
        && algorithm.len() <= 128
        && algorithm.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'@' | b'+')
        })
}

fn valid_sha256_fingerprint(fingerprint: &str) -> bool {
    let Some(encoded) = fingerprint.strip_prefix("SHA256:") else {
        return false;
    };
    encoded.len() == 43
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn trust_import_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
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

fn proxy_jump_route_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn proxy_jump_nested_profile_error() -> AppError {
    proxy_jump_route_error(
        "PROFILE_PROXY_JUMP_NESTED_PROFILE",
        "profile.proxyJumpNestedProfile",
    )
}

fn profile_used_as_jump_error() -> AppError {
    AppError {
        code: "PROFILE_USED_AS_JUMP".to_owned(),
        message_key: "profile.usedAsJump".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
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

fn not_found_error(code: &str, message_key: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn profile_export_limit_error() -> AppError {
    AppError {
        code: "PROFILE_EXPORT_LIMIT_EXCEEDED".to_owned(),
        message_key: "errors.profileExportLimit".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn profile_export_route_integrity_error() -> AppError {
    AppError {
        code: "PROFILE_EXPORT_ROUTE_INVALID".to_owned(),
        message_key: "errors.profileExportFailed".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("proxyJumpProfileIds".to_owned()),
    }
}

fn invalid_transition_error() -> AppError {
    AppError {
        code: "SESSION_INVALID_TRANSITION".to_owned(),
        message_key: "errors.sessionInvalidTransition".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use filex_contracts::{
        AppError, AuthenticationMethod, CreateConnectionProfileInput, EnvironmentKind,
        SafeSettings, SessionState,
    };

    use super::{
        DEFAULT_UI_FONT_FAMILY, InMemoryProfileRepository, ProfileService, SessionMachine,
        SettingsRepository, SettingsService, default_safe_settings, validate_profile,
    };

    #[derive(Default)]
    struct TestSettingsRepository {
        settings: Mutex<Option<SafeSettings>>,
    }

    impl SettingsRepository for TestSettingsRepository {
        fn load(&self) -> Result<Option<SafeSettings>, AppError> {
            Ok(self.settings.lock().expect("settings mutex").clone())
        }

        fn save(&self, settings: &SafeSettings) -> Result<(), AppError> {
            *self.settings.lock().expect("settings mutex") = Some(settings.clone());
            Ok(())
        }
    }

    fn valid_input() -> CreateConnectionProfileInput {
        CreateConnectionProfileInput {
            name: "example-host".to_owned(),
            group: "Development".to_owned(),
            host: "example.internal".to_owned(),
            port: 22,
            username: "developer".to_owned(),
            environment: EnvironmentKind::Development,
            tags: vec!["api".to_owned(), " api ".to_owned()],
            authentication_method: AuthenticationMethod::Password,
            identity_file: None,
            proxy_jump: None,
            proxy_jump_profile_ids: Vec::new(),
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
    fn default_settings_use_harmony_ui_font_at_fourteen_pixels() {
        let settings = default_safe_settings();
        assert_eq!(settings.ui_font_family, DEFAULT_UI_FONT_FAMILY);
        assert!(settings.ui_font_family.contains("HarmonyOS Sans SC"));
        assert_eq!(settings.ui_font_size, 14);
        assert_eq!(settings.assistant_pane_width, 360);
    }

    #[test]
    fn settings_load_migrates_legacy_visual_defaults() {
        let repository = Arc::new(TestSettingsRepository::default());
        let mut legacy = default_safe_settings();
        legacy.ui_font_family = "Inter, system-ui, sans-serif".to_owned();
        legacy.terminal_theme = "dark".to_owned();
        repository.save(&legacy).expect("legacy settings save");

        let service = SettingsService::new(repository.clone());
        let migrated = service.load().expect("settings load");
        assert_eq!(migrated.ui_font_family, DEFAULT_UI_FONT_FAMILY);
        assert_eq!(migrated.terminal_theme, "filex-dark");
        assert_eq!(
            repository
                .load()
                .expect("stored settings load")
                .expect("stored settings")
                .ui_font_family,
            DEFAULT_UI_FONT_FAMILY
        );
        assert_eq!(
            repository
                .load()
                .expect("stored settings load")
                .expect("stored settings")
                .terminal_theme,
            "filex-dark"
        );

        let mut custom = default_safe_settings();
        custom.ui_font_family = "Custom Sans, sans-serif".to_owned();
        custom.terminal_theme = "dracula".to_owned();
        service.save(custom).expect("custom settings save");
        let loaded = service.load().expect("custom settings load");
        assert_eq!(loaded.ui_font_family, "Custom Sans, sans-serif");
        assert_eq!(loaded.terminal_theme, "dracula");

        let mut unsupported = default_safe_settings();
        unsupported.terminal_theme = "unknown-theme".to_owned();
        assert!(service.save(unsupported).is_err());
    }

    #[test]
    fn service_creates_non_secret_profile() {
        let service = ProfileService::new(Arc::new(InMemoryProfileRepository::default()));
        let profile = service
            .create(valid_input())
            .expect("profile should be created");
        assert!(profile.credential_ref.is_none());
        assert_eq!(profile.tags, vec!["api"]);
        assert_eq!(service.list().expect("list should work").len(), 1);
    }

    #[test]
    fn parses_supported_ssh_config_fields_and_warns_on_patterns() {
        let source = r#"
            Host *.internal
              User ignored
            Host production-api
              HostName 192.0.2.20
              User deploy
              Port 2222
              IdentityFile ~/.ssh/id_ed25519
              ProxyJump bastion
              ProxyCommand unsupported
        "#;
        let (candidates, warnings) = super::parse_ssh_config(source);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].alias, "production-api");
        assert_eq!(candidates[0].host, "192.0.2.20");
        assert_eq!(candidates[0].port, 2222);
        assert_eq!(candidates[0].proxy_jump.as_deref(), Some("bastion"));
        assert!(candidates[0].warnings[0].contains("ProxyCommand"));
        assert!(warnings[0].contains("skipped pattern"));
    }

    #[test]
    fn session_machine_enforces_trust_before_authentication() {
        let service = ProfileService::new(Arc::new(InMemoryProfileRepository::default()));
        let profile = service.create(valid_input()).expect("profile is created");
        let mut machine = SessionMachine::new(&profile);
        assert_eq!(
            machine.start_attempt().expect("attempt starts").generation,
            1
        );
        machine
            .transition(SessionState::Connecting)
            .expect("connects");
        machine
            .transition(SessionState::VerifyingHost)
            .expect("verifies host");
        assert!(machine.transition(SessionState::Connected).is_err());
        machine
            .transition(SessionState::TrustRequired)
            .expect("trust challenge is allowed");
        machine
            .transition(SessionState::ReadyToAuthenticate)
            .expect("trusted host is ready for authentication");
        machine
            .transition(SessionState::Authenticating)
            .expect("authentication follows trust");
        machine
            .transition(SessionState::Connected)
            .expect("connects");
    }

    #[test]
    fn parses_bounded_monitor_probe_output() {
        let snapshot = super::parse_monitor_probe(
            "HOST=node-01\nOS=Linux 6.6 x86_64\nUPTIME=1234.50\nLOAD1=0.42\nLOAD5=0.35\nLOAD15=0.30\nMEM_TOTAL=8192\nMEM_AVAILABLE=4096\nROOT_TOTAL=102400\nROOT_AVAILABLE=51200\n",
            42,
        );
        assert_eq!(snapshot.hostname.as_deref(), Some("node-01"));
        assert_eq!(snapshot.uptime_seconds, Some(1234));
        assert_eq!(snapshot.memory_available_kib, Some(4096));
        assert_eq!(snapshot.load_five, Some(0.35));
        assert_eq!(snapshot.load_fifteen, Some(0.30));
        assert_eq!(snapshot.collected_at_ms, 42);
        assert!(snapshot.mounts.is_empty());
    }

    #[test]
    fn parses_bounded_disk_mount_lines() {
        let mounts = super::parse_disk_mounts(
            "MOUNT=/|1000|400\nMOUNT=/run|bad|2\nMOUNT=|3|1\nMOUNT=/tmp|0|0\nMOUNT=/var|50|60\nMOUNT=/home|2000|1000|extra\nMOUNT=/a|10|5\nMOUNT=/b|10|5\nMOUNT=/c|10|5\nMOUNT=/d|10|5\nMOUNT=/e|10|5\nMOUNT=/f|10|5\nMOUNT=/g|10|5\nMOUNT=/h|10|5\nMOUNT=/i|10|5\nMOUNT=/j|10|5\nMOUNT=/k|10|5\nMOUNT=/l|10|5\nMOUNT=/m|10|5\n",
        );
        assert_eq!(mounts.len(), 12);
        assert_eq!(mounts[0].path, "/");
        assert_eq!(mounts[0].total_kib, 1000);
        assert_eq!(mounts[0].available_kib, 400);
        // Invalid, empty-path, zero-total, available>total and extra-segment lines are skipped.
        assert!(!mounts.iter().any(|mount| mount.path == "/run"));
        assert!(!mounts.iter().any(|mount| mount.path.is_empty()));
        assert!(!mounts.iter().any(|mount| mount.total_kib == 0));
        assert!(!mounts.iter().any(|mount| mount.path == "/var"));
        assert!(!mounts.iter().any(|mount| mount.path == "/home"));
        // The 12-entry cap keeps the first valid entries and drops the rest.
        assert!(!mounts.iter().any(|mount| mount.path == "/m"));
    }
}
