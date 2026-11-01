//! This Mac's Tailscale name, read from `tailscale status --json`, so phone access can fill its public URL.

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
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

/// What a CLI run printed. `status` is `None` when it was killed (timed out or stopped early).
struct Output {
    status: Option<std::process::ExitStatus>,
    out: String,
    err: String,
}

/// Runs `cli args` with a timeout, never through a shell. `stop` sees stdout + stderr so far and can end
/// the run early (it is then killed). Errs if the CLI can't start (not installed there).
fn exec(cli: &str, args: &[&str], timeout: Duration, stop: impl Fn(&str) -> bool) -> std::io::Result<Output> {
    use std::os::unix::process::CommandExt;
    // Its own process group, so a kill also ends what a wrapper script started: /usr/local/bin/tailscale is
    // a `#!/bin/sh` that runs the app's binary without `exec`, and that binary would hold the pipes open.
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    // Read on threads: the peer list can outgrow the pipe buffer, which would stall the child.
    let pump = |mut r: Box<dyn Read + Send>, buf: Arc<Mutex<String>>| {
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n @ 1..) = r.read(&mut chunk) {
                buf.lock().unwrap().push_str(&String::from_utf8_lossy(&chunk[..n]));
            }
        })
    };
    let (out, err) = (Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())));
    let readers = [
        pump(Box::new(child.stdout.take().expect("piped stdout")), out.clone()),
        pump(Box::new(child.stderr.take().expect("piped stderr")), err.clone()),
    ];
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if start.elapsed() < timeout && !stop(&format!("{}{}", out.lock().unwrap(), err.lock().unwrap())) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                // SAFETY: plain syscall; the group is the child's (process_group(0) made its pid the pgid).
                unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // After a kill, something outside the group (a daemonized grandchild) may still hold a pipe: wait briefly,
    // then take what the buffers hold rather than block on it.
    let deadline = Instant::now() + Duration::from_millis(if status.is_some() { 2000 } else { 300 });
    while readers.iter().any(|r| !r.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let take = |b: Arc<Mutex<String>>| std::mem::take(&mut *b.lock().unwrap());
    Ok(Output { status, out: take(out), err: take(err) })
}

/// The first CLI that answers `status --json`, and that status. Blocks up to 2 s per CLI tried.
fn find() -> Option<(&'static str, Tailscale)> {
    // A CLI that runs but gives no status (say, a stale one whose tailscaled is gone) falls through to the next.
    CLIS.iter().find_map(|cli| {
        let o = exec(cli, &["status", "--json"], TIMEOUT, |_| false).ok()?;
        // A stopped backend exits non-zero but still prints its status.
        o.status?;
        Some((*cli, parse(&o.out)?))
    })
}

/// This Mac's Tailscale status, or `None` when the CLI isn't installed or doesn't answer. Blocks up to 2 s per CLI tried.
pub fn detect() -> Option<Tailscale> {
    find().map(|(_, t)| t)
}

/// Where Tailscale Serve sends `https://<this Mac>/` (port 443, path `/`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    /// Nothing is served there.
    None,
    /// This build's phone server.
    Ours,
    /// Another Navarch build's phone server (the installed app's or a dev build's port).
    Navarch,
    /// Anything else: another local server, a file, text, a TCP forward.
    Other,
}

/// The port of a plain `http://127.0.0.1:<port>` (or localhost) proxy target, path `/` or none.
fn local_port(proxy: &str) -> Option<u16> {
    let rest = proxy.strip_prefix("http://")?;
    let (auth, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    let (host, port) = auth.rsplit_once(':')?;
    (path.is_empty() && matches!(host, "127.0.0.1" | "localhost")).then(|| port.parse().ok()).flatten()
}

/// A serve config (the top level or a foreground session's) that uses port 443.
fn uses_443(c: &Value) -> bool {
    c.pointer("/TCP/443").is_some() || c.get("Web").and_then(Value::as_object).is_some_and(|w| w.keys().any(|k| k.ends_with(":443")))
}

/// Reads `tailscale serve status --json`: where 443 `/` goes (for `port`, this build's), and its target as
/// Tailscale shows it. `None` if it isn't a serve config. Funnel on 443 (any path) and a foreground
/// `tailscale serve` on 443 read as `Other`, so Navarch only changes them on an explicit Replace.
pub fn parse_serve(json: &str, port: u16) -> Option<(Route, Option<String>)> {
    let json = json.trim();
    if json.is_empty() || json == "null" {
        return Some((Route::None, None));
    }
    let v: Value = serde_json::from_str(json).ok()?;
    if v.get("Foreground").and_then(Value::as_object).is_some_and(|f| f.values().any(uses_443)) {
        return Some((Route::Other, Some("a foreground tailscale serve".into())));
    }
    let funnel = v
        .get("AllowFunnel")
        .and_then(Value::as_object)
        .is_some_and(|f| f.iter().any(|(k, on)| k.ends_with(":443") && on.as_bool() == Some(true)));
    let (route, target) = parse_root(v.as_object()?, port);
    if funnel {
        let what = target.unwrap_or_else(|| "other paths".into());
        return Some((Route::Other, Some(format!("{what} through Funnel, open to the internet"))));
    }
    Some((route, target))
}

fn parse_root(v: &serde_json::Map<String, Value>, port: u16) -> (Route, Option<String>) {
    if let Some(fwd) = v.get("TCP").and_then(|t| t.get("443")).and_then(|p| p.get("TCPForward")) {
        return (Route::Other, Some(format!("TCP to {}", fwd.as_str().unwrap_or("?"))));
    }
    let web = v.get("Web").and_then(Value::as_object);
    let root = web.into_iter().flatten().filter(|(k, _)| k.ends_with(":443")).find_map(|(_, s)| s.get("Handlers")?.get("/"));
    let Some(h) = root else { return (Route::None, None) };
    let Some(proxy) = h.get("Proxy").and_then(Value::as_str) else {
        let what = if h.get("Path").is_some() { "a file or folder" } else { "text" };
        return (Route::Other, Some(what.into()));
    };
    let route = match local_port(proxy) {
        Some(p) if p == port => Route::Ours,
        Some(p) if p == crate::mobile::PORT || p == crate::mobile::DEV_PORT => Route::Navarch,
        _ => Route::Other,
    };
    (route, Some(proxy.to_string()))
}

/// The `https://login.tailscale.com/...` link the first `serve` prints on a tailnet without HTTPS.
fn login_url(text: &str) -> Option<String> {
    let at = text.find("https://login.tailscale.com/")?;
    let url: String = text[at..].chars().take_while(|c| c.is_ascii_graphic()).collect();
    Some(url.trim_end_matches(['.', ',', ')', '"', '\'']).to_string())
}

/// Tailscale Serve as the phone popover shows it.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Serve {
    /// The Tailscale CLI answered.
    pub cli: bool,
    /// Connected to the tailnet.
    pub running: bool,
    pub dns_name: Option<String>,
    /// Where 443 `/` goes; none without the CLI, while disconnected, or if serve status can't be read.
    pub route: Option<Route>,
    /// The route's target as Tailscale shows it, e.g. `http://127.0.0.1:47820`.
    pub target: Option<String>,
    /// This build (the installed app) points Serve at itself when phone access is on; dev builds only on request.
    pub auto: bool,
    /// Serve needs HTTPS enabled for the tailnet first: this page does it.
    pub login_url: Option<String>,
    /// What this call changed, for a toast.
    pub changed: Option<String>,
    pub error: Option<String>,
}

const CHANGE_TIMEOUT: Duration = Duration::from_secs(10);

fn first_line(o: &Output) -> String {
    let text = if o.err.trim().is_empty() { &o.out } else { &o.err };
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output").to_string()
}

fn read_status(port: u16, auto: bool) -> (Option<&'static str>, Serve) {
    let mut s = Serve { auto, ..Default::default() };
    let Some((cli, ts)) = find() else { return (None, s) };
    (s.cli, s.running, s.dns_name) = (true, ts.running, ts.dns_name);
    if !s.running {
        return (Some(cli), s);
    }
    match exec(cli, &["serve", "status", "--json"], TIMEOUT, |_| false) {
        Ok(o) if o.status.is_some_and(|st| st.success()) => match parse_serve(&o.out, port) {
            Some((route, target)) => (s.route, s.target) = (Some(route), target),
            None => s.error = Some("Can't read tailscale serve status".into()),
        },
        Ok(o) if o.status.is_none() => s.error = Some("tailscale serve status didn't answer".into()),
        Ok(o) => s.error = Some(format!("tailscale serve status: {}", first_line(&o))),
        Err(e) => s.error = Some(e.to_string()),
    }
    (Some(cli), s)
}

/// Where Tailscale Serve sends this Mac's https address. Blocks up to a few seconds.
pub fn serve_status(port: u16, auto: bool) -> Serve {
    read_status(port, auto).1
}

/// Points 443 `/` at `http://127.0.0.1:<port>` (`on`), or removes that mapping if it is ours (`!on`).
/// Turning on takes over an unset route, a dev build's when `auto` (the installed app), and anything else
/// only with `replace`. Blocks up to 10 s more; a tailnet without HTTPS gets `login_url` and no change.
pub fn serve(port: u16, auto: bool, on: bool, replace: bool) -> Serve {
    let (cli, mut s) = read_status(port, auto);
    let (Some(cli), Some(route)) = (cli, s.route) else { return s };
    let target = format!("http://127.0.0.1:{port}");
    let args: &[&str] = match (on, route) {
        (true, Route::Ours) | (false, Route::None | Route::Navarch | Route::Other) => return s,
        (true, Route::Navarch | Route::Other) if !replace && !(auto && route == Route::Navarch) => return s,
        (true, _) => &["serve", "--bg", "--yes", "--https=443", &target],
        (false, Route::Ours) => &["serve", "--yes", "--https=443", "off"],
    };
    let o = match exec(cli, args, CHANGE_TIMEOUT, |text| login_url(text).is_some_and(|u| text.contains(&format!("{u}\n")))) {
        Ok(o) => o,
        Err(e) => {
            s.error = Some(e.to_string());
            return s;
        }
    };
    if let Some(url) = login_url(&format!("{}\n{}", o.out, o.err)) {
        s.login_url = Some(url);
        s.error = Some("Tailscale Serve needs HTTPS enabled for your tailnet".into());
        return s;
    }
    match o.status {
        None => s.error = Some("tailscale serve didn't finish in 10 s".into()),
        Some(st) if !st.success() => s.error = Some(format!("tailscale serve: {}", first_line(&o))),
        Some(_) => {
            let name = s.dns_name.clone().unwrap_or_else(|| "this Mac".into());
            let mut after = serve_status(port, auto);
            after.changed = Some(if on {
                format!("Tailscale now serves https://{name} from this Mac")
            } else {
                format!("Tailscale no longer serves https://{name}")
            });
            return after;
        }
    }
    s
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
        assert!(exec("/nonexistent/tailscale", &["status", "--json"], TIMEOUT, |_| false).is_err());
    }

    #[test]
    fn runs_end_early_on_request_and_on_timeout() {
        let o = exec("/bin/sh", &["-c", "echo visit https://login.tailscale.com/f/serve?node=abc; sleep 5"], TIMEOUT, |t| t.contains('\n')).unwrap();
        assert!(o.status.is_none());
        assert_eq!(login_url(&o.out).as_deref(), Some("https://login.tailscale.com/f/serve?node=abc"));
        let o = exec("/bin/sh", &["-c", "sleep 5"], Duration::from_millis(100), |_| false).unwrap();
        assert!(o.status.is_none());
        // A wrapper that runs the real CLI without `exec` (as /usr/local/bin/tailscale does): the kill must
        // reach the grandchild too, or its open pipes would hold the run up past the timeout.
        let t = Instant::now();
        let o = exec("/bin/sh", &["-c", "sleep 5; true"], Duration::from_millis(100), |_| false).unwrap();
        assert!(o.status.is_none());
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        let o = exec("/bin/sh", &["-c", "echo out; echo err >&2; exit 3"], TIMEOUT, |_| false).unwrap();
        assert_eq!((o.status.and_then(|s| s.code()), o.out.as_str(), first_line(&o).as_str()), (Some(3), "out\n", "err"));
    }

    /// `tailscale serve status --json` as Tailscale 1.104 prints it, with a fictional name.
    fn serve_json(proxy: &str) -> String {
        format!(r#"{{"TCP":{{"443":{{"HTTPS":true}}}},"Web":{{"mac.tail1234.ts.net:443":{{"Handlers":{{"/":{{"Proxy":"{proxy}"}}}}}}}}}}"#)
    }

    #[test]
    fn reads_where_serve_sends_the_root() {
        use crate::mobile::{DEV_PORT, PORT};
        let ours = serve_json("http://127.0.0.1:47820");
        assert_eq!(parse_serve(&ours, PORT), Some((Route::Ours, Some("http://127.0.0.1:47820".into()))));
        assert_eq!(parse_serve(&ours, DEV_PORT).unwrap().0, Route::Navarch);
        assert_eq!(parse_serve(&serve_json("http://localhost:47821"), DEV_PORT).unwrap().0, Route::Ours);
        assert_eq!(parse_serve(&serve_json("http://127.0.0.1:47821"), 50000).unwrap().0, Route::Navarch);
        for other in ["http://127.0.0.1:3000", "http://127.0.0.1:47820/api", "https+insecure://localhost:47820", "http://10.0.0.2:47820"] {
            assert_eq!(parse_serve(&serve_json(other), PORT).unwrap().0, Route::Other, "{other}");
        }
        let text = r#"{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Text":"hi"}}}}}"#;
        assert_eq!(parse_serve(text, PORT), Some((Route::Other, Some("text".into()))));
        let tcp = r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:22"}}}"#;
        assert_eq!(parse_serve(tcp, PORT).unwrap().0, Route::Other);
        // Other paths or ports leave / on 443 free.
        let elsewhere = r#"{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/grafana":{"Proxy":"http://127.0.0.1:3000"}}},"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(parse_serve(elsewhere, PORT), Some((Route::None, None)));
        // Funnel on 443, at / or on another path, and a foreground serve on 443 are never taken over unasked.
        let funneled = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47820"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":true}}"#;
        assert_eq!(
            parse_serve(funneled, PORT),
            Some((Route::Other, Some("http://127.0.0.1:47820 through Funnel, open to the internet".into())))
        );
        let funneled_elsewhere = r#"{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/blog":{"Path":"/srv/blog"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":true}}"#;
        assert_eq!(parse_serve(funneled_elsewhere, PORT).unwrap().0, Route::Other);
        let funnel_off = r#"{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47820"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":false,"mac.tail1234.ts.net:8443":true}}"#;
        assert_eq!(parse_serve(funnel_off, PORT).unwrap().0, Route::Ours);
        let foreground = r#"{"Foreground":{"abc123":{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}}}"#;
        assert_eq!(parse_serve(foreground, PORT), Some((Route::Other, Some("a foreground tailscale serve".into()))));
        let foreground_8443 = r#"{"Foreground":{"abc123":{"TCP":{"8443":{"HTTPS":true}}}}}"#;
        assert_eq!(parse_serve(foreground_8443, PORT), Some((Route::None, None)));
        for none in ["", "{}", "null", "\n"] {
            assert_eq!(parse_serve(none, PORT), Some((Route::None, None)), "{none:?}");
        }
        for bad in ["[]", "serve config not found", "{"] {
            assert_eq!(parse_serve(bad, PORT), None, "{bad}");
        }
    }

    #[test]
    fn finds_the_login_link() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXyz123CNTRL\n";
        assert_eq!(login_url(out).as_deref(), Some("https://login.tailscale.com/f/serve?node=nXyz123CNTRL"));
        assert_eq!(login_url("all good"), None);
    }

    #[test]
    #[ignore = "asks this Mac's Tailscale: cargo test live_detect -- --ignored --nocapture"]
    fn live_detect() {
        println!("{:?}", detect());
        println!("{:?}", serve_status(crate::mobile::PORT, false));
    }
}
