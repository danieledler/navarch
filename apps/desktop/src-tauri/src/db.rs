//! SQLite storage: schema/migrations and the planner CRUD (spaces, projects, tasks, periods).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub type Res<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub sort: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub space_id: i64,
    pub name: String,
    pub path: String,
    pub sort: f64,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub parent_id: Option<i64>,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub deadline: Option<String>,
    pub sort: f64,
    pub created_at: i64,
    pub done_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub id: i64,
    pub name: String,
    pub start: String,
    pub end: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PeriodTask {
    pub period_id: i64,
    pub task_id: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeekTask {
    pub week: String,
    pub task_id: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub spaces: Vec<Space>,
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub periods: Vec<Period>,
    pub period_tasks: Vec<PeriodTask>,
    pub week_tasks: Vec<WeekTask>,
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub deadline: Option<String>,
    pub parent_id: Option<i64>,
    pub sort: Option<f64>,
}

const SCHEMA_V1: &str = r#"
CREATE TABLE spaces(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort REAL NOT NULL DEFAULT 0);
CREATE TABLE projects(
  id INTEGER PRIMARY KEY, space_id INTEGER NOT NULL REFERENCES spaces(id), name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE, sort REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE tasks(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), parent_id INTEGER NULL,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  deadline TEXT NULL, sort REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  done_at INTEGER NULL, deleted_at INTEGER NULL);
CREATE INDEX tasks_project ON tasks(project_id);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE TABLE periods(id INTEGER PRIMARY KEY, name TEXT NOT NULL, "start" TEXT NOT NULL, "end" TEXT NOT NULL);
CREATE TABLE period_tasks(period_id INTEGER NOT NULL, task_id INTEGER NOT NULL, PRIMARY KEY(period_id, task_id));
CREATE TABLE week_tasks(week TEXT NOT NULL, task_id INTEGER NOT NULL, PRIMARY KEY(week, task_id));
CREATE TABLE session_links(session_id TEXT PRIMARY KEY, task_id INTEGER NULL, source TEXT NOT NULL, linked_at INTEGER NOT NULL);
CREATE TABLE pending_spawns(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
-- incremental transcript parsing: one row per jsonl file (main or subagent), state is JSON (cursor, totals, day buckets)
CREATE TABLE transcripts(path TEXT PRIMARY KEY, cli_id TEXT NOT NULL, is_sub INTEGER NOT NULL, state TEXT NOT NULL);
"#;

pub fn open(path: &Path) -> Res<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let conn = Connection::open(path).map_err(err)?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(err)?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
    migrate(&conn)?;
    Ok(conn)
}

/// A consistent copy of a live database, WAL included, without writing to it.
pub fn copy_database(from: &Path, to: &Path) -> Res<()> {
    let src = Connection::open_with_flags(from, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
    src.execute("VACUUM INTO ?1", [to.to_string_lossy()]).map_err(err)?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> Res<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(err)?;
    if v < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"))
            .map_err(err)?;
    }
    if v < 2 {
        // pending_spawns: task_id becomes optional (a project's "New session"); rows live an hour, so recreate.
        // session_folders: the folder Navarch launched a session for, when Claude started it in a temp folder instead.
        conn.execute_batch(
            "BEGIN;
             DROP TABLE pending_spawns;
             CREATE TABLE pending_spawns(id INTEGER PRIMARY KEY, task_id INTEGER NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE session_folders(session_id TEXT PRIMARY KEY, path TEXT NOT NULL, adopted_at INTEGER NOT NULL);
             PRAGMA user_version = 2;
             COMMIT;",
        )
        .map_err(err)?;
    }
    if v < 3 {
        // settings: app preferences, key → JSON (the usage-limit alert thresholds).
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 3;
             COMMIT;",
        )
        .map_err(err)?;
    }
    let n: i64 = conn.query_row("SELECT count(*) FROM spaces", [], |r| r.get(0)).map_err(err)?;
    if n == 0 {
        conn.execute_batch(
            "INSERT INTO spaces(name,color,sort) VALUES ('Work','#3b82f6',1),('Personal','#22c55e',2);",
        )
        .map_err(err)?;
    }
    Ok(())
}

pub fn get_setting(c: &Connection, key: &str) -> Res<Option<String>> {
    c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional().map_err(err)
}

pub fn set_setting(c: &Connection, key: &str, value: &str) -> Res<()> {
    c.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value])
        .map_err(err)?;
    Ok(())
}

pub fn delete_setting(c: &Connection, key: &str) -> Res<()> {
    c.execute("DELETE FROM settings WHERE key=?1", [key]).map_err(err)?;
    Ok(())
}

// ---------- row mappers ----------

const SPACE_COLS: &str = "id,name,color,sort";
const PROJECT_COLS: &str = "id,space_id,name,path,sort,created_at";
const TASK_COLS: &str = "id,project_id,parent_id,title,notes,status,deadline,sort,created_at,done_at";
const PERIOD_COLS: &str = r#"id,name,"start","end""#;

fn space_row(r: &Row) -> rusqlite::Result<Space> {
    Ok(Space { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, sort: r.get(3)? })
}
fn project_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        space_id: r.get(1)?,
        name: r.get(2)?,
        path: r.get(3)?,
        sort: r.get(4)?,
        created_at: r.get(5)?,
    })
}
fn task_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        project_id: r.get(1)?,
        parent_id: r.get(2)?,
        title: r.get(3)?,
        notes: r.get(4)?,
        status: r.get(5)?,
        deadline: r.get(6)?,
        sort: r.get(7)?,
        created_at: r.get(8)?,
        done_at: r.get(9)?,
    })
}
fn period_row(r: &Row) -> rusqlite::Result<Period> {
    Ok(Period { id: r.get(0)?, name: r.get(1)?, start: r.get(2)?, end: r.get(3)? })
}

fn query_all<T>(
    conn: &Connection,
    sql: &str,
    f: impl FnMut(&Row) -> rusqlite::Result<T>,
) -> Res<Vec<T>> {
    let mut st = conn.prepare(sql).map_err(err)?;
    let rows = st.query_map([], f).map_err(err)?;
    rows.collect::<rusqlite::Result<Vec<T>>>().map_err(err)
}

pub fn get_space(conn: &Connection, id: i64) -> Res<Space> {
    conn.query_row(&format!("SELECT {SPACE_COLS} FROM spaces WHERE id=?"), [id], space_row)
        .map_err(err)
}
pub fn get_project(conn: &Connection, id: i64) -> Res<Project> {
    conn.query_row(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id=?"), [id], project_row)
        .map_err(err)
}
pub fn get_task(conn: &Connection, id: i64) -> Res<Task> {
    conn.query_row(&format!("SELECT {TASK_COLS} FROM tasks WHERE id=?"), [id], task_row)
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("Task {id} not found"))
}
pub fn get_period(conn: &Connection, id: i64) -> Res<Period> {
    conn.query_row(&format!("SELECT {PERIOD_COLS} FROM periods WHERE id=?"), [id], period_row)
        .map_err(err)
}

pub fn snapshot(conn: &Connection) -> Res<Snapshot> {
    Ok(Snapshot {
        spaces: query_all(conn, &format!("SELECT {SPACE_COLS} FROM spaces ORDER BY sort,id"), space_row)?,
        projects: query_all(
            conn,
            &format!("SELECT {PROJECT_COLS} FROM projects ORDER BY sort,id"),
            project_row,
        )?,
        tasks: query_all(
            conn,
            &format!("SELECT {TASK_COLS} FROM tasks WHERE deleted_at IS NULL ORDER BY sort,id"),
            task_row,
        )?,
        periods: query_all(
            conn,
            &format!(r#"SELECT {PERIOD_COLS} FROM periods ORDER BY "start",id"#),
            period_row,
        )?,
        period_tasks: query_all(conn, "SELECT period_id,task_id FROM period_tasks", |r| {
            Ok(PeriodTask { period_id: r.get(0)?, task_id: r.get(1)? })
        })?,
        week_tasks: query_all(conn, "SELECT week,task_id FROM week_tasks ORDER BY week", |r| {
            Ok(WeekTask { week: r.get(0)?, task_id: r.get(1)? })
        })?,
    })
}

// ---------- spaces ----------

pub fn create_space(conn: &Connection, name: &str, color: &str) -> Res<Space> {
    let sort: f64 = conn
        .query_row("SELECT coalesce(max(sort),0)+1 FROM spaces", [], |r| r.get(0))
        .map_err(err)?;
    conn.execute("INSERT INTO spaces(name,color,sort) VALUES (?,?,?)", params![name, color, sort])
        .map_err(err)?;
    get_space(conn, conn.last_insert_rowid())
}

pub fn update_space(conn: &Connection, id: i64, name: &str, color: &str) -> Res<Space> {
    conn.execute("UPDATE spaces SET name=?, color=? WHERE id=?", params![name, color, id])
        .map_err(err)?;
    get_space(conn, id)
}

pub fn delete_space(conn: &Connection, id: i64) -> Res<()> {
    let n: i64 = conn
        .query_row("SELECT count(*) FROM projects WHERE space_id=?", [id], |r| r.get(0))
        .map_err(err)?;
    if n > 0 {
        return Err("Space has projects".into());
    }
    conn.execute("DELETE FROM spaces WHERE id=?", [id]).map_err(err)?;
    Ok(())
}

// ---------- projects ----------

pub fn create_project(conn: &Connection, space_id: i64, path: &str, name: Option<String>) -> Res<Project> {
    let path = path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    let exists: Option<i64> = conn
        .query_row("SELECT id FROM projects WHERE path=?", [path], |r| r.get(0))
        .optional()
        .map_err(err)?;
    if exists.is_some() {
        return Err("Project already imported".into());
    }
    get_space(conn, space_id).map_err(|_| format!("Space {space_id} not found"))?;
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
        Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    });
    let sort: f64 = conn
        .query_row("SELECT coalesce(max(sort),0)+1 FROM projects WHERE space_id=?", [space_id], |r| r.get(0))
        .map_err(err)?;
    conn.execute(
        "INSERT INTO projects(space_id,name,path,sort,created_at) VALUES (?,?,?,?,?)",
        params![space_id, name, path, sort, now_ms()],
    )
    .map_err(err)?;
    get_project(conn, conn.last_insert_rowid())
}

pub fn update_project(conn: &Connection, id: i64, name: Option<String>, space_id: Option<i64>) -> Res<Project> {
    if let Some(n) = name {
        conn.execute("UPDATE projects SET name=? WHERE id=?", params![n, id]).map_err(err)?;
    }
    if let Some(s) = space_id {
        get_space(conn, s).map_err(|_| format!("Space {s} not found"))?;
        let sort: f64 = conn
            .query_row("SELECT coalesce(max(sort),0)+1 FROM projects WHERE space_id=?", [s], |r| r.get(0))
            .map_err(err)?;
        conn.execute(
            "UPDATE projects SET space_id=?, sort=CASE WHEN space_id=? THEN sort ELSE ? END WHERE id=?",
            params![s, s, sort, id],
        )
        .map_err(err)?;
    }
    get_project(conn, id)
}

pub fn delete_project(conn: &mut Connection, id: i64) -> Res<()> {
    let tx = conn.transaction().map_err(err)?;
    let sub = "SELECT id FROM tasks WHERE project_id=?1";
    for t in ["period_tasks", "week_tasks", "session_links", "pending_spawns"] {
        tx.execute(&format!("DELETE FROM {t} WHERE task_id IN ({sub})"), [id]).map_err(err)?;
    }
    tx.execute("DELETE FROM tasks WHERE project_id=?", [id]).map_err(err)?;
    tx.execute("DELETE FROM projects WHERE id=?", [id]).map_err(err)?;
    tx.commit().map_err(err)
}

/// Renumbers the sort of `ids` (a space's projects, in their new order) to 1..n.
pub fn reorder_projects(conn: &mut Connection, ids: &[i64]) -> Res<()> {
    let tx = conn.transaction().map_err(err)?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE projects SET sort=? WHERE id=?", params![(i + 1) as f64, id]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

// ---------- tasks ----------

fn next_sort_after(conn: &Connection, project_id: i64, parent_id: Option<i64>, after: f64) -> Res<f64> {
    let next: Option<f64> = conn
        .query_row(
            "SELECT min(sort) FROM tasks WHERE project_id=? AND parent_id IS ? AND deleted_at IS NULL AND sort > ?",
            params![project_id, parent_id, after],
            |r| r.get(0),
        )
        .map_err(err)?;
    Ok(match next {
        Some(n) => (after + n) / 2.0,
        None => after + 1.0,
    })
}

fn append_sort(conn: &Connection, project_id: i64, parent_id: Option<i64>) -> Res<f64> {
    conn.query_row(
        "SELECT coalesce(max(sort),0)+1 FROM tasks WHERE project_id=? AND parent_id IS ? AND deleted_at IS NULL",
        params![project_id, parent_id],
        |r| r.get(0),
    )
    .map_err(err)
}

pub fn create_task(
    conn: &Connection,
    project_id: i64,
    parent_id: Option<i64>,
    title: &str,
    after_id: Option<i64>,
) -> Res<Task> {
    get_project(conn, project_id).map_err(|_| format!("Project {project_id} not found"))?;
    let parent_id = parent_id.filter(|&p| p != 0);
    if let Some(p) = parent_id {
        let pt = get_task(conn, p)?;
        if pt.project_id != project_id {
            return Err("Parent task belongs to another project".into());
        }
    }
    let sort = match after_id {
        Some(a) => {
            let at = get_task(conn, a)?;
            next_sort_after(conn, project_id, parent_id, at.sort)?
        }
        None => append_sort(conn, project_id, parent_id)?,
    };
    conn.execute(
        "INSERT INTO tasks(project_id,parent_id,title,notes,status,sort,created_at) VALUES (?,?,?,'','open',?,?)",
        params![project_id, parent_id, title, sort, now_ms()],
    )
    .map_err(err)?;
    get_task(conn, conn.last_insert_rowid())
}

/// True if `candidate` is `id` or one of its descendants.
fn is_self_or_descendant(conn: &Connection, id: i64, candidate: i64) -> Res<bool> {
    let mut cur = Some(candidate);
    let mut guard = 0;
    while let Some(c) = cur {
        if c == id {
            return Ok(true);
        }
        cur = conn
            .query_row("SELECT parent_id FROM tasks WHERE id=?", [c], |r| r.get::<_, Option<i64>>(0))
            .optional()
            .map_err(err)?
            .flatten();
        guard += 1;
        if guard > 10_000 {
            return Err("Task tree cycle detected".into());
        }
    }
    Ok(false)
}

pub fn update_task(conn: &mut Connection, id: i64, patch: TaskPatch) -> Res<Task> {
    let task = get_task(conn, id)?;
    let tx = conn.transaction().map_err(err)?;
    if let Some(t) = &patch.title {
        tx.execute("UPDATE tasks SET title=? WHERE id=?", params![t, id]).map_err(err)?;
    }
    if let Some(n) = &patch.notes {
        tx.execute("UPDATE tasks SET notes=? WHERE id=?", params![n, id]).map_err(err)?;
    }
    if let Some(s) = &patch.status {
        match s.as_str() {
            "done" => {
                if task.status != "done" {
                    tx.execute("UPDATE tasks SET status='done', done_at=? WHERE id=?", params![now_ms(), id])
                        .map_err(err)?;
                }
            }
            "open" => {
                tx.execute("UPDATE tasks SET status='open', done_at=NULL WHERE id=?", [id]).map_err(err)?;
            }
            other => return Err(format!("Invalid status '{other}'")),
        }
    }
    if let Some(d) = &patch.deadline {
        let v: Option<&str> = if d.is_empty() { None } else { Some(d.as_str()) };
        tx.execute("UPDATE tasks SET deadline=? WHERE id=?", params![v, id]).map_err(err)?;
    }
    if let Some(p) = patch.parent_id {
        let new_parent = if p == 0 { None } else { Some(p) };
        if new_parent != task.parent_id {
            if let Some(np) = new_parent {
                if is_self_or_descendant(&tx, id, np)? {
                    return Err("Cannot move a task under itself".into());
                }
                let pt = get_task(&tx, np)?;
                if pt.project_id != task.project_id {
                    return Err("Parent task belongs to another project".into());
                }
            }
            tx.execute("UPDATE tasks SET parent_id=? WHERE id=?", params![new_parent, id]).map_err(err)?;
            if patch.sort.is_none() {
                let s = append_sort(&tx, task.project_id, new_parent)?;
                tx.execute("UPDATE tasks SET sort=? WHERE id=?", params![s, id]).map_err(err)?;
            }
        }
    }
    if let Some(s) = patch.sort {
        tx.execute("UPDATE tasks SET sort=? WHERE id=?", params![s, id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    get_task(conn, id)
}

pub fn delete_task(conn: &Connection, id: i64) -> Res<()> {
    get_task(conn, id)?;
    let stamp = now_ms();
    conn.execute(
        "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id=sub.id)
         UPDATE tasks SET deleted_at=?2 WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL",
        params![id, stamp],
    )
    .map_err(err)?;
    Ok(())
}

pub fn restore_task(conn: &Connection, id: i64) -> Res<()> {
    let stamp: Option<i64> = conn
        .query_row("SELECT deleted_at FROM tasks WHERE id=?", [id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("Task {id} not found"))?;
    if let Some(s) = stamp {
        conn.execute(
            "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id=sub.id)
             UPDATE tasks SET deleted_at=NULL WHERE id IN (SELECT id FROM sub) AND deleted_at=?2",
            params![id, s],
        )
        .map_err(err)?;
    }
    Ok(())
}

// ---------- periods ----------

pub fn create_period(conn: &Connection, name: &str, start: &str, end: &str) -> Res<Period> {
    conn.execute(r#"INSERT INTO periods(name,"start","end") VALUES (?,?,?)"#, params![name, start, end])
        .map_err(err)?;
    get_period(conn, conn.last_insert_rowid())
}

pub fn update_period(conn: &Connection, id: i64, name: &str, start: &str, end: &str) -> Res<Period> {
    conn.execute(
        r#"UPDATE periods SET name=?, "start"=?, "end"=? WHERE id=?"#,
        params![name, start, end, id],
    )
    .map_err(err)?;
    get_period(conn, id)
}

pub fn delete_period(conn: &Connection, id: i64) -> Res<()> {
    conn.execute("DELETE FROM period_tasks WHERE period_id=?", [id]).map_err(err)?;
    conn.execute("DELETE FROM periods WHERE id=?", [id]).map_err(err)?;
    Ok(())
}

pub fn set_period_task(conn: &Connection, period_id: i64, task_id: i64, on: bool) -> Res<()> {
    if on {
        conn.execute("INSERT OR IGNORE INTO period_tasks(period_id,task_id) VALUES (?,?)", params![period_id, task_id])
    } else {
        conn.execute("DELETE FROM period_tasks WHERE period_id=? AND task_id=?", params![period_id, task_id])
    }
    .map_err(err)?;
    Ok(())
}

pub fn set_week_task(conn: &Connection, week: &str, task_id: i64, on: bool) -> Res<()> {
    if on {
        conn.execute("INSERT OR IGNORE INTO week_tasks(week,task_id) VALUES (?,?)", params![week, task_id])
    } else {
        conn.execute("DELETE FROM week_tasks WHERE week=? AND task_id=?", params![week, task_id])
    }
    .map_err(err)?;
    Ok(())
}

// ---------- session links ----------

pub fn link_session(conn: &Connection, session_id: &str, task_id: Option<i64>) -> Res<()> {
    // An unlink keeps a row with task_id NULL so the scanner does not auto-link the session again.
    conn.execute(
        "INSERT INTO session_links(session_id,task_id,source,linked_at) VALUES (?,?,'manual',?)
         ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id, source='manual', linked_at=excluded.linked_at",
        params![session_id, task_id, now_ms()],
    )
    .map_err(err)?;
    Ok(())
}

pub fn add_pending_spawn(conn: &Connection, task_id: Option<i64>, path: &str) -> Res<()> {
    conn.execute(
        "INSERT INTO pending_spawns(task_id,path,created_at) VALUES (?,?,?)",
        params![task_id, path.trim_end_matches('/'), now_ms()],
    )
    .map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_database_includes_the_wal() {
        let dir = std::env::temp_dir().join(format!("navarch-copy-{}", std::process::id()));
        let (a, b) = (dir.join("a.db"), dir.join("b.db"));
        let live = open(&a).unwrap(); // seeded, still open: rows may sit in the WAL
        let count = |c: &Connection| c.query_row("SELECT count(*) FROM spaces", [], |r| r.get::<_, i64>(0)).unwrap();
        copy_database(&a, &b).unwrap();
        assert!(count(&live) > 0);
        assert_eq!(count(&live), count(&Connection::open(&b).unwrap()));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn settings_round_trip() {
        let c = mem();
        assert_eq!(get_setting(&c, "k").unwrap(), None);
        set_setting(&c, "k", "1").unwrap();
        set_setting(&c, "k", "2").unwrap();
        assert_eq!(get_setting(&c, "k").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn seed_and_tree_soft_delete_restore() {
        let mut c = mem();
        let s = snapshot(&c).unwrap();
        assert_eq!(s.spaces.len(), 2);
        let p = create_project(&c, s.spaces[0].id, "/tmp/foo/", None).unwrap();
        assert_eq!(p.name, "foo");
        assert!(create_project(&c, s.spaces[0].id, "/tmp/foo", None).is_err());
        assert_eq!(delete_space(&c, s.spaces[0].id).unwrap_err(), "Space has projects");

        let q = create_project(&c, s.spaces[0].id, "/tmp/bar", None).unwrap();
        reorder_projects(&mut c, &[q.id, p.id]).unwrap();
        let order: Vec<i64> = snapshot(&c).unwrap().projects.iter().map(|x| x.id).collect();
        assert_eq!(order, [q.id, p.id]);
        delete_project(&mut c, q.id).unwrap();

        let a = create_task(&c, p.id, None, "a", None).unwrap();
        let b = create_task(&c, p.id, None, "b", None).unwrap();
        let mid = create_task(&c, p.id, None, "mid", Some(a.id)).unwrap();
        assert!(mid.sort > a.sort && mid.sort < b.sort);
        let a1 = create_task(&c, p.id, Some(a.id), "a1", None).unwrap();
        let a11 = create_task(&c, p.id, Some(a1.id), "a11", None).unwrap();

        // cycle rejection
        let e = update_task(&mut c, a.id, TaskPatch { parent_id: Some(a11.id), ..Default::default() });
        assert!(e.is_err());
        // status/deadline conventions
        let t = update_task(
            &mut c,
            b.id,
            TaskPatch { status: Some("done".into()), deadline: Some("2026-11-01".into()), ..Default::default() },
        )
        .unwrap();
        assert!(t.done_at.is_some() && t.deadline.as_deref() == Some("2026-11-01"));
        let t = update_task(
            &mut c,
            b.id,
            TaskPatch { status: Some("open".into()), deadline: Some("".into()), ..Default::default() },
        )
        .unwrap();
        assert!(t.done_at.is_none() && t.deadline.is_none());

        // delete a11 separately first, then the a subtree; restore a must not bring back a11
        delete_task(&c, a11.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        delete_task(&c, a.id).unwrap();
        assert_eq!(snapshot(&c).unwrap().tasks.len(), 2);
        restore_task(&c, a.id).unwrap();
        let ids: Vec<i64> = snapshot(&c).unwrap().tasks.iter().map(|t| t.id).collect();
        assert!(ids.contains(&a.id) && ids.contains(&a1.id) && !ids.contains(&a11.id));

        set_week_task(&c, "2026-W44", a.id, true).unwrap();
        set_week_task(&c, "2026-W44", a.id, true).unwrap();
        assert_eq!(snapshot(&c).unwrap().week_tasks.len(), 1);
        delete_project(&mut c, p.id).unwrap();
        let s = snapshot(&c).unwrap();
        assert!(s.tasks.is_empty() && s.week_tasks.is_empty() && s.projects.is_empty());
    }
}
