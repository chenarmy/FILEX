use filex_contracts::{
    AppError, DockerAvailability, DockerContainerAction, DockerContainerEntry, DockerImageEntry,
    DockerLogsSnapshot, DockerSnapshot, MonitorState, OpsCategory, OpsCommandSection, OpsSnapshot,
    ProcessSignal, RemoteState,
};

pub const DOCKER_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
pub const DOCKER_LOGS_OUTPUT_BYTES: usize = 256 * 1024;
pub const OPS_PROBE_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_CONTAINER_ROWS: usize = 100;
const MAX_IMAGE_ROWS: usize = 60;
const MAX_SECTION_LINES: usize = 160;

pub const DOCKER_SNAPSHOT_PROBE: &str = r#"LC_ALL=C; export LC_ALL
if ! command -v docker >/dev/null 2>&1; then
  printf 'DOCKER=NOT_INSTALLED\n'
  exit 0
fi
info_out=$(docker info --format '{{.ServerVersion}}' 2>&1)
info_rc=$?
if [ "$info_rc" -ne 0 ]; then
  lower_info=$(printf '%s' "$info_out" | tr '[:upper:]' '[:lower:]')
  case "$lower_info" in
    *"permission denied"*|*"got permission denied"*)
      printf 'DOCKER=PERMISSION_DENIED\n'
      ;;
    *)
      printf 'DOCKER=DAEMON_STOPPED\n'
      printf 'NOTE\t%s\n' "$(printf '%s' "$info_out" | head -n 1 | tr '\t\r\n' '   ')"
      ;;
  esac
  exit 0
fi
printf 'DOCKER=AVAILABLE\n'
printf 'VERSION\t%s\n' "$(printf '%s' "$info_out" | head -n 1 | tr '\t\r\n' '   ')"
docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}' 2>/dev/null | head -n 101 | while IFS= read -r line; do
  printf 'C\t%s\n' "$line"
done
if command -v timeout >/dev/null 2>&1; then
  timeout 4 docker stats --no-stream --no-trunc --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' 2>/dev/null | while IFS= read -r line; do
    printf 'S\t%s\n' "$line"
  done
else
  docker stats --no-stream --no-trunc --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' 2>/dev/null | while IFS= read -r line; do
    printf 'S\t%s\n' "$line"
  done
fi
docker images --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null | head -n 61 | while IFS= read -r line; do
  printf 'I\t%s\n' "$line"
done"#;

pub fn posix_signal_flag(signal: ProcessSignal) -> &'static str {
    match signal {
        ProcessSignal::Sigterm => "TERM",
        ProcessSignal::Sigkill => "KILL",
        ProcessSignal::Sighup => "HUP",
        ProcessSignal::Sigstop => "STOP",
        ProcessSignal::Sigcont => "CONT",
    }
}

pub fn validate_container_id(container_id: &str) -> Result<&str, AppError> {
    let trimmed = container_id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(docker_target_invalid_error());
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err(docker_target_invalid_error());
    };
    if !first.is_ascii_alphanumeric() {
        return Err(docker_target_invalid_error());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
    {
        return Err(docker_target_invalid_error());
    }
    Ok(trimmed)
}

pub fn docker_action_command(
    container_id: &str,
    action: DockerContainerAction,
) -> Result<String, AppError> {
    let id = validate_container_id(container_id)?;
    let command = match action {
        DockerContainerAction::Start => format!("LC_ALL=C docker start '{id}' 2>&1"),
        DockerContainerAction::Stop => format!("LC_ALL=C docker stop -t 10 '{id}' 2>&1"),
        DockerContainerAction::Restart => format!("LC_ALL=C docker restart -t 10 '{id}' 2>&1"),
        DockerContainerAction::Pause => format!("LC_ALL=C docker pause '{id}' 2>&1"),
        DockerContainerAction::Unpause => format!("LC_ALL=C docker unpause '{id}' 2>&1"),
        DockerContainerAction::Remove => format!("LC_ALL=C docker rm -f '{id}' 2>&1"),
    };
    Ok(command)
}

pub fn docker_logs_command(
    container_id: &str,
    tail_lines: Option<u32>,
) -> Result<String, AppError> {
    let id = validate_container_id(container_id)?;
    let tail = tail_lines.unwrap_or(200).clamp(10, 500);
    Ok(format!(
        "LC_ALL=C docker logs --tail {tail} --timestamps '{id}' 2>&1"
    ))
}

pub fn parse_docker_snapshot(
    output: &str,
    collected_at_ms: u64,
) -> Result<DockerSnapshot, AppError> {
    let status = output
        .lines()
        .find_map(|line| line.strip_prefix("DOCKER="))
        .map(str::trim);

    match status {
        Some("NOT_INSTALLED") => {
            return Ok(DockerSnapshot {
                availability: DockerAvailability::NotInstalled,
                collected_at_ms,
                server_version: None,
                containers: Vec::new(),
                images: Vec::new(),
                truncated: false,
                detail_note: None,
            });
        }
        Some("PERMISSION_DENIED") => {
            return Ok(DockerSnapshot {
                availability: DockerAvailability::PermissionDenied,
                collected_at_ms,
                server_version: None,
                containers: Vec::new(),
                images: Vec::new(),
                truncated: false,
                detail_note: None,
            });
        }
        Some("DAEMON_STOPPED") => {
            let note = output
                .lines()
                .find_map(|line| line.strip_prefix("NOTE\t"))
                .map(sanitize_plain_text)
                .filter(|value| !value.is_empty());
            return Ok(DockerSnapshot {
                availability: DockerAvailability::DaemonStopped,
                collected_at_ms,
                server_version: None,
                containers: Vec::new(),
                images: Vec::new(),
                truncated: false,
                detail_note: note,
            });
        }
        Some("AVAILABLE") => {}
        _ => return Err(docker_probe_error()),
    }

    let server_version = output
        .lines()
        .find_map(|line| line.strip_prefix("VERSION\t"))
        .map(sanitize_plain_text)
        .filter(|value| !value.is_empty());

    let mut stats_by_id = std::collections::HashMap::<String, (String, String, String)>::new();
    for line in output.lines() {
        let Some(rest) = line.strip_prefix("S\t") else {
            continue;
        };
        let fields = rest.split('\t').collect::<Vec<_>>();
        if fields.len() >= 4 {
            let id = sanitize_plain_text(fields[0]);
            if !id.is_empty() {
                stats_by_id.insert(
                    id,
                    (
                        sanitize_plain_text(fields[1]),
                        sanitize_plain_text(fields[2]),
                        sanitize_plain_text(fields[3]),
                    ),
                );
            }
        }
    }

    let container_lines = output
        .lines()
        .filter_map(|line| line.strip_prefix("C\t"))
        .collect::<Vec<_>>();
    let containers_truncated = container_lines.len() > MAX_CONTAINER_ROWS;
    let mut containers = Vec::with_capacity(container_lines.len().min(MAX_CONTAINER_ROWS));
    for line in container_lines.into_iter().take(MAX_CONTAINER_ROWS) {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() < 7 {
            continue;
        }
        let id = sanitize_plain_text(fields[0]);
        if id.is_empty() {
            continue;
        }
        let stat = stats_by_id.get(&id).or_else(|| {
            stats_by_id
                .iter()
                .find(|(key, _)| id.starts_with(key.as_str()) || key.starts_with(id.as_str()))
                .map(|(_, value)| value)
        });
        containers.push(DockerContainerEntry {
            id,
            name: sanitize_plain_text(fields[1]),
            image: sanitize_plain_text(fields[2]),
            state: sanitize_plain_text(fields[3]).to_lowercase(),
            status: sanitize_plain_text(fields[4]),
            ports: sanitize_plain_text(fields[5]),
            created_at: sanitize_plain_text(fields[6]),
            cpu_percent: stat.map(|entry| entry.0.clone()).filter(|v| !v.is_empty()),
            memory_usage: stat.map(|entry| entry.1.clone()).filter(|v| !v.is_empty()),
            pids: stat.map(|entry| entry.2.clone()).filter(|v| !v.is_empty()),
        });
    }

    let image_lines = output
        .lines()
        .filter_map(|line| line.strip_prefix("I\t"))
        .collect::<Vec<_>>();
    let images_truncated = image_lines.len() > MAX_IMAGE_ROWS;
    let mut images = Vec::with_capacity(image_lines.len().min(MAX_IMAGE_ROWS));
    for line in image_lines.into_iter().take(MAX_IMAGE_ROWS) {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        images.push(DockerImageEntry {
            id: sanitize_plain_text(fields[0]),
            repository: sanitize_plain_text(fields[1]),
            tag: sanitize_plain_text(fields[2]),
            size: sanitize_plain_text(fields[3]),
            created_since: sanitize_plain_text(fields[4]),
        });
    }

    Ok(DockerSnapshot {
        availability: DockerAvailability::Available,
        collected_at_ms,
        server_version,
        containers,
        images,
        truncated: containers_truncated || images_truncated,
        detail_note: None,
    })
}

pub fn parse_docker_logs(container_id: String, output: &str) -> DockerLogsSnapshot {
    let raw_lines = output.lines().map(sanitize_log_line).collect::<Vec<_>>();
    let truncated = raw_lines.len() > 500;
    let lines = if truncated {
        raw_lines
            .into_iter()
            .rev()
            .take(500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        raw_lines
    };
    DockerLogsSnapshot {
        container_id,
        lines,
        truncated,
    }
}

pub fn ops_probe_command(category: OpsCategory) -> &'static str {
    match category {
        OpsCategory::Overview => OPS_OVERVIEW_PROBE,
        OpsCategory::Ports => OPS_PORTS_PROBE,
        OpsCategory::Services => OPS_SERVICES_PROBE,
        OpsCategory::Disks => OPS_DISKS_PROBE,
        OpsCategory::Logs => OPS_LOGS_PROBE,
    }
}

const OPS_HEADER: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
os_name=""
if [ -r /etc/os-release ]; then
  os_name=$(awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2); print $2; exit}' /etc/os-release 2>/dev/null)
fi
printf 'OS\t%s\n' "$(printf '%s' "$os_name" | tr '\t\r\n' '   ')"
emit_section() {
  sec_id="$1"
  title_key="$2"
  cmd_label="$3"
  printf 'SEC_START\t%s\t%s\t%s\n' "$sec_id" "$title_key" "$cmd_label"
  head -n 161 | while IFS= read -r row; do
    printf 'LINE\t%s\n' "$row"
  done
  printf 'SEC_END\n'
}"#;

const OPS_OVERVIEW_PROBE: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
os_name=""
if [ -r /etc/os-release ]; then
  os_name=$(awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2); print $2; exit}' /etc/os-release 2>/dev/null)
fi
printf 'OS\t%s\n' "$(printf '%s' "$os_name" | tr '\t\r\n' '   ')"
emit_section() {
  printf 'SEC_START\t%s\t%s\t%s\n' "$1" "$2" "$3"
  head -n 161 | while IFS= read -r row; do printf 'LINE\t%s\n' "$row"; done
  printf 'SEC_END\n'
}
{ uptime 2>/dev/null; who 2>/dev/null | head -n 20; } | emit_section "uptime" "opsDialog.sectionUptime" "uptime && who"
if command -v free >/dev/null 2>&1; then
  free -h 2>/dev/null | emit_section "memory" "opsDialog.sectionMemory" "free -h"
fi
if command -v ss >/dev/null 2>&1; then
  ss -tuln 2>/dev/null | emit_section "ports" "opsDialog.sectionPorts" "ss -tuln"
fi
df -hP 2>/dev/null | emit_section "disks" "opsDialog.sectionDiskUsage" "df -hP""#;

const OPS_PORTS_PROBE: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
emit_section() {
  printf 'SEC_START\t%s\t%s\t%s\n' "$1" "$2" "$3"
  head -n 161 | while IFS= read -r row; do printf 'LINE\t%s\n' "$row"; done
  printf 'SEC_END\n'
}
if command -v ss >/dev/null 2>&1; then
  ss -tulnp 2>/dev/null | emit_section "listening" "opsDialog.sectionListeningPorts" "ss -tulnp"
  ss -s 2>/dev/null | emit_section "summary" "opsDialog.sectionSocketSummary" "ss -s"
elif command -v netstat >/dev/null 2>&1; then
  netstat -tulnp 2>/dev/null | emit_section "listening" "opsDialog.sectionListeningPorts" "netstat -tulnp"
fi"#;

const OPS_SERVICES_PROBE: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
emit_section() {
  printf 'SEC_START\t%s\t%s\t%s\n' "$1" "$2" "$3"
  head -n 161 | while IFS= read -r row; do printf 'LINE\t%s\n' "$row"; done
  printf 'SEC_END\n'
}
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --state=failed --no-pager --no-legend 2>/dev/null | emit_section "failed" "opsDialog.sectionFailedServices" "systemctl --state=failed"
  systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | emit_section "running" "opsDialog.sectionRunningServices" "systemctl --state=running"
elif command -v service >/dev/null 2>&1; then
  service --status-all 2>&1 | emit_section "running" "opsDialog.sectionRunningServices" "service --status-all"
fi"#;

const OPS_DISKS_PROBE: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
emit_section() {
  printf 'SEC_START\t%s\t%s\t%s\n' "$1" "$2" "$3"
  head -n 161 | while IFS= read -r row; do printf 'LINE\t%s\n' "$row"; done
  printf 'SEC_END\n'
}
df -hP 2>/dev/null | emit_section "space" "opsDialog.sectionDiskUsage" "df -hP"
df -iP 2>/dev/null | emit_section "inodes" "opsDialog.sectionDiskInodes" "df -iP"
if command -v lsblk >/dev/null 2>&1; then
  lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null | emit_section "blocks" "opsDialog.sectionBlockDevices" "lsblk"
fi"#;

const OPS_LOGS_PROBE: &str = r#"LC_ALL=C; export LC_ALL
printf 'OPS_PLATFORM=POSIX\n'
printf 'HOST\t%s\n' "$(hostname 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
printf 'KERNEL\t%s\n' "$(uname -srmo 2>/dev/null | head -n 1 | tr '\t\r\n' '   ')"
emit_section() {
  printf 'SEC_START\t%s\t%s\t%s\n' "$1" "$2" "$3"
  head -n 161 | while IFS= read -r row; do printf 'LINE\t%s\n' "$row"; done
  printf 'SEC_END\n'
}
if command -v journalctl >/dev/null 2>&1; then
  journalctl -n 120 --no-pager 2>&1 | emit_section "journal" "opsDialog.sectionJournalLogs" "journalctl -n 120"
fi
if [ -r /var/log/messages ]; then
  tail -n 120 /var/log/messages 2>/dev/null | emit_section "syslog" "opsDialog.sectionSystemLog" "tail -n 120 /var/log/messages"
elif [ -r /var/log/syslog ]; then
  tail -n 120 /var/log/syslog 2>/dev/null | emit_section "syslog" "opsDialog.sectionSystemLog" "tail -n 120 /var/log/syslog"
fi
if command -v dmesg >/dev/null 2>&1; then
  dmesg 2>/dev/null | tail -n 80 | emit_section "dmesg" "opsDialog.sectionKernelLog" "dmesg | tail -n 80"
fi"#;

#[allow(dead_code)]
fn _ops_header_placeholder() -> &'static str {
    OPS_HEADER
}

pub fn parse_ops_snapshot(
    category: OpsCategory,
    output: &str,
    collected_at_ms: u64,
) -> Result<OpsSnapshot, AppError> {
    if !output
        .lines()
        .any(|line| line.trim() == "OPS_PLATFORM=POSIX")
    {
        return Err(ops_probe_error());
    }

    let hostname = output
        .lines()
        .find_map(|line| line.strip_prefix("HOST\t"))
        .map(sanitize_plain_text)
        .filter(|value| !value.is_empty());
    let kernel = output
        .lines()
        .find_map(|line| line.strip_prefix("KERNEL\t"))
        .map(sanitize_plain_text)
        .filter(|value| !value.is_empty());
    let os_release = output
        .lines()
        .find_map(|line| line.strip_prefix("OS\t"))
        .map(sanitize_plain_text)
        .filter(|value| !value.is_empty());

    let mut sections = Vec::new();
    let mut current: Option<(String, String, String, Vec<String>)> = None;

    for line in output.lines() {
        if let Some(meta) = line.strip_prefix("SEC_START\t") {
            let parts = meta.split('\t').collect::<Vec<_>>();
            if parts.len() >= 3 {
                current = Some((
                    sanitize_plain_text(parts[0]),
                    sanitize_plain_text(parts[1]),
                    sanitize_plain_text(parts[2]),
                    Vec::new(),
                ));
            }
            continue;
        }
        if line.trim() == "SEC_END" {
            if let Some((id, title_key, command_label, mut lines)) = current.take() {
                let truncated = lines.len() > MAX_SECTION_LINES;
                if truncated {
                    lines.truncate(MAX_SECTION_LINES);
                }
                sections.push(OpsCommandSection {
                    id,
                    title_key,
                    command_label,
                    lines,
                    truncated,
                });
            }
            continue;
        }
        if let Some(content) = line.strip_prefix("LINE\t")
            && let Some((_, _, _, lines)) = current.as_mut()
            && lines.len() <= MAX_SECTION_LINES
        {
            lines.push(sanitize_log_line(content));
        }
    }

    Ok(OpsSnapshot {
        state: if sections.is_empty() {
            MonitorState::Unsupported
        } else {
            MonitorState::Live
        },
        collected_at_ms,
        category,
        hostname,
        kernel,
        os_release,
        sections,
    })
}

fn sanitize_plain_text(input: &str) -> String {
    strip_ansi_escape_sequences(input)
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(512)
        .collect()
}

fn sanitize_log_line(input: &str) -> String {
    strip_ansi_escape_sequences(input)
        .chars()
        .map(|ch| if ch == '\t' { ' ' } else { ch })
        .filter(|ch| !ch.is_control())
        .take(1024)
        .collect()
}

fn strip_ansi_escape_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\x07' {
                            break;
                        }
                        if next == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        output.push(ch);
    }
    output
}

pub fn docker_probe_error() -> AppError {
    AppError {
        code: "DOCKER_PROBE_FAILED".to_owned(),
        message_key: "errors.dockerProbeFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

pub fn docker_target_invalid_error() -> AppError {
    AppError {
        code: "DOCKER_TARGET_INVALID".to_owned(),
        message_key: "errors.dockerTargetInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("containerId".to_owned()),
    }
}

pub fn docker_action_error() -> AppError {
    AppError {
        code: "DOCKER_ACTION_FAILED".to_owned(),
        message_key: "errors.dockerActionFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

pub fn ops_probe_error() -> AppError {
    AppError {
        code: "OPS_PROBE_FAILED".to_owned(),
        message_key: "errors.opsProbeFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_container_identifiers_strictly() {
        assert_eq!(validate_container_id("nginx-web_1.0"), Ok("nginx-web_1.0"));
        assert_eq!(validate_container_id("a1b2c3d4e5f6"), Ok("a1b2c3d4e5f6"));
        assert!(validate_container_id("").is_err());
        assert!(validate_container_id("-bad").is_err());
        assert!(validate_container_id("nginx; rm -rf /").is_err());
        assert!(validate_container_id("web$(id)").is_err());
        assert!(validate_container_id("web`id`").is_err());
        assert!(validate_container_id("web' || true").is_err());
    }

    #[test]
    fn parses_docker_availability_and_rows() {
        let missing = parse_docker_snapshot("DOCKER=NOT_INSTALLED\n", 100).unwrap();
        assert_eq!(missing.availability, DockerAvailability::NotInstalled);

        let denied = parse_docker_snapshot("DOCKER=PERMISSION_DENIED\n", 100).unwrap();
        assert_eq!(denied.availability, DockerAvailability::PermissionDenied);

        let sample = "\
DOCKER=AVAILABLE
VERSION\t27.3.1
C\tabc123456789\tweb-api\tnginx:1.27\trunning\tUp 2 hours\t0.0.0.0:8080->80/tcp\t2026-11-10 08:00:00
S\tabc123456789\t1.25%\t42.1MiB / 3.6GiB\t6
I\tsha256:999\tnginx\t1.27\t187MB\t2 weeks ago
";
        let snapshot = parse_docker_snapshot(sample, 1234).unwrap();
        assert_eq!(snapshot.availability, DockerAvailability::Available);
        assert_eq!(snapshot.server_version.as_deref(), Some("27.3.1"));
        assert_eq!(snapshot.containers.len(), 1);
        assert_eq!(snapshot.containers[0].name, "web-api");
        assert_eq!(snapshot.containers[0].cpu_percent.as_deref(), Some("1.25%"));
        assert_eq!(snapshot.images.len(), 1);
        assert_eq!(snapshot.images[0].repository, "nginx");
    }

    #[test]
    fn parses_ops_snapshot_and_strips_ansi_sequences() {
        let sample = "\
OPS_PLATFORM=POSIX
HOST\tprod-edge-01
KERNEL\tLinux 6.8.0 x86_64
OS\tUbuntu 24.04 LTS
SEC_START\tspace\topsDialog.sectionDiskUsage\tdf -hP
LINE\tFilesystem      Size  Used Avail Use% Mounted on
LINE\t/dev/vda1        \x1b[32m80G\x1b[0m   38G   39G  50% /
SEC_END
";
        let snapshot = parse_ops_snapshot(OpsCategory::Disks, sample, 456).unwrap();
        assert_eq!(snapshot.state, MonitorState::Live);
        assert_eq!(snapshot.hostname.as_deref(), Some("prod-edge-01"));
        assert_eq!(snapshot.sections.len(), 1);
        assert_eq!(
            snapshot.sections[0].lines[1],
            "/dev/vda1        80G   38G   39G  50% /"
        );
    }
}
