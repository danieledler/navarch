//! This Mac's Tailscale name, read from `tailscale status --json`, so phone access can fill its public URL.

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(2);
/// A GUI app's PATH is only /usr/bin:/bin:/usr/sbin:/sbin, so the usual install places are tried after it.
const CLIS: &[&str] = &[
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tailscale {
    /// Connected to the tailnet (`BackendState` is `Running`).
    pub running: bool,
    /// This Mac's MagicDNS name without the trailing dot, e.g. `mac.tail1234.ts.net`; none while logged out.
    pub dns_name: Option<String>,
}

/// Reads `tailscale status --json` output; `None` if it isn't a status object.
pub fn parse(json: &str) -> Option<Tailscale> {
    let v: Value = serde_json::from_str(json).ok()?;
    let state = v.get("BackendState")?.as_str()?;
    let dns_name = v
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    Some(Tailscale { running: state == "Running", dns_name })
}

/// Runs one CLI with a timeout. `None` if it can't start (not installed there), times out, or prints no status.
fn run(cli: &str) -> Result<Option<Tailscale>, std::io::Error> {
    let mut child = Command::new(cli)
        .args(["status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    // Read on a thread: the peer list can outgrow the pipe buffer, which would stall the child.
    let mut out = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
        }
    }
    // A stopped backend exits non-zero but still prints its status.
    Ok(reader.join().ok().and_then(|s| parse(&s)))
}

/// This Mac's Tailscale status, or `None` when the CLI isn't installed or doesn't answer. Blocks up to 2 s per CLI tried.
pub fn detect() -> Option<Tailscale> {
    // A CLI that runs but gives no status (say, a stale one whose tailscaled is gone) falls through to the next.
    CLIS.iter().find_map(|cli| run(cli).ok().flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_name_and_state() {
        let running = r#"{"Version":"1.90.0","BackendState":"Running","Self":{"DNSName":"Mac.tail1234.ts.net.","HostName":"mac"},"MagicDNSSuffix":"tail1234.ts.net","Peer":{}}"#;
        assert_eq!(parse(running), Some(Tailscale { running: true, dns_name: Some("mac.tail1234.ts.net".into()) }));
        let stopped = r#"{"BackendState":"Stopped","Self":{"DNSName":"mac.tail1234.ts.net."}}"#;
        assert_eq!(parse(stopped), Some(Tailscale { running: false, dns_name: Some("mac.tail1234.ts.net".into()) }));
        let logged_out = r#"{"BackendState":"NeedsLogin","Self":{"DNSName":""}}"#;
        assert_eq!(parse(logged_out), Some(Tailscale { running: false, dns_name: None }));
        assert_eq!(parse(r#"{"BackendState":"NoState"}"#), Some(Tailscale { running: false, dns_name: None }));
        for bad in ["", "failed to connect to local tailscaled", "{}", "[]", r#"{"BackendState":1}"#] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_missing_cli_is_none() {
        assert!(run("/nonexistent/tailscale").is_err());
    }

    #[test]
    #[ignore = "asks this Mac's Tailscale: cargo test live_detect -- --ignored --nocapture"]
    fn live_detect() {
        println!("{:?}", detect());
    }
}
