//! Tauri command handlers. All are async so they run off the main thread.

use crate::db::{self, Period, Project, Res, Snapshot, Space, Task, TaskPatch};
use crate::procs::{CpuSample, SystemStats};
use crate::scanner::Session;
use crate::limits::{self, Thresholds};
use crate::usage::Usage;
use crate::AppState;
use tauri::State;

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

#[tauri::command]
pub async fn get_snapshot(state: S<'_>) -> Res<Snapshot> {
    with_db!(state, |c| db::snapshot(c))
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
    with_db!(state, |c| db::create_task(c, project_id, parent_id, &title, after_id))
}

#[tauri::command]
pub async fn update_task(state: S<'_>, id: i64, patch: TaskPatch) -> Res<Task> {
    with_db!(state, |c| db::update_task(c, id, patch))
}

#[tauri::command]
pub async fn delete_task(state: S<'_>, id: i64) -> Res<()> {
    with_db!(state, |c| db::delete_task(c, id))
}

#[tauri::command]
pub async fn restore_task(state: S<'_>, id: i64) -> Res<()> {
    with_db!(state, |c| db::restore_task(c, id))
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
    with_db!(state, |c| db::set_period_task(c, period_id, task_id, on))
}

#[tauri::command]
pub async fn set_week_task(state: S<'_>, week: String, task_id: i64, on: bool) -> Res<()> {
    with_db!(state, |c| db::set_week_task(c, &week, task_id, on))
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
    Ok(state.sessions.lock().map_err(db::err)?.clone())
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

#[tauri::command]
pub async fn get_limit_alerts(state: S<'_>) -> Res<limits::Status> {
    Ok(state.limits.lock().map_err(db::err)?.status())
}

/// Saves new thresholds and applies them to the usage at hand right away.
#[tauri::command]
pub async fn set_limit_thresholds(state: S<'_>, thresholds: Thresholds) -> Res<limits::Status> {
    let ok = |p: f64| (1.0..=100.0).contains(&p);
    if !ok(thresholds.five_hour) || !ok(thresholds.seven_day) {
        return Err("Thresholds go from 1 to 100%".into());
    }
    with_db!(state, |c| db::set_setting(c, limits::SETTING_KEY, &serde_json::to_string(&thresholds).map_err(db::err)?))?;
    let cache = state.usage.clone();
    let usage = tauri::async_runtime::spawn_blocking(move || cache.get(false)).await.map_err(db::err)?;
    let mut w = state.limits.lock().map_err(db::err)?;
    w.thresholds = thresholds;
    if usage.error.is_none() {
        w.update(&usage);
    }
    Ok(w.status())
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
