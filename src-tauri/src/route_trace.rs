use std::{
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

use filex_contracts::{AppError, RemoteState, RouteTraceHop, RouteTraceResult};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Command,
    time::timeout,
};

const MAX_TRACE_HOPS: u32 = 25;
const TRACE_TIMEOUT_SECONDS: u64 = 25;
const WHOIS_TIMEOUT_SECONDS: u64 = 5;
const WHOIS_MAX_BYTES: usize = 16 * 1024;
const WHOIS_MAX_LINES: usize = 120;

pub fn validate_trace_target(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 253 || trimmed.starts_with('-') {
        return Err(trace_target_invalid_error());
    }
    if trimmed.parse::<IpAddr>().is_ok() {
        return Ok(trimmed.to_owned());
    }
    let valid_hostname = trimmed.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    if !valid_hostname {
        return Err(trace_target_invalid_error());
    }
    Ok(trimmed.to_owned())
}

pub async fn run_route_trace(
    raw_target: &str,
    include_whois: bool,
    max_hops: Option<u32>,
) -> Result<RouteTraceResult, AppError> {
    let target = validate_trace_target(raw_target)?;
    let max_hops = max_hops.unwrap_or(20).clamp(5, MAX_TRACE_HOPS);
    let resolved_ip = resolve_target_ip(&target).await;
    let trace_host = resolved_ip.as_deref().unwrap_or(&target);

    let (hops, truncated) = execute_local_traceroute(trace_host, max_hops).await?;
    let (whois_lines, whois_summary) = if include_whois {
        let query_target = resolved_ip.as_deref().unwrap_or(&target);
        match query_whois(query_target).await {
            Ok(lines) => {
                let summary = extract_whois_summary(&lines);
                (lines, summary)
            }
            Err(_) => (Vec::new(), None),
        }
    } else {
        (Vec::new(), None)
    };

    Ok(RouteTraceResult {
        target,
        resolved_ip,
        hops,
        whois_lines,
        whois_summary,
        truncated,
    })
}

async fn resolve_target_ip(target: &str) -> Option<String> {
    if let Ok(ip) = target.parse::<IpAddr>() {
        return Some(ip.to_string());
    }
    let owned = target.to_owned();
    tokio::task::spawn_blocking(move || {
        (owned.as_str(), 0)
            .to_socket_addrs()
            .ok()?
            .map(|socket| socket.ip())
            .min_by_key(|ip| if ip.is_ipv4() { 0 } else { 1 })
            .map(|ip| ip.to_string())
    })
    .await
    .ok()
    .flatten()
}

async fn execute_local_traceroute(
    target: &str,
    max_hops: u32,
) -> Result<(Vec<RouteTraceHop>, bool), AppError> {
    let output = run_platform_trace_command(target, max_hops).await?;
    let text = String::from_utf8_lossy(&output);
    let hops = parse_traceroute_output(&text, max_hops);
    let truncated = hops.len() >= max_hops as usize;
    Ok((hops, truncated))
}

#[cfg(target_os = "windows")]
async fn run_platform_trace_command(target: &str, max_hops: u32) -> Result<Vec<u8>, AppError> {
    let mut command = Command::new("tracert");
    command
        .args(["-d", "-h", &max_hops.to_string(), "-w", "750", target])
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(TRACE_TIMEOUT_SECONDS), command.output())
        .await
        .map_err(|_| trace_timeout_error())?
        .map_err(|_| trace_failed_error())?;
    Ok(output.stdout)
}

#[cfg(not(target_os = "windows"))]
async fn run_platform_trace_command(target: &str, max_hops: u32) -> Result<Vec<u8>, AppError> {
    let mut primary = Command::new("traceroute");
    primary
        .args([
            "-n",
            "-m",
            &max_hops.to_string(),
            "-w",
            "1",
            "-q",
            "3",
            target,
        ])
        .kill_on_drop(true);
    if let Ok(result) = timeout(Duration::from_secs(TRACE_TIMEOUT_SECONDS), primary.output()).await
        && let Ok(output) = result
        && !output.stdout.is_empty()
    {
        return Ok(output.stdout);
    }

    let mut fallback = Command::new("tracepath");
    fallback
        .args(["-n", "-m", &max_hops.to_string(), target])
        .kill_on_drop(true);
    let output = timeout(
        Duration::from_secs(TRACE_TIMEOUT_SECONDS),
        fallback.output(),
    )
    .await
    .map_err(|_| trace_timeout_error())?
    .map_err(|_| trace_failed_error())?;
    Ok(output.stdout)
}

pub fn parse_traceroute_output(output: &str, max_hops: u32) -> Vec<RouteTraceHop> {
    let mut hops = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tokens = trimmed.split_whitespace().collect::<Vec<_>>();
        let Some(first) = tokens.first() else {
            continue;
        };
        let hop_str = first.trim_end_matches(':');
        let Ok(hop_number) = hop_str.parse::<u32>() else {
            continue;
        };
        if hop_number == 0 || hop_number > max_hops {
            continue;
        }

        let mut address: Option<String> = None;
        let mut latencies: Vec<f64> = Vec::new();
        let mut timeouts = 0_u32;

        let mut idx = 1;
        while idx < tokens.len() {
            let token = tokens[idx];
            if token == "*" {
                timeouts += 1;
                idx += 1;
                continue;
            }
            if token == "<1" {
                latencies.push(0.5);
                if tokens
                    .get(idx + 1)
                    .is_some_and(|next| next.eq_ignore_ascii_case("ms"))
                {
                    idx += 2;
                } else {
                    idx += 1;
                }
                continue;
            }
            if let Some(ms_text) = token.strip_suffix("ms") {
                let cleaned = ms_text.trim_start_matches('<');
                if let Ok(value) = cleaned.parse::<f64>()
                    && value.is_finite()
                    && value >= 0.0
                {
                    latencies.push(value);
                    idx += 1;
                    continue;
                }
            }
            if tokens
                .get(idx + 1)
                .is_some_and(|next| next.eq_ignore_ascii_case("ms"))
            {
                let cleaned = token.trim_start_matches('<');
                if let Ok(value) = cleaned.parse::<f64>()
                    && value.is_finite()
                    && value >= 0.0
                {
                    latencies.push(value);
                    idx += 2;
                    continue;
                }
            }
            let cleaned_ip = token.trim_matches(|ch| matches!(ch, '(' | ')' | '[' | ']' | ','));
            if address.is_none() && cleaned_ip.parse::<IpAddr>().is_ok() {
                address = Some(cleaned_ip.to_owned());
            }
            idx += 1;
        }

        let responded_probes = latencies.len() as u32;
        let total_probes = responded_probes.saturating_add(timeouts);
        let responded = address.is_some() || responded_probes > 0;
        let loss_percent = if total_probes > 0 {
            ((timeouts as f64 / total_probes as f64) * 100.0).round()
        } else if responded {
            0.0
        } else {
            100.0
        };
        let avg_latency_ms = if latencies.is_empty() {
            None
        } else {
            Some(((latencies.iter().sum::<f64>() / latencies.len() as f64) * 10.0).round() / 10.0)
        };
        let min_latency_ms = latencies
            .iter()
            .copied()
            .reduce(f64::min)
            .map(|value| (value * 10.0).round() / 10.0);
        let max_latency_ms = latencies
            .iter()
            .copied()
            .reduce(f64::max)
            .map(|value| (value * 10.0).round() / 10.0);

        hops.push(RouteTraceHop {
            hop: hop_number,
            address,
            avg_latency_ms,
            min_latency_ms,
            max_latency_ms,
            loss_percent,
            responded,
        });
    }
    hops
}

async fn query_whois(target: &str) -> Result<Vec<String>, ()> {
    let iana = query_single_whois_server("whois.iana.org", target).await?;
    let referral = iana.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("refer:") || lower.starts_with("whois:") {
            let server = line.split_once(':')?.1.trim();
            if valid_whois_server(server) {
                return Some(server.to_owned());
            }
        }
        None
    });

    let body = if let Some(server) = referral {
        let followed = query_single_whois_server(&server, target)
            .await
            .unwrap_or(iana);
        format!("% [{server}]\n{followed}")
    } else {
        iana
    };

    let lines = body
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !line.starts_with('#') && !(line.starts_with('%') && !line.starts_with("% ["))
        })
        .take(WHOIS_MAX_LINES)
        .map(|line| line.chars().take(240).collect::<String>())
        .collect::<Vec<_>>();
    Ok(lines)
}

fn valid_whois_server(server: &str) -> bool {
    !server.is_empty()
        && server.len() <= 128
        && server
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

async fn query_single_whois_server(server: &str, query: &str) -> Result<String, ()> {
    let mut stream = timeout(
        Duration::from_secs(WHOIS_TIMEOUT_SECONDS),
        TcpStream::connect((server, 43)),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let payload = format!("{query}\r\n");
    timeout(
        Duration::from_secs(WHOIS_TIMEOUT_SECONDS),
        stream.write_all(payload.as_bytes()),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 2048];
    loop {
        let read = timeout(
            Duration::from_secs(WHOIS_TIMEOUT_SECONDS),
            stream.read(&mut chunk),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        if read == 0 {
            break;
        }
        let remaining = WHOIS_MAX_BYTES.saturating_sub(buffer.len());
        if remaining == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

pub fn extract_whois_summary(lines: &[String]) -> Option<String> {
    let mut country: Option<String> = None;
    let mut org: Option<String> = None;
    let mut netname: Option<String> = None;

    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.as_str() {
            "country" if country.is_none() => country = Some(value.to_owned()),
            "org-name" | "orgname" | "descr" | "organization" if org.is_none() => {
                org = Some(value.to_owned())
            }
            "netname" if netname.is_none() => netname = Some(value.to_owned()),
            _ => {}
        }
    }

    let parts = [country, org.or(netname)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn trace_target_invalid_error() -> AppError {
    AppError {
        code: "ROUTE_TRACE_TARGET_INVALID".to_owned(),
        message_key: "errors.routeTraceTargetInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some("target".to_owned()),
    }
}

fn trace_timeout_error() -> AppError {
    AppError {
        code: "ROUTE_TRACE_TIMEOUT".to_owned(),
        message_key: "errors.routeTraceTimeout".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

fn trace_failed_error() -> AppError {
    AppError {
        code: "ROUTE_TRACE_FAILED".to_owned(),
        message_key: "errors.routeTraceFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_whois_summary, parse_traceroute_output, validate_trace_target};

    #[test]
    fn validates_trace_targets_strictly() {
        assert_eq!(
            validate_trace_target("123.57.91.172").as_deref(),
            Ok("123.57.91.172")
        );
        assert_eq!(
            validate_trace_target("example.com").as_deref(),
            Ok("example.com")
        );
        assert!(validate_trace_target("-flag").is_err());
        assert!(validate_trace_target("1.1.1.1; rm -rf /").is_err());
        assert!(validate_trace_target("").is_err());
    }

    #[test]
    fn parses_windows_and_unix_traceroute_output() {
        let windows = "\
Tracing route to 123.57.91.172 over a maximum of 20 hops

  1    <1 ms     1 ms     1 ms  192.168.1.1
  2     *        *        *     Request timed out.
  3    12 ms     *       14 ms  10.0.0.1
";
        let hops = parse_traceroute_output(windows, 20);
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0].hop, 1);
        assert_eq!(hops[0].address.as_deref(), Some("192.168.1.1"));
        assert_eq!(hops[0].loss_percent, 0.0);
        assert!(hops[0].responded);
        assert_eq!(hops[1].hop, 2);
        assert_eq!(hops[1].address, None);
        assert_eq!(hops[1].loss_percent, 100.0);
        assert!(!hops[1].responded);
        assert_eq!(hops[2].hop, 3);
        assert_eq!(hops[2].address.as_deref(), Some("10.0.0.1"));
        assert_eq!(hops[2].avg_latency_ms, Some(13.0));
        assert_eq!(hops[2].loss_percent, 33.0);

        let unix = "\
traceroute to 123.57.91.172 (123.57.91.172), 20 hops max, 60 byte packets
 1  10.0.0.1  0.512 ms  0.600 ms  0.588 ms
 2  * * *
";
        let unix_hops = parse_traceroute_output(unix, 20);
        assert_eq!(unix_hops.len(), 2);
        assert_eq!(unix_hops[0].address.as_deref(), Some("10.0.0.1"));
        assert_eq!(unix_hops[0].avg_latency_ms, Some(0.6));
        assert_eq!(unix_hops[1].loss_percent, 100.0);
    }

    #[test]
    fn extracts_whois_summary_from_apnic_lines() {
        let lines = vec![
            "% [whois.apnic.net]".to_owned(),
            "netname: ALISOFT".to_owned(),
            "descr: Aliyun Computing Co., LTD".to_owned(),
            "country: CN".to_owned(),
        ];
        assert_eq!(
            extract_whois_summary(&lines).as_deref(),
            Some("CN · Aliyun Computing Co., LTD")
        );
    }
}
