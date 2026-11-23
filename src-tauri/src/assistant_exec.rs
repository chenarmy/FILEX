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
    Destructive,
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
    if is_read_only_command(trimmed) {
        return AssistantCommandRisk::ReadOnly;
    }
    if is_destructive_command(trimmed) {
        return AssistantCommandRisk::Destructive;
    }
    AssistantCommandRisk::RequiresConfirmation
}

fn is_read_only_command(trimmed: &str) -> bool {
    if trimmed.len() > READ_ONLY_MAX_COMMAND_BYTES
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return false;
    }
    if contains_disallowed_shell_syntax(trimmed) || references_sensitive_target(trimmed) {
        return false;
    }

    let Some(stages) = split_pipeline_stages(trimmed) else {
        return false;
    };
    if stages.is_empty() || stages.len() > 6 {
        return false;
    }

    for stage in stages {
        let Some(tokens) = tokenize_stage(&stage) else {
            return false;
        };
        if !is_read_only_stage(&tokens) {
            return false;
        }
    }

    true
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

fn short_flags_contain(arg: &str, target: char) -> bool {
    arg.starts_with('-')
        && !arg.starts_with("--")
        && arg.len() > 1
        && arg[1..].chars().any(|ch| ch == target)
}

fn is_short_flag_cluster_only(arg: &str, allowed: &[char]) -> bool {
    arg.starts_with('-')
        && !arg.starts_with("--")
        && arg.len() > 1
        && arg[1..].chars().all(|ch| allowed.contains(&ch))
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
        "/etc/master.passwd",
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
        ".npmrc",
        ".pypirc",
        ".docker/config.json",
        ".git-credentials",
        ".vault-token",
        "vault-token",
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
        "uptime",
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
        "df",
        "du",
        "lsblk",
        "findmnt",
        "ps",
        "pgrep",
        "pidof",
        "lsof",
        "netstat",
        "getent",
        "ls",
        "stat",
        "file",
        "wc",
        "head",
        "grep",
        "egrep",
        "fgrep",
        "cut",
        "tr",
        "cat",
        "last",
        "who",
        "w",
        "which",
        "whereis",
        "hostnamectl",
        "timedatectl",
        "lsattr",
        "getconf",
        "crontab",
        "lslocks",
        "lsns",
        "lsipc",
        "lsmem",
        "numastat",
    ];

    if ALWAYS_READ_ONLY.contains(&binary) {
        if binary == "crontab" {
            return args.len() == 1 && args[0] == "-l";
        }
        if binary == "timedatectl" || binary == "hostnamectl" {
            return args.is_empty() || (args.len() == 1 && args[0] == "status");
        }
        return true;
    }

    match binary {
        "hostname" => is_read_only_hostname(args),
        "date" => is_read_only_date(args),
        "dmesg" => is_read_only_dmesg(args),
        "sar" => !args.iter().any(|arg| {
            arg.starts_with("-o")
                || arg == "--output"
                || arg.starts_with("--output=")
                || short_flags_contain(arg, 'o')
        }),
        "pidstat" => !args.iter().any(|arg| {
            arg == "-e"
                || arg == "--exec"
                || arg.starts_with("--exec=")
                || short_flags_contain(arg, 'e')
        }),
        "sort" => is_read_only_sort(args),
        "uniq" => is_read_only_uniq(args),
        "ulimit" => args
            .iter()
            .all(|arg| is_short_flag_cluster_only(arg, &['a', 'H', 'S'])),
        "ss" => is_read_only_ss(args),
        "dig" => !args.iter().any(|arg| {
            short_flags_contain(arg, 'f')
                || short_flags_contain(arg, 'k')
                || short_flags_contain(arg, 'y')
        }),
        "nslookup" => {
            args.iter().any(|arg| !arg.starts_with('-')) && args.iter().all(|arg| arg != "-")
        }
        "tail" => !args.iter().any(|arg| {
            arg == "-f"
                || arg == "-F"
                || arg == "--follow"
                || arg.starts_with("--follow=")
                || short_flags_contain(arg, 'f')
                || short_flags_contain(arg, 'F')
        }),
        "top" => {
            let has_batch = args
                .iter()
                .any(|arg| arg == "-b" || short_flags_contain(arg, 'b'));
            let has_iterations = args
                .iter()
                .any(|arg| arg == "-n" || short_flags_contain(arg, 'n'));
            has_batch && has_iterations
        }
        "mount" => args.is_empty(),
        "swapon" => args.iter().any(|arg| arg == "--show" || arg == "-s"),
        "sysctl" => {
            !args.is_empty()
                && !args.iter().any(|arg| {
                    matches!(
                        arg.as_str(),
                        "--system" | "--write" | "--load" | "-w" | "-p" | "-f"
                    ) || arg.starts_with("--write=")
                        || arg.starts_with("--load=")
                        || arg.contains('=')
                        || short_flags_contain(arg, 'w')
                        || short_flags_contain(arg, 'p')
                        || short_flags_contain(arg, 'f')
                })
        }
        "systemctl" => is_read_only_systemctl(args),
        "service" => {
            args == ["--status-all"]
                || (args.len() == 2 && !args[0].starts_with('-') && args[1] == "status")
        }
        "journalctl" => is_read_only_journalctl(args),
        "ip" => is_read_only_ip(args),
        "ifconfig" => args.len() <= 1,
        "ping" => {
            let has_count = args
                .iter()
                .any(|arg| arg == "-c" || short_flags_contain(arg, 'c'));
            let has_disallowed = args.iter().any(|arg| {
                arg == "--flood"
                    || arg == "--preload"
                    || short_flags_contain(arg, 'f')
                    || short_flags_contain(arg, 'l')
            });
            has_count && !has_disallowed
        }
        "docker" | "podman" => is_read_only_docker(args),
        "kubectl" => is_read_only_kubectl(args),
        "nginx" => {
            !args.is_empty()
                && args
                    .iter()
                    .all(|arg| matches!(arg.as_str(), "-t" | "-T" | "-v" | "-V"))
        }
        "apachectl" | "apache2ctl" | "httpd" => {
            !args.is_empty()
                && args.iter().all(|arg| {
                    matches!(
                        arg.as_str(),
                        "-t" | "-S"
                            | "-V"
                            | "-v"
                            | "-M"
                            | "-l"
                            | "configtest"
                            | "status"
                            | "fullstatus"
                    )
                })
        }
        "ufw" => matches!(
            args.iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice(),
            ["status"] | ["status", "verbose"] | ["status", "numbered"] | ["version"]
        ),
        "coredumpctl" => is_read_only_coredumpctl(args),
        "localectl" => args.is_empty() || (args.len() == 1 && args[0] == "status"),
        "loginctl" => is_read_only_loginctl(args),
        "resolvectl" | "systemd-resolve" => is_read_only_resolvectl(args),
        "ethtool" => is_read_only_ethtool(args),
        "fail2ban-client" => {
            matches!(
                args.iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice(),
                ["status"] | ["ping"] | ["version"]
            ) || (args.len() == 2 && args[0] == "status" && !args[1].starts_with('-'))
        }
        "redis-cli" => {
            (args.len() == 1
                && (args[0].eq_ignore_ascii_case("ping") || args[0].eq_ignore_ascii_case("info")))
                || (args.len() == 2
                    && args[0].eq_ignore_ascii_case("info")
                    && !args[1].starts_with('-'))
        }
        "pg_isready" => is_read_only_pg_isready(args),
        "sestatus" => args.is_empty() || (args.len() == 1 && args[0] == "-v"),
        "getenforce" | "aa-status" | "apparmor_status" => args.is_empty(),
        "sed" => is_read_only_sed(args),
        "awk" => is_read_only_awk(args),
        "find" => !args.iter().any(|arg| {
            arg.starts_with("-exec")
                || arg.starts_with("-ok")
                || arg == "-delete"
                || arg == "--delete"
                || arg.starts_with("-fprint")
                || arg.starts_with("-fls")
                || arg == "-files0-from"
                || arg.starts_with("-files0-from=")
        }),
        _ => false,
    }
}

fn is_read_only_hostname(args: &[String]) -> bool {
    args.iter().all(|arg| {
        matches!(
            arg.as_str(),
            "-f" | "--fqdn"
                | "--long"
                | "-s"
                | "--short"
                | "-i"
                | "--ip-address"
                | "-I"
                | "--all-ip-addresses"
                | "-a"
                | "--alias"
                | "-d"
                | "--domain"
                | "-A"
                | "--all-fqdns"
                | "-v"
                | "--verbose"
                | "-V"
                | "--version"
        )
    })
}

fn is_read_only_date(args: &[String]) -> bool {
    let mut expect_value = false;
    for arg in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        if arg == "-s"
            || arg == "--set"
            || arg.starts_with("--set=")
            || arg == "-f"
            || arg == "--file"
            || arg.starts_with("--file=")
            || short_flags_contain(arg, 's')
            || short_flags_contain(arg, 'f')
        {
            return false;
        }
        if matches!(
            arg.as_str(),
            "-d" | "--date" | "-r" | "--reference" | "--rfc-3339"
        ) {
            expect_value = true;
            continue;
        }
        if arg.starts_with("--date=")
            || arg.starts_with("--reference=")
            || arg.starts_with("--rfc-3339=")
            || arg.starts_with("--iso-8601")
        {
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        if !arg.starts_with('+') {
            return false;
        }
    }
    !expect_value
}

fn is_read_only_dmesg(args: &[String]) -> bool {
    !args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--clear"
                | "--read-clear"
                | "--console-level"
                | "--console-off"
                | "--console-on"
                | "--file"
                | "--syslog"
        ) || arg.starts_with("--console-level=")
            || arg.starts_with("--file=")
            || short_flags_contain(arg, 'c')
            || short_flags_contain(arg, 'C')
            || short_flags_contain(arg, 'n')
            || short_flags_contain(arg, 'D')
            || short_flags_contain(arg, 'E')
            || short_flags_contain(arg, 'F')
            || short_flags_contain(arg, 'S')
    })
}

fn is_read_only_sort(args: &[String]) -> bool {
    !args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--output" | "--compress-program" | "--temporary-directory" | "--files0-from"
        ) || arg.starts_with("--output=")
            || arg.starts_with("--compress-program=")
            || arg.starts_with("--temporary-directory=")
            || arg.starts_with("--files0-from=")
            || short_flags_contain(arg, 'o')
            || short_flags_contain(arg, 'T')
            || short_flags_contain(arg, 'S')
    })
}

fn is_read_only_uniq(args: &[String]) -> bool {
    let mut positional_count = 0usize;
    let mut expect_value = false;
    for arg in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        if matches!(
            arg.as_str(),
            "-f" | "--skip-fields" | "-s" | "--skip-chars" | "-w" | "--check-chars"
        ) {
            expect_value = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        positional_count += 1;
        if positional_count > 1 {
            return false;
        }
    }
    !expect_value
}

fn is_read_only_ss(args: &[String]) -> bool {
    !args.iter().any(|arg| {
        matches!(arg.as_str(), "--kill" | "--diag" | "--net" | "--filter")
            || arg.starts_with("--diag=")
            || arg.starts_with("--net=")
            || arg.starts_with("--filter=")
            || short_flags_contain(arg, 'K')
            || short_flags_contain(arg, 'D')
            || short_flags_contain(arg, 'N')
            || short_flags_contain(arg, 'F')
    })
}

fn is_read_only_systemctl(args: &[String]) -> bool {
    const SAFE_SUBCOMMANDS: &[&str] = &[
        "status",
        "is-active",
        "is-failed",
        "is-enabled",
        "list-units",
        "list-unit-files",
        "list-timers",
        "list-sockets",
        "list-dependencies",
        "show",
        "cat",
    ];
    const MUTATING_SUBCOMMANDS: &[&str] = &[
        "start",
        "stop",
        "restart",
        "reload",
        "try-restart",
        "reload-or-restart",
        "kill",
        "enable",
        "disable",
        "mask",
        "unmask",
        "daemon-reload",
        "edit",
        "set-property",
        "isolate",
        "poweroff",
        "reboot",
        "halt",
        "suspend",
        "hibernate",
        "rescue",
        "emergency",
        "reset-failed",
        "clean",
        "freeze",
        "thaw",
    ];

    let mut positionals = Vec::new();
    let mut expect_value = false;
    for arg in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        if matches!(
            arg.as_str(),
            "-t" | "--type"
                | "-p"
                | "--property"
                | "-n"
                | "--lines"
                | "-o"
                | "--output"
                | "--state"
        ) {
            expect_value = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "--no-pager"
                | "--no-legend"
                | "--full"
                | "-l"
                | "--all"
                | "-a"
                | "--failed"
                | "--user"
                | "--system"
                | "-q"
                | "--quiet"
                | "--plain"
                | "--reverse"
        ) || arg.starts_with("--state=")
            || arg.starts_with("--type=")
            || arg.starts_with("-t=")
            || arg.starts_with("--property=")
            || arg.starts_with("-p=")
            || arg.starts_with("--lines=")
            || arg.starts_with("-n=")
            || arg.starts_with("--output=")
            || arg.starts_with("-o=")
            || is_short_flag_cluster_only(arg, &['l', 'a', 'q'])
        {
            continue;
        }
        if arg.starts_with('-') {
            return false;
        }
        positionals.push(arg.as_str());
    }
    if expect_value {
        return false;
    }
    let Some(&subcommand) = positionals.first() else {
        return false;
    };
    SAFE_SUBCOMMANDS.contains(&subcommand)
        && !positionals
            .iter()
            .any(|token| MUTATING_SUBCOMMANDS.contains(token))
}

fn is_read_only_journalctl(args: &[String]) -> bool {
    !args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--follow"
                | "--rotate"
                | "--flush"
                | "--relinquish-var"
                | "--smart-relinquish-var"
                | "--sync"
                | "--setup-keys"
                | "--update-catalog"
                | "--list-catalog"
                | "--dump-catalog"
                | "--directory"
                | "--file"
                | "--root"
                | "--image"
        ) || arg.starts_with("--follow=")
            || arg.starts_with("--vacuum")
            || arg.starts_with("--directory=")
            || arg.starts_with("--file=")
            || arg.starts_with("--root=")
            || arg.starts_with("--image=")
            || short_flags_contain(arg, 'f')
            || short_flags_contain(arg, 'D')
    })
}

fn is_read_only_ip(args: &[String]) -> bool {
    if args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "-b" | "-batch" | "--batch" | "-force" | "--force" | "-n" | "-netns" | "--netns"
        ) || arg.starts_with("-batch=")
            || arg.starts_with("--batch=")
            || arg.starts_with("-netns=")
            || arg.starts_with("--netns=")
    }) {
        return false;
    }

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

fn is_read_only_sed(args: &[String]) -> bool {
    let mut has_quiet = false;
    let mut expect_expression = false;
    let mut scripts: Vec<&str> = Vec::new();
    let mut positionals: Vec<&str> = Vec::new();

    for arg in args {
        if expect_expression {
            scripts.push(arg.as_str());
            expect_expression = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        if arg == "-e" || arg == "--expression" {
            expect_expression = true;
            continue;
        }
        if let Some(expr) = arg.strip_prefix("--expression=") {
            scripts.push(expr);
            continue;
        }
        if let Some(expr) = arg.strip_prefix("-e") {
            if !expr.is_empty() {
                scripts.push(expr);
                continue;
            }
        }
        if matches!(arg.as_str(), "-n" | "--quiet" | "--silent") {
            has_quiet = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "-E" | "-r"
                | "--regexp-extended"
                | "-u"
                | "--unbuffered"
                | "-s"
                | "--separate"
                | "-z"
                | "--null-data"
                | "--posix"
        ) {
            continue;
        }
        if is_short_flag_cluster_only(arg, &['n', 'E', 'r', 'u', 's', 'z']) {
            if short_flags_contain(arg, 'n') {
                has_quiet = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            return false;
        }
        positionals.push(arg.as_str());
    }

    if expect_expression || !has_quiet {
        return false;
    }
    if scripts.is_empty() {
        let Some(&first) = positionals.first() else {
            return false;
        };
        scripts.push(first);
    }

    !scripts.is_empty() && scripts.into_iter().all(is_safe_sed_print_script)
}

fn parse_sed_address(bytes: &[u8], mut idx: usize, allow_relative: bool) -> Option<usize> {
    if idx >= bytes.len() {
        return None;
    }
    if allow_relative && bytes[idx] == b'+' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        return (idx > start).then_some(idx);
    }
    if bytes[idx] == b'$' {
        return Some(idx + 1);
    }
    if bytes[idx].is_ascii_digit() {
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        return Some(idx);
    }
    if bytes[idx] == b'/' {
        idx += 1;
        let content_start = idx;
        while idx < bytes.len() {
            match bytes[idx] {
                b'\\' => {
                    if idx + 1 >= bytes.len() {
                        return None;
                    }
                    idx += 2;
                }
                b'\n' | b'\r' => return None,
                b'/' => return (idx > content_start).then_some(idx + 1),
                _ => idx += 1,
            }
        }
        return None;
    }
    None
}

fn is_safe_sed_print_script(script: &str) -> bool {
    let bytes = script.as_bytes();
    let mut idx = 0usize;
    let mut clause_count = 0usize;

    while idx < bytes.len() {
        while idx < bytes.len() && (bytes[idx].is_ascii_whitespace() || bytes[idx] == b';') {
            idx += 1;
        }
        if idx >= bytes.len() {
            break;
        }

        if let Some(next) = parse_sed_address(bytes, idx, false) {
            idx = next;
            while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
                idx += 1;
            }
            if idx < bytes.len() && bytes[idx] == b',' {
                idx += 1;
                while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
                    idx += 1;
                }
                let Some(end_addr) = parse_sed_address(bytes, idx, true) else {
                    return false;
                };
                idx = end_addr;
            }
        }

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b'p' {
            return false;
        }
        idx += 1;
        clause_count += 1;

        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx < bytes.len() && bytes[idx] != b';' {
            return false;
        }
    }

    clause_count > 0
}

fn is_read_only_awk(args: &[String]) -> bool {
    for arg in args {
        if arg == "--" {
            return false;
        }
        if matches!(
            arg.as_str(),
            "-f" | "--file"
                | "-i"
                | "--include"
                | "-l"
                | "--load"
                | "-o"
                | "--pretty-print"
                | "-D"
                | "--debug"
                | "-W"
        ) || arg.starts_with("--file=")
            || arg.starts_with("--include=")
            || arg.starts_with("--load=")
            || arg.starts_with("--pretty-print=")
            || arg.starts_with("--debug=")
            || arg.starts_with("-W")
            || short_flags_contain(arg, 'f')
            || short_flags_contain(arg, 'i')
            || short_flags_contain(arg, 'l')
            || short_flags_contain(arg, 'o')
            || short_flags_contain(arg, 'D')
            || short_flags_contain(arg, 'W')
        {
            return false;
        }

        let lower = arg.to_ascii_lowercase();
        if lower.contains('|')
            || lower.contains('>')
            || lower.contains('<')
            || lower.contains("system")
            || lower.contains("getline")
            || lower.contains("close")
            || lower.contains("fflush")
            || lower.contains("nextfile")
            || lower.contains("environ")
            || lower.contains("procinfo")
            || lower.contains("@include")
            || lower.contains("@load")
        {
            return false;
        }
    }
    true
}

fn is_read_only_docker(args: &[String]) -> bool {
    let Some(sub) = args.first().map(String::as_str) else {
        return false;
    };
    let rest = &args[1..];
    match sub {
        "ps" | "info" | "version" | "images" | "inspect" | "top" | "port" | "diff" => true,
        "stats" => rest.iter().any(|arg| arg == "--no-stream"),
        "logs" => !rest.iter().any(|arg| {
            arg == "-f"
                || arg == "--follow"
                || arg.starts_with("--follow=")
                || short_flags_contain(arg, 'f')
        }),
        "network" | "volume" => rest
            .first()
            .is_some_and(|action| matches!(action.as_str(), "ls" | "list" | "inspect")),
        "compose" => match rest.first().map(String::as_str) {
            Some("ps" | "config" | "images" | "top") => true,
            Some("logs") => !rest[1..].iter().any(|arg| {
                arg == "-f"
                    || arg == "--follow"
                    || arg.starts_with("--follow=")
                    || short_flags_contain(arg, 'f')
            }),
            _ => false,
        },
        _ => false,
    }
}

fn is_read_only_kubectl(args: &[String]) -> bool {
    const SAFE_SUBCOMMANDS: &[&str] = &[
        "get",
        "describe",
        "top",
        "version",
        "cluster-info",
        "api-resources",
        "api-versions",
        "explain",
        "events",
    ];
    let mut subcommand: Option<&str> = None;
    let mut expect_value = false;
    let mut follow_flag = false;
    let mut watch_flag = false;

    for arg in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        let lower = arg.to_ascii_lowercase();
        if lower == "--token"
            || lower.starts_with("--token=")
            || lower == "--kubeconfig"
            || lower.starts_with("--kubeconfig=")
            || lower == "--client-key"
            || lower.starts_with("--client-key=")
            || lower == "--client-certificate"
            || lower.starts_with("--client-certificate=")
            || lower == "--certificate-authority"
            || lower.starts_with("--certificate-authority=")
            || lower == "--as"
            || lower.starts_with("--as=")
            || lower == "--as-group"
            || lower.starts_with("--as-group=")
            || lower == "--as-uid"
            || lower.starts_with("--as-uid=")
            || lower == "--password"
            || lower.starts_with("--password=")
            || lower == "--username"
            || lower.starts_with("--username=")
            || lower == "--output-directory"
            || lower.starts_with("--output-directory=")
        {
            return false;
        }
        if arg == "-f"
            || arg == "--follow"
            || arg.starts_with("--follow=")
            || short_flags_contain(arg, 'f')
        {
            follow_flag = true;
            continue;
        }
        if arg == "-w"
            || arg == "--watch"
            || arg == "--watch-only"
            || arg.starts_with("--watch=")
            || short_flags_contain(arg, 'w')
        {
            watch_flag = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "-n" | "--namespace"
                | "--context"
                | "--cluster"
                | "--user"
                | "-s"
                | "--server"
                | "-o"
                | "--output"
                | "-l"
                | "--selector"
                | "--field-selector"
                | "--sort-by"
                | "--tail"
                | "--since"
                | "--since-time"
                | "-c"
                | "--container"
                | "--limit"
        ) {
            expect_value = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        if subcommand.is_none() {
            subcommand = Some(arg.as_str());
        }
    }

    if expect_value || watch_flag || follow_flag {
        return false;
    }
    subcommand.is_some_and(|sub| sub == "logs" || SAFE_SUBCOMMANDS.contains(&sub))
}

fn is_read_only_coredumpctl(args: &[String]) -> bool {
    let mut positionals: Vec<&str> = Vec::new();
    let mut expect_value = false;
    for arg in args {
        if expect_value {
            expect_value = false;
            continue;
        }
        if arg == "--" {
            return false;
        }
        if arg == "-o"
            || arg == "--output"
            || arg.starts_with("--output=")
            || short_flags_contain(arg, 'o')
        {
            return false;
        }
        if matches!(
            arg.as_str(),
            "-n" | "--since" | "--until" | "-F" | "--field"
        ) {
            expect_value = true;
            continue;
        }
        if matches!(
            arg.as_str(),
            "--no-pager" | "--no-legend" | "-1" | "-r" | "--reverse" | "-q" | "--quiet" | "--all"
        ) || arg.starts_with("-n")
            || arg.starts_with("--since=")
            || arg.starts_with("--until=")
            || arg.starts_with("--field=")
            || arg.starts_with("--json=")
        {
            continue;
        }
        if arg.starts_with('-') {
            return false;
        }
        if matches!(arg.as_str(), "dump" | "debug" | "gdb") {
            return false;
        }
        positionals.push(arg.as_str());
    }
    if expect_value {
        return false;
    }
    positionals.is_empty()
        || positionals
            .first()
            .is_some_and(|sub| matches!(*sub, "list" | "info"))
}

fn is_read_only_loginctl(args: &[String]) -> bool {
    const SAFE_SUBCOMMANDS: &[&str] = &[
        "list-sessions",
        "list-users",
        "list-seats",
        "session-status",
        "user-status",
        "seat-status",
        "show-session",
        "show-user",
        "show-seat",
    ];
    let mut positionals: Vec<&str> = Vec::new();
    for arg in args {
        if arg == "--" {
            return false;
        }
        if matches!(
            arg.as_str(),
            "--no-pager" | "--no-legend" | "-a" | "--all" | "-l" | "--full"
        ) || is_short_flag_cluster_only(arg, &['a', 'l'])
        {
            continue;
        }
        if arg.starts_with('-') {
            return false;
        }
        positionals.push(arg.as_str());
    }
    positionals.is_empty()
        || positionals
            .first()
            .is_some_and(|sub| SAFE_SUBCOMMANDS.contains(sub))
}

fn is_read_only_resolvectl(args: &[String]) -> bool {
    let mut positionals: Vec<&str> = Vec::new();
    for arg in args {
        if arg == "--" {
            return false;
        }
        if matches!(arg.as_str(), "--no-pager" | "--status" | "--statistics") {
            continue;
        }
        if arg.starts_with('-') {
            return false;
        }
        positionals.push(arg.as_str());
    }
    positionals
        .iter()
        .all(|sub| matches!(*sub, "status" | "statistics"))
}

fn is_read_only_ethtool(args: &[String]) -> bool {
    match args {
        [iface] => !iface.starts_with('-'),
        [flag, iface] => {
            matches!(
                flag.as_str(),
                "-i" | "-k"
                    | "-S"
                    | "-g"
                    | "-a"
                    | "-c"
                    | "-l"
                    | "-P"
                    | "-m"
                    | "-T"
                    | "--driver"
                    | "--show-features"
                    | "--statistics"
                    | "--show-ring"
                    | "--show-pause"
                    | "--show-coalesce"
                    | "--show-channels"
                    | "--show-permaddr"
                    | "--dump-module-eeprom"
                    | "--show-time-stamping"
            ) && !iface.starts_with('-')
        }
        _ => false,
    }
}

fn is_read_only_pg_isready(args: &[String]) -> bool {
    let mut expect_value = false;
    for arg in args {
        if expect_value {
            if arg.starts_with('-') {
                return false;
            }
            expect_value = false;
            continue;
        }
        if matches!(arg.as_str(), "-h" | "-p" | "-U" | "-d" | "-t") {
            expect_value = true;
            continue;
        }
        if matches!(arg.as_str(), "-q" | "--quiet" | "-V" | "--version")
            || arg.starts_with("--host=")
            || arg.starts_with("--port=")
            || arg.starts_with("--username=")
            || arg.starts_with("--dbname=")
            || arg.starts_with("--timeout=")
        {
            continue;
        }
        return false;
    }
    !expect_value
}

fn is_destructive_command(command: &str) -> bool {
    for segment in split_command_segments_for_destructive(command) {
        let Some(tokens) = tokenize_stage(&segment) else {
            continue;
        };
        if is_destructive_stage(&tokens) {
            return true;
        }
    }
    false
}

fn split_command_segments_for_destructive(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let chars = command.chars().collect::<Vec<_>>();
    let mut idx = 0usize;

    while idx < chars.len() {
        let ch = chars[idx];
        match ch {
            '\\' if !in_single => {
                if let Some(&next) = chars.get(idx + 1) {
                    current.push(ch);
                    current.push(next);
                    idx += 2;
                    continue;
                }
            }
            '\'' if !in_double => {
                in_single = !in_single;
                current.push(ch);
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(ch);
            }
            '`' if !in_single => {
                let piece = current.trim();
                if !piece.is_empty() {
                    segments.push(piece.to_owned());
                    current.clear();
                }
            }
            '$' if !in_single && chars.get(idx + 1) == Some(&'(') => {
                let piece = current.trim();
                if !piece.is_empty() {
                    segments.push(piece.to_owned());
                    current.clear();
                }
                idx += 2;
                continue;
            }
            ')' if !in_single && !in_double => {
                let piece = current.trim();
                if !piece.is_empty() {
                    segments.push(piece.to_owned());
                    current.clear();
                }
            }
            ';' | '|' | '&' | '\n' | '\r' if !in_single && !in_double => {
                let piece = current.trim();
                if !piece.is_empty() {
                    segments.push(piece.to_owned());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
        idx += 1;
    }

    let tail = current.trim();
    if !tail.is_empty() {
        segments.push(tail.to_owned());
    }
    segments
}

fn unwrap_command_prefix(mut tokens: &[String]) -> &[String] {
    loop {
        while let Some(first) = tokens.first() {
            if !first.starts_with('-') && first.contains('=') && !first.starts_with('/') {
                tokens = &tokens[1..];
            } else {
                break;
            }
        }
        let Some(first) = tokens.first() else {
            return tokens;
        };
        let Some(binary) = normalize_binary_name(first) else {
            return tokens;
        };
        match binary {
            "sudo" | "doas" => {
                let mut idx = 1usize;
                while idx < tokens.len() {
                    let tok = tokens[idx].as_str();
                    if tok == "--" {
                        idx += 1;
                        break;
                    }
                    if matches!(tok, "-u" | "-g" | "-p" | "-C" | "-h") {
                        idx += 2;
                        continue;
                    }
                    if tok.starts_with('-') {
                        idx += 1;
                        continue;
                    }
                    break;
                }
                tokens = &tokens[idx.min(tokens.len())..];
            }
            "env" => {
                let mut idx = 1usize;
                while idx < tokens.len() {
                    let tok = tokens[idx].as_str();
                    if tok == "--" {
                        idx += 1;
                        break;
                    }
                    if matches!(tok, "-u" | "-C" | "-S") {
                        idx += 2;
                        continue;
                    }
                    if tok.starts_with('-') || tok.contains('=') {
                        idx += 1;
                        continue;
                    }
                    break;
                }
                tokens = &tokens[idx.min(tokens.len())..];
            }
            "command" | "nohup" => {
                let mut idx = 1usize;
                while idx < tokens.len() && tokens[idx].starts_with('-') {
                    idx += 1;
                }
                tokens = &tokens[idx..];
            }
            "timeout" => {
                let mut idx = 1usize;
                while idx < tokens.len() && tokens[idx].starts_with('-') {
                    let tok = tokens[idx].as_str();
                    if matches!(tok, "-k" | "-s" | "--signal" | "--kill-after") {
                        idx += 2;
                    } else {
                        idx += 1;
                    }
                }
                if idx < tokens.len() {
                    idx += 1;
                }
                tokens = &tokens[idx.min(tokens.len())..];
            }
            _ => return tokens,
        }
    }
}

fn is_destructive_stage(raw_tokens: &[String]) -> bool {
    let tokens = unwrap_command_prefix(raw_tokens);
    let Some(first) = tokens.first() else {
        return false;
    };
    let Some(binary) = normalize_binary_name(first) else {
        return false;
    };
    let args = &tokens[1..];

    if matches!(
        binary,
        "rm" | "rmdir"
            | "shred"
            | "unlink"
            | "wipefs"
            | "mkfs"
            | "fdisk"
            | "sfdisk"
            | "cfdisk"
            | "parted"
            | "dd"
            | "truncate"
            | "reboot"
            | "shutdown"
            | "poweroff"
            | "halt"
            | "init"
            | "telinit"
            | "kill"
            | "pkill"
            | "killall"
            | "skill"
            | "userdel"
            | "groupdel"
    ) || binary.starts_with("mkfs.")
    {
        return true;
    }

    match binary {
        "find" => args.iter().any(|arg| arg == "-delete" || arg == "--delete"),
        "systemctl" => args.iter().filter(|arg| !arg.starts_with('-')).any(|arg| {
            matches!(
                arg.as_str(),
                "stop"
                    | "restart"
                    | "try-restart"
                    | "reload-or-restart"
                    | "kill"
                    | "disable"
                    | "mask"
                    | "poweroff"
                    | "reboot"
                    | "halt"
                    | "isolate"
                    | "emergency"
                    | "rescue"
            )
        }),
        "service" => args
            .iter()
            .filter(|arg| !arg.starts_with('-'))
            .skip(1)
            .any(|arg| matches!(arg.as_str(), "stop" | "restart" | "force-reload")),
        "docker" | "podman" => {
            let mut pos = args.iter().filter(|arg| !arg.starts_with('-'));
            match pos.next().map(String::as_str) {
                Some("rm" | "rmi" | "kill" | "stop" | "restart" | "prune") => true,
                Some("system" | "volume" | "network" | "container" | "image") => pos
                    .next()
                    .is_some_and(|action| matches!(action.as_str(), "rm" | "remove" | "prune")),
                Some("compose") => pos.next().is_some_and(|action| {
                    matches!(action.as_str(), "down" | "rm" | "stop" | "kill")
                }),
                _ => false,
            }
        }
        "kubectl" => {
            let pos: Vec<&str> = args
                .iter()
                .filter(|arg| !arg.starts_with('-'))
                .map(String::as_str)
                .collect();
            pos.iter()
                .any(|tok| matches!(*tok, "delete" | "drain" | "cordon" | "replace"))
                || pos.windows(2).any(|w| w == ["rollout", "undo"])
        }
        "iptables" | "ip6tables" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-F" | "--flush" | "-X" | "--delete-chain" | "-D" | "--delete" | "-P" | "--policy"
            ) || short_flags_contain(arg, 'F')
                || short_flags_contain(arg, 'X')
                || short_flags_contain(arg, 'D')
                || short_flags_contain(arg, 'P')
        }),
        "nft" => args
            .iter()
            .filter(|arg| !arg.starts_with('-'))
            .any(|arg| matches!(arg.as_str(), "flush" | "delete" | "destroy")),
        "ufw" => args.iter().filter(|arg| !arg.starts_with('-')).any(|arg| {
            matches!(
                arg.as_str(),
                "disable" | "reset" | "delete" | "deny" | "reject"
            )
        }),
        "ip" => {
            let pos: Vec<&str> = args
                .iter()
                .filter(|arg| !arg.starts_with('-'))
                .map(String::as_str)
                .collect();
            pos.iter()
                .any(|arg| matches!(*arg, "del" | "delete" | "flush"))
                || (pos.contains(&"set") && pos.contains(&"down"))
        }
        "ifconfig" => args
            .iter()
            .filter(|arg| !arg.starts_with('-'))
            .any(|arg| arg == "down"),
        "chmod" | "chown" | "chgrp" => args
            .iter()
            .any(|arg| arg == "-R" || arg == "--recursive" || short_flags_contain(arg, 'R')),
        "crontab" => args
            .iter()
            .any(|arg| arg == "-r" || short_flags_contain(arg, 'r')),
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
            "systemctl list-units --type=service --state=failed --no-pager",
            "service nginx status",
            "service --status-all",
            "journalctl -u nginx -n 80 --no-pager",
            "docker ps -a",
            "docker stats --no-stream",
            "docker logs --tail 100 nginx",
            "podman ps -a",
            "podman logs --tail 50 api",
            "ip addr show",
            "ip -br addr show",
            "cat /proc/loadavg",
            "hostname",
            "hostname -f",
            "date",
            "date -u +%FT%T",
            "date -d 'yesterday' +%s",
            "dmesg -T | tail -n 30",
            "sar -u 1 1",
            "sort -nr",
            "uniq -c",
            "uniq -c /var/log/syslog",
            "ulimit -a",
            "nslookup example.com",
            "sed -n '1,50p' /var/log/nginx/error.log",
            "sed -n -e '1,10p' -e '/ERROR/p' /var/log/app.log",
            "awk -F: '{print $1}' /etc/passwd",
            "kubectl get pods -A",
            "kubectl -n prod describe pod web-0",
            "kubectl logs --tail=100 web-0",
            "nginx -t",
            "apachectl -t",
            "ufw status verbose",
            "coredumpctl list --no-pager",
            "localectl status",
            "loginctl list-sessions --no-pager",
            "resolvectl status",
            "ethtool -S eth0",
            "fail2ban-client status sshd",
            "redis-cli info memory",
            "pg_isready -h 127.0.0.1 -p 5432",
            "sestatus",
            "getenforce",
            "lslocks",
            "lsns",
            "lsipc",
            "lsmem",
            "pidstat -u 1 1",
            "numastat",
            "ping -c 4 8.8.8.8",
        ] {
            assert_eq!(
                classify_assistant_command(command),
                AssistantCommandRisk::ReadOnly,
                "expected read_only for: {command}"
            );
        }
    }

    #[test]
    fn rejects_classifier_bypasses_from_read_only() {
        for command in [
            "sed -n '1e rm -rf /tmp/x' /etc/hosts",
            "sed -n 'w /etc/x' /etc/hosts",
            "sed -n '1,5p; w /tmp/out' /etc/hosts",
            "sed -n -f /tmp/evil.sed /etc/hosts",
            "sed -i 's/a/b/' /etc/hosts",
            "awk '{print | \"sh\"}' /etc/passwd",
            "awk 'BEGIN{system (\"id\")}'",
            "awk -f /tmp/evil.awk /etc/passwd",
            "awk '{print $1 > \"/tmp/out\"}' /etc/passwd",
            "systemctl restart nginx status",
            "systemctl stop nginx status",
            "service nginx stop status",
            "hostname newhost",
            "hostname -F /etc/hostname",
            "date -s '2026-01-01'",
            "date 11232100",
            "sort -o /tmp/out /etc/passwd",
            "sort --compress-program=sh /etc/passwd",
            "uniq /etc/hosts /tmp/out",
            "find /tmp -fls /tmp/out",
            "find /tmp -exec id \\;",
            "sar -o /tmp/sa.out 1 1",
            "dmesg -n 1",
            "dmesg -Tc",
            "dmesg -D",
            "journalctl --setup-keys",
            "journalctl --update-catalog",
            "journalctl -xf",
            "ss -K",
            "ip -batch /tmp/cmd.ip addr show",
            "sysctl --system",
            "ping -fc 4 8.8.8.8",
            "nslookup",
            "nslookup -",
            "ulimit -n 65535",
            "pidstat -e id",
            "kubectl logs -f web-0",
            "kubectl get secret db-creds -o yaml",
            "nginx -s reload",
            "ethtool -s eth0 speed 1000",
        ] {
            assert_ne!(
                classify_assistant_command(command),
                AssistantCommandRisk::ReadOnly,
                "bypass should NOT be read_only: {command}"
            );
        }
    }

    #[test]
    fn requires_confirmation_for_mutating_chained_interactive_or_secret_commands() {
        for command in [
            "docker logs -f nginx",
            "tail -f /var/log/syslog",
            "top",
            "cat /etc/shadow",
            "cat ~/.ssh/id_rsa",
            "cat /app/.env",
            "cat /proc/1/environ",
            "cat /home/user/.npmrc",
            "echo test > /tmp/file",
            "ps $(id)",
            "ip route add default via 10.0.0.1",
            "sed -i 's/a/b/' /etc/hosts",
            "systemctl start nginx",
            "systemctl reload nginx",
            "sudo ps aux",
        ] {
            assert_eq!(
                classify_assistant_command(command),
                AssistantCommandRisk::RequiresConfirmation,
                "expected requires_confirmation for: {command}"
            );
        }
    }

    #[test]
    fn classifies_destructive_commands_accurately() {
        for command in [
            "rm -rf /tmp/test",
            "sudo rm -rf /tmp/test",
            "ps aux; rm -rf /tmp/test",
            "ps aux && reboot",
            "echo $(rm -rf /tmp/test)",
            "kill -9 32280",
            "pkill -9 nginx",
            "systemctl restart nginx",
            "systemctl stop nginx",
            "systemctl restart nginx status",
            "service nginx stop status",
            "docker restart mysql",
            "docker rm -f web",
            "docker compose down",
            "podman stop api",
            "kubectl delete pod web-0",
            "kubectl rollout undo deployment/web",
            "iptables -F",
            "ufw disable",
            "ip link set eth0 down",
            "ifconfig eth0 down",
            "chmod -R 777 /var/www",
            "chown -R root:root /var/www",
            "crontab -r",
            "find /tmp -delete",
        ] {
            assert_eq!(
                classify_assistant_command(command),
                AssistantCommandRisk::Destructive,
                "expected destructive for: {command}"
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
