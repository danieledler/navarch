//! Claude plan usage limits via the OAuth usage endpoint. The token is read from the macOS
//! keychain on each fetch and never logged, cached, or returned.

use crate::db::now_ms;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
const MAX_AGE_MS: i64 = 5 * 60_000;
const FORCE_MIN_AGE_MS: i64 = 30_000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub error: Option<String>,
    pub fetched_at: i64,
}

impl Usage {
    fn error(msg: &str) -> Self {
        Usage { five_hour: None, seven_day: None, error: Some(msg.to_string()), fetched_at: now_ms() }
    }
}

#[derive(Default)]
pub struct UsageCache(Mutex<Option<Usage>>);

impl UsageCache {
    pub fn get(&self, force: bool) -> Usage {
        let now = now_ms();
        if let Some(u) = self.0.lock().unwrap().as_ref() {
            let age = now - u.fetched_at;
            if age < MAX_AGE_MS && !(force && age >= FORCE_MIN_AGE_MS) {
                return u.clone();
            }
        }
        let u = fetch();
        *self.0.lock().unwrap() = Some(u.clone());
        u
    }
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

fn fetch() -> Usage {
    let (token, expires) = match read_token() {
        Ok(t) => t,
        Err(e) => return Usage::error(&e),
    };
    if expires.is_some_and(|e| e <= now_ms()) {
        return Usage::error("Claude Code login expired");
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    let res = agent
        .get(URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "navarch/0.1")
        .call();
    drop(token);
    let body = match res {
        Ok(mut r) => match r.body_mut().read_to_string() {
            Ok(b) => b,
            Err(_) => return Usage::error("Could not read usage response"),
        },
        Err(ureq::Error::StatusCode(401)) => return Usage::error("Claude Code login expired"),
        Err(ureq::Error::StatusCode(c)) => return Usage::error(&format!("Usage request failed (HTTP {c})")),
        Err(_) => return Usage::error("Usage request failed (network)"),
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Usage::error("Unexpected usage response");
    };
    Usage {
        five_hour: window(&v, "five_hour"),
        seven_day: window(&v, "seven_day"),
        error: None,
        fetched_at: now_ms(),
    }
}
