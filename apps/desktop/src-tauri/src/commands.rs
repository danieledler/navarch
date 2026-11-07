//! Tauri command handlers. All are async so they run off the main thread.

use crate::db::{self, Period, Project, Res, Snapshot, Space, Task, TaskPatch};
use crate::procs::{CpuSample, SystemStats};
use crate::scanner::Session;
use crate::limits::{self, Thresholds};
use crate::mobile::{self, MobileAccess, PairingCode};
use crate::usage::{self, Usage};
use crate::AppState;
use tauri::{Emitter, State};

type S<'a> = State<'a, AppState>;

macro_rules! with_db {
    ($state:expr, |$c:ident| $body:expr) => {{
        #[allow(unused_mut)]
        let mut guard = $state.db.lock().map_err(|_| "database lock poisoned".to_string())?;
        #[allow(unused_mut)]
        let mut $c: &mut rusqlite::Connection = &mut *guard;
        $body
    }};
}

/// The commands the phone API shares (http.rs), as plain functions over the app state.
pub(crate) mod core {
    use super::*;

    pub fn get_snapshot(st: &AppState) -> Res<Snapshot> {
        with_db!(st, |c| db::snapshot(c))
    }

    pub fn create_task(st: &AppState, project_id: i64, parent_id: Option<i64>, title: &str, after_id: Option<i64>) -> Res<Task> {
        with_db!(st, |c| db::create_task(c, project_id, parent_id, title, after_id))
    }

    pub fn update_task(st: &AppState, id: i64, patch: TaskPatch) -> Res<Task> {
        with_db!(st, |c| db::update_task(c, id, patch))
    }

    pub fn delete_task(st: &AppState, id: i64) -> Res<()> {
        with_db!(st, |c| db::delete_task(c, id))
    }

    pub fn restore_task(st: &AppState, id: i64) -> Res<()> {
        with_db!(st, |c| db::restore_task(c, id))
    }

    pub fn set_period_task(st: &AppState, period_id: i64, task_id: i64, on: bool) -> Res<()> {
        with_db!(st, |c| db::set_period_task(c, period_id, task_id, on))
    }

    pub fn set_week_task(st: &AppState, week: &str, task_id: i64, on: bool) -> Res<()> {
        with_db!(st, |c| db::set_week_task(c, week, task_id, on))
    }

    pub fn get_sessions(st: &AppState) -> Res<Vec<Session>> {
        Ok(st.sessions.lock().map_err(db::err)?.clone())
    }

    pub fn get_limit_alerts(st: &AppState) -> Res<limits::Status> {
        Ok(st.limits.lock().map_err(db::err)?.status())
    }
}

#[tauri::command]
pub async fn get_snapshot(state: S<'_>) -> Res<Snapshot> {
    core::get_snapshot(&state)
}

#[tauri::command]
pub async fn create_space(state: S<'_>, name: String, color: String) -> Res<Space> {
    with_db!(state, |c| db::create_space(c, &name, &color))
}

#[tauri::command]
pub async fn update_space(state: S<'_>, id: i64, name: String, color: String) -> Res<Space> {
    with_db!(state, |c| db::update_space(c, id, &name, &color))
}

#[tauri::command]
pub async fn delete_space(state: S<'_>, id: i64) -> Res<()> {
    with_db!(state, |c| db::delete_space(c, id))
}

#[tauri::command]
pub async fn create_project(state: S<'_>, space_id: i64, path: String, name: Option<String>) -> Res<Project> {
    with_db!(state, |c| db::create_project(c, space_id, &path, name))
}

#[tauri::command]
pub async fn update_project(state: S<'_>, id: i64, name: Option<String>, space_id: Option<i64>) -> Res<Project> {
    with_db!(state, |c| db::update_project(c, id, name, space_id))
}

#[tauri::command]
pub async fn change_project_folder(state: S<'_>, id: i64, path: String) -> Res<Project> {
    with_db!(state, |c| db::change_project_folder(c, id, &path))
}

#[tauri::command]
pub async fn reorder_projects(state: S<'_>, ids: Vec<i64>) -> Res<()> {
    with_db!(state, |c| db::reorder_projects(c, &ids))
}

#[tauri::command]
pub async fn delete_project(state: S<'_>, id: i64) -> Res<()> {
    with_db!(state, |c| db::delete_project(c, id))
}

#[tauri::command]
pub async fn create_task(
    state: S<'_>,
    project_id: i64,
    parent_id: Option<i64>,
    title: String,
    after_id: Option<i64>,
) -> Res<Task> {
    core::create_task(&state, project_id, parent_id, &title, after_id)
}

#[tauri::command]
pub async fn update_task(state: S<'_>, id: i64, patch: TaskPatch) -> Res<Task> {
    core::update_task(&state, id, patch)
}

#[tauri::command]
pub async fn delete_task(state: S<'_>, id: i64) -> Res<()> {
    core::delete_task(&state, id)
}

#[tauri::command]
pub async fn restore_task(state: S<'_>, id: i64) -> Res<()> {
    core::restore_task(&state, id)
}

#[tauri::command]
pub async fn create_period(state: S<'_>, name: String, start: String, end: String) -> Res<Period> {
    with_db!(state, |c| db::create_period(c, &name, &start, &end))
}

#[tauri::command]
pub async fn update_period(state: S<'_>, id: i64, name: String, start: String, end: String) -> Res<Period> {
    with_db!(state, |c| db::update_period(c, id, &name, &start, &end))
}

#[tauri::command]
pub async fn delete_period(state: S<'_>, id: i64) -> Res<()> {
    with_db!(state, |c| db::delete_period(c, id))
}

#[tauri::command]
pub async fn set_period_task(state: S<'_>, period_id: i64, task_id: i64, on: bool) -> Res<()> {
    core::set_period_task(&state, period_id, task_id, on)
}

#[tauri::command]
pub async fn set_week_task(state: S<'_>, week: String, task_id: i64, on: bool) -> Res<()> {
    core::set_week_task(&state, &week, task_id, on)
}

#[tauri::command]
pub async fn link_session(state: S<'_>, session_id: String, task_id: Option<i64>) -> Res<()> {
    with_db!(state, |c| db::link_session(c, &session_id, task_id))?;
    if let Ok(mut list) = state.sessions.lock() {
        if let Some(s) = list.iter_mut().find(|s| s.id == session_id) {
            s.task_id = task_id;
        }
    }
    Ok(())
}

/// Percent-encode everything except RFC 3986 unreserved characters.
pub fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn run_open(args: &[&str]) -> Res<()> {
    let st = std::process::Command::new("/usr/bin/open").args(args).status().map_err(db::err)?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("open failed ({st})"))
    }
}

#[tauri::command]
pub async fn open_new_session(state: S<'_>, folder: String, prompt: String, task_id: Option<i64>) -> Res<()> {
    with_db!(state, |c| db::add_pending_spawn(c, task_id, &folder))?;
    // No folder= in the link: the Claude app asks for trust and then starts the session in a scratch
    // folder anyway. Without it you pick the folder in Claude's composer, which works.
    let url = if prompt.is_empty() {
        "claude://code/new".to_string()
    } else {
        format!("claude://code/new?q={}", urlenc(&prompt))
    };
    run_open(&[&url])
}

#[tauri::command]
pub async fn open_session(session_id: String) -> Res<()> {
    run_open(&[&format!("claude://code/continue?session={}", urlenc(&session_id))])
}

#[tauri::command]
pub async fn reveal_path(path: String) -> Res<()> {
    run_open(&["-R", &path])
}

#[tauri::command]
pub async fn get_sessions(state: S<'_>) -> Res<Vec<Session>> {
    core::get_sessions(&state)
}

#[tauri::command]
pub async fn get_system_stats(state: S<'_>) -> Res<SystemStats> {
    Ok(state.cpu.lock().map_err(db::err)?.stats())
}

#[tauri::command]
pub async fn get_cpu_history(state: S<'_>) -> Res<Vec<CpuSample>> {
    Ok(state.cpu.lock().map_err(db::err)?.history())
}

/// Which code this binary was built from, stamped by build.rs.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    version: &'static str,
    commit: &'static str,
    branch: &'static str,
    checkout: &'static str,
    dirty: u32, // tracked files with uncommitted changes at build time
    built_at: i64,
    dev_ui: bool, // UI loaded live from the Vite dev server instead of built in
    db: String,   // database file in use: navarch.db, or this checkout's dev copy
}

fn build_info(db: String) -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("NAVARCH_COMMIT"),
        branch: env!("NAVARCH_BRANCH"),
        checkout: env!("NAVARCH_CHECKOUT"),
        dirty: env!("NAVARCH_DIRTY").parse().unwrap_or(0),
        built_at: env!("NAVARCH_BUILT_AT").parse().unwrap_or(0),
        dev_ui: tauri::is_dev(),
        db,
    }
}

#[tauri::command]
pub async fn get_build_info(state: S<'_>) -> Res<BuildInfo> {
    Ok(build_info(state.db_file.clone()))
}

#[tauri::command]
pub async fn get_usage(state: S<'_>, force: bool) -> Res<Usage> {
    let cache = state.usage.clone();
    tauri::async_runtime::spawn_blocking(move || cache.get(force)).await.map_err(db::err)
}

/// Starts Claude Code's sign-in, which opens the browser; `claude-sign-in` says how it ended (null when
/// it worked, else why not), and the next usage read asks the server again.
#[tauri::command]
pub async fn sign_in_claude(app: tauri::AppHandle, state: S<'_>) -> Res<()> {
    let cache = state.usage.clone();
    usage::sign_in(move |result| {
        if result.is_ok() {
            cache.signed_in();
        }
        let _ = app.emit("claude-sign-in", result.err());
    })
}

#[tauri::command]
pub async fn get_limit_alerts(state: S<'_>) -> Res<limits::Status> {
    core::get_limit_alerts(&state)
}

/// Saves new thresholds and applies them to the usage at hand right away.
#[tauri::command]
pub async fn set_limit_thresholds(state: S<'_>, thresholds: Thresholds) -> Res<limits::Status> {
    let ok = |p: f64| (1.0..=100.0).contains(&p);
    if !ok(thresholds.five_hour) || !ok(thresholds.seven_day) {
        return Err("Thresholds go from 1 to 100%".into());
    }
    with_db!(state, |c| limits::save(c, &thresholds))?;
    let cache = state.usage.clone();
    let usage = tauri::async_runtime::spawn_blocking(move || cache.get(false)).await.map_err(db::err)?;
    let mut w = state.limits.lock().map_err(db::err)?;
    w.thresholds = thresholds;
    if usage.error.is_none() {
        w.update(&usage);
    }
    Ok(w.status())
}

#[tauri::command]
pub async fn get_mobile_access(state: S<'_>) -> Res<MobileAccess> {
    Ok(state.mobile.access())
}

/// Turns phone access on or off and sets the URL the phone uses (its host passes the Host check).
#[tauri::command]
/// `enabled: null` keeps it as it is, so saving the URL can't turn access off from a stale view.
pub async fn set_mobile_access(app: tauri::AppHandle, enabled: Option<bool>, public_url: String) -> Res<MobileAccess> {
    let ctx = crate::AppRef(app);
    let enabled = enabled.unwrap_or_else(|| ctx.as_ref().mobile.enabled());
    mobile::set_access(ctx, enabled, public_url).await
}

#[tauri::command]
pub async fn new_pairing_code(state: S<'_>) -> Res<PairingCode> {
    state.mobile.new_pairing_code()
}

#[tauri::command]
pub async fn reset_mobile_token(state: S<'_>) -> Res<MobileAccess> {
    mobile::reset_token(&state)
}

/// This Mac's Tailscale name and state; null when the Tailscale CLI isn't installed or doesn't answer.
#[tauri::command]
pub async fn detect_tailscale() -> Res<Option<crate::tailscale::Tailscale>> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::detect).await.map_err(db::err)
}

/// Where Tailscale Serve sends this Mac's https address, against this build's phone port.
#[tauri::command]
pub async fn tailscale_serve_status(state: S<'_>) -> Res<crate::tailscale::Serve> {
    let port = state.mobile.port;
    let auto = crate::dev_name().is_none();
    tauri::async_runtime::spawn_blocking(move || crate::tailscale::serve_status(port, auto)).await.map_err(db::err)
}

/// Points Tailscale Serve's https://<this Mac>/ at this build's phone server (`on`), taking it from something
/// else only with `replace`; or removes it if it is ours. Takes up to ~15 s.
#[tauri::command]
pub async fn tailscale_serve(state: S<'_>, on: bool, replace: bool) -> Res<crate::tailscale::Serve> {
    let port = state.mobile.port;
    let auto = crate::dev_name().is_none();
    tauri::async_runtime::spawn_blocking(move || crate::tailscale::serve(port, auto, on, replace)).await.map_err(db::err)
}

/// Opens Tailscale's page for enabling HTTPS on the tailnet, a link `tailscale serve` printed.
#[tauri::command]
pub async fn open_tailscale_login(url: String) -> Res<()> {
    let ok = url.starts_with("https://login.tailscale.com/") && url.chars().all(|c| c.is_ascii_graphic());
    if !ok {
        return Err("Not a Tailscale login link".into());
    }
    run_open(&[&url])
}

/// The Repo panel's data for a project folder: its git worktrees and GitHub pull requests and issues;
/// null when the folder isn't in a git repo. GitHub data is cached 5 min unless `force`.
#[tauri::command]
pub async fn get_repo_overview(path: String, force: bool) -> Res<Option<crate::repo::RepoOverview>> {
    tauri::async_runtime::spawn_blocking(move || crate::repo::overview(&path, force)).await.map_err(db::err)
}

/// The git repos of a project folder for the Repo panel's picker: the one it is in, then those 1–2 folders
/// below it, most recent commit first. Local only.
#[tauri::command]
pub async fn find_repos(path: String) -> Res<Vec<crate::repo::RepoRef>> {
    tauri::async_runtime::spawn_blocking(move || crate::repo::find_repos(&path)).await.map_err(db::err)
}

/// Opens a GitHub page (a pull request, an issue) in the browser.
#[tauri::command]
pub async fn open_url(url: String) -> Res<()> {
    let ok = url.starts_with("https://github.com/") && url.chars().all(|c| c.is_ascii_graphic());
    if !ok {
        return Err("Not a GitHub link".into());
    }
    run_open(&[&url])
}

#[cfg(test)]
mod tests {
    #[test]
    fn urlenc_works() {
        assert_eq!(super::urlenc("/a b/ä?&=#"), "%2Fa%20b%2F%C3%A4%3F%26%3D%23");
        assert_eq!(super::urlenc("Az09-._~"), "Az09-._~");
    }

    #[test]
    fn build_is_stamped_with_its_commit() {
        let b = super::build_info("navarch.db".into());
        assert!(b.commit.len() >= 7, "commit {:?}", b.commit);
        assert!(!b.branch.is_empty() && b.checkout.starts_with('/'));
        assert!(b.built_at > 1_700_000_000_000);
    }
}
