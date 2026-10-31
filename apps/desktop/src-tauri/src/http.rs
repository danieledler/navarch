//! The phone's API: `POST /api/<cmd>` with the Tauri command's camelCase args as a JSON object,
//! answered by the same functions as the desktop commands. Bound to 127.0.0.1 (mobile.rs); the phone
//! reaches it through `tailscale serve` or a Cloudflare tunnel, so nothing here knows the transport.

use crate::commands::core;
use crate::db::{Res, TaskPatch};
use crate::mobile::{self, Ctx};
use crate::scanner::Session;
use crate::AppState;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use chrono::{Datelike, NaiveDate};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const BODY_LIMIT: usize = 64 * 1024;
/// lastPrompt and lastReply are cut to this many characters for the phone.
const TEXT_LIMIT: usize = 280;
/// Commands that change planner data: the desktop UI reloads after each.
const WRITES: &[&str] = &["create_task", "update_task", "delete_task", "restore_task", "set_week_task", "set_period_task"];

#[derive(Debug, PartialEq)]
pub enum Failure {
    NotFound,
    BadArgs(String),
    Failed(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTask {
    project_id: i64,
    parent_id: Option<i64>,
    title: String,
    after_id: Option<i64>,
}

#[derive(Deserialize)]
struct UpdateTask {
    id: i64,
    patch: TaskPatch,
}

#[derive(Deserialize)]
struct ById {
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WeekTask {
    week: String,
    task_id: i64,
    on: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeriodTask {
    period_id: i64,
    task_id: i64,
    on: bool,
}

fn args<T: DeserializeOwned>(v: Value) -> Result<T, Failure> {
    serde_json::from_value(v).map_err(|e| Failure::BadArgs(e.to_string()))
}

fn out<T: Serialize>(r: Res<T>) -> Result<Value, Failure> {
    serde_json::to_value(r.map_err(Failure::Failed)?).map_err(|e| Failure::Failed(e.to_string()))
}

/// Runs an allowlisted command; anything else is `NotFound`. Blocking (database, usage fetch).
pub fn dispatch(st: &AppState, cmd: &str, a: Value) -> Result<Value, Failure> {
    let v = match cmd {
        "ping" => Ok(json!({ "ok": true })),
        "get_snapshot" => out(core::get_snapshot(st)),
        "get_sessions" => out(core::get_sessions(st).map(|l| slim_sessions(l, chrono::Local::now().date_naive()))),
        // Never forced: the phone mustn't drive Anthropic's usage endpoint.
        "get_usage" => out(Ok(st.usage.get(false))),
        "get_limit_alerts" => out(core::get_limit_alerts(st)),
        "create_task" => {
            let a: CreateTask = args(a)?;
            out(core::create_task(st, a.project_id, a.parent_id, &a.title, a.after_id))
        }
        "update_task" => {
            let a: UpdateTask = args(a)?;
            out(core::update_task(st, a.id, a.patch))
        }
        "delete_task" => out(core::delete_task(st, args::<ById>(a)?.id)),
        "restore_task" => out(core::restore_task(st, args::<ById>(a)?.id)),
        "set_week_task" => {
            let a: WeekTask = args(a)?;
            out(core::set_week_task(st, &a.week, a.task_id, a.on))
        }
        "set_period_task" => {
            let a: PeriodTask = args(a)?;
            out(core::set_period_task(st, a.period_id, a.task_id, a.on))
        }
        _ => Err(Failure::NotFound),
    }?;
    if WRITES.contains(&cmd) {
        st.mobile.changed();
    }
    Ok(v)
}

fn cut(mut s: String) -> String {
    if let Some((i, _)) = s.char_indices().nth(TEXT_LIMIT) {
        s.truncate(i);
    }
    s
}

/// What the phone needs of the session list: no archived sessions, short texts, and only this ISO
/// week's days (Monday to Sunday), which its week view counts.
pub fn slim_sessions(list: Vec<Session>, today: NaiveDate) -> Vec<Session> {
    let monday = today - chrono::Days::new(today.weekday().num_days_from_monday() as u64);
    let (from, to) = (monday.format("%Y-%m-%d").to_string(), (monday + chrono::Days::new(6)).format("%Y-%m-%d").to_string());
    list.into_iter()
        .filter(|s| !s.archived)
        .map(|mut s| {
            s.last_prompt = s.last_prompt.map(cut);
            s.last_reply = s.last_reply.map(cut);
            s.days.retain(|d| d.day >= from && d.day <= to);
            s
        })
        .collect()
}

fn reply(status: StatusCode, body: &Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

fn fail(status: StatusCode, msg: &str) -> Response {
    reply(status, &json!({ "error": msg }))
}

pub fn router<C: Ctx>(ctx: C) -> Router {
    Router::new().fallback(handle::<C>).layer(DefaultBodyLimit::max(BODY_LIMIT)).with_state(ctx)
}

async fn handle<C: Ctx>(
    State(ctx): State<C>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let st = ctx.as_ref();
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !st.mobile.host_allowed(host) {
        return fail(StatusCode::FORBIDDEN, "Unknown host");
    }
    let path = uri.path();
    let Some(cmd) = path.strip_prefix("/api/").or((path == "/api").then_some("")) else {
        return fail(StatusCode::NOT_FOUND, "Not found");
    };
    if method != Method::POST {
        let mut r = fail(StatusCode::METHOD_NOT_ALLOWED, "Use POST");
        r.headers_mut().insert(header::ALLOW, header::HeaderValue::from_static("POST"));
        return r;
    }
    let body = match body {
        Ok(b) => b,
        Err(e) => return fail(e.status(), &e.body_text()),
    };
    let a: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v @ Value::Object(_)) => v,
            _ => return fail(StatusCode::BAD_REQUEST, "The body must be a JSON object"),
        }
    };
    if cmd == "pair" {
        let code = a.get("code").and_then(Value::as_str).unwrap_or("");
        return match mobile::pair(st, code) {
            Ok(Some(token)) => reply(StatusCode::OK, &json!({ "token": token })),
            Ok(None) => fail(StatusCode::UNAUTHORIZED, "Wrong or expired pairing code"),
            Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e),
        };
    }
    let auth = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok());
    if !st.mobile.authorize(auth) {
        return fail(StatusCode::UNAUTHORIZED, "Not paired");
    }
    let cmd = cmd.to_string();
    let worker = ctx.clone();
    match tauri::async_runtime::spawn_blocking(move || dispatch(worker.as_ref(), &cmd, a)).await {
        Ok(Ok(v)) => reply(StatusCode::OK, &v),
        Ok(Err(Failure::NotFound)) => fail(StatusCode::NOT_FOUND, "Unknown command"),
        Ok(Err(Failure::BadArgs(e))) => fail(StatusCode::BAD_REQUEST, &e),
        Ok(Err(Failure::Failed(e))) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scanner::SessionDay;
    use crate::usage::{Usage, UsageCache};
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const TOKEN: &str = "test-token";
    const HOST: &str = "mac.tail1.ts.net";

    struct T {
        st: Arc<AppState>,
        changes: Arc<AtomicUsize>,
    }

    fn setup(usage: UsageCache) -> T {
        setup_on(0, usage)
    }

    fn setup_on(port: u16, usage: UsageCache) -> T {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let setting = json!({ "enabled": true, "publicUrl": format!("https://{HOST}") });
        db::set_setting(&c, mobile::SETTING_KEY, &setting.to_string()).unwrap();
        db::set_setting(&c, "mobile_token", TOKEN).unwrap();
        let changes = Arc::new(AtomicUsize::new(0));
        let n = changes.clone();
        let mobile = mobile::Mobile::new(&c, port, Box::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
        }));
        let dir = std::env::temp_dir().join(format!("navarch-http-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let st = AppState {
            db: Mutex::new(c),
            db_file: "memory".into(),
            sessions: Arc::new(Mutex::new(Vec::new())),
            cpu: Mutex::new(crate::procs::CpuMeter::new()),
            usage: Arc::new(usage),
            limits: Mutex::new(crate::limits::Watch::new(crate::limits::Files::new(&dir, Some("test")), Default::default())),
            mobile,
        };
        T { st: Arc::new(st), changes }
    }

    impl T {
        fn send(&self, method: &str, path: &str, host: &str, token: Option<&str>, body: String) -> (u16, Value) {
            let mut req = Request::builder().method(method).uri(path).header("host", host);
            if let Some(t) = token {
                req = req.header("authorization", format!("Bearer {t}"));
            }
            let req = req.body(Body::from(body)).unwrap();
            let app = router(self.st.clone());
            tauri::async_runtime::block_on(async move {
                let r = app.oneshot(req).await.unwrap();
                let status = r.status().as_u16();
                let bytes = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
                (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
            })
        }

        fn call(&self, cmd: &str, body: Value) -> (u16, Value) {
            self.send("POST", &format!("/api/{cmd}"), HOST, Some(TOKEN), body.to_string())
        }
    }

    #[test]
    fn needs_the_token() {
        let t = setup(UsageCache::default());
        let ping = |tok| t.send("POST", "/api/ping", "localhost:47821", tok, "{}".into());
        assert_eq!(ping(None).0, 401);
        assert_eq!(ping(Some("test-tokem")).0, 401);
        assert_eq!(ping(Some("")).0, 401);
        assert_eq!(t.st.mobile.access().last_seen_at, None);
        assert_eq!(ping(Some(TOKEN)), (200, json!({ "ok": true })));
        assert!(t.st.mobile.access().last_seen_at.is_some());
    }

    #[test]
    fn checks_host_method_allowlist_and_size() {
        let t = setup(UsageCache::default());
        for host in ["evil.example.com", "mac.tail1.ts.net.evil.com", "", "[::1]:47821"] {
            assert_eq!(t.send("POST", "/api/ping", host, Some(TOKEN), "{}".into()).0, 403, "{host}");
        }
        for host in ["localhost", "127.0.0.1:47820", "MAC.tail1.ts.net", "mac.tail1.ts.net:443"] {
            assert_eq!(t.send("POST", "/api/ping", host, Some(TOKEN), "{}".into()).0, 200, "{host}");
        }
        assert_eq!(t.call("delete_space", json!({ "id": 1 })).0, 404);
        assert_eq!(t.call("open_session", json!({ "sessionId": "x" })).0, 404);
        assert_eq!(t.send("GET", "/api/ping", HOST, Some(TOKEN), String::new()).0, 405);
        assert_eq!(t.send("GET", "/api", HOST, None, String::new()).0, 405);
        assert_eq!(t.send("OPTIONS", "/api/get_snapshot", HOST, None, String::new()).0, 405);
        assert_eq!(t.send("POST", "/other", HOST, Some(TOKEN), "{}".into()).0, 404);
        assert_eq!(t.call("ping", json!([1])).0, 400);
        let big = json!({ "x": "a".repeat(BODY_LIMIT) }).to_string();
        let (status, body) = t.send("POST", "/api/ping", HOST, Some(TOKEN), big);
        assert_eq!(status, 413);
        assert!(body["error"].is_string());
    }

    #[test]
    fn usage_is_never_forced() {
        // Old enough that a forced read would refetch, young enough for a plain read to use the cache.
        let fetched_at = db::now_ms() - 60_000;
        let cached = Usage { five_hour: None, seven_day: None, error: Some("cached".into()), fetched_at };
        let t = setup(UsageCache::holding(cached));
        let (status, body) = t.call("get_usage", json!({ "force": true }));
        assert_eq!(status, 200);
        assert_eq!((body["fetchedAt"].as_i64(), body["error"].as_str()), (Some(fetched_at), Some("cached")));
    }

    #[test]
    fn pairs_once_with_a_fresh_code() {
        let t = setup(UsageCache::default());
        let pair = |code: &str| t.send("POST", "/api/pair", HOST, None, json!({ "code": code }).to_string());
        assert_eq!(pair("ABCDEF").0, 401, "no code yet");
        let code = t.st.mobile.new_pairing_code().unwrap().code;
        assert_eq!(pair("WRONG2").0, 401);
        assert_eq!(pair(&code), (200, json!({ "token": TOKEN })));
        assert!(t.st.mobile.access().paired_at.is_some());
        assert_eq!(pair(&code).0, 401, "single use");

        let code = t.st.mobile.new_pairing_code().unwrap().code;
        for _ in 0..5 {
            assert_eq!(pair("WRONG2").0, 401);
        }
        assert_eq!(pair(&code).0, 401, "five misses end the code");

        // A new token unpairs: the old one stops working.
        let access = mobile::reset_token(&t.st).unwrap();
        assert_eq!((access.paired_at, access.last_seen_at), (None, None));
        assert_eq!(t.call("ping", json!({})).0, 401);
    }

    #[test]
    fn writes_tell_the_desktop() {
        let t = setup(UsageCache::default());
        let (status, snap) = t.call("get_snapshot", json!({}));
        assert_eq!(status, 200);
        let space = snap["spaces"][0]["id"].as_i64().unwrap();
        let project = db::create_project(&t.st.db.lock().unwrap(), space, "/tmp/p", None).unwrap();
        assert_eq!(t.changes.load(Ordering::SeqCst), 0);
        let (status, task) = t.call("create_task", json!({ "projectId": project.id, "title": "From the phone" }));
        assert_eq!(status, 200, "{task}");
        assert_eq!(task["title"], "From the phone");
        assert_eq!(t.changes.load(Ordering::SeqCst), 1);
        let id = task["id"].as_i64().unwrap();
        let (status, task) = t.call("update_task", json!({ "id": id, "patch": { "status": "done" } }));
        assert_eq!((status, task["status"].as_str()), (200, Some("done")));
        assert_eq!(t.call("set_week_task", json!({ "week": "2026-W44", "taskId": id, "on": true })).0, 200);
        assert_eq!(t.call("delete_task", json!({ "id": id })), (200, Value::Null));
        assert_eq!(t.call("restore_task", json!({ "id": id })).0, 200);
        assert_eq!(t.changes.load(Ordering::SeqCst), 5);
        // Reads, bad args and failed writes change nothing.
        assert_eq!(t.call("create_task", json!({ "title": "no project" })).0, 400);
        assert_eq!(t.call("get_limit_alerts", json!({})).0, 200);
        assert_eq!(t.changes.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn serves_on_its_port_and_reports_a_taken_one() {
        use std::io::{Read, Write};
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let t = setup_on(port, UsageCache::default());
        mobile::start(t.st.clone());
        let a = t.st.mobile.access();
        assert!(!a.running && a.error.unwrap().contains("Can't listen"));
        drop(taken);

        let on = |enabled| tauri::async_runtime::block_on(mobile::set_access(t.st.clone(), enabled, format!("https://{HOST}/")));
        // A process another test spawns at the wrong moment can briefly inherit a socket on its port.
        let eventually = |f: &dyn Fn() -> bool| {
            (0..40).any(|_| f() || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                false
            })
        };
        assert!(eventually(&|| on(true).unwrap().running), "{:?}", t.st.mobile.access());
        let mut conn = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(conn, "POST /api/ping HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
        let mut resp = String::new();
        conn.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200") && resp.ends_with(r#"{"ok":true}"#), "{resp}");
        assert!(!resp.to_ascii_lowercase().contains("access-control"));

        let a = on(false).unwrap();
        assert!(!a.running && a.error.is_none());
        assert!(eventually(&|| std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()), "the port is free again");
        assert!(eventually(&|| on(true).unwrap().running), "and it starts again");
        on(false).unwrap();
    }

    fn session(id: &str, archived: bool, days: &[&str]) -> Session {
        Session {
            id: id.into(),
            cli_id: String::new(),
            title: id.into(),
            cwd: "/tmp".into(),
            model: None,
            created_at: 0,
            last_activity_at: 0,
            archived,
            status: "idle".into(),
            running: false,
            procs: 0,
            cpu: 0.0,
            last_prompt: Some("ä".repeat(300)),
            last_reply: Some("short".into()),
            tokens: 0,
            token_rate: 0,
            cache_read: 0,
            active_ms: 0,
            days: days.iter().map(|d| SessionDay { day: d.to_string(), active_ms: 1, tokens: 1 }).collect(),
            task_id: None,
            temp_folder: false,
            launch_path: None,
            remote_id: Some("session_r".into()),
        }
    }

    #[test]
    fn sessions_are_slim() {
        let thursday = NaiveDate::from_ymd_opt(2026, 10, 29).unwrap();
        let days = ["2026-10-25", "2026-10-26", "2026-10-29", "2026-11-01", "2026-11-02"];
        let got = slim_sessions(vec![session("a", false, &days), session("b", true, &days)], thursday);
        assert_eq!(got.len(), 1);
        let s = &got[0];
        assert_eq!(s.days.iter().map(|d| d.day.as_str()).collect::<Vec<_>>(), ["2026-10-26", "2026-10-29", "2026-11-01"]);
        assert_eq!(s.last_prompt.as_ref().unwrap().chars().count(), TEXT_LIMIT);
        assert_eq!(s.last_reply.as_deref(), Some("short"));

        // Over HTTP, against today's week.
        let t = setup(UsageCache::default());
        let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        *t.st.sessions.lock().unwrap() = vec![session("a", false, &["2000-01-03", &today]), session("b", true, &[])];
        let (status, list) = t.call("get_sessions", json!({}));
        assert_eq!(status, 200);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["days"], json!([{ "day": today, "activeMs": 1, "tokens": 1 }]));
        assert_eq!(list[0]["remoteId"], "session_r");
        assert_eq!(list[0]["lastPrompt"].as_str().unwrap().chars().count(), TEXT_LIMIT);
    }
}
