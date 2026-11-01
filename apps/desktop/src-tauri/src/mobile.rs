//! Phone access: its settings, the token, pairing codes and the local server's lifecycle. The server
//! listens on 127.0.0.1 only; `tailscale serve` or a Cloudflare tunnel brings it to the phone. Routes
//! are in http.rs.

use crate::db::{self, Res};
use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

pub const SETTING_KEY: &str = "mobile";
const TOKEN_KEY: &str = "mobile_token";
const PAIRED_AT_KEY: &str = "mobile_paired_at";
/// The installed app's port; every other build uses `DEV_PORT`, so both can run at once.
pub const PORT: u16 = 47820;
pub const DEV_PORT: u16 = 47821;
/// Overrides `DEV_PORT`, so two dev runs can serve at once. The installed app ignores it.
pub const PORT_ENV: &str = "NAVARCH_PHONE_PORT";

/// The port a build listens on: `PORT` for the installed app, else `PORT_ENV`'s value if it's a port.
pub fn port_for(installed: bool, env: Option<&str>) -> u16 {
    if installed {
        return PORT;
    }
    env.and_then(|v| v.trim().parse::<u16>().ok()).filter(|&p| p != 0).unwrap_or(DEV_PORT)
}
/// Pairing codes avoid characters that read alike (0/O, 1/I/L).
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN: usize = 6;
const CODE_TTL_MS: i64 = 10 * 60_000;
const MAX_MISSES: u32 = 5;
const STOP_WAIT: Duration = Duration::from_secs(3);

/// What the `mobile` setting stores.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Setting {
    pub enabled: bool,
    pub public_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MobileAccess {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub public_url: String,
    pub error: Option<String>,
    pub paired_at: Option<String>,
    /// The last request with the token, since launch.
    pub last_seen_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub code: String,
    pub expires_at: String,
}

struct Pairing {
    code: String,
    expires_at: i64,
    misses: u32,
}

#[derive(Default)]
struct Config {
    setting: Setting,
    public_host: Option<String>,
    token: Option<String>,
    paired_at: Option<String>,
}

#[derive(Default)]
struct Server {
    generation: u64,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    running: bool,
    error: Option<String>,
}

/// Sends a Tauri event (no payload) to the desktop UI: `SNAPSHOT_CHANGED` or `MOBILE_CHANGED`.
pub type Emit = Box<dyn Fn(&'static str) + Send + Sync>;
/// The phone changed planner data.
pub const SNAPSHOT_CHANGED: &str = "snapshot-changed";
/// `MobileAccess` changed, or the pairing code shown ended: a phone paired, the code locked, the server stopped.
pub const MOBILE_CHANGED: &str = "mobile-changed";

/// The app state as the server's handlers reach it: the app handle in the app, an `Arc` in tests.
pub trait Ctx: AsRef<AppState> + Clone + Send + Sync + 'static {}
impl<T: AsRef<AppState> + Clone + Send + Sync + 'static> Ctx for T {}

pub struct Mobile {
    pub port: u16,
    emit: Emit,
    cfg: Mutex<Config>,
    pairing: Mutex<Option<Pairing>>,
    last_seen: Mutex<Option<String>>,
    server: Mutex<Server>,
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn random<const N: usize>() -> Res<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(db::err)?;
    Ok(b)
}

fn base64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 3);
    for ch in bytes.chunks(3) {
        let n = ch.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=ch.len() {
            out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// 32 random bytes, base64url without padding.
fn new_token() -> Res<String> {
    Ok(base64url(&random::<32>()?))
}

fn new_code() -> Res<String> {
    let mut code = String::with_capacity(CODE_LEN);
    while code.len() < CODE_LEN {
        // Rejection sampling keeps every character equally likely.
        let limit = 256 - 256 % CODE_ALPHABET.len();
        for b in random::<16>()? {
            if (b as usize) < limit && code.len() < CODE_LEN {
                code.push(CODE_ALPHABET[b as usize % CODE_ALPHABET.len()] as char);
            }
        }
    }
    Ok(code)
}

/// Compares in time that depends only on the lengths.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// The host of a URL, lowercased, without scheme, user, port or path.
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let auth = rest.split(['/', '?', '#']).next()?;
    let auth = auth.rsplit_once('@').map_or(auth, |(_, h)| h);
    let host = strip_port(auth).trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty() && !host.contains(char::is_whitespace)).then_some(host)
}

/// A host passes as the configured public host itself or a name under it, so a tailnet domain alone
/// (`tail1234.ts.net`, typed without the Mac's name) still lets `mac.tail1234.ts.net` in. Names under it count
/// only for a `.ts.net` host or one of 3+ labels, so a shared suffix (`duckdns.org`, `mac`) doesn't let in
/// names anyone can register and point at 127.0.0.1.
pub fn host_matches(host: &str, public: &str) -> bool {
    if public.is_empty() {
        return false;
    }
    let under = public.ends_with(".ts.net") || public.split('.').filter(|l| !l.is_empty()).count() >= 3;
    host == public
        || under
            && host.strip_suffix(public).and_then(|s| s.strip_suffix('.')).is_some_and(|sub| {
                !sub.is_empty() && sub.split('.').all(|l| !l.is_empty())
            })
}

/// The Host header, port dropped, lowercased, if it's only [a-z0-9.-] (safe to show back); else `None`.
pub fn plain_host(host: &str) -> Option<String> {
    let h = strip_port(host).trim_end_matches('.').to_ascii_lowercase();
    (!h.is_empty() && h.len() <= 253 && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'))
        .then_some(h)
}

fn strip_port(h: &str) -> &str {
    match h.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => h,
    }
}

impl Mobile {
    /// Loads the settings; the server starts separately (`start`).
    pub fn new(conn: &Connection, port: u16, emit: Emit) -> Self {
        let get = |k| db::get_setting(conn, k).ok().flatten();
        let setting: Setting = get(SETTING_KEY).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default();
        let cfg = Config {
            public_host: url_host(&setting.public_url),
            setting,
            token: get(TOKEN_KEY).filter(|t| !t.is_empty()),
            paired_at: get(PAIRED_AT_KEY).filter(|t| !t.is_empty()),
        };
        Mobile {
            port,
            emit,
            cfg: Mutex::new(cfg),
            pairing: Mutex::new(None),
            last_seen: Mutex::new(None),
            server: Mutex::new(Server::default()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.cfg.lock().is_ok_and(|c| c.setting.enabled)
    }

    pub fn access(&self) -> MobileAccess {
        let cfg = self.cfg.lock().unwrap();
        let srv = self.server.lock().unwrap();
        MobileAccess {
            enabled: cfg.setting.enabled,
            running: srv.running,
            port: self.port,
            public_url: cfg.setting.public_url.clone(),
            error: srv.error.clone(),
            paired_at: cfg.paired_at.clone(),
            last_seen_at: self.last_seen.lock().unwrap().clone(),
        }
    }

    pub fn changed(&self) {
        (self.emit)(SNAPSHOT_CHANGED)
    }

    pub fn notify(&self) {
        (self.emit)(MOBILE_CHANGED)
    }

    /// The Host header, port dropped, must be this Mac or match the public URL's host (`host_matches`).
    pub fn host_allowed(&self, host: &str) -> bool {
        let h = strip_port(host).trim_end_matches('.').to_ascii_lowercase();
        h == "localhost"
            || h == "127.0.0.1"
            || self.cfg.lock().is_ok_and(|c| c.public_host.as_deref().is_some_and(|p| host_matches(&h, p)))
    }

    /// Checks an `Authorization` header against the token and notes when the phone was last seen.
    pub fn authorize(&self, header: Option<&str>) -> bool {
        let given = header.and_then(|h| h.strip_prefix("Bearer ")).unwrap_or("").trim();
        let ok = self.cfg.lock().is_ok_and(|c| c.token.as_deref().is_some_and(|t| same(given.as_bytes(), t.as_bytes())));
        if ok {
            *self.last_seen.lock().unwrap() = Some(rfc3339(db::now_ms()));
        }
        ok
    }

    pub fn new_pairing_code(&self) -> Res<PairingCode> {
        self.new_pairing_code_at(db::now_ms())
    }

    fn new_pairing_code_at(&self, now: i64) -> Res<PairingCode> {
        if !self.enabled() {
            return Err("Turn on phone access first".into());
        }
        let code = new_code()?;
        let expires_at = now + CODE_TTL_MS;
        *self.pairing.lock().unwrap() = Some(Pairing { code: code.clone(), expires_at, misses: 0 });
        Ok(PairingCode { code, expires_at: rfc3339(expires_at) })
    }

    /// Uses up the code on a match; too many misses or its expiry also end it.
    fn take_code(&self, given: &str, now: i64) -> bool {
        let mut p = self.pairing.lock().unwrap();
        let Some(cur) = p.as_mut() else { return false };
        if now >= cur.expires_at {
            *p = None;
            return false;
        }
        if same(given.trim().to_ascii_uppercase().as_bytes(), cur.code.as_bytes()) {
            *p = None;
            return true;
        }
        cur.misses += 1;
        if cur.misses >= MAX_MISSES {
            *p = None;
            drop(p);
            self.notify();
        }
        false
    }

    /// Ends the server; returns its task so the caller can wait for the port to be free.
    fn stop(&self) -> Option<tauri::async_runtime::JoinHandle<()>> {
        let mut s = self.server.lock().unwrap();
        s.generation += 1;
        s.running = false;
        s.error = None;
        if let Some(tx) = s.stop.take() {
            let _ = tx.send(());
        }
        s.task.take()
    }
}

/// `POST /api/pair`: the token for a valid code, which is then used up.
pub fn pair(st: &AppState, code: &str) -> Res<Option<String>> {
    let now = db::now_ms();
    if !st.mobile.take_code(code, now) {
        return Ok(None);
    }
    let at = rfc3339(now);
    {
        let c = st.db.lock().map_err(db::err)?;
        db::set_setting(&c, PAIRED_AT_KEY, &at)?;
    }
    let token = {
        let mut cfg = st.mobile.cfg.lock().unwrap();
        cfg.paired_at = Some(at);
        cfg.token.clone()
    };
    st.mobile.notify();
    Ok(token)
}

/// A dev build's copy of the real database mustn't serve the installed app's phones: drop phone access.
pub fn forget(conn: &Connection) -> Res<()> {
    [SETTING_KEY, TOKEN_KEY, PAIRED_AT_KEY].iter().try_for_each(|k| db::delete_setting(conn, k))
}

/// A new token: every paired phone has to pair again.
pub fn reset_token(st: &AppState) -> Res<MobileAccess> {
    let token = new_token()?;
    {
        let c = st.db.lock().map_err(db::err)?;
        db::set_setting(&c, TOKEN_KEY, &token)?;
        db::delete_setting(&c, PAIRED_AT_KEY)?;
    }
    {
        let mut cfg = st.mobile.cfg.lock().unwrap();
        cfg.token = Some(token);
        cfg.paired_at = None;
    }
    *st.mobile.pairing.lock().unwrap() = None;
    *st.mobile.last_seen.lock().unwrap() = None;
    Ok(st.mobile.access())
}

/// Saves the setting and starts or stops the server to match. The token is made on first enable.
pub async fn set_access<C: Ctx>(ctx: C, enabled: bool, public_url: String) -> Res<MobileAccess> {
    let public_url = public_url.trim().to_string();
    let public_host = match public_url.as_str() {
        "" => None,
        u => Some(url_host(u).ok_or("The public URL needs a host, like https://my-mac.tailnet.ts.net")?),
    };
    let st = ctx.as_ref();
    let setting = Setting { enabled, public_url };
    let has_token = st.mobile.cfg.lock().unwrap().token.is_some();
    let token = if enabled && !has_token { Some(new_token()?) } else { None };
    {
        let c = st.db.lock().map_err(db::err)?;
        db::set_setting(&c, SETTING_KEY, &serde_json::to_string(&setting).map_err(db::err)?)?;
        if let Some(t) = &token {
            db::set_setting(&c, TOKEN_KEY, t)?;
        }
    }
    {
        let mut cfg = st.mobile.cfg.lock().unwrap();
        cfg.setting = setting;
        cfg.public_host = public_host;
        if token.is_some() {
            cfg.token = token;
        }
    }
    if enabled {
        start(ctx.clone());
    } else if let Some(task) = st.mobile.stop() {
        *st.mobile.pairing.lock().unwrap() = None;
        let _ = tokio::time::timeout(STOP_WAIT, task).await;
    }
    Ok(st.mobile.access())
}

/// At launch: starts the server if phone access is on. An update's relaunch can overlap the old app, which
/// holds the port for a moment, so a taken port is retried for a few seconds (blocking: call it off the
/// async runtime). Returns whether the server runs.
pub fn start_if_enabled<C: Ctx>(ctx: C, retries: u32) -> bool {
    let m = &ctx.as_ref().mobile;
    for i in 0..=retries {
        if !m.enabled() {
            return false;
        }
        if i > 0 {
            std::thread::sleep(Duration::from_millis(500));
        }
        start(ctx.clone());
        if m.server.lock().unwrap().running {
            if i > 0 {
                m.notify();
            }
            return true;
        }
    }
    false
}

/// Starts the server unless it runs. A port that's taken shows up as `error`, never a panic.
pub fn start<C: Ctx>(ctx: C) {
    let m = &ctx.as_ref().mobile;
    let mut srv = m.server.lock().unwrap();
    if srv.running {
        return;
    }
    let bound = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, m.port)).and_then(|l| {
        l.set_nonblocking(true)?;
        Ok(l)
    });
    let listener = match bound {
        Ok(l) => l,
        Err(e) => {
            srv.error = Some(format!("Can't listen on 127.0.0.1:{}: {e}", m.port));
            return;
        }
    };
    srv.generation += 1;
    let generation = srv.generation;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    srv.stop = Some(tx);
    srv.running = true;
    srv.error = None;
    let app = crate::http::router(ctx.clone());
    let owner = ctx.clone();
    srv.task = Some(tauri::async_runtime::spawn(async move {
        let res = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => axum::serve(l, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await
                .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        let m = &owner.as_ref().mobile;
        let ended = m.server.lock().is_ok_and(|mut s| {
            let current = s.generation == generation;
            if current {
                s.running = false;
                s.stop = None;
                s.task = None;
                s.error = res.err().or_else(|| Some("The server stopped".into()));
            }
            current
        });
        if ended {
            m.notify();
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dev_builds_take_the_port_override() {
        assert_eq!(port_for(true, Some("50000")), PORT);
        assert_eq!(port_for(false, Some("50000")), 50000);
        assert_eq!(port_for(false, Some(" 50001 ")), 50001);
        for bad in [None, Some(""), Some("0"), Some("70000"), Some("port")] {
            assert_eq!(port_for(false, bad), DEV_PORT, "{bad:?}");
        }
    }

    fn mobile(enabled: bool) -> Mobile {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        db::set_setting(&c, SETTING_KEY, &serde_json::json!({ "enabled": enabled }).to_string()).unwrap();
        db::set_setting(&c, TOKEN_KEY, "tok").unwrap();
        Mobile::new(&c, 0, Box::new(|_| {}))
    }

    #[test]
    fn codes_expire_and_lock_after_five_misses() {
        let m = mobile(true);
        let now = 1_000_000;
        let p = m.new_pairing_code_at(now).unwrap();
        assert_eq!(p.code.len(), CODE_LEN);
        assert!(p.code.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        assert!(!m.take_code(&p.code, now + CODE_TTL_MS));
        assert!(!m.take_code(&p.code, now), "an expired code is gone");

        let p = m.new_pairing_code_at(now).unwrap();
        for _ in 0..MAX_MISSES {
            assert!(!m.take_code("ZZZZZZ2", now));
        }
        assert!(!m.take_code(&p.code, now), "locked after five misses");

        let p = m.new_pairing_code_at(now).unwrap();
        assert!(m.take_code(&p.code.to_ascii_lowercase(), now + 1));
        assert!(!m.take_code(&p.code, now + 2), "single use");
    }

    #[test]
    fn dev_copies_forget_phone_access() {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        for k in [SETTING_KEY, TOKEN_KEY, PAIRED_AT_KEY] {
            db::set_setting(&c, k, "x").unwrap();
        }
        forget(&c).unwrap();
        for k in [SETTING_KEY, TOKEN_KEY, PAIRED_AT_KEY] {
            assert_eq!(db::get_setting(&c, k).unwrap(), None);
        }
    }

    #[test]
    fn no_codes_while_disabled() {
        assert!(mobile(false).new_pairing_code().is_err());
    }

    #[test]
    fn tokens_are_base64url() {
        assert_eq!(base64url(b"\xfb\xff\xbf"), "-_-_");
        assert_eq!(base64url(b"hi"), "aGk");
        let t = new_token().unwrap();
        assert_eq!(t.len(), 43);
        assert!(t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(t, new_token().unwrap());
    }

    #[test]
    fn hosts() {
        assert_eq!(url_host("https://Mac.tail1.ts.net:443/x?y").as_deref(), Some("mac.tail1.ts.net"));
        assert_eq!(url_host("navarch.example.com").as_deref(), Some("navarch.example.com"));
        assert_eq!(url_host("https://"), None);
        assert_eq!(strip_port("localhost:47820"), "localhost");
        assert_eq!(strip_port("[::1]:80"), "[::1]:80");
    }

    #[test]
    fn public_hosts_match_themselves_and_names_under_them() {
        let net = "tail1234.ts.net";
        assert!(host_matches(net, net));
        assert!(host_matches("mac.tail1234.ts.net", net));
        for bad in ["eviltail1234.ts.net", "tail1234.ts.net.evil.com", ".tail1234.ts.net", "ts.net", "il1234.ts.net", ""] {
            assert!(!host_matches(bad, net), "{bad}");
        }
        assert!(!host_matches("anything", ""));
        assert!(!host_matches("..tail1234.ts.net", net) && !host_matches("a..tail1234.ts.net", net));
        // No names under a shared suffix or a single label.
        for (host, public) in [("evil.duckdns.org", "duckdns.org"), ("x.ngrok-free.app", "ngrok-free.app"), ("evil.mac", "mac")] {
            assert!(!host_matches(host, public), "{host}");
            assert!(host_matches(public, public));
        }
        assert!(host_matches("a.navarch.example.com", "navarch.example.com"));

        let m = mobile(true);
        m.cfg.lock().unwrap().public_host = url_host(net);
        for ok in ["mac.tail1234.ts.net:443", "TAIL1234.ts.net", "localhost:47821", "127.0.0.1"] {
            assert!(m.host_allowed(ok), "{ok}");
        }
        for bad in ["eviltail1234.ts.net", "tail1234.ts.net.evil.com", "evil.com"] {
            assert!(!m.host_allowed(bad), "{bad}");
        }
        m.cfg.lock().unwrap().public_host = None;
        assert!(!m.host_allowed("mac.tail1234.ts.net"));
    }

    #[test]
    fn only_plain_hosts_are_shown_back() {
        assert_eq!(plain_host("Mac.Tail1.ts.net:443").as_deref(), Some("mac.tail1.ts.net"));
        for bad in ["", "<script>.ts.net", "a b", "x\"y", "[::1]:80", "h\u{e9}.com"] {
            assert_eq!(plain_host(bad), None, "{bad}");
        }
    }
}
