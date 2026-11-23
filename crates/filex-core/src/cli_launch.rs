use std::fmt;
use std::fs::File;
use std::io::Read;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};

use filex_contracts::{AppError, RemoteState};

const CLI_LAUNCH_SESSION_FILE_MAX_BYTES: usize = 256 * 1024;
const CLI_LAUNCH_USERNAME_MAX_CHARS: usize = 256;
const CLI_LAUNCH_PASSWORD_MAX_BYTES: usize = 16 * 1024;
const CLI_LAUNCH_DISPLAY_NAME_MAX_CHARS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliLaunchProtocol {
    Ssh,
    Sftp,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ParsedCliLaunch {
    pub protocol: CliLaunchProtocol,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub display_name: Option<String>,
    pub identity_file: Option<String>,
}

impl fmt::Debug for ParsedCliLaunch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ParsedCliLaunch")
            .field("protocol", &self.protocol)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("display_name", &self.display_name)
            .field("identity_file", &self.identity_file)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliLaunchOutcome {
    None,
    Launch(ParsedCliLaunch),
    Error(AppError),
}

pub fn parse_cli_launch_args(args: &[String], cwd: Option<&Path>) -> CliLaunchOutcome {
    let tokens = args.get(1..).unwrap_or(&[]);
    if tokens.is_empty() {
        return CliLaunchOutcome::None;
    }

    let mut explicit_launch = false;
    let mut default_protocol = CliLaunchProtocol::Ssh;
    let mut url_spec: Option<String> = None;
    let mut session_file: Option<String> = None;
    let mut display_name: Option<String> = None;
    let mut identity_file: Option<String> = None;
    let mut username_override: Option<String> = None;
    let mut port_override: Option<u16> = None;
    let mut password_override: Option<String> = None;

    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].trim();
        index += 1;
        if token.is_empty() {
            continue;
        }

        if let Some((flag, inline_value)) = split_known_flag(token) {
            match flag {
                KnownFlag::Url => {
                    explicit_launch = true;
                    match take_flag_value(inline_value, tokens, &mut index) {
                        Some(value) => url_spec = Some(value),
                        None => return CliLaunchOutcome::Error(invalid_target_error()),
                    }
                }
                KnownFlag::NewTab => {
                    if let Some(value) = inline_value {
                        if let Some(clean) = normalize_display_name(value) {
                            display_name = Some(clean);
                        }
                    } else if let Some(next) = tokens.get(index)
                        && is_tab_name_candidate(next)
                    {
                        index += 1;
                        if let Some(clean) = normalize_display_name(next) {
                            display_name = Some(clean);
                        }
                    }
                }
                KnownFlag::Ignore => {}
                KnownFlag::Title => match take_flag_value(inline_value, tokens, &mut index) {
                    Some(value) => {
                        if let Some(clean) = normalize_display_name(&value) {
                            display_name = Some(clean);
                        }
                    }
                    None => return CliLaunchOutcome::Error(invalid_target_error()),
                },
                KnownFlag::Identity => match take_flag_value(inline_value, tokens, &mut index) {
                    Some(value) => identity_file = Some(value),
                    None => return CliLaunchOutcome::Error(invalid_target_error()),
                },
                KnownFlag::SessionFile => {
                    explicit_launch = true;
                    match take_flag_value(inline_value, tokens, &mut index) {
                        Some(value) => session_file = Some(value),
                        None => return CliLaunchOutcome::Error(invalid_target_error()),
                    }
                }
                KnownFlag::User => {
                    explicit_launch = true;
                    match take_flag_value(inline_value, tokens, &mut index) {
                        Some(value) => username_override = Some(value),
                        None => return CliLaunchOutcome::Error(invalid_target_error()),
                    }
                }
                KnownFlag::Port => {
                    explicit_launch = true;
                    let Some(value) = take_flag_value(inline_value, tokens, &mut index) else {
                        return CliLaunchOutcome::Error(invalid_target_error());
                    };
                    match parse_port_value(&value) {
                        Some(port) => port_override = Some(port),
                        None => return CliLaunchOutcome::Error(invalid_target_error()),
                    }
                }
                KnownFlag::Password => {
                    explicit_launch = true;
                    match take_flag_value(inline_value, tokens, &mut index) {
                        Some(value) => password_override = Some(value),
                        None => return CliLaunchOutcome::Error(invalid_target_error()),
                    }
                }
                KnownFlag::Ssh => {
                    explicit_launch = true;
                    default_protocol = CliLaunchProtocol::Ssh;
                }
                KnownFlag::Sftp => {
                    explicit_launch = true;
                    default_protocol = CliLaunchProtocol::Sftp;
                }
            }
            continue;
        }

        if token.starts_with('-') {
            continue;
        }

        if token.contains("://") {
            explicit_launch = true;
            url_spec = Some(token.to_owned());
        } else if has_xsh_extension(token) {
            explicit_launch = true;
            session_file = Some(token.to_owned());
        } else if looks_like_user_at_host(token) {
            explicit_launch = true;
            url_spec = Some(token.to_owned());
        } else if explicit_launch && url_spec.is_none() && session_file.is_none() {
            url_spec = Some(token.to_owned());
        }
    }

    if !explicit_launch {
        return CliLaunchOutcome::None;
    }

    let mut parsed = if let Some(path_value) = session_file {
        let resolved = resolve_path(&path_value, cwd);
        match read_and_parse_xsh_file(&resolved) {
            Ok(parsed) => parsed,
            Err(error) => return CliLaunchOutcome::Error(error),
        }
    } else if let Some(spec) = url_spec {
        match parse_launch_endpoint(&spec, default_protocol) {
            Ok(parsed) => parsed,
            Err(error) => return CliLaunchOutcome::Error(error),
        }
    } else {
        return CliLaunchOutcome::Error(invalid_target_error());
    };

    if let Some(user) = username_override {
        let trimmed = user.trim();
        if !trimmed.is_empty() {
            parsed.username = Some(trimmed.to_owned());
        }
    }
    if let Some(port) = port_override {
        parsed.port = port;
    }
    if let Some(password) = password_override {
        parsed.password = Some(password);
    }
    if let Some(name) = display_name {
        parsed.display_name = Some(name);
    }
    if let Some(key_path) = identity_file {
        let trimmed = key_path.trim();
        if !trimmed.is_empty() {
            parsed.identity_file = Some(resolve_path(trimmed, cwd).to_string_lossy().into_owned());
        }
    } else if let Some(existing_key) = parsed.identity_file.take() {
        let trimmed = existing_key.trim();
        if !trimmed.is_empty() {
            parsed.identity_file = Some(resolve_path(trimmed, cwd).to_string_lossy().into_owned());
        }
    }

    match finalize_parsed_launch(parsed) {
        Ok(valid) => CliLaunchOutcome::Launch(valid),
        Err(error) => CliLaunchOutcome::Error(error),
    }
}

pub fn parse_xsh_session_bytes(
    bytes: &[u8],
    fallback_name: Option<&str>,
) -> Result<ParsedCliLaunch, AppError> {
    if bytes.len() > CLI_LAUNCH_SESSION_FILE_MAX_BYTES {
        return Err(session_file_invalid_error());
    }
    let text = decode_xsh_text(bytes).ok_or_else(session_file_invalid_error)?;
    let mut section = String::new();
    let mut protocol_raw: Option<String> = None;
    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut username: Option<String> = None;
    let mut password: Option<String> = None;
    let mut password_key_present = false;
    let mut auth_method_raw: Option<String> = None;
    let mut public_key_file: Option<String> = None;
    let mut user_key_raw: Option<String> = None;
    let mut description: Option<String> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') && line.len() >= 2 {
            section = line[1..line.len() - 1].trim().to_ascii_uppercase();
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value.trim();

        match section.as_str() {
            "CONNECTION" => match key.as_str() {
                "protocol" if !value.is_empty() => protocol_raw = Some(value.to_owned()),
                "host" if !value.is_empty() => host = Some(value.to_owned()),
                "port" if !value.is_empty() => {
                    port = Some(parse_port_value(value).ok_or_else(session_file_invalid_error)?);
                }
                "description" if !value.is_empty() && !is_default_xsh_description(value) => {
                    description = normalize_display_name(value);
                }
                _ => {}
            },
            "CONNECTION:AUTHENTICATION" => match key.as_str() {
                "username" if !value.is_empty() => username = Some(value.to_owned()),
                "password" => {
                    password_key_present = true;
                    if !value.is_empty() {
                        password = Some(value.to_owned());
                    }
                }
                "method" if !value.is_empty() => auth_method_raw = Some(value.to_owned()),
                "publickeyfile" if !value.is_empty() => public_key_file = Some(value.to_owned()),
                "userkey" if !value.is_empty() => user_key_raw = Some(value.to_owned()),
                _ => {}
            },
            "SESSIONINFO"
                if key == "description"
                    && description.is_none()
                    && !value.is_empty()
                    && !is_default_xsh_description(value) =>
            {
                description = normalize_display_name(value);
            }
            _ => {}
        }
    }

    let protocol = match protocol_raw
        .as_deref()
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        None | Some("") | Some("SSH") | Some("SSH2") => CliLaunchProtocol::Ssh,
        Some("SFTP") => CliLaunchProtocol::Sftp,
        Some(_) => return Err(unsupported_protocol_error()),
    };

    let host = host.ok_or_else(session_file_invalid_error)?;
    let display_name = description.or_else(|| fallback_name.and_then(normalize_display_name));
    let wants_public_key = auth_method_raw.as_deref().is_some_and(|method| {
        method == "1"
            || method.eq_ignore_ascii_case("publickey")
            || method.eq_ignore_ascii_case("public_key")
    });
    let identity_file = if wants_public_key {
        public_key_file
            .or(user_key_raw)
            .filter(|candidate| looks_like_identity_file_path(candidate))
    } else if auth_method_raw.is_none() {
        public_key_file.filter(|candidate| looks_like_identity_file_path(candidate))
    } else {
        None
    };

    if identity_file.is_none()
        && password.is_none()
        && password_key_present
        && is_loopback_host(&host)
    {
        password = Some(String::new());
    }

    finalize_parsed_launch(ParsedCliLaunch {
        protocol,
        host,
        port: port.unwrap_or(22),
        username,
        password,
        display_name,
        identity_file,
    })
}

pub fn parse_launch_endpoint(
    raw_spec: &str,
    default_protocol: CliLaunchProtocol,
) -> Result<ParsedCliLaunch, AppError> {
    let spec = trim_wrapping_quotes(raw_spec.trim());
    if spec.is_empty() {
        return Err(invalid_target_error());
    }

    let (protocol, remainder) = if let Some(scheme_pos) = spec.find("://") {
        let scheme = &spec[..scheme_pos];
        let rest = &spec[scheme_pos + 3..];
        if scheme.eq_ignore_ascii_case("ssh") {
            (CliLaunchProtocol::Ssh, rest)
        } else if scheme.eq_ignore_ascii_case("sftp") {
            (CliLaunchProtocol::Sftp, rest)
        } else {
            return Err(unsupported_protocol_error());
        }
    } else {
        (default_protocol, spec)
    };

    if remainder.is_empty() {
        return Err(invalid_target_error());
    }

    let (userinfo_raw, host, port, trailing) = split_authority_and_trailing(remainder)?;
    let (username, password) = match userinfo_raw {
        Some(userinfo) => parse_userinfo(userinfo),
        None => (None, None),
    };
    let display_name = extract_title_from_trailing(trailing);

    finalize_parsed_launch(ParsedCliLaunch {
        protocol,
        host,
        port,
        username,
        password,
        display_name,
        identity_file: None,
    })
}

#[derive(Clone, Copy)]
enum KnownFlag {
    Url,
    NewTab,
    Ignore,
    Title,
    Identity,
    SessionFile,
    User,
    Port,
    Password,
    Ssh,
    Sftp,
}

fn split_known_flag(token: &str) -> Option<(KnownFlag, Option<&str>)> {
    let (raw_flag, inline_value) = match token.split_once('=') {
        Some((left, right)) => (left, Some(right)),
        None => (token, None),
    };

    let (prefix, name) = if let Some(rest) = raw_flag.strip_prefix("--") {
        ("--", rest)
    } else if let Some(rest) = raw_flag.strip_prefix('-') {
        ("-", rest)
    } else {
        let rest = raw_flag.strip_prefix('/')?;
        ("/", rest)
    };

    let lower = name.to_ascii_lowercase();
    let flag = match (prefix, lower.as_str()) {
        (_, "url") => KnownFlag::Url,
        (_, "newtab") => KnownFlag::NewTab,
        (_, "newwin") | (_, "register") | ("-" | "--", "prop") => KnownFlag::Ignore,
        ("-" | "--", "t") | (_, "title") => KnownFlag::Title,
        ("-" | "--", "i") | ("-" | "--", "identity") => KnownFlag::Identity,
        ("-" | "--", "f") | ("-" | "--", "file") | ("-" | "--", "s") | ("--", "session") => {
            KnownFlag::SessionFile
        }
        (_, "l") | ("-" | "--", "user") => KnownFlag::User,
        (_, "p") | ("-" | "--", "port") => KnownFlag::Port,
        ("-" | "--", "pw") | (_, "password") => KnownFlag::Password,
        (_, "ssh") => KnownFlag::Ssh,
        (_, "sftp") => KnownFlag::Sftp,
        _ => return None,
    };

    Some((flag, inline_value))
}

fn take_flag_value(
    inline_value: Option<&str>,
    tokens: &[String],
    index: &mut usize,
) -> Option<String> {
    if let Some(value) = inline_value {
        return Some(trim_wrapping_quotes(value).to_owned());
    }
    let value = tokens.get(*index)?;
    *index += 1;
    Some(trim_wrapping_quotes(value).to_owned())
}

fn is_tab_name_candidate(token: &str) -> bool {
    let trimmed = token.trim();
    !(trimmed.is_empty()
        || split_known_flag(trimmed).is_some()
        || trimmed.starts_with('-')
        || trimmed.contains("://")
        || has_xsh_extension(trimmed)
        || looks_like_user_at_host(trimmed))
}

fn has_xsh_extension(token: &str) -> bool {
    let trimmed = trim_wrapping_quotes(token.trim());
    let bytes = trimmed.as_bytes();
    bytes.len() > 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".xsh")
}

fn looks_like_user_at_host(token: &str) -> bool {
    let trimmed = trim_wrapping_quotes(token.trim());
    if trimmed.contains('\\') || trimmed.contains('/') {
        return false;
    }
    let Some((user, host_port)) = trimmed.rsplit_once('@') else {
        return false;
    };
    !user.is_empty() && parse_host_port(host_port).is_some()
}

fn trim_wrapping_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn resolve_path(raw_path: &str, cwd: Option<&Path>) -> PathBuf {
    let path = PathBuf::from(trim_wrapping_quotes(raw_path.trim()));
    if path.is_absolute() {
        return path;
    }
    match cwd {
        Some(base) => base.join(path),
        None => path,
    }
}

fn read_and_parse_xsh_file(path: &Path) -> Result<ParsedCliLaunch, AppError> {
    let file = File::open(path).map_err(|_| session_file_unavailable_error())?;
    let mut bytes = Vec::new();
    file.take((CLI_LAUNCH_SESSION_FILE_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| session_file_unavailable_error())?;
    let fallback_name = path.file_stem().and_then(|stem| stem.to_str());
    parse_xsh_session_bytes(&bytes, fallback_name)
}

fn decode_xsh_text(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16_bytes(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16_bytes(&bytes[2..], false);
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..]).ok().map(str::to_owned);
    }
    if let Ok(text) = std::str::from_utf8(bytes)
        && !text.contains('\0')
    {
        return Some(text.to_owned());
    }
    if bytes.len() >= 4 && bytes.len() % 2 == 0 {
        let even_zeros = bytes.iter().step_by(2).filter(|&&b| b == 0).count();
        let odd_zeros = bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
        if odd_zeros > bytes.len() / 6 && odd_zeros > even_zeros {
            return decode_utf16_bytes(bytes, true);
        }
        if even_zeros > bytes.len() / 6 && even_zeros > odd_zeros {
            return decode_utf16_bytes(bytes, false);
        }
    }
    if !bytes.contains(&0) {
        return Some(String::from_utf8_lossy(bytes).into_owned());
    }
    None
}

fn looks_like_identity_file_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.contains('/') || trimmed.contains('\\') || Path::new(trimmed).exists()
}

fn is_default_xsh_description(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("xshell session file")
}

fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim();
    let unbracketed = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    if unbracketed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    unbracketed
        .parse::<IpAddr>()
        .is_ok_and(|addr| addr.is_loopback())
}

fn decode_utf16_bytes(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units).ok()
}

fn split_authority_and_trailing(
    remainder: &str,
) -> Result<(Option<&str>, String, u16, &str), AppError> {
    for (at_index, _) in remainder.rmatch_indices('@') {
        let after_at = &remainder[at_index + 1..];
        let (host_port_raw, trailing) = split_host_port_and_trailing(after_at);
        if let Some((host, port)) = parse_host_port(host_port_raw) {
            return Ok((Some(&remainder[..at_index]), host, port, trailing));
        }
    }

    let (host_port_raw, trailing) = split_host_port_and_trailing(remainder);
    let (host, port) = parse_host_port(host_port_raw).ok_or_else(invalid_target_error)?;
    Ok((None, host, port, trailing))
}

fn split_host_port_and_trailing(input: &str) -> (&str, &str) {
    match input.find(['/', '?', '#']) {
        Some(idx) => (&input[..idx], &input[idx..]),
        None => (input, ""),
    }
}

fn parse_userinfo(userinfo: &str) -> (Option<String>, Option<String>) {
    if userinfo.is_empty() {
        return (None, None);
    }
    match userinfo.split_once(':') {
        Some((raw_user, raw_password)) => {
            let user = tolerant_percent_decode(raw_user);
            let password = tolerant_percent_decode(raw_password);
            let username = if user.is_empty() { None } else { Some(user) };
            (username, Some(password))
        }
        None => {
            let user = tolerant_percent_decode(userinfo);
            let username = if user.is_empty() { None } else { Some(user) };
            (username, None)
        }
    }
}

fn extract_title_from_trailing(trailing: &str) -> Option<String> {
    let query_start = trailing.find('?')?;
    let after_question = &trailing[query_start + 1..];
    let query = after_question.split('#').next().unwrap_or(after_question);
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case("title") || key.eq_ignore_ascii_case("name") {
            let decoded = tolerant_percent_decode(&value.replace('+', " "));
            if let Some(clean) = normalize_display_name(&decoded) {
                return Some(clean);
            }
        }
    }
    None
}

fn parse_host_port(raw: &str) -> Option<(String, u16)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(after_open) = trimmed.strip_prefix('[') {
        let close = after_open.find(']')?;
        let ipv6_str = &after_open[..close];
        ipv6_str.parse::<Ipv6Addr>().ok()?;
        let rest = &after_open[close + 1..];
        let port = if rest.is_empty() {
            22
        } else {
            let port_str = rest.strip_prefix(':')?;
            parse_port_value(port_str)?
        };
        return Some((ipv6_str.to_owned(), port));
    }

    if trimmed.parse::<Ipv6Addr>().is_ok() {
        return Some((trimmed.to_owned(), 22));
    }

    let (host, port) = match trimmed.rsplit_once(':') {
        Some((host_part, port_part)) if !host_part.contains(':') => {
            (host_part, parse_port_value(port_part)?)
        }
        _ => (trimmed, 22),
    };

    if !is_valid_launch_host(host) {
        return None;
    }
    Some((host.to_owned(), port))
}

fn parse_port_value(raw: &str) -> Option<u16> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = trimmed.parse::<u16>().ok()?;
    if port == 0 { None } else { Some(port) }
}

fn is_valid_launch_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.chars().any(char::is_whitespace) {
        return false;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
    })
}

fn tolerant_percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            output.push((high << 4) | low);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).unwrap_or_else(|_| input.to_owned())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn normalize_display_name(raw: &str) -> Option<String> {
    let trimmed = trim_wrapping_quotes(raw.trim()).trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    let limited: String = trimmed
        .chars()
        .take(CLI_LAUNCH_DISPLAY_NAME_MAX_CHARS)
        .collect();
    Some(limited)
}

fn finalize_parsed_launch(mut parsed: ParsedCliLaunch) -> Result<ParsedCliLaunch, AppError> {
    let trimmed_host = parsed.host.trim();
    let normalized_host = if trimmed_host.starts_with('[') && trimmed_host.ends_with(']') {
        &trimmed_host[1..trimmed_host.len() - 1]
    } else {
        trimmed_host
    };
    if !is_valid_launch_host(normalized_host) || parsed.port == 0 {
        return Err(invalid_target_error());
    }
    parsed.host = normalized_host.to_owned();

    if let Some(username) = parsed.username.take() {
        let trimmed = username.trim();
        if !trimmed.is_empty() {
            if trimmed.chars().count() > CLI_LAUNCH_USERNAME_MAX_CHARS
                || trimmed
                    .chars()
                    .any(|character| character.is_control() || character.is_whitespace())
            {
                return Err(invalid_target_error());
            }
            parsed.username = Some(trimmed.to_owned());
        }
    }

    if let Some(password) = parsed.password.as_ref()
        && password.len() > CLI_LAUNCH_PASSWORD_MAX_BYTES
    {
        return Err(invalid_target_error());
    }

    parsed.display_name = parsed
        .display_name
        .as_deref()
        .and_then(normalize_display_name);

    Ok(parsed)
}

fn invalid_target_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_INVALID_TARGET".to_owned(),
        message_key: "errors.cliLaunchInvalidTarget".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn unsupported_protocol_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_UNSUPPORTED_PROTOCOL".to_owned(),
        message_key: "errors.cliLaunchUnsupportedProtocol".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn session_file_unavailable_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_SESSION_FILE_UNAVAILABLE".to_owned(),
        message_key: "errors.cliLaunchSessionFileUnavailable".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn session_file_invalid_error() -> AppError {
    AppError {
        code: "CLI_LAUNCH_SESSION_FILE_INVALID".to_owned(),
        message_key: "errors.cliLaunchSessionFileInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CliLaunchOutcome, CliLaunchProtocol, parse_cli_launch_args, parse_xsh_session_bytes,
    };

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn returns_none_for_plain_startup_and_unrelated_flags() {
        assert_eq!(
            parse_cli_launch_args(&args(&["filex-desktop.exe"]), None),
            CliLaunchOutcome::None
        );
        assert_eq!(
            parse_cli_launch_args(&args(&["filex-desktop.exe", "--minimized"]), None),
            CliLaunchOutcome::None
        );
    }

    #[test]
    fn parses_xshell_url_with_newtab_and_special_bastion_credentials() {
        let outcome = parse_cli_launch_args(
            &args(&[
                "filex-desktop.exe",
                "-newtab",
                "天玥-核心库",
                "-url",
                "ssh://gw_user@root@10.0.0.5:p@ss#1/2?3@192.168.10.20:5107",
            ]),
            None,
        );
        let CliLaunchOutcome::Launch(parsed) = outcome else {
            panic!("expected launch outcome, got {outcome:?}");
        };
        assert_eq!(parsed.protocol, CliLaunchProtocol::Ssh);
        assert_eq!(parsed.host, "192.168.10.20");
        assert_eq!(parsed.port, 5107);
        assert_eq!(parsed.username.as_deref(), Some("gw_user@root@10.0.0.5"));
        assert_eq!(parsed.password.as_deref(), Some("p@ss#1/2?3"));
        assert_eq!(parsed.display_name.as_deref(), Some("天玥-核心库"));

        let debug = format!("{parsed:?}");
        assert!(!debug.contains("p@ss#1/2?3"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn parses_newtab_without_title_before_url_flag() {
        let outcome = parse_cli_launch_args(
            &args(&[
                "filex-desktop.exe",
                "-newtab",
                "-url",
                "ssh://ops@bastion.internal:2222",
            ]),
            None,
        );
        let CliLaunchOutcome::Launch(parsed) = outcome else {
            panic!("expected launch outcome");
        };
        assert_eq!(parsed.host, "bastion.internal");
        assert_eq!(parsed.port, 2222);
        assert_eq!(parsed.username.as_deref(), Some("ops"));
        assert_eq!(parsed.password, None);
        assert_eq!(parsed.display_name, None);
    }

    #[test]
    fn parses_direct_urls_ipv6_sftp_and_tolerant_percent_encoding() {
        let ssh_outcome = parse_cli_launch_args(
            &args(&[
                "filex-desktop.exe",
                "ssh://user%40corp:100%safe%231@[2001:db8::1]:2222",
            ]),
            None,
        );
        let CliLaunchOutcome::Launch(ssh_parsed) = ssh_outcome else {
            panic!("expected launch outcome");
        };
        assert_eq!(ssh_parsed.protocol, CliLaunchProtocol::Ssh);
        assert_eq!(ssh_parsed.host, "2001:db8::1");
        assert_eq!(ssh_parsed.port, 2222);
        assert_eq!(ssh_parsed.username.as_deref(), Some("user@corp"));
        assert_eq!(ssh_parsed.password.as_deref(), Some("100%safe#1"));

        let sftp_outcome = parse_cli_launch_args(
            &args(&[
                "filex-desktop.exe",
                "sftp://deploy:tok@10.1.2.3?title=Files",
            ]),
            None,
        );
        let CliLaunchOutcome::Launch(sftp_parsed) = sftp_outcome else {
            panic!("expected sftp launch outcome");
        };
        assert_eq!(sftp_parsed.protocol, CliLaunchProtocol::Sftp);
        assert_eq!(sftp_parsed.host, "10.1.2.3");
        assert_eq!(sftp_parsed.port, 22);
        assert_eq!(sftp_parsed.display_name.as_deref(), Some("Files"));
    }

    #[test]
    fn parses_host_only_url_and_identity_flag() {
        let outcome = parse_cli_launch_args(
            &args(&[
                "filex-desktop.exe",
                "-url",
                "10.0.0.8:2200",
                "-i",
                "C:\\keys\\id_ed25519",
            ]),
            None,
        );
        let CliLaunchOutcome::Launch(parsed) = outcome else {
            panic!("expected launch outcome");
        };
        assert_eq!(parsed.host, "10.0.0.8");
        assert_eq!(parsed.port, 2200);
        assert_eq!(parsed.username, None);
        assert_eq!(
            parsed.identity_file.as_deref(),
            Some("C:\\keys\\id_ed25519")
        );
    }

    #[test]
    fn rejects_unsupported_protocols() {
        let outcome = parse_cli_launch_args(
            &args(&["filex-desktop.exe", "-url", "telnet://10.0.0.1:23"]),
            None,
        );
        let CliLaunchOutcome::Error(error) = outcome else {
            panic!("expected error outcome");
        };
        assert_eq!(error.code, "CLI_LAUNCH_UNSUPPORTED_PROTOCOL");
    }

    #[test]
    fn parses_utf8_and_utf16le_xsh_session_files() {
        let ini = concat!(
            "[CONNECTION]\r\n",
            "Protocol=SSH\r\n",
            "Host=10.20.30.40\r\n",
            "Port=5107\r\n",
            "[CONNECTION:AUTHENTICATION]\r\n",
            "UserName=bastion_user\r\n",
            "Password=temp_pass\r\n",
        );
        let utf8 = parse_xsh_session_bytes(ini.as_bytes(), Some("prod-db")).expect("parse utf8");
        assert_eq!(utf8.host, "10.20.30.40");
        assert_eq!(utf8.port, 5107);
        assert_eq!(utf8.username.as_deref(), Some("bastion_user"));
        assert_eq!(utf8.password.as_deref(), Some("temp_pass"));
        assert_eq!(utf8.display_name.as_deref(), Some("prod-db"));

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in ini.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let parsed = parse_xsh_session_bytes(&utf16, Some("utf16-node")).expect("parse utf16le");
        assert_eq!(parsed.host, "10.20.30.40");
        assert_eq!(parsed.port, 5107);
        assert_eq!(parsed.username.as_deref(), Some("bastion_user"));

        let telnet_ini = "[CONNECTION]\nProtocol=TELNET\nHost=10.20.30.40\nPort=23\n";
        let err = parse_xsh_session_bytes(telnet_ini.as_bytes(), None).unwrap_err();
        assert_eq!(err.code, "CLI_LAUNCH_UNSUPPORTED_PROTOCOL");
    }

    #[test]
    fn parses_tianyue_local_proxy_xsh_ignoring_dummy_userkey_under_password_method() {
        let ini = concat!(
            "?[TRACE]\n",
            "SockConn=1\n",
            "[SessionInfo]\n",
            "Description=Xshell session file\n",
            "Version=8.1\n",
            "[CONNECTION]\n",
            "Port=63908\n",
            "Protocol=SSH\n",
            "Host=127.0.0.1\n",
            "[CONNECTION:AUTHENTICATION]\n",
            "Password=\n",
            "Method=0\n",
            "AuthMethodList=01\n",
            "UserKey=fake_rsa\n",
            "UserName=cudp\n",
        );
        let parsed = parse_xsh_session_bytes(ini.as_bytes(), Some("cudp(SSH)@172.16.132.58"));
        let parsed = parsed.expect("parse tianyue xsh");
        assert_eq!(parsed.protocol, CliLaunchProtocol::Ssh);
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, 63908);
        assert_eq!(parsed.username.as_deref(), Some("cudp"));
        assert_eq!(parsed.password.as_deref(), Some(""));
        assert_eq!(parsed.identity_file, None);
        assert_eq!(
            parsed.display_name.as_deref(),
            Some("cudp(SSH)@172.16.132.58")
        );
    }
}
