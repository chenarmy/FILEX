use serde::{Deserialize, Serialize};

pub const ASSISTANT_EXEC_MAX_OUTPUT_BYTES: usize = 32 * 1024;
pub const ASSISTANT_EXEC_TIMEOUT_SECONDS: u64 = 15;
pub const ASSISTANT_EXEC_MAX_COMMAND_BYTES: usize = 2_000;
const READ_ONLY_MAX_COMMAND_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantCommandRisk {
    ReadOnly,
    RequiresConfirmation,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantCommandExecutionResult {
    pub command: String,
    pub risk: AssistantCommandRisk,
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u64,
}

pub fn classify_assistant_command(command: &str) -> AssistantCommandRisk {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.len() > ASSISTANT_EXEC_MAX_COMMAND_BYTES {
        return AssistantCommandRisk::Blocked;
    }
    if trimmed.chars().any(is_blocked_control_char) {
        return AssistantCommandRisk::Blocked;
    }
    if trimmed.len() > READ_ONLY_MAX_COMMAND_BYTES
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return AssistantCommandRisk::RequiresConfirmation;
    }
    if contains_disallowed_shell_syntax(trimmed) || references_sensitive_target(trimmed) {
        return AssistantCommandRisk::RequiresConfirmation;
    }

    let Some(stages) = split_pipeline_stages(trimmed) else {
        return AssistantCommandRisk::RequiresConfirmation;
    };
    if stages.is_empty() || stages.len() > 6 {
        return AssistantCommandRisk::RequiresConfirmation;
    }

    for stage in stages {
        let Some(tokens) = tokenize_stage(&stage) else {
            return AssistantCommandRisk::RequiresConfirmation;
        };
        if !is_read_only_stage(&tokens) {
            return AssistantCommandRisk::RequiresConfirmation;
        }
    }

    AssistantCommandRisk::ReadOnly
}

fn is_blocked_control_char(ch: char) -> bool {
    if ch == '\0' {
        return true;
    }
    if ch.is_control() && !matches!(ch, '\t' | '\n' | '\r') {
        return true;
    }
    matches!(
        ch,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}'
    )
}

fn contains_disallowed_shell_syntax(command: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let chars = command.chars().collect::<Vec<_>>();
    let mut idx = 0;
    while idx < chars.len() {
        let ch = chars[idx];
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' => return true,
            '`' if !in_single => return true,
            '$' if !in_single => {
                if matches!(chars.get(idx + 1), Some('(' | '{')) {
                    return true;
                }
            }
            ';' | '&' | '>' | '<' if !in_single && !in_double => return true,
            '|' if !in_single && !in_double && chars.get(idx + 1) == Some(&'|') => return true,
            _ => {}
        }
        idx += 1;
    }
    in_single || in_double
}

fn references_sensitive_target(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    const SENSITIVE_FRAGMENTS: &[&str] = &[
        "/etc/shadow",
        "/etc/gshadow",
        "/etc/sudoers",
        "/.ssh",
        ".ssh/",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "id_dsa",
        "authorized_keys",
        "/environ",
        "printenv",
        ".env",
        ".pgpass",
        ".my.cnf",
        ".netrc",
        "aws/credentials",
        ".kube/config",
        "private_key",
        "secret",
    ];
    SENSITIVE_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
}

fn split_pipeline_stages(command: &str) -> Option<Vec<String>> {
    let mut stages = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for ch in command.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
                current.push(ch);
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(ch);
            }
            '|' if !in_single && !in_double => {
                let stage = current.trim();
                if stage.is_empty() {
                    return None;
                }
                stages.push(stage.to_owned());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if in_single || in_double {
        return None;
    }
    let stage = current.trim();
    if stage.is_empty() {
        return None;
    }
    stages.push(stage.to_owned());
    Some(stages)
}

fn tokenize_stage(stage: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;

    for ch in stage.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            _ => {
                current.push(ch);
                has_token = true;
            }
        }
    }
    if in_single || in_double {
        return None;
    }
    if has_token {
        tokens.push(current);
    }
    Some(tokens)
}

fn normalize_binary_name(raw: &str) -> Option<&str> {
    for prefix in ["/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/"] {
        if let Some(stripped) = raw.strip_prefix(prefix) {
            return (!stripped.contains('/')).then_some(stripped);
        }
    }
    (!raw.contains('/')).then_some(raw)
}

fn is_read_only_stage(tokens: &[String]) -> bool {
    let Some(first) = tokens.first() else {
        return false;
    };
    let Some(binary) = normalize_binary_name(first) else {
        return false;
    };
    let args = &tokens[1..];

    const ALWAYS_READ_ONLY: &[&str] = &[
        "uname",
        "hostname",
        "uptime",
        "date",
        "whoami",
        "id",
        "nproc",
        "lscpu",
        "lsmod",
        "lsusb",
        "lspci",
        "free",
        "vmstat",
        "mpstat",
        "iostat",
        "sar",
        "df",
        "du",
        "lsblk",
        "findmnt",
        "ps",
        "pgrep",
        "pidof",
        "lsof",
        "ss",
        "netstat",
        "dig",
        "nslookup",
        "getent",
        "ls",
        "stat",
        "file",
        "wc",
        "head",
        "grep",
        "egrep",
        "fgrep",
        "sort",
        "uniq",
        "cut",
        "tr",
        "cat",
        "dmesg",
        "last",
        "who",
        "w",
        "which",
        "whereis",
        "hostnamectl",
        "timedatectl",
        "lsattr",
        "ulimit",
        "getconf",
        "crontab",
    ];

    if ALWAYS_READ_ONLY.contains(&binary) {
        if binary == "crontab" {
            return args.len() == 1 && args[0] == "-l";
        }
        if binary == "dmesg" {
            return !args
                .iter()
                .any(|arg| matches!(arg.as_str(), "-c" | "-C" | "--clear" | "--read-clear"));
        }
        if binary == "timedatectl" || binary == "hostnamectl" {
            return args.is_empty() || (args.len() == 1 && args[0] == "status");
        }
        return true;
    }

    match binary {
        "tail" => !args.iter().any(|arg| {
            arg == "-f" || arg == "-F" || arg == "--follow" || arg.starts_with("--follow=")
        }),
        "top" => {
            let has_batch = args.iter().any(|arg| arg == "-b" || arg.starts_with("-b"));
            let has_iterations = args.iter().any(|arg| arg == "-n" || arg.starts_with("-n"));
            has_batch && has_iterations
        }
        "mount" => args.is_empty(),
        "swapon" => args.iter().any(|arg| arg == "--show" || arg == "-s"),
        "sysctl" => {
            !args.is_empty()
                && !args.iter().any(|arg| {
                    matches!(arg.as_str(), "-w" | "-p" | "-f" | "--load" | "--write")
                        || arg.contains('=')
                })
        }
        "systemctl" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "status"
                    | "is-active"
                    | "is-failed"
                    | "is-enabled"
                    | "list-units"
                    | "list-unit-files"
                    | "list-timers"
                    | "list-sockets"
                    | "show"
                    | "cat"
            )
        }),
        "service" => args
            .last()
            .is_some_and(|arg| arg == "status" || arg == "--status-all"),
        "journalctl" => !args.iter().any(|arg| {
            arg == "-f"
                || arg == "--follow"
                || arg.starts_with("--vacuum")
                || arg == "--rotate"
                || arg == "--flush"
                || arg == "--relinquish-var"
        }),
        "ip" => {
            let mut subcommands = args.iter().filter(|arg| !arg.starts_with('-'));
            let Some(object) = subcommands.next() else {
                return false;
            };
            let allowed_object = matches!(
                object.as_str(),
                "a" | "addr" | "address" | "r" | "route" | "l" | "link" | "n" | "neigh" | "rule"
            );
            let mutating = subcommands.any(|arg| {
                matches!(
                    arg.as_str(),
                    "add" | "del" | "delete" | "change" | "replace" | "set" | "flush" | "append"
                )
            });
            allowed_object && !mutating
        }
        "ifconfig" => args.len() <= 1,
        "ping" => args.iter().any(|arg| arg == "-c" || arg.starts_with("-c")),
        "docker" => is_read_only_docker(args),
        "sed" => {
            args.iter().any(|arg| arg == "-n" || arg == "--quiet")
                && !args.iter().any(|arg| {
                    arg == "-i" || arg.starts_with("-i") || arg.starts_with("--in-place")
                })
        }
        "awk" => !args.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.contains("system(") || lower.contains("getline") || lower.contains('>')
        }),
        "find" => !args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete" | "-fprint" | "-fprintf"
            )
        }),
        _ => false,
    }
}

fn is_read_only_docker(args: &[String]) -> bool {
    let Some(sub) = args.first().map(String::as_str) else {
        return false;
    };
    let rest = &args[1..];
    match sub {
        "ps" | "info" | "version" | "images" | "inspect" | "top" | "port" | "diff" => true,
        "stats" => rest.iter().any(|arg| arg == "--no-stream"),
        "logs" => !rest
            .iter()
            .any(|arg| arg == "-f" || arg == "--follow" || arg.starts_with("--follow=")),
        "network" | "volume" => rest
            .first()
            .is_some_and(|action| matches!(action.as_str(), "ls" | "list" | "inspect")),
        "compose" => match rest.first().map(String::as_str) {
            Some("ps" | "config" | "images" | "top") => true,
            Some("logs") => !rest[1..]
                .iter()
                .any(|arg| arg == "-f" || arg == "--follow" || arg.starts_with("--follow=")),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{AssistantCommandRisk, classify_assistant_command};

    #[test]
    fn classifies_common_server_diagnostic_pipelines_as_read_only() {
        for command in [
            "ps aux --sort=-%cpu | head -n 20",
            "top -b -n 1 | head -n 30",
            "free -h",
            "df -h",
            "ss -tulpen | head -n 50",
            "systemctl status nginx --no-pager",
            "journalctl -u nginx -n 80 --no-pager",
            "docker ps -a",
            "docker stats --no-stream",
            "docker logs --tail 100 nginx",
            "ip addr show",
            "cat /proc/loadavg",
        ] {
            assert_eq!(
                classify_assistant_command(command),
                AssistantCommandRisk::ReadOnly,
                "expected read_only for: {command}"
            );
        }
    }

    #[test]
    fn requires_confirmation_for_mutating_chained_interactive_or_secret_commands() {
        for command in [
            "kill -9 32280",
            "systemctl restart nginx",
            "docker restart mysql",
            "docker logs -f nginx",
            "tail -f /var/log/syslog",
            "top",
            "rm -rf /tmp/test",
            "ps aux; rm -rf /tmp/test",
            "ps aux && reboot",
            "cat /etc/shadow",
            "cat ~/.ssh/id_rsa",
            "cat /app/.env",
            "cat /proc/1/environ",
            "echo test > /tmp/file",
            "ps $(id)",
            "ip route add default via 10.0.0.1",
            "sed -i 's/a/b/' /etc/hosts",
        ] {
            assert_eq!(
                classify_assistant_command(command),
                AssistantCommandRisk::RequiresConfirmation,
                "expected requires_confirmation for: {command}"
            );
        }
    }

    #[test]
    fn blocks_empty_or_control_character_commands() {
        assert_eq!(
            classify_assistant_command("   "),
            AssistantCommandRisk::Blocked
        );
        assert_eq!(
            classify_assistant_command("ps aux\0rm -rf /"),
            AssistantCommandRisk::Blocked
        );
        assert_eq!(
            classify_assistant_command("ps \u{202E}aux"),
            AssistantCommandRisk::Blocked
        );
    }
}
