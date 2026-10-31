//! Session scanner: reads Claude desktop session metadata, parses CLI transcripts incrementally
//! (cursor + totals persisted in SQLite), joins live process info, derives status and auto-links
//! sessions to Navarch tasks.

use crate::db::{err, now_ms, Res};
use crate::procs::{ProcInfo, ProcTracker};
use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const ACTIVE_GAP_MS: i64 = 5 * 60 * 1000;
const FIRST_PROMPT_MAX: usize = 2000;
const REPLY_MAX: usize = 1000;
const INDEX_TTL: Duration = Duration::from_secs(30);
const INDEX_MISSING_TTL: Duration = Duration::from_secs(10);
const DAYS_WINDOW: i64 = 21;
/// The token rate counts the tokens of messages written in this trailing window.
const RATE_WINDOW_MS: i64 = 60_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDay {
    pub day: String,
    pub active_ms: i64,
    pub tokens: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub cli_id: String,
    pub title: String,
    pub cwd: String,
    pub model: Option<String>,
    pub created_at: i64,
    pub last_activity_at: i64,
    pub archived: bool,
    pub status: String,
    pub running: bool,
    pub procs: u32,
    pub cpu: f64,
    pub last_prompt: Option<String>,
    /// Claude's latest text in reply to that message.
    pub last_reply: Option<String>,
    pub tokens: i64,
    /// Tokens of the messages written in the last minute, subagents included.
    pub token_rate: i64,
    pub cache_read: i64,
    pub active_ms: i64,
    pub days: Vec<SessionDay>,
    pub task_id: Option<i64>,
    /// Claude started it in a temporary folder of its own instead of a project folder.
    pub temp_folder: bool,
    /// While it sits in that temporary folder: the folder Navarch launched it for.
    pub launch_path: Option<String>,
}

/// Claude's own folders for sessions started without one ("This computer" in the Code tab).
fn is_temp_folder(cwd: &str) -> bool {
    cwd.contains("/Library/Application Support/Claude/scratch-workspaces/")
}

// ---------------- transcript parsing ----------------

/// Per-file parse cursor and running totals. Persisted as JSON in `transcripts.state`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct FileState {
    pub offset: u64,
    /// ms timestamp of the last user/assistant line (for active-time gaps)
    pub last_ts: i64,
    pub last_msg_id: String,
    /// "user" | "assistant" | "interrupt" | ""
    pub last_kind: String,
    pub last_stop: String,
    pub last_tool: String,
    pub lp: Option<String>,
    pub last_user_prompt: Option<String>,
    /// Claude's latest text block since the last prompt (main transcript only).
    pub last_reply: Option<String>,
    /// False for states saved before `last_reply` existed; `parse_file` fills it in once.
    #[serde(default)]
    pub reply_checked: bool,
    pub first_prompt: Option<String>,
    pub tokens: i64,
    pub cache_read: i64,
    /// local day -> [active_ms, tokens]
    pub days: BTreeMap<String, [i64; 2]>,
    /// (ms timestamp, tokens) of the latest messages, at most a minute apart; feeds the token rate.
    /// Not persisted: after a restart the rate counts only lines read since.
    #[serde(skip)]
    pub recent: VecDeque<(i64, i64)>,
}

impl FileState {
    pub fn last_prompt(&self) -> Option<String> {
        self.lp.clone().or_else(|| self.last_user_prompt.clone())
    }
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    message: Option<Msg>,
    #[serde(rename = "lastPrompt")]
    last_prompt: Option<String>,
}

#[derive(Deserialize)]
struct Msg {
    id: Option<String>,
    usage: Option<Usage>,
    stop_reason: Option<String>,
    content: Option<Content>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<i64>,
    cache_creation_input_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: Option<String>,
    name: Option<String>,
    text: Option<String>,
}

fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

pub fn local_day(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(d) => d.format("%Y-%m-%d").to_string(),
        None => String::new(),
    }
}

fn truncate_chars(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    memchr::memmem::find(hay, needle).is_some()
}

/// Parse the complete lines in `data` (bytes after `st.offset`). Returns bytes consumed;
/// a trailing partial line is left for the next read. Subagent files only contribute tokens.
pub fn parse_chunk(st: &mut FileState, data: &[u8], is_sub: bool) -> usize {
    let Some(last_nl) = memchr::memrchr(b'\n', data) else {
        return 0;
    };
    let body = &data[..=last_nl];
    let mut start = 0;
    for nl in memchr::memchr_iter(b'\n', body) {
        let raw = &body[start..nl];
        start = nl + 1;
        if raw.is_empty() {
            continue;
        }
        // cheap prefilter: skip the many line types we don't care about without a JSON parse
        if !(contains(raw, b"\"assistant\"") || contains(raw, b"\"user\"") || contains(raw, b"last-prompt")) {
            continue;
        }
        let Ok(line) = serde_json::from_slice::<Line>(raw) else { continue };
        let kind = line.kind.as_deref().unwrap_or("");
        let ts = line.timestamp.as_deref().and_then(parse_ts);
        match kind {
            "last-prompt" => {
                if let Some(p) = line.last_prompt.filter(|p| !p.trim().is_empty()) {
                    st.lp = Some(p);
                }
            }
            "user" if !is_sub => {
                if line.is_meta == Some(true) {
                    continue;
                }
                let Some(msg) = line.message else { continue };
                match msg.content {
                    Some(Content::Text(s)) => {
                        if st.first_prompt.is_none() {
                            st.first_prompt = Some(truncate_chars(&s, FIRST_PROMPT_MAX));
                        }
                        st.last_user_prompt = Some(truncate_chars(&s, FIRST_PROMPT_MAX));
                        st.last_reply = None;
                        st.last_kind = "user".into();
                    }
                    Some(Content::Blocks(b)) => {
                        let interrupted = b.iter().any(|b| {
                            b.kind.as_deref() == Some("text")
                                && b.text.as_deref().is_some_and(|t| t.starts_with("[Request interrupted"))
                        });
                        let prompt = !interrupted && !b.iter().any(|b| b.kind.as_deref() == Some("tool_result"));
                        if prompt {
                            st.last_reply = None;
                        }
                        st.last_kind = if interrupted { "interrupt" } else { "user" }.into();
                    }
                    None => continue,
                }
                st.last_stop.clear();
                st.last_tool.clear();
                add_active(st, ts);
            }
            "assistant" => {
                let Some(msg) = line.message else { continue };
                let id = msg.id.unwrap_or_default();
                let new_msg = id.is_empty() || id != st.last_msg_id;
                if new_msg {
                    if let Some(u) = &msg.usage {
                        let t = u.input_tokens.unwrap_or(0)
                            + u.cache_creation_input_tokens.unwrap_or(0)
                            + u.output_tokens.unwrap_or(0);
                        st.tokens += t;
                        st.cache_read += u.cache_read_input_tokens.unwrap_or(0);
                        if let Some(ms) = ts {
                            st.days.entry(local_day(ms)).or_default()[1] += t;
                            while st.recent.front().is_some_and(|r| r.0 <= ms - RATE_WINDOW_MS) {
                                st.recent.pop_front();
                            }
                            st.recent.push_back((ms, t));
                        }
                    }
                    st.last_msg_id = id;
                    if !is_sub {
                        st.last_tool.clear();
                    }
                }
                if !is_sub {
                    if let Some(Content::Blocks(b)) = &msg.content {
                        if let Some(name) = b
                            .iter()
                            .rev()
                            .find(|b| b.kind.as_deref() == Some("tool_use"))
                            .and_then(|b| b.name.clone())
                        {
                            st.last_tool = name;
                        }
                        if let Some(t) = b
                            .iter()
                            .rev()
                            .filter(|b| b.kind.as_deref() == Some("text"))
                            .filter_map(|b| b.text.as_deref().map(str::trim))
                            .find(|t| !t.is_empty())
                        {
                            st.last_reply = Some(truncate_chars(t, REPLY_MAX));
                        }
                    }
                    st.last_kind = "assistant".into();
                    st.last_stop = msg.stop_reason.unwrap_or_default();
                    add_active(st, ts);
                }
            }
            _ => {}
        }
    }
    last_nl + 1
}

/// Claude's latest reply in the transcript before byte `end`, looking back at most 1 MB.
/// Fills in `last_reply` for states saved before it existed, without reparsing whole files.
fn reply_before(path: &Path, end: u64) -> Option<String> {
    let start = end.saturating_sub(1 << 20);
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).ok()?;
    let from = if start == 0 { 0 } else { memchr::memchr(b'\n', &buf)? + 1 };
    let mut tmp = FileState::default();
    parse_chunk(&mut tmp, &buf[from..], false);
    tmp.last_reply
}

fn add_active(st: &mut FileState, ts: Option<i64>) {
    let Some(ms) = ts else { return };
    if st.last_ts > 0 {
        let gap = ms - st.last_ts;
        if gap > 0 && gap <= ACTIVE_GAP_MS {
            st.days.entry(local_day(ms)).or_default()[0] += gap;
        }
    }
    if ms > st.last_ts {
        st.last_ts = ms;
    }
}

/// Turn state from the last user/assistant line.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Turn {
    Ended,
    Waiting,
    Mid,
    Empty,
}

pub fn turn_state(st: &FileState) -> Turn {
    match st.last_kind.as_str() {
        "" => Turn::Empty,
        "interrupt" => Turn::Ended,
        "assistant" => match st.last_stop.as_str() {
            "end_turn" | "stop_sequence" => Turn::Ended,
            "tool_use" if st.last_tool == "AskUserQuestion" || st.last_tool == "ExitPlanMode" => Turn::Waiting,
            _ => Turn::Mid,
        },
        _ => Turn::Mid,
    }
}

pub fn derive_status(turn: Turn, running: bool, last_turn_edge: Option<i64>, last_focused: Option<i64>) -> &'static str {
    let ended = || {
        if last_turn_edge.unwrap_or(0) > last_focused.unwrap_or(0) {
            "unread"
        } else {
            "idle"
        }
    };
    match (turn, running) {
        (Turn::Waiting, true) => "needs_input",
        (Turn::Mid, true) => "working",
        (Turn::Ended, _) | (Turn::Empty, _) => ended(),
        (Turn::Mid, false) | (Turn::Waiting, false) => "stopped",
    }
}

// ---------------- metadata ----------------

#[derive(Clone, Debug)]
struct Meta {
    session_id: String,
    cli_id: Option<String>,
    cwd: String,
    title: String,
    model: Option<String>,
    created_at: i64,
    last_activity_at: i64,
    last_turn_edge_at: Option<i64>,
    last_focused_at: Option<i64>,
    archived: bool,
}

fn read_meta(path: &Path) -> Option<Meta> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let n = |k: &str| v.get(k).and_then(|x| x.as_f64()).map(|x| x as i64);
    let created_at = n("createdAt").unwrap_or(0);
    Some(Meta {
        session_id: s("sessionId")?,
        cli_id: s("cliSessionId").filter(|x| !x.is_empty()),
        cwd: s("cwd").unwrap_or_default(),
        title: s("title").unwrap_or_default(),
        model: s("model"),
        created_at,
        last_activity_at: n("lastActivityAt").unwrap_or(created_at),
        last_turn_edge_at: n("lastTurnEdgeAt"),
        last_focused_at: n("lastFocusedAt"),
        archived: v.get("isArchived").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

fn list_dir(p: &Path) -> Vec<PathBuf> {
    fs::read_dir(p).map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default()
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

// ---------------- scanner ----------------

pub struct Scanner {
    conn: Connection,
    sessions_dir: PathBuf,
    projects_dir: PathBuf,
    metas: HashMap<PathBuf, (SystemTime, Option<Meta>)>,
    /// cliSessionId -> main transcript path
    index: HashMap<String, PathBuf>,
    /// cliSessionId -> subagent transcript paths
    subs: HashMap<String, Vec<PathBuf>>,
    index_at: Option<Instant>,
    files: HashMap<PathBuf, FileState>,
    pub procs: ProcTracker,
}

impl Scanner {
    pub fn new(conn: Connection) -> Res<Self> {
        let home = dirs::home_dir().ok_or("no home dir")?;
        let mut files = HashMap::new();
        {
            let mut st = conn.prepare("SELECT path, state FROM transcripts").map_err(err)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(err)?;
            for (p, s) in rows.flatten() {
                if let Ok(fs) = serde_json::from_str::<FileState>(&s) {
                    files.insert(PathBuf::from(p), fs);
                }
            }
        }
        Ok(Self {
            conn,
            sessions_dir: home.join("Library/Application Support/Claude/claude-code-sessions"),
            projects_dir: home.join(".claude/projects"),
            metas: HashMap::new(),
            index: HashMap::new(),
            subs: HashMap::new(),
            index_at: None,
            files,
            procs: ProcTracker::new(),
        })
    }

    fn refresh_meta(&mut self) {
        let mut seen = Vec::new();
        for a in list_dir(&self.sessions_dir) {
            for b in list_dir(&a) {
                for f in list_dir(&b) {
                    let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    if !(name.starts_with("local_") && name.ends_with(".json")) {
                        continue;
                    }
                    let Some(mt) = mtime(&f) else { continue };
                    let stale = self.metas.get(&f).map(|(m, _)| *m != mt).unwrap_or(true);
                    if stale {
                        let meta = read_meta(&f);
                        self.metas.insert(f.clone(), (mt, meta));
                    }
                    seen.push(f);
                }
            }
        }
        if seen.len() != self.metas.len() {
            let keep: std::collections::HashSet<_> = seen.into_iter().collect();
            self.metas.retain(|k, _| keep.contains(k));
        }
    }

    fn refresh_index(&mut self) {
        let wanted: Vec<String> =
            self.metas.values().filter_map(|(_, m)| m.as_ref()?.cli_id.clone()).collect();
        let missing = wanted.iter().any(|id| !self.index.contains_key(id));
        let due = match self.index_at {
            None => true,
            Some(t) => t.elapsed() >= INDEX_TTL || (missing && t.elapsed() >= INDEX_MISSING_TTL),
        };
        if !due {
            return;
        }
        self.index_at = Some(Instant::now());
        let mut index = HashMap::new();
        for d in list_dir(&self.projects_dir) {
            for f in list_dir(&d) {
                if f.extension().is_some_and(|e| e == "jsonl") {
                    if let Some(stem) = f.file_stem() {
                        index.insert(stem.to_string_lossy().into_owned(), f);
                    }
                }
            }
        }
        let mut subs = HashMap::new();
        for id in &wanted {
            if let Some(main) = index.get(id) {
                let dir = main.with_extension("").join("subagents");
                let v: Vec<PathBuf> = list_dir(&dir)
                    .into_iter()
                    .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                    .collect();
                if !v.is_empty() {
                    subs.insert(id.clone(), v);
                }
            }
        }
        self.index = index;
        self.subs = subs;
    }

    /// Parse new bytes of one transcript; returns true if its state changed.
    fn parse_file(&mut self, path: &Path, cli_id: &str, is_sub: bool) -> bool {
        let Ok(md) = fs::metadata(path) else { return false };
        let len = md.len();
        let mut st = self.files.get(path).cloned().unwrap_or_default();
        if len == st.offset && st.reply_checked {
            return false;
        }
        if len < st.offset {
            st = FileState::default(); // file was rewritten: start over
        }
        if !st.reply_checked {
            if !is_sub && st.offset > 0 {
                st.last_reply = reply_before(path, st.offset);
            }
            st.reply_checked = true;
        }
        if len > st.offset {
            let Ok(mut f) = fs::File::open(path) else { return false };
            if f.seek(SeekFrom::Start(st.offset)).is_err() {
                return false;
            }
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = vec![0u8; 4 << 20];
            loop {
                let n = match f.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                let used = parse_chunk(&mut st, &buf, is_sub);
                st.offset += used as u64;
                buf.drain(..used);
                if st.offset + buf.len() as u64 >= len {
                    break;
                }
            }
        }
        let changed = self.files.get(path) != Some(&st);
        if changed {
            let json = serde_json::to_string(&st).unwrap_or_default();
            let _ = self.conn.execute(
                "INSERT OR REPLACE INTO transcripts(path,cli_id,is_sub,state) VALUES (?,?,?,?)",
                params![path.to_string_lossy(), cli_id, is_sub as i64, json],
            );
            self.files.insert(path.to_path_buf(), st);
        }
        changed
    }

    fn parse_transcripts(&mut self) {
        let mut jobs: Vec<(PathBuf, String, bool)> = Vec::new();
        for (_, m) in self.metas.values() {
            let Some(id) = m.as_ref().and_then(|m| m.cli_id.clone()) else { continue };
            if let Some(p) = self.index.get(&id) {
                jobs.push((p.clone(), id.clone(), false));
            }
            for p in self.subs.get(&id).into_iter().flatten() {
                jobs.push((p.clone(), id.clone(), true));
            }
        }
        for (p, id, sub) in jobs {
            self.parse_file(&p, &id, sub);
        }
    }

    fn file_state(&self, cli_id: &str) -> Option<&FileState> {
        self.index.get(cli_id).and_then(|p| self.files.get(p))
    }

    fn auto_link(&mut self) -> Res<()> {
        let now = now_ms();
        self.conn
            .execute("DELETE FROM pending_spawns WHERE created_at < ?", [now - 3_600_000])
            .map_err(err)?;
        let ids = |sql: &str| -> Res<std::collections::HashSet<String>> {
            let mut st = self.conn.prepare(sql).map_err(err)?;
            let r = st.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
            Ok(r.flatten().collect())
        };
        let linked = ids("SELECT session_id FROM session_links")?;
        let adopted = ids("SELECT session_id FROM session_folders")?;
        let mut pending: Vec<(i64, Option<i64>, String, i64)> = {
            let mut st =
                self.conn.prepare("SELECT id, task_id, path, created_at FROM pending_spawns").map_err(err)?;
            let r = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(err)?;
            r.flatten().collect()
        };
        let mut metas: Vec<Meta> = self.metas.values().filter_map(|(_, m)| m.clone()).collect();
        // Oldest first, so the first session after a spawn claims it.
        metas.sort_by_key(|m| m.created_at);
        for m in metas {
            // Claude can drop the link's folder and start the session in a temporary folder of its own.
            let temp = is_temp_folder(&m.cwd) && !adopted.contains(&m.session_id);
            let is_linked = linked.contains(&m.session_id);
            // A linked session can still owe its spawn: Claude pre-warms sessions in a placeholder
            // folder, so the marker links them before they reach the spawn's folder.
            if is_linked && !temp && pending.is_empty() {
                continue;
            }
            let marker = m
                .cli_id
                .as_deref()
                .and_then(|c| self.file_state(c))
                .and_then(|st| st.first_prompt.as_deref())
                .and_then(task_marker);
            let marker = match marker {
                Some(tid) => self
                    .conn
                    .query_row("SELECT id FROM tasks WHERE id=?", [tid], |r| r.get::<_, i64>(0))
                    .optional()
                    .map_err(err)?,
                None => None,
            };
            if let (Some(tid), false) = (marker, is_linked) {
                self.insert_link(&m.session_id, tid)?;
            }
            if pending.is_empty() {
                continue;
            }
            // The spawn it came from: the latest one in its folder, or, for a temporary folder,
            // the latest one for its task.
            let hit = pending
                .iter()
                .enumerate()
                .filter(|(_, (_, tid, path, created))| {
                    let from = if temp {
                        marker.is_none() || *tid == marker
                    } else {
                        let inside = m.cwd == *path || m.cwd.starts_with(&format!("{}/", path.trim_end_matches('/')));
                        // A linked session only takes its own task's spawn, from before it started.
                        inside && (!is_linked || (marker.is_some() && *tid == marker && *created <= m.created_at))
                    };
                    from && *created >= m.created_at - 15 * 60_000 && *created <= m.created_at + 60_000
                })
                .max_by_key(|(_, p)| p.3)
                .map(|(i, _)| i);
            let Some(i) = hit else { continue };
            let (pid, tid, path, _) = pending.remove(i);
            self.conn.execute("DELETE FROM pending_spawns WHERE id=?", [pid]).map_err(err)?;
            if temp {
                self.conn
                    .execute(
                        "INSERT OR IGNORE INTO session_folders(session_id,path,adopted_at) VALUES (?,?,?)",
                        params![m.session_id, path, now_ms()],
                    )
                    .map_err(err)?;
            }
            if let (Some(tid), None, false) = (tid, marker, is_linked) {
                self.insert_link(&m.session_id, tid)?;
            }
        }
        Ok(())
    }

    fn insert_link(&self, session_id: &str, task_id: i64) -> Res<()> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO session_links(session_id,task_id,source,linked_at) VALUES (?,?,'auto',?)",
                params![session_id, task_id, now_ms()],
            )
            .map_err(err)?;
        Ok(())
    }

    fn build(&self) -> Vec<Session> {
        let links: HashMap<String, Option<i64>> = self
            .conn
            .prepare("SELECT session_id, task_id FROM session_links")
            .and_then(|mut st| {
                st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))
                    .map(|r| r.flatten().collect())
            })
            .unwrap_or_default();
        let folders: HashMap<String, String> = self
            .conn
            .prepare("SELECT session_id, path FROM session_folders")
            .and_then(|mut st| {
                st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .map(|r| r.flatten().collect())
            })
            .unwrap_or_default();
        let live = self.procs.sessions();
        let today = Local::now().date_naive();
        let cutoff = (today - chrono::Days::new((DAYS_WINDOW - 1) as u64)).format("%Y-%m-%d").to_string();
        let empty = FileState::default();
        let since = now_ms() - RATE_WINDOW_MS;
        let rate = |st: &FileState| st.recent.iter().filter(|r| r.0 > since).map(|r| r.1).sum::<i64>();
        let mut out: Vec<Session> = Vec::new();
        for (_, m) in self.metas.values() {
            let Some(m) = m else { continue };
            let cli = m.cli_id.clone().unwrap_or_default();
            let main = self.file_state(&cli).unwrap_or(&empty);
            let mut tokens = main.tokens;
            let mut token_rate = rate(main);
            let mut cache_read = main.cache_read;
            let mut days: BTreeMap<String, [i64; 2]> = main.days.clone();
            for p in self.subs.get(&cli).into_iter().flatten() {
                if let Some(s) = self.files.get(p) {
                    tokens += s.tokens;
                    token_rate += rate(s);
                    cache_read += s.cache_read;
                    for (d, v) in &s.days {
                        days.entry(d.clone()).or_default()[1] += v[1];
                    }
                }
            }
            let active_ms: i64 = main.days.values().map(|v| v[0]).sum();
            let mut pi: ProcInfo = if cli.is_empty() { ProcInfo::default() } else { live.by_cli.get(&cli).copied().unwrap_or_default() };
            if let Some(f) = live.by_host.get(&m.session_id) {
                pi.procs += f.procs;
                pi.cpu += f.cpu;
            }
            let running = pi.procs > 0;
            if let Some(d) = live.detached.get(&m.session_id) {
                pi.procs += d.procs;
                pi.cpu += d.cpu;
            }
            let status = derive_status(turn_state(main), running, m.last_turn_edge_at, m.last_focused_at);
            let temp_folder = is_temp_folder(&m.cwd);
            out.push(Session {
                id: m.session_id.clone(),
                cli_id: cli.clone(),
                title: m.title.clone(),
                cwd: m.cwd.clone(),
                model: m.model.clone(),
                created_at: m.created_at,
                last_activity_at: m.last_activity_at,
                archived: m.archived,
                status: status.to_string(),
                running,
                procs: pi.procs,
                cpu: (pi.cpu as f64 * 10.0).round() / 10.0,
                last_prompt: main.last_prompt(),
                last_reply: main.last_reply.clone(),
                tokens,
                token_rate,
                cache_read,
                active_ms,
                days: days
                    .into_iter()
                    .filter(|(d, v)| *d >= cutoff && (v[0] > 0 || v[1] > 0))
                    .map(|(day, v)| SessionDay { day, active_ms: v[0], tokens: v[1] })
                    .collect(),
                task_id: links.get(&m.session_id).copied().flatten(),
                temp_folder,
                launch_path: if temp_folder { folders.get(&m.session_id).cloned() } else { None },
            });
        }
        out.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// Metadata + stored transcript state only (fast; used before the first full parse).
    pub fn scan_quick(&mut self) -> Vec<Session> {
        self.refresh_meta();
        self.refresh_index();
        self.procs.refresh();
        self.build()
    }

    /// Full scan: metadata, transcript index, processes, incremental parse, auto-linking.
    pub fn scan(&mut self) -> Vec<Session> {
        self.refresh_meta();
        self.refresh_index();
        self.procs.refresh();
        self.parse_transcripts();
        if let Err(e) = self.auto_link() {
            eprintln!("navarch: auto-link failed: {e}");
        }
        self.build()
    }
}

/// Extract N from "Navarch task #N".
pub fn task_marker(s: &str) -> Option<i64> {
    let i = s.find("Navarch task #")?;
    let rest = &s[i + "Navarch task #".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: serde_json::Value) -> String {
        format!("{}\n", v)
    }

    #[test]
    fn keeps_the_last_minute_of_tokens_for_the_rate() {
        let usage = serde_json::json!({"input_tokens": 1, "output_tokens": 9});
        let mut text = String::new();
        for (id, at) in [("a", "10:00:00"), ("b", "10:00:30"), ("c", "10:01:10"), ("c", "10:01:12")] {
            text += &line(serde_json::json!({"type":"assistant","timestamp":format!("2026-10-29T{at}Z"),
                "message":{"id":id,"usage":usage,"content":[{"type":"text","text":"x"}]}}));
        }
        let mut st = FileState::default();
        parse_chunk(&mut st, text.as_bytes(), false);
        // a is over a minute older than c and dropped; c's second line is the same message
        assert_eq!(st.recent.len(), 2);
        assert_eq!(st.recent.iter().map(|r| r.1).sum::<i64>(), 20);
        assert_eq!(st.tokens, 30);
    }

    #[test]
    fn parses_synthetic_transcript_incrementally() {
        let usage = serde_json::json!({"input_tokens": 10, "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 1000, "output_tokens": 5});
        let mut text = String::new();
        text += &line(serde_json::json!({"type":"user","isMeta":true,"timestamp":"2026-10-29T10:00:00Z",
            "message":{"content":"meta stuff"}}));
        text += &line(serde_json::json!({"type":"user","timestamp":"2026-10-29T10:00:00Z",
            "message":{"content":"Do Navarch task #42 please"}}));
        // one assistant message split over two lines (same id, same usage)
        text += &line(serde_json::json!({"type":"assistant","timestamp":"2026-10-29T10:00:10Z",
            "message":{"id":"m1","usage":usage,"stop_reason":"tool_use",
            "content":[{"type":"text","text":"hi"}]}}));
        text += &line(serde_json::json!({"type":"assistant","timestamp":"2026-10-29T10:00:20Z",
            "message":{"id":"m1","usage":usage,"stop_reason":"tool_use",
            "content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}));
        text += &line(serde_json::json!({"type":"user","timestamp":"2026-10-29T10:00:30Z",
            "message":{"content":[{"type":"tool_result","content":"ok"}]}}));
        let split = text.len();
        text += &line(serde_json::json!({"type":"assistant","timestamp":"2026-10-29T10:01:00Z",
            "message":{"id":"m2","usage":usage,"stop_reason":"tool_use",
            "content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}));
        text += &line(serde_json::json!({"type":"last-prompt","lastPrompt":"the last one","timestamp":"2026-10-29T10:01:00Z"}));
        // a gap > 5 min is not active time
        text += &line(serde_json::json!({"type":"user","timestamp":"2026-10-29T11:00:00Z",
            "message":{"content":"second prompt"}}));
        text += &line(serde_json::json!({"type":"assistant","timestamp":"2026-10-29T11:00:30Z",
            "message":{"id":"m3","usage":usage,"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}));
        let bytes = text.as_bytes();

        // incremental: first part plus half a line, then the rest
        let mut st = FileState::default();
        let used = parse_chunk(&mut st, &bytes[..split + 20], false);
        assert_eq!(used, split);
        st.offset = used as u64;
        assert_eq!(st.tokens, 115); // m1 counted once
        assert_eq!(turn_state(&st), Turn::Mid);
        assert_eq!(st.last_reply.as_deref(), Some("hi"));
        let used2 = parse_chunk(&mut st, &bytes[split..], false);
        assert_eq!(split + used2, bytes.len());

        assert_eq!(st.tokens, 3 * 115);
        assert_eq!(st.cache_read, 3000);
        assert_eq!(st.first_prompt.as_deref(), Some("Do Navarch task #42 please"));
        assert_eq!(st.last_prompt().as_deref(), Some("the last one"));
        assert_eq!(st.last_reply.as_deref(), Some("done"));
        assert_eq!(task_marker(st.first_prompt.as_deref().unwrap()), Some(42));
        let active: i64 = st.days.values().map(|v| v[0]).sum();
        assert_eq!(active, 60_000 + 30_000); // 10:00:00→10:01:00 and 11:00:00→11:00:30
        assert_eq!(turn_state(&st), Turn::Ended);
        assert_eq!(derive_status(Turn::Ended, true, Some(5), Some(3)), "unread");
        assert_eq!(derive_status(Turn::Ended, false, Some(3), Some(5)), "idle");
        assert_eq!(derive_status(Turn::Mid, false, None, None), "stopped");
        assert_eq!(derive_status(Turn::Mid, true, None, None), "working");

        // waiting state after AskUserQuestion
        let mut st2 = FileState::default();
        parse_chunk(&mut st2, &bytes[..bytes.len()], false);
        let mut st3 = FileState::default();
        let upto = text.find("{\"lastPrompt\"").or_else(|| text.find("last-prompt")).unwrap();
        let line_start = text[..upto].rfind('\n').unwrap() + 1;
        parse_chunk(&mut st3, &bytes[..line_start], false);
        assert_eq!(turn_state(&st3), Turn::Waiting);
        assert_eq!(st3.last_reply.as_deref(), Some("hi")); // tool-only messages keep the last text
        // a new prompt clears the reply until Claude writes again
        let after_prompt = text.find("second prompt").unwrap();
        let line_end = after_prompt + text[after_prompt..].find('\n').unwrap() + 1;
        let mut st4 = FileState::default();
        parse_chunk(&mut st4, &bytes[..line_end], false);
        assert_eq!(st4.last_reply, None);

        // backfill for states saved before last_reply: found in the tail of the parsed part
        let path = std::env::temp_dir().join(format!("navarch-reply-{}.jsonl", std::process::id()));
        fs::write(&path, &text).unwrap();
        assert_eq!(reply_before(&path, line_start as u64).as_deref(), Some("hi"));
        assert_eq!(reply_before(&path, bytes.len() as u64).as_deref(), Some("done"));
        let _ = fs::remove_file(&path);
        assert_eq!(derive_status(Turn::Waiting, true, None, None), "needs_input");

        // subagent: tokens only
        let mut sub = FileState::default();
        parse_chunk(&mut sub, bytes, true);
        assert_eq!(sub.tokens, 3 * 115);
        assert_eq!(sub.days.values().map(|v| v[0]).sum::<i64>(), 0);
        assert!(sub.first_prompt.is_none());
        assert!(sub.last_reply.is_none());
    }

    #[test]
    fn adopts_temp_folder_sessions_after_a_spawn() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let space = crate::db::snapshot(&c).unwrap().spaces[0].id;
        let p = crate::db::create_project(&c, space, "/tmp/proj", None).unwrap();
        let t = crate::db::create_task(&c, p.id, None, "t", None).unwrap();
        let min = 60_000;
        let now = now_ms();
        let spawn = |task: Option<i64>, at: i64| {
            c.execute("INSERT INTO pending_spawns(task_id,path,created_at) VALUES (?,'/tmp/proj',?)", params![task, now + at])
                .unwrap();
        };
        spawn(Some(t.id), -10 * min); // "Start session" on a task
        spawn(None, -min); // "New session" on the project
        let mut sc = Scanner::new(c).unwrap();
        let temp = "/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1";
        for (id, at) in [("local_a", -9 * min), ("local_b", -8 * min), ("local_c", 0)] {
            let m = Meta {
                session_id: id.into(), cli_id: None, cwd: temp.into(), title: id.into(), model: None,
                created_at: now + at, last_activity_at: now, last_turn_edge_at: None,
                last_focused_at: None, archived: false,
            };
            sc.metas.insert(PathBuf::from(id), (SystemTime::now(), Some(m)));
        }
        sc.auto_link().unwrap();
        let got: HashMap<String, (Option<i64>, Option<String>)> =
            sc.build().into_iter().map(|s| (s.id, (s.task_id, s.launch_path))).collect();
        // The first session after each spawn claims it; the project-only spawn adopts without a task.
        assert_eq!(got["local_a"], (Some(t.id), Some("/tmp/proj".into())));
        assert_eq!(got["local_b"], (None, None));
        assert_eq!(got["local_c"], (None, Some("/tmp/proj".into())));
    }

    #[test]
    fn consumes_the_spawn_once_a_prewarmed_session_settles() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let space = crate::db::snapshot(&c).unwrap().spaces[0].id;
        let p = crate::db::create_project(&c, space, "/tmp/proj", None).unwrap();
        let t = crate::db::create_task(&c, p.id, None, "t", None).unwrap();
        let u = crate::db::create_task(&c, p.id, None, "u", None).unwrap();
        let now = now_ms();
        for (task, at) in [(t.id, -20_000), (u.id, 10_000)] {
            c.execute("INSERT INTO pending_spawns(task_id,path,created_at) VALUES (?,'/tmp/proj',?)", params![task, now + at])
                .unwrap();
        }
        let mut sc = Scanner::new(c).unwrap();
        sc.index.insert("cli_s".into(), PathBuf::from("s.jsonl"));
        let first_prompt = Some(format!("Navarch task #{}: t", t.id));
        sc.files.insert(PathBuf::from("s.jsonl"), FileState { first_prompt, ..Default::default() });
        let meta = |cwd: &str| Meta {
            session_id: "local_s".into(), cli_id: Some("cli_s".into()), cwd: cwd.into(), title: "s".into(),
            model: None, created_at: now, last_activity_at: now, last_turn_edge_at: None,
            last_focused_at: None, archived: false,
        };
        let spawns = |sc: &Scanner| -> Vec<i64> {
            let mut st = sc.conn.prepare("SELECT task_id FROM pending_spawns ORDER BY id").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().flatten().collect()
        };
        // Claude pre-warms the session in a placeholder folder; its marker links it before the folder is known.
        let placeholder = "/Users/x/Library/Application Support/Claude/claude-code-spare";
        sc.metas.insert(PathBuf::from("s"), (SystemTime::now(), Some(meta(placeholder))));
        sc.auto_link().unwrap();
        assert_eq!(spawns(&sc), vec![t.id, u.id]);
        // Once it settles in the project folder it claims its own task's spawn, not another task's.
        sc.metas.insert(PathBuf::from("s"), (SystemTime::now(), Some(meta("/tmp/proj"))));
        sc.auto_link().unwrap();
        assert_eq!(spawns(&sc), vec![u.id]);
        let s = sc.build().into_iter().find(|s| s.id == "local_s").unwrap();
        assert_eq!((s.task_id, s.launch_path), (Some(t.id), None));
    }
}
