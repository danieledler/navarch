//! Claude plan usage limits via the OAuth usage endpoint. The token is read from the macOS
//! keychain on each fetch and never logged, cached, or returned.
//!
//! Every Navarch process on the Mac (the installed app, dev windows) shares one cache file beside
//! the database, so they make one request per interval between them. After a 429 nobody asks again
//! until the backoff is over, and a failed request keeps the last good numbers, marked with the error.
//!
//! The keychain token lasts 8 hours, and only Claude Code renews it, when it makes a request of its own; the
//! desktop app's Code tab never renews this copy. So when it has expired, Navarch has Claude Code make the
//! smallest request it can (`renew`), at most every half hour, and asks again.

use crate::db::now_ms;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const CACHE_FILE: &str = "usage-cache.json";
const MAX_AGE_MS: i64 = 5 * 60_000;
const FORCE_MIN_AGE_MS: i64 = 30_000;
/// Backoff after 429s in a row: 5, 10, 20, then 30 minutes. A longer Retry-After wins; a shorter one
/// doesn't, since the endpoint has kept answering 429 for many minutes while asking for under a minute.
const BACKOFF_FIRST_MS: i64 = MAX_AGE_MS;
const BACKOFF_MAX_MS: i64 = 30 * 60_000;
/// Retry-After is honoured up to this, so a garbled value can't stop updates for good.
const RETRY_AFTER_MAX_MS: i64 = 60 * 60_000;
/// At most one renewal per this, so a Claude Code that can't renew (signed out) isn't run every 5 minutes.
const RENEW_EVERY_MS: i64 = 30 * 60_000;
const RENEW_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: Option<String>,
}

/// With `error` set, the windows (if any) are the last good numbers, from `fetched_at`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub error: Option<String>,
    pub fetched_at: i64,
}

/// The shared cache file's contents: usage plus request bookkeeping. Never the token.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct Shared {
    usage: Usage,
    /// When some process last asked the server, whatever the answer.
    asked_at: i64,
    /// After a 429: no request before this time, forced or not.
    retry_at: i64,
    /// 429s in a row, for the backoff.
    rate_limited: u32,
    /// When some process last had Claude Code renew the token.
    renewed_at: i64,
    /// Why that renewal failed; cleared once a request works again.
    renew_error: Option<String>,
}

enum Outcome {
    Usage(Option<UsageWindow>, Option<UsageWindow>),
    RateLimited(Option<i64>),
    /// The token has expired (or was refused): time to renew it.
    Expired,
    Failed(String),
}

/// Whether to ask the server now, or serve the cached numbers.
fn should_fetch(s: &Shared, force: bool, now: i64) -> bool {
    if now < s.retry_at {
        return false;
    }
    let age = now - s.asked_at;
    age >= MAX_AGE_MS || (force && age >= FORCE_MIN_AGE_MS)
}

/// Wait after the n-th 429 in a row (n ≥ 1), unless Retry-After asks for longer.
fn backoff_ms(n: u32) -> i64 {
    (BACKOFF_FIRST_MS << n.saturating_sub(1).min(8)).min(BACKOFF_MAX_MS)
}

/// Retry-After as milliseconds from `now`: delay-seconds or an HTTP date.
fn retry_after_ms(v: &str, now: i64) -> Option<i64> {
    let v = v.trim();
    if let Ok(s) = v.parse::<i64>() {
        return Some(s.max(0) * 1000);
    }
    let at = chrono::DateTime::parse_from_rfc2822(v).ok()?.timestamp_millis();
    Some((at - now).max(0))
}

fn clock(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default()
}

fn expired_message(renew_error: Option<&str>) -> String {
    match renew_error {
        Some(e) => format!("Claude Code's sign-in expired and Navarch couldn't renew it ({e}). Run claude in Terminal to sign in again."),
        None => "Claude Code's sign-in expired".into(),
    }
}

/// The cache after a request made at `now`.
fn record(prev: Shared, outcome: Outcome, now: i64) -> Shared {
    let failed = |error: String, retry_at, rate_limited| {
        let had_numbers = prev.usage.five_hour.is_some() || prev.usage.seven_day.is_some();
        let fetched_at = if had_numbers { prev.usage.fetched_at } else { now };
        Shared {
            usage: Usage { error: Some(error), fetched_at, ..prev.usage.clone() },
            asked_at: now,
            retry_at,
            rate_limited,
            ..prev.clone()
        }
    };
    match outcome {
        Outcome::Usage(five_hour, seven_day) => Shared {
            usage: Usage { five_hour, seven_day, error: None, fetched_at: now },
            asked_at: now,
            retry_at: 0,
            rate_limited: 0,
            renewed_at: prev.renewed_at,
            renew_error: None,
        },
        Outcome::RateLimited(retry_after) => {
            let n = prev.rate_limited + 1;
            let wait = backoff_ms(n).max(retry_after.map_or(0, |ms| ms.min(RETRY_AFTER_MAX_MS)));
            let retry_at = now + wait;
            failed(format!("Usage requests rate-limited (HTTP 429); next try at {}", clock(retry_at)), retry_at, n)
        }
        Outcome::Expired => failed(expired_message(prev.renew_error.as_deref()), 0, prev.rate_limited),
        Outcome::Failed(e) => failed(e, 0, prev.rate_limited),
    }
}

pub struct UsageCache {
    file: Option<PathBuf>,
    /// This process's copy, used when the file can't be opened; the lock also keeps its threads in line.
    mem: Mutex<Shared>,
}

impl UsageCache {
    /// `file` is shared by every Navarch process; None keeps the cache in memory.
    pub fn new(file: Option<PathBuf>) -> Self {
        UsageCache { file, mem: Mutex::new(Shared::default()) }
    }

    /// A cache holding `u` from a minute ago: fresh for `get(false)`, stale enough that
    /// `get(true)` would ask the server, so tests can tell the two apart without the network.
    #[cfg(test)]
    pub fn holding(u: Usage) -> Self {
        let shared = Shared { usage: u, asked_at: now_ms() - 60_000, ..Shared::default() };
        UsageCache { file: None, mem: Mutex::new(shared) }
    }

    pub fn get(&self, force: bool) -> Usage {
        self.get_with(force, now_ms(), request, renew)
    }

    /// Holds the file lock while deciding, fetching and renewing, so other processes wait for the
    /// answer instead of asking (or renewing) too.
    fn get_with(
        &self,
        force: bool,
        now: i64,
        mut request: impl FnMut() -> Outcome,
        renew: impl FnOnce() -> Result<(), String>,
    ) -> Usage {
        let mut mem = self.mem.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.file.as_ref().and_then(|p| open_locked(p).ok());
        let mut shared = file.as_mut().and_then(read_shared).unwrap_or_else(|| mem.clone());
        let shared = if should_fetch(&shared, force, now) {
            let mut outcome = request();
            if matches!(outcome, Outcome::Expired) && now - shared.renewed_at >= RENEW_EVERY_MS {
                shared.renewed_at = now;
                shared.renew_error = match renew() {
                    Ok(()) => {
                        outcome = request();
                        matches!(outcome, Outcome::Expired).then(|| "still expired after renewing".to_string())
                    }
                    Err(e) => Some(e),
                };
            }
            let next = record(shared, outcome, now);
            if let Some(f) = file.as_mut() {
                let _ = write_shared(f, &next);
            }
            next
        } else {
            shared
        };
        *mem = shared.clone();
        shared.usage
    }
}

/// Opens the cache file with an exclusive lock, released when the file is dropped.
fn open_locked(path: &Path) -> std::io::Result<File> {
    let f = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
    f.lock()?;
    Ok(f)
}

fn read_shared(f: &mut File) -> Option<Shared> {
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_shared(f: &mut File, s: &Shared) -> std::io::Result<()> {
    f.set_len(0)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&serde_json::to_vec(s).map_err(std::io::Error::other)?)
}

fn read_token() -> Result<(String, Option<i64>), String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|_| "Could not run security".to_string())?;
    if !out.status.success() {
        return Err("Claude Code credentials not found in keychain".into());
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|_| "Unreadable Claude Code credentials".to_string())?;
    let oauth = v.get("claudeAiOauth").ok_or("No Claude login in credentials")?;
    let token = oauth
        .get("accessToken")
        .and_then(|t| t.as_str())
        .ok_or("No access token in credentials")?
        .to_string();
    let expires = oauth.get("expiresAt").and_then(|e| e.as_f64()).map(|e| e as i64);
    Ok((token, expires))
}

fn window(v: &serde_json::Value, key: &str) -> Option<UsageWindow> {
    let w = v.get(key)?;
    if w.is_null() {
        return None;
    }
    Some(UsageWindow {
        percent: w.get("utilization").and_then(|x| x.as_f64()).unwrap_or(0.0),
        resets_at: w.get("resets_at").and_then(|x| x.as_str()).map(|s| s.to_string()),
    })
}

fn request() -> Outcome {
    let (token, expires) = match read_token() {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e),
    };
    if expires.is_some_and(|e| e <= now_ms()) {
        return Outcome::Expired;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into();
    let res = agent
        .get(URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "navarch/0.1")
        .call();
    drop(token);
    let Ok(mut res) = res else { return Outcome::Failed("Usage request failed (network)".into()) };
    match res.status().as_u16() {
        200..=299 => {}
        401 => return Outcome::Expired,
        429 => {
            let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok());
            return Outcome::RateLimited(retry_after.and_then(|v| retry_after_ms(v, now_ms())));
        }
        c => return Outcome::Failed(format!("Usage request failed (HTTP {c})")),
    }
    let Ok(body) = res.body_mut().read_to_string() else {
        return Outcome::Failed("Could not read usage response".into());
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Outcome::Failed("Unexpected usage response".into());
    };
    Outcome::Usage(window(&v, "five_hour"), window(&v, "seven_day"))
}

/// Has Claude Code renew its keychain token by making the smallest request it can: Haiku, no tools, no
/// settings (so no hooks), and no saved session (so nothing for the scanner). Navarch never touches the
/// token itself. Inherited CLAUDE*/ANTHROPIC* variables are dropped: a dev window started from a Claude
/// session carries them, and a token or key in them would leave the keychain copy as it is.
fn renew() -> Result<(), String> {
    let bin = claude_bin().ok_or("no claude command found")?;
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "Reply with OK.", "--model", "haiku", "--no-session-persistence", "--tools", "", "--setting-sources", ""])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(|k| k.starts_with("CLAUDE") || k.starts_with("ANTHROPIC")) {
            cmd.env_remove(k);
        }
    }
    let mut child = cmd.spawn().map_err(|_| "couldn't run claude".to_string())?;
    let deadline = Instant::now() + RENEW_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("claude exited with {}", status.code().unwrap_or(-1))),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("claude timed out".into());
            }
            Err(_) => return Err("couldn't run claude".into()),
        }
    }
}

/// The claude command: an app from Finder gets a bare PATH, so the usual install places come first.
fn claude_bin() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let known = home
        .iter()
        .flat_map(|h| [h.join(".local/bin/claude"), h.join(".claude/local/claude")])
        .chain(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).map(|d| d.join("claude")).collect::<Vec<_>>());
    known.chain(on_path).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const MIN: i64 = 60_000;

    fn ok(five: f64) -> Outcome {
        Outcome::Usage(Some(UsageWindow { percent: five, resets_at: None }), None)
    }

    #[test]
    fn freshness() {
        let s = Shared { asked_at: 1_000 * MIN, ..Default::default() };
        let at = |m: i64| 1_000 * MIN + m;
        assert!(should_fetch(&Shared::default(), false, at(0)));
        assert!(!should_fetch(&s, false, at(4 * MIN)) && should_fetch(&s, false, at(5 * MIN)));
        assert!(!should_fetch(&s, true, at(29_000)) && should_fetch(&s, true, at(30_000)));
        // During backoff nothing fetches, forced or not.
        let s = Shared { retry_at: at(20 * MIN), ..s };
        assert!(!should_fetch(&s, true, at(19 * MIN)) && should_fetch(&s, false, at(20 * MIN)));
    }

    #[test]
    fn backoff_after_429() {
        assert_eq!((1..=5).map(backoff_ms).map(|ms| ms / MIN).collect::<Vec<_>>(), [5, 10, 20, 30, 30]);
        assert_eq!(backoff_ms(u32::MAX), BACKOFF_MAX_MS);
        let now = 1_000 * MIN;
        let good = record(Shared::default(), ok(42.0), now - 10 * MIN);
        let s = record(good.clone(), Outcome::RateLimited(None), now);
        assert_eq!((s.rate_limited, s.retry_at, s.asked_at), (1, now + 5 * MIN, now));
        // The last good numbers stay, with their time, beside the error.
        assert_eq!(s.usage.five_hour, good.usage.five_hour);
        assert_eq!(s.usage.fetched_at, now - 10 * MIN);
        assert!(s.usage.error.as_deref().is_some_and(|e| e.contains("HTTP 429")));
        let s = record(s, Outcome::RateLimited(None), now + 5 * MIN);
        assert_eq!((s.rate_limited, s.retry_at), (2, now + 15 * MIN));
        // The longer of Retry-After (up to an hour) and the backoff wins.
        let wait = |retry_after| (record(s.clone(), Outcome::RateLimited(retry_after), now).retry_at - now) / MIN;
        assert_eq!([wait(Some(0)), wait(Some(MIN)), wait(Some(45 * MIN)), wait(Some(86_400_000))], [20, 20, 45, 60]);
        // Other failures keep the numbers and the count but don't hold requests back.
        let f = record(s.clone(), Outcome::Failed("x".into()), now);
        assert_eq!((f.rate_limited, f.retry_at, f.usage.five_hour.is_some()), (2, 0, true));
        // Success clears it all.
        let s = record(s, ok(50.0), now + 20 * MIN);
        assert_eq!((s.rate_limited, s.retry_at, s.usage.error), (0, 0, None));
        // Without earlier numbers, the error carries the time of the attempt.
        assert_eq!(record(Shared::default(), Outcome::Failed("x".into()), now).usage.fetched_at, now);
    }

    #[test]
    fn retry_after_header() {
        assert_eq!(retry_after_ms(" 120 ", 0), Some(120_000));
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-31T12:00:00Z").unwrap().timestamp_millis();
        assert_eq!(retry_after_ms("Sat, 31 Oct 2026 12:02:00 GMT", now), Some(2 * MIN));
        assert_eq!(retry_after_ms("soon", now), None);
    }

    fn no_renew() -> Result<(), String> {
        panic!("nothing expired, so nothing to renew")
    }

    #[test]
    fn expired_token_is_renewed_at_most_every_half_hour() {
        let cache = UsageCache::new(None);
        let now = 1_000 * MIN;
        let script = std::cell::RefCell::new(std::collections::VecDeque::new());
        let renewals = Cell::new(0);
        let run = |at: i64, outcomes: Vec<Outcome>, renewal: Result<(), String>| {
            script.borrow_mut().extend(outcomes);
            let next = || script.borrow_mut().pop_front().expect("one request too many");
            let u = cache.get_with(false, at, next, || {
                renewals.set(renewals.get() + 1);
                renewal
            });
            assert!(script.borrow().is_empty(), "a scripted request wasn't made");
            u
        };
        // Expired: Claude Code renews it and the second request works.
        let u = run(now, vec![Outcome::Expired, ok(10.0)], Ok(()));
        assert_eq!((renewals.get(), u.error, u.five_hour.map(|w| w.percent)), (1, None, Some(10.0)));
        // A failed renewal keeps the numbers and says why.
        let u = run(now + 31 * MIN, vec![Outcome::Expired], Err("claude timed out".into()));
        let e = u.error.unwrap();
        assert!(e.contains("claude timed out") && e.contains("Run claude"), "{e}");
        assert_eq!((renewals.get(), u.five_hour.map(|w| w.percent)), (2, Some(10.0)));
        // Within half an hour it isn't tried again, and the reason stays.
        let u = run(now + 37 * MIN, vec![Outcome::Expired], Ok(()));
        assert_eq!(renewals.get(), 2);
        assert!(u.error.unwrap().contains("claude timed out"));
        let u = run(now + 62 * MIN, vec![Outcome::Expired, ok(20.0)], Ok(()));
        assert_eq!((renewals.get(), u.error, u.five_hour.map(|w| w.percent)), (3, None, Some(20.0)));
        // Renewed, yet still refused.
        let u = run(now + 93 * MIN, vec![Outcome::Expired, Outcome::Expired], Ok(()));
        assert!(u.error.unwrap().contains("still expired after renewing"));
    }

    #[test]
    fn processes_share_one_request() {
        let dir = std::env::temp_dir().join(format!("navarch-usage-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CACHE_FILE);
        let _ = std::fs::remove_file(&path);
        let (a, b) = (UsageCache::new(Some(path.clone())), UsageCache::new(Some(path.clone())));
        let calls = Cell::new(0);
        let fetch = |o: Outcome| {
            calls.set(calls.get() + 1);
            o
        };
        let now = 1_000 * MIN;
        assert_eq!(a.get_with(false, now, || fetch(ok(10.0)), no_renew).five_hour.unwrap().percent, 10.0);
        // B reads A's answer from the file instead of asking.
        assert_eq!(b.get_with(false, now + MIN, || fetch(ok(99.0)), no_renew).five_hour.unwrap().percent, 10.0);
        assert_eq!(calls.get(), 1);
        // A 429 seen by B holds A back too, and both keep showing the numbers.
        let u = b.get_with(false, now + 5 * MIN, || fetch(Outcome::RateLimited(None)), no_renew);
        assert!(u.error.is_some() && u.five_hour.is_some());
        let u = a.get_with(true, now + 9 * MIN, || fetch(ok(99.0)), no_renew);
        assert_eq!((calls.get(), u.five_hour.unwrap().percent), (2, 10.0));
        assert_eq!(a.get_with(false, now + 10 * MIN, || fetch(ok(20.0)), no_renew).error, None);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("Bearer"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
