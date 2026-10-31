//! Process tracking: which desktop sessions have a live `claude` process (`--resume=<cliId>`,
//! or a fresh one known by its environment) or jobs they left running detached, plus system
//! CPU stats (total, per core, load averages) with a short history.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcInfo {
    pub procs: u32,
    pub cpu: f32,
}

/// Set by the Claude desktop app on every process of a session (undocumented): the
/// desktop session id, inherited by jobs that outlive their shell.
const HOST_VAR: &str = "CLAUDE_CODE_HOST_SESSION_ID";

/// Live processes per session.
#[derive(Default)]
pub struct Live {
    /// cliSessionId -> the `claude --resume=<id>` process tree.
    pub by_cli: HashMap<String, ProcInfo>,
    /// Desktop session id -> the tree of a `claude` started without `--resume` (a fresh session).
    pub by_host: HashMap<String, ProcInfo>,
    /// Desktop session id -> jobs that left that tree (reparented to launchd, e.g. `nohup … &`).
    pub detached: HashMap<String, ProcInfo>,
}

/// A process's desktop session, from the environment it was started with.
#[derive(Clone, Debug, PartialEq)]
enum Host {
    /// macOS shows no environment for platform binaries (`/bin/bash`, `/bin/sleep`): ask their children.
    Hidden,
    Known(Option<String>),
}

pub struct ProcTracker {
    sys: System,
    /// pid -> (start time, host), read once per process.
    hosts: HashMap<Pid, (u64, Host)>,
    /// Orphaned process trees (root's parent is launchd) and the session that started them.
    detached: Vec<(Pid, String)>,
    /// `claude` processes without `--resume` and the session that started them.
    fresh: Vec<(Pid, String)>,
    args: Vec<u8>,
}

impl ProcTracker {
    pub fn new() -> Self {
        Self {
            sys: System::new().expect("sysinfo supports macOS"),
            hosts: HashMap::new(),
            detached: Vec::new(),
            fresh: Vec::new(),
            args: Vec::new(),
        }
    }

    pub fn refresh(&mut self) {
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        let procs = self.sys.processes();
        let children = children_of(procs);
        self.hosts.retain(|pid, (start, _)| procs.get(pid).is_some_and(|p| p.start_time() == *start));
        self.detached.clear();
        self.fresh.clear();
        for (pid, p) in procs {
            if is_claude(p) && resume_id(p).is_none() && !under_claude(procs, p) {
                let (_, host) = self.hosts.entry(*pid).or_insert_with(|| (p.start_time(), host_of(*pid, &mut self.args)));
                if let Host::Known(Some(id)) = host {
                    self.fresh.push((*pid, id.clone()));
                }
                continue;
            }
            if p.parent() != Some(Pid::from(1)) || is_claude(p) {
                continue;
            }
            // The first environment that shows, from the root down.
            let mut stack = vec![*pid];
            while let Some(cur) = stack.pop() {
                let Some(cp) = procs.get(&cur) else { continue };
                let (_, host) = self.hosts.entry(cur).or_insert_with(|| (cp.start_time(), host_of(cur, &mut self.args)));
                match host {
                    Host::Hidden => stack.extend(children.get(&cur).into_iter().flatten().copied()),
                    Host::Known(Some(id)) => {
                        self.detached.push((*pid, id.clone()));
                        break;
                    }
                    Host::Known(None) => {}
                }
            }
        }
    }

    pub fn sessions(&self) -> Live {
        let procs = self.sys.processes();
        let children = children_of(procs);
        let tree = |root: Pid| {
            let mut info = ProcInfo::default();
            let mut stack = vec![root];
            let mut guard = 0;
            while let Some(cur) = stack.pop() {
                guard += 1;
                if guard > 5000 {
                    break;
                }
                if let Some(cp) = procs.get(&cur) {
                    info.procs += 1;
                    info.cpu += cp.cpu_usage();
                }
                if let Some(ch) = children.get(&cur) {
                    stack.extend(ch.iter().copied());
                }
            }
            info
        };
        let add = |map: &mut HashMap<String, ProcInfo>, id: &str, info: ProcInfo| {
            let e = map.entry(id.to_string()).or_default();
            e.procs += info.procs;
            e.cpu += info.cpu;
        };
        let mut live = Live::default();
        for (pid, p) in procs {
            if !is_claude(p) {
                continue;
            }
            let Some(id) = resume_id(p) else {
                continue;
            };
            add(&mut live.by_cli, id, tree(*pid));
        }
        for (pid, host) in &self.fresh {
            add(&mut live.by_host, host, tree(*pid));
        }
        for (pid, host) in &self.detached {
            add(&mut live.detached, host, tree(*pid));
        }
        live
    }
}

fn children_of(procs: &HashMap<Pid, sysinfo::Process>) -> HashMap<Pid, Vec<Pid>> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in procs {
        if let Some(pp) = p.parent() {
            children.entry(pp).or_default().push(*pid);
        }
    }
    children
}

fn is_claude(p: &sysinfo::Process) -> bool {
    p.exe().map(|e| e.to_string_lossy().ends_with("/claude")).unwrap_or(false)
}

fn resume_id(p: &sysinfo::Process) -> Option<&str> {
    p.cmd().iter().find_map(|a| a.to_str().and_then(|s| s.strip_prefix("--resume=")))
}

/// A `claude` run from inside a session (`claude -p` in its shell) inherits the session's
/// environment and is already counted in that session's tree.
fn under_claude(procs: &HashMap<Pid, sysinfo::Process>, p: &sysinfo::Process) -> bool {
    let mut cur = p.parent();
    for _ in 0..64 {
        let Some(pp) = cur.and_then(|c| procs.get(&c)) else { return false };
        if is_claude(pp) {
            return true;
        }
        cur = pp.parent();
    }
    false
}

/// The session variable from a process's environment as it was at exec (`KERN_PROCARGS2`).
/// Only that variable is kept, and the buffer is wiped: the rest can hold tokens.
#[cfg(target_os = "macos")]
fn host_of(pid: Pid, buf: &mut Vec<u8>) -> Host {
    if buf.is_empty() {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut max: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut max as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) };
        buf.resize(if rc == 0 && max > 0 { max as usize } else { 1 << 20 }, 0);
    }
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid.as_u32() as libc::c_int];
    let mut size = buf.len();
    let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return Host::Known(None); // gone, or another user's
    }
    let host = parse_host(&buf[..size], HOST_VAR);
    buf[..size].fill(0);
    host
}

#[cfg(not(target_os = "macos"))]
fn host_of(_pid: Pid, _buf: &mut Vec<u8>) -> Host {
    Host::Known(None)
}

fn parse_host(data: &[u8], name: &str) -> Host {
    let mut vars = env_block(data).unwrap_or_default().split(|&b| b == 0).take_while(|kv| !kv.is_empty()).peekable();
    if vars.peek().is_none() {
        return Host::Hidden;
    }
    Host::Known(
        vars.find_map(|kv| kv.strip_prefix(name.as_bytes())?.strip_prefix(b"="))
            .and_then(|v| String::from_utf8(v.to_vec()).ok()),
    )
}

/// `KERN_PROCARGS2` layout: argc (i32), exec path, NUL padding, argc args, then `KEY=value`s,
/// each NUL-terminated.
fn env_block(data: &[u8]) -> Option<&[u8]> {
    let argc = i32::from_ne_bytes(data.get(..4)?.try_into().ok()?) as usize;
    let mut rest = &data[4..];
    rest = &rest[memchr::memchr(0, rest)?..];
    while rest.first() == Some(&0) {
        rest = &rest[1..];
    }
    for _ in 0..argc {
        rest = rest.get(memchr::memchr(0, rest)? + 1..)?;
    }
    Some(rest)
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu: f32,
    /// Busy % per logical core, in the order macOS numbers them.
    pub cores: Vec<f32>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub brand: String,
}

/// One point of the CPU history: unix ms, total CPU %, 1-minute load average.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct CpuSample {
    pub t: i64,
    pub cpu: f32,
    pub load1: f64,
}

pub const CPU_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const HISTORY_LEN: usize = 300; // 10 min of samples

/// Sampled on its own thread (not on UI polls) so history keeps filling while the window is hidden.
pub struct CpuMeter {
    sys: System,
    latest: SystemStats,
    history: VecDeque<CpuSample>,
}

impl CpuMeter {
    pub fn new() -> Self {
        let mut sys = System::new().expect("sysinfo supports macOS");
        sys.refresh_cpu_usage();
        Self { sys, latest: SystemStats::default(), history: VecDeque::with_capacity(HISTORY_LEN) }
    }

    pub fn sample(&mut self) {
        self.sys.refresh_cpu_usage();
        let load = System::load_average().unwrap_or_default();
        let cpus = self.sys.cpus();
        self.latest = SystemStats {
            cpu: self.sys.global_cpu_usage(),
            cores: cpus.iter().map(|c| c.usage()).collect(),
            load1: load.one,
            load5: load.five,
            load15: load.fifteen,
            brand: cpus.first().map(|c| c.brand().to_string()).unwrap_or_default(),
        };
        if self.history.len() == HISTORY_LEN {
            self.history.pop_front();
        }
        self.history.push_back(CpuSample {
            t: chrono::Utc::now().timestamp_millis(),
            cpu: self.latest.cpu,
            load1: load.one,
        });
    }

    pub fn stats(&self) -> SystemStats {
        self.latest.clone()
    }

    pub fn history(&self) -> Vec<CpuSample> {
        self.history.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_meter_reads_every_core_and_records_history() {
        let mut m = CpuMeter::new();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        m.sample();
        m.sample();
        let s = m.stats();
        assert!(!s.cores.is_empty());
        assert!(!s.brand.is_empty());
        assert!(s.load1 >= 0.0);
        assert_eq!(m.history().len(), 2);
    }

    #[test]
    fn reads_the_session_variable_past_empty_args() {
        let known = |v: &str| Host::Known(Some(v.to_string()));
        let mut d = 2i32.to_ne_bytes().to_vec();
        d.extend_from_slice(b"/bin/sh\0\0\0\0-c\0\0A=1\0CLAUDE_CODE_HOST_SESSION_ID_X=no\0CLAUDE_CODE_HOST_SESSION_ID=local_x\0\0junk=1\0");
        assert_eq!(parse_host(&d, HOST_VAR), known("local_x"));
        assert_eq!(parse_host(&d, "A"), known("1"));
        assert_eq!(parse_host(&d, "junk"), Host::Known(None));
        assert_eq!(parse_host(&d, "-c"), Host::Known(None));
        let mut hidden = 1i32.to_ne_bytes().to_vec();
        hidden.extend_from_slice(b"/bin/sleep\0\0\0sleep\0\0\0");
        assert_eq!(parse_host(&hidden, HOST_VAR), Host::Hidden);
    }

    #[test]
    fn detached_jobs_count_for_the_session_that_started_them() {
        let id = format!("local_navarch_test_{}", std::process::id());
        // The outer shell exits at once, leaving the inner one (environment hidden) to launchd,
        // with this test binary (environment visible) under it, as with `nohup ./run.sh &`.
        let script = r#"/bin/sh -c '"$0" --ignored --exact procs::tests::sleep_a_little >/dev/null 2>&1; true' "$0" &"#;
        std::process::Command::new("/bin/sh")
            .args(["-c", script])
            .arg(std::env::current_exe().unwrap())
            .env(HOST_VAR, &id)
            .status()
            .unwrap();
        let mut t = ProcTracker::new();
        let mut procs = None;
        for _ in 0..30 {
            t.refresh();
            procs = t.sessions().detached.get(&id).map(|i| i.procs);
            if procs == Some(2) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(procs, Some(2));
    }

    #[test]
    fn a_fresh_claude_counts_for_its_session_once() {
        let id = format!("local_navarch_fresh_{}", std::process::id());
        // A copy of this test binary named `claude`, started without `--resume`, that runs
        // another `claude` under it, as `claude -p` from a session's shell would. It is left to
        // launchd, outside any `claude` this test may itself run under.
        let dir = std::env::temp_dir().join(format!("navarch-fresh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("claude");
        std::fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        std::process::Command::new("/bin/sh")
            .args(["-c", r#""$0" --ignored --exact procs::tests::run_nested_claude >/dev/null 2>&1 &"#])
            .arg(&exe)
            .env(HOST_VAR, &id)
            .status()
            .unwrap();
        let mut procs = None;
        for _ in 0..30 {
            // A new tracker each time: one that saw the outer `claude` before `sh` exec'd it
            // keeps it as `/bin/sh` (the app's `disclaimer` spawns, so has no such window).
            let mut t = ProcTracker::new();
            t.refresh();
            procs = t.sessions().by_host.get(&id).map(|i| i.procs);
            if procs == Some(2) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(procs, Some(2));
    }

    #[test]
    #[ignore = "child process of a_fresh_claude_counts_for_its_session_once"]
    fn run_nested_claude() {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "procs::tests::sleep_a_little"])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
    }

    #[test]
    #[ignore = "child process of detached_jobs_count_for_the_session_that_started_them"]
    fn sleep_a_little() {
        std::thread::sleep(Duration::from_secs(3));
    }
}
