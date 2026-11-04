//! Usage-limit alerts for running sessions. When a plan window reaches its threshold, Navarch writes an
//! alert file. `limit-hook.sh`, which Navarch also writes and ~/.claude/settings.json runs as a
//! PostToolUse and UserPromptSubmit hook, hands the alert to each session (and each subagent) once, as
//! context for Claude: save your work, and schedule your own resume for after the reset.

use crate::usage::{Usage, UsageWindow};
use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTING_KEY: &str = "limit_thresholds";
/// Within this many points of a threshold, usage is refetched every minute instead of every 5.
const NEAR_POINTS: f64 = 10.0;
/// Sessions resume this long after the reset, so the new window has surely started.
const RESUME_AFTER_MIN: i64 = 5;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub five_hour: f64,
    pub seven_day: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds { five_hour: 95.0, seven_day: 99.0 }
    }
}

/// The saved thresholds, or the defaults when none are saved (or the row doesn't parse).
pub fn load(c: &rusqlite::Connection) -> crate::db::Res<Thresholds> {
    Ok(crate::db::get_setting(c, SETTING_KEY)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

pub fn save(c: &rusqlite::Connection, t: &Thresholds) -> crate::db::Res<()> {
    crate::db::set_setting(c, SETTING_KEY, &serde_json::to_string(t).map_err(crate::db::err)?)
}

#[derive(Debug)]
pub struct Alert {
    /// Names the windows over their threshold and their resets: sessions hear again when it changes.
    pub id: String,
    /// Unix seconds of the first reset; the hook ignores the alert after it.
    pub expires: i64,
    /// For the UI: "5h at 96%, resets 14:30".
    pub summary: String,
    /// For a session's main thread, and for subagents.
    pub main: String,
    pub sub: String,
}

struct Over {
    key: &'static str,
    name: &'static str,
    short: &'static str,
    percent: i64,
    reset: Option<DateTime<Local>>,
}

fn windows<'a>(u: &'a Usage, t: &Thresholds) -> impl Iterator<Item = (&'static str, &'a UsageWindow, f64)> {
    [("5h", u.five_hour.as_ref(), t.five_hour), ("7d", u.seven_day.as_ref(), t.seven_day)]
        .into_iter()
        .filter_map(|(k, w, limit)| w.map(|w| (k, w, limit)))
}

pub fn near(u: &Usage, t: &Thresholds) -> bool {
    windows(u, t).any(|(_, w, limit)| w.percent >= limit - NEAR_POINTS)
}

/// "at 14:30" today, else "Mon 3 Nov at 09:00".
fn when(t: DateTime<Local>, now: DateTime<Local>) -> String {
    if t.date_naive() == now.date_naive() { t.format("at %H:%M") } else { t.format("%a %-d %b at %H:%M") }.to_string()
}

pub fn alert_for(u: &Usage, t: &Thresholds, now: DateTime<Local>) -> Option<Alert> {
    let over: Vec<Over> = windows(u, t)
        .filter(|(_, w, limit)| w.percent >= *limit)
        .map(|(key, w, _)| Over {
            key,
            name: if key == "5h" { "5-hour window" } else { "weekly window" },
            short: if key == "5h" { "5h" } else { "Weekly" },
            percent: w.percent.floor() as i64,
            reset: w
                .resets_at
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Local)),
        })
        .collect();
    if over.is_empty() {
        return None;
    }
    let id = over.iter().map(|o| format!("{}{}", o.key, o.reset.map_or(0, |r| r.timestamp()))).collect::<Vec<_>>().join("-");
    let expires = over.iter().filter_map(|o| o.reset).map(|r| r.timestamp()).min().unwrap_or(now.timestamp() + 15 * 60);
    let resets = |o: &Over, f: fn(String) -> String| o.reset.map(|r| f(when(r, now))).unwrap_or_default();
    let summary = over.iter().map(|o| format!("{} at {}%{}", o.short, o.percent, resets(o, |w| format!(", resets {w}")))).collect::<Vec<_>>().join(" · ");
    let state = over.iter().map(|o| format!("the {} is at {}%{}", o.name, o.percent, resets(o, |w| format!(" (resets {w})")))).collect::<Vec<_>>().join(" and ");
    let resume = match over.iter().filter_map(|o| o.reset).max() {
        Some(r) => {
            let r = r + chrono::Duration::minutes(RESUME_AFTER_MIN);
            format!(
                "a one-shot job (recurring: false) with cron \"{} {} {} {} *\" ({} local time, {RESUME_AFTER_MIN} minutes after the reset)",
                r.minute(), r.hour(), r.day(), r.month(), when(r, now).trim_start_matches("at "),
            )
        }
        None => "a one-shot job (recurring: false) for a few minutes after the limit resets".into(),
    };
    let head = format!("Usage alert from Navarch, the user's session monitor: the Claude plan is close to its limit; {state}. Work stops for every session once a window reaches 100%.");
    let main = format!(
        "{head} Before that happens:\n\
         1. Don't start new big steps or launch new agents or workflows; bring the current step to a safe stopping point.\n\
         2. Save your work: commit what's done (a WIP commit is fine) and write a short handoff (goal, what's done, what's in progress, the next step, files touched) to a file that survives a restart.\n\
         3. Schedule your own resume with the CronCreate tool: {resume}, whose prompt reads the handoff and carries on, or does nothing if the work is already finished.\n\
         4. Tell the user in one line what you saved, where, and when you'll resume."
    );
    let sub = format!(
        "{head} Wrap up now: don't start new steps, and return to your caller with what you have (what's done, what's in progress, the next step) so the main session can save it."
    );
    Some(Alert { id, expires, summary, main, sub })
}

/// The hook. `__ALERT__` and `__SEEN__` become the alert file and the directory of "already told"
/// markers (`<alert id>-<session>[-<agent>]`, made with mkdir so parallel tool calls can't both win).
const HOOK: &str = r#"#!/bin/sh
# Written by Navarch at launch; edits are overwritten. Claude Code runs it as a PostToolUse and
# UserPromptSubmit hook. While Navarch has a usage-limit alert out, it gives that alert to each
# session, and to each subagent, once.
alert=__ALERT__
seen=__SEEN__
[ -f "$alert" ] || exit 0
{ read -r id expires; read -r main; read -r sub; } < "$alert" || exit 0
[ "$(date +%s)" -lt "$expires" ] || exit 0
input=$(cat)
field() { printf '%s' "$input" | grep -o "\"$1\" *: *\"[^\"]*\"" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'; }
sid=$(field session_id)
[ -n "$sid" ] || exit 0
agent=$(field agent_id)
mkdir -p "$seen" && mkdir "$seen/$id-$sid${agent:+-$agent}" 2>/dev/null || exit 0
[ -n "$agent" ] && main=$sub
event=$(field hook_event_name)
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":%s}}\n' "${event:-PostToolUse}" "$main"
"#;

/// Where the hook, the alert and the hook's markers live. Dev builds use names of their own, which no
/// hook reads, so trying a branch never messages real sessions.
pub struct Files {
    pub script: PathBuf,
    pub alert: PathBuf,
    pub seen: PathBuf,
    pub live: bool,
}

impl Files {
    pub fn new(dir: &Path, dev: Option<&str>) -> Self {
        let sfx = dev.map(|n| format!("-dev-{n}")).unwrap_or_default();
        Files {
            script: dir.join(format!("limit-hook{sfx}.sh")),
            alert: dir.join(format!("limit-alert{sfx}")),
            seen: dir.join(format!("limit-alert-seen{sfx}")),
            live: dev.is_none(),
        }
    }

    fn script_text(&self) -> String {
        let q = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"));
        HOOK.replace("__ALERT__", &q(&self.alert)).replace("__SEEN__", &q(&self.seen))
    }

    pub fn write_script(&self) -> std::io::Result<()> {
        let text = self.script_text();
        if std::fs::read_to_string(&self.script).ok().as_deref() == Some(text.as_str()) {
            return Ok(());
        }
        if let Some(dir) = self.script.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.script, text)
    }

    /// Writes or removes the alert file. True when a new alert went out (its id changed); the old
    /// alert's markers go with it.
    pub fn publish(&self, alert: Option<&Alert>) -> std::io::Result<bool> {
        let old = std::fs::read_to_string(&self.alert).ok();
        let json = |s: &str| serde_json::to_string(s).unwrap_or_default();
        let new = alert.map(|a| format!("{} {}\n{}\n{}\n", a.id, a.expires, json(&a.main), json(&a.sub)));
        if old == new {
            return Ok(false);
        }
        let old_id = old.as_deref().and_then(|s| s.split(' ').next());
        let changed = old_id != alert.map(|a| a.id.as_str());
        if changed {
            let _ = std::fs::remove_dir_all(&self.seen);
        }
        match new {
            Some(text) => {
                let tmp = self.alert.with_extension("tmp");
                std::fs::write(&tmp, text)?;
                std::fs::rename(&tmp, &self.alert)?;
            }
            None => std::fs::remove_file(&self.alert)?,
        }
        Ok(changed && alert.is_some())
    }
}

/// Whether ~/.claude/settings.json runs the installed app's hook.
fn hook_installed() -> bool {
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".claude/settings.json")).ok())
        .is_some_and(|s| s.contains("limit-hook.sh"))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub five_hour: f64,
    pub seven_day: f64,
    /// The alert out now, as `Alert::summary`.
    pub active: Option<String>,
    pub hook_installed: bool,
    /// False in dev builds, whose alerts no hook reads.
    pub live: bool,
}

pub struct Watch {
    pub files: Files,
    pub thresholds: Thresholds,
    active: Option<String>,
}

impl Watch {
    pub fn new(files: Files, thresholds: Thresholds) -> Self {
        if let Err(e) = files.write_script() {
            eprintln!("navarch: can't write {}: {e}", files.script.display());
        }
        Watch { files, thresholds, active: None }
    }

    /// Brings the alert file in line with `u`; returns the summary when a new alert went out.
    pub fn update(&mut self, u: &Usage) -> Option<String> {
        let alert = alert_for(u, &self.thresholds, Local::now());
        self.active = alert.as_ref().map(|a| a.summary.clone());
        match self.files.publish(alert.as_ref()) {
            Ok(true) => self.active.clone(),
            Ok(false) => None,
            Err(e) => {
                eprintln!("navarch: can't write {}: {e}", self.files.alert.display());
                None
            }
        }
    }

    pub fn status(&self) -> Status {
        Status {
            five_hour: self.thresholds.five_hour,
            seven_day: self.thresholds.seven_day,
            active: self.active.clone(),
            hook_installed: hook_installed(),
            live: self.files.live,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn usage(five: f64, week: f64) -> Usage {
        let w = |percent, resets_at: &str| Some(UsageWindow { percent, resets_at: Some(resets_at.into()) });
        Usage { five_hour: w(five, "2026-10-30T14:30:00+00:00"), seven_day: w(week, "2026-11-03T09:00:00+00:00"), error: None, fetched_at: 0, needs_sign_in: false }
    }

    #[test]
    fn alerts_only_over_a_threshold() {
        let now = Local.with_ymd_and_hms(2026, 10, 30, 12, 0, 0).unwrap();
        let t = Thresholds::default();
        assert!(alert_for(&usage(94.9, 98.9), &t, now).is_none());
        assert!(near(&usage(85.0, 0.0), &t) && !near(&usage(84.0, 88.0), &t));

        let a = alert_for(&usage(95.4, 50.0), &t, now).unwrap();
        let reset = DateTime::parse_from_rfc3339("2026-10-30T14:30:00+00:00").unwrap();
        assert_eq!(a.id, format!("5h{}", reset.timestamp()));
        assert_eq!(a.expires, reset.timestamp());
        let r = reset.with_timezone(&Local) + chrono::Duration::minutes(5);
        assert!(a.main.contains(&format!("cron \"{} {} {} {} *\"", r.minute(), r.hour(), r.day(), r.month())), "{}", a.main);
        assert!(a.main.contains("5-hour window is at 95%") && !a.main.contains("weekly"));
        assert!(a.sub.contains("return to your caller"));

        // Both over: listed together, resume after the later reset, expire at the first.
        let both = alert_for(&usage(99.0, 99.0), &t, now).unwrap();
        assert!(both.id.starts_with("5h") && both.id.contains("-7d"));
        assert_eq!(both.expires, reset.timestamp());
        assert!(both.summary.starts_with("5h at 99%") && both.summary.contains("Weekly at 99%"));
    }

    #[test]
    fn thresholds_persist_through_the_settings_table() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        assert_eq!(load(&c).unwrap(), Thresholds { five_hour: 95.0, seven_day: 99.0 });
        let t = Thresholds { five_hour: 90.0, seven_day: 97.0 };
        save(&c, &t).unwrap();
        assert!(crate::db::get_setting(&c, SETTING_KEY).unwrap().is_some());
        assert_eq!(load(&c).unwrap(), t);
        crate::db::set_setting(&c, SETTING_KEY, "not json").unwrap();
        assert_eq!(load(&c).unwrap(), Thresholds::default());
    }

    #[test]
    fn hook_hands_out_each_alert_once_per_session_and_agent() {
        let dir = std::env::temp_dir().join(format!("navarch-limits-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = Files::new(&dir, Some("test"));
        f.write_script().unwrap();
        let run = |input: &str| {
            use std::io::Write;
            let mut c = std::process::Command::new("sh")
                .arg(&f.script)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            c.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
            String::from_utf8(c.wait_with_output().unwrap().stdout).unwrap()
        };
        let main = r#"{"session_id":"s1","hook_event_name":"PostToolUse","tool_input":{"session_id":"x"}}"#;
        let sub = r#"{"session_id":"s1","agent_id":"a1","hook_event_name":"PostToolUse"}"#;
        assert_eq!(run(main), "", "no alert, no output");

        let now = Local::now();
        let mut a = alert_for(&usage(96.0, 0.0), &Thresholds::default(), now).unwrap();
        a.expires = now.timestamp() + 600;
        assert!(f.publish(Some(&a)).unwrap());
        assert!(!f.publish(Some(&a)).unwrap(), "same alert again is not new");
        let out: serde_json::Value = serde_json::from_str(&run(main)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        assert_eq!(out["hookSpecificOutput"]["additionalContext"], a.main.as_str());
        assert_eq!(run(main), "", "told once");
        let out: serde_json::Value = serde_json::from_str(&run(sub)).unwrap();
        assert_eq!(out["hookSpecificOutput"]["additionalContext"], a.sub.as_str());

        assert!(!f.publish(None).unwrap());
        assert!(!f.alert.exists() && !f.seen.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
