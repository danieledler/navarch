mod commands;
pub mod db;
pub mod http;
pub mod limits;
pub mod mobile;
pub mod procs;
pub mod scanner;
pub mod usage;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub db_file: String,
    pub sessions: Arc<Mutex<Vec<scanner::Session>>>,
    pub cpu: Mutex<procs::CpuMeter>,
    pub usage: Arc<usage::UsageCache>,
    pub limits: Mutex<limits::Watch>,
    pub mobile: mobile::Mobile,
}

/// The managed state reached through the app handle, for the phone server (mobile.rs).
#[derive(Clone)]
pub struct AppRef(pub tauri::AppHandle);

impl AsRef<AppState> for AppRef {
    fn as_ref(&self) -> &AppState {
        self.0.state::<AppState>().inner()
    }
}

const SCAN_INTERVAL: Duration = Duration::from_secs(3);
const LIMIT_CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// Only the app installed in /Applications (scripts/install-app.sh) opens the real database. Every other
/// build (dev windows, `cargo build`, `--dump-sessions`, bundles left in target/) gets a copy per checkout,
/// made on first launch, so a branch can't change real data or run an unfinished migration on it.
/// Delete `navarch-dev-<checkout>.db` to copy afresh.
fn database_path(data_dir: &Path) -> db::Res<PathBuf> {
    let real = data_dir.join("navarch.db");
    let Some(name) = dev_name() else { return Ok(real) };
    let dev = data_dir.join(format!("navarch-dev-{name}.db"));
    if !dev.exists() && real.exists() {
        db::copy_database(&real, &dev)?;
        mobile::forget(&rusqlite::Connection::open(&dev).map_err(db::err)?)?;
    }
    Ok(dev)
}

/// None for the app installed in /Applications; otherwise this checkout's name, for its own copies.
fn dev_name() -> Option<String> {
    if std::env::current_exe().is_ok_and(|p| p.starts_with("/Applications")) {
        return None;
    }
    let checkout = Path::new(env!("NAVARCH_CHECKOUT")).file_name().unwrap_or_default().to_string_lossy();
    Some(checkout.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect())
}

/// Keeps the usage-limit alert file in step with plan usage: refetched every 5 minutes, or every
/// minute near a threshold. Tells the UI when a new alert goes out to sessions. Dev builds skip the
/// 1-minute refetch: their alerts go to a file no hook reads.
fn start_limit_watch(app: tauri::AppHandle) {
    let installed = dev_name().is_none();
    std::thread::Builder::new()
        .name("navarch-limits".into())
        .spawn(move || {
            let mut near = false;
            loop {
                let st = app.state::<AppState>();
                let usage = st.usage.get(near && installed);
                // A failed fetch says nothing about usage: keep the alert as it is.
                if usage.error.is_none() {
                    if let Ok(mut w) = st.limits.lock() {
                        near = limits::near(&usage, &w.thresholds);
                        if let Some(summary) = w.update(&usage) {
                            let _ = app.emit("limit-alert", summary);
                        }
                    }
                }
                std::thread::sleep(LIMIT_CHECK_INTERVAL);
            }
        })
        .expect("spawn limit watch thread");
}

fn start_scanner(app: tauri::AppHandle, db_path: std::path::PathBuf, sessions: Arc<Mutex<Vec<scanner::Session>>>) {
    std::thread::Builder::new()
        .name("navarch-scanner".into())
        .spawn(move || {
            let mut sc = match db::open(&db_path).and_then(scanner::Scanner::new) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("navarch: scanner failed to start: {e}");
                    return;
                }
            };
            let mut prev = String::new();
            let mut first = true;
            loop {
                // First pass publishes metadata + stored totals immediately; the full
                // (possibly slow, first-run) transcript parse follows right after.
                let list = if first { sc.scan_quick() } else { sc.scan() };
                let json = serde_json::to_string(&list).unwrap_or_default();
                if json != prev {
                    if let Ok(mut g) = sessions.lock() {
                        *g = list.clone();
                    }
                    let _ = app.emit("sessions-updated", &list);
                    prev = json;
                }
                if !first {
                    std::thread::sleep(SCAN_INTERVAL);
                }
                first = false;
            }
        })
        .expect("spawn scanner thread");
}

fn start_cpu_sampler(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("navarch-cpu".into())
        .spawn(move || {
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
            loop {
                if let Ok(mut m) = app.state::<AppState>().cpu.lock() {
                    m.sample();
                }
                std::thread::sleep(procs::CPU_SAMPLE_INTERVAL);
            }
        })
        .expect("spawn cpu sampler thread");
}

/// Edit › Undo, kept so the UI can name the action it will undo.
struct UndoMenuItem(tauri::menu::MenuItem<tauri::Wry>);

#[tauri::command]
fn set_undo_menu(app: tauri::AppHandle, text: String, enabled: bool) -> Result<(), String> {
    if let Some(item) = app.try_state::<UndoMenuItem>() {
        item.0.set_text(text).map_err(|e| e.to_string())?;
        item.0.set_enabled(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The default macOS menu, except Edit › Undo (⌘Z) is ours: it asks the UI to undo, which
/// undoes the last Navarch action, or the text edit when a field has focus.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let Some(edit) = item.as_submenu() else { continue };
        if edit.text()? != "Edit" {
            continue;
        }
        for (i, it) in edit.items()?.into_iter().enumerate() {
            if matches!(&it, MenuItemKind::Predefined(p) if p.text().is_ok_and(|t| t == "Undo")) {
                let undo = MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
                edit.remove(&it)?;
                edit.insert(&undo, i)?;
                app.manage(UndoMenuItem(undo));
                break;
            }
        }
    }
    Ok(menu)
}

/// Dev builds get a dark-red Dock icon, so a dev window can't pass for the installed app. Runs on
/// `Ready`, right after Tauri has set the dev build's icon from `icons/icon.icns`.
#[cfg(all(dev, target_os = "macos"))]
fn set_dev_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(include_bytes!("../icons/icon-dev.png"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&icon)) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "undo" {
                let _ = app.emit("menu-undo", ());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            let dir = app.path().app_data_dir()?;
            let db_path = database_path(&dir)?;
            let conn = db::open(&db_path)?;
            let thresholds = db::get_setting(&conn, limits::SETTING_KEY)?
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default();
            let watch = limits::Watch::new(limits::Files::new(&dir, dev_name().as_deref()), thresholds);
            let sessions = Arc::new(Mutex::new(Vec::new()));
            let port = mobile::port_for(dev_name().is_none(), std::env::var(mobile::PORT_ENV).ok().as_deref());
            let handle = app.handle().clone();
            let mobile = mobile::Mobile::new(&conn, port, Box::new(move |event| {
                let _ = handle.emit(event, ());
            }));
            app.manage(AppState {
                db: Mutex::new(conn),
                db_file: db_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                sessions: sessions.clone(),
                cpu: Mutex::new(procs::CpuMeter::new()),
                usage: Arc::new(usage::UsageCache::new(Some(dir.join(usage::CACHE_FILE)))),
                limits: Mutex::new(watch),
                mobile,
            });
            start_scanner(app.handle().clone(), db_path, sessions);
            start_cpu_sampler(app.handle().clone());
            start_limit_watch(app.handle().clone());
            if app.state::<AppState>().mobile.enabled() {
                mobile::start(AppRef(app.handle().clone()));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::create_space,
            commands::update_space,
            commands::delete_space,
            commands::create_project,
            commands::update_project,
            commands::reorder_projects,
            commands::delete_project,
            commands::create_task,
            commands::update_task,
            commands::delete_task,
            commands::restore_task,
            commands::create_period,
            commands::update_period,
            commands::delete_period,
            commands::set_period_task,
            commands::set_week_task,
            commands::link_session,
            commands::open_new_session,
            commands::open_session,
            commands::reveal_path,
            commands::get_sessions,
            commands::get_system_stats,
            commands::get_cpu_history,
            commands::get_build_info,
            commands::get_usage,
            commands::get_limit_alerts,
            commands::set_limit_thresholds,
            commands::get_mobile_access,
            commands::set_mobile_access,
            commands::new_pairing_code,
            commands::reset_mobile_token,
            set_undo_menu,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Navarch")
        .run(|_app, _event| {
            #[cfg(all(dev, target_os = "macos"))]
            if let tauri::RunEvent::Ready = _event {
                set_dev_dock_icon();
            }
        });
}

/// `navarch --dump-sessions`: one full scan without the GUI, compact JSON summary to stdout.
pub fn dump_sessions() -> Result<(), String> {
    let path = database_path(&dirs::data_dir().ok_or("no data dir")?.join("se.icelab.navarch"))?;
    let t0 = std::time::Instant::now();
    let mut sc = scanner::Scanner::new(db::open(&path)?)?;
    sc.procs.refresh(); // CPU baseline
    std::thread::sleep(Duration::from_millis(500));
    let list = sc.scan();
    let mut by_status = serde_json::Map::new();
    for s in &list {
        let e = by_status.entry(s.status.clone()).or_insert(serde_json::json!(0));
        *e = serde_json::json!(e.as_i64().unwrap_or(0) + 1);
    }
    let sample: Vec<_> = list
        .iter()
        .take(5)
        .map(|s| {
            serde_json::json!({
                "id": s.id, "title": s.title, "cwd": s.cwd, "status": s.status,
                "procs": s.procs, "cpu": s.cpu, "tokens": s.tokens, "tokenRate": s.token_rate, "activeMs": s.active_ms,
                "days": s.days.len(), "taskId": s.task_id,
                "lastPrompt": s.last_prompt.as_deref().map(|p| p.chars().take(60).collect::<String>()),
                "lastReply": s.last_reply.as_deref().map(|p| p.chars().take(60).collect::<String>()),
            })
        })
        .collect();
    let out = serde_json::json!({
        "count": list.len(),
        "byStatus": by_status,
        "running": list.iter().filter(|s| s.running).count(),
        "totalTokens": list.iter().map(|s| s.tokens).sum::<i64>(),
        "tokenRate": list.iter().map(|s| s.token_rate).sum::<i64>(),
        "scanMs": t0.elapsed().as_millis() as u64,
        "sample": sample,
    });
    println!("{}", serde_json::to_string_pretty(&out).map_err(db::err)?);
    Ok(())
}
