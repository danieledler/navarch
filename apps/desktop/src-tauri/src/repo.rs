//! The Repo panel's data (`get_repo_overview`): a project folder's git worktrees, compared with the base
//! branch, and its GitHub pull requests and issues through the `gh` CLI. Nothing runs in the background: only
//! when the UI asks. git runs as /usr/bin/git (5 s timeout, never through a shell, no optional locks so a
//! working session's index.lock is never taken); gh signs in on its own (its token is never read here) and its
//! data is cached 5 min per repo.

use crate::tailscale::exec;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// A GUI app's PATH is only /usr/bin:/bin:/usr/sbin:/sbin; Apple's git is always here.
const GIT: &str = "/usr/bin/git";
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// The usual install places, tried after PATH.
const GH_CLIS: &[&str] = &["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const GH_TIMEOUT: Duration = Duration::from_secs(20);
/// How long GitHub data, or a failure to get it, is reused unless forced.
const GH_TTL: Duration = Duration::from_secs(5 * 60);
const GH_MISSING: &str = "GitHub CLI (gh) not found. Install it with brew install gh.";
const GH_SIGNED_OUT: &str = "gh is not signed in. Run gh auth login in a terminal.";
const NO_REMOTE: &str = "No GitHub remote";
/// Fields of a pull request, asked for with `gh api graphql`: unlike `gh pr list --json`, counts come as
/// `totalCount`, not as full lists (gh's `commits` costs ~10,700 nodes per PR).
const PR_FRAGMENT: &str = "fragment pr on PullRequest {
  number title url author { login } isDraft state headRefName baseRefName createdAt updatedAt mergedAt closedAt
  reviewDecision additions deletions changedFiles body mergeable mergeStateStatus
  labels(first: 20) { nodes { name color } }
  latestReviews(first: 20) { nodes { author { login } state } }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug name } } } }
  commits { totalCount }
  comments { totalCount }
  closingIssuesReferences(first: 10) { nodes { number } }
  autoMergeRequest { enabledAt }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
}";
const ISSUE_SELECTION: &str = "number title url author { login } createdAt updatedAt body
  labels(first: 20) { nodes { name color } }
  assignees(first: 10) { nodes { login } }
  comments { totalCount }
  milestone { title }
  issueType { name }
  subIssuesSummary { total completed }
  closedByPullRequestsReferences(first: 10) { nodes { number } }";
/// Open PRs asked for. GitHub gives a query about 10 s; on a busy repo (cli/cli) 40 open PRs take ~7 s,
/// 50 sometimes time out (mergeability and diff stats are computed per PR).
const OPEN_PRS: u32 = 40;
/// Closed PRs asked for (most recently updated first), of which the `RECENT_PRS` last merged or closed are kept.
const CLOSED_PRS: u32 = 30;
const RECENT_PRS: usize = 15;
const OPEN_ISSUES: u32 = 50;
const BODY_MAX: usize = 600;
const CHANGES_MAX: usize = 20;
const COMMITS_MAX: usize = 10;
const PROCS_MAX: usize = 10;
const CMD_MAX: usize = 160;
const CHECKS_MAX: usize = 20;

// ── Contract (apps/desktop/src/api/types.ts, "Repo overview") ──

/// Declared in display order: failing first, then pending, success, neutral.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Failure,
    Pending,
    Success,
    Neutral,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PrCheck {
    pub name: String,
    pub state: CheckState,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Label {
    pub name: String,
    /// "#rrggbb"
    pub color: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Review {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Reviewer {
    pub login: String,
    /// approved, changes_requested, commented, dismissed, or pending (still requested).
    pub state: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub is_draft: bool,
    pub state: PrState,
    pub head_ref: String,
    pub base_ref: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub review: Option<Review>,
    pub checks_state: Option<CheckState>,
    pub checks: Vec<PrCheck>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub labels: Vec<Label>,
    pub body: String,
    pub mergeable: Mergeable,
    pub merge_state: String,
    pub reviewers: Vec<Reviewer>,
    pub commits: u32,
    pub comments: u32,
    pub closing_issues: Vec<u64>,
    pub auto_merge: bool,
    pub merged_at: Option<i64>,
    pub closed_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SubIssues {
    pub total: u64,
    pub completed: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub comments: u32,
    pub body: String,
    pub milestone: Option<String>,
    pub issue_type: Option<String>,
    pub sub_issues: Option<SubIssues>,
    pub linked_pulls: Vec<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub subject: String,
    pub committed_at: i64,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
    pub changes: Vec<String>,
    pub merged: bool,
    pub locked: bool,
    pub prunable: bool,
    pub commits_ahead: Vec<WorktreeCommit>,
    pub upstream: Option<String>,
    pub unpushed: Option<u32>,
    pub procs: Vec<WorktreeProc>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WorktreeCommit {
    pub hash: String,
    pub subject: String,
    pub at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WorktreeProc {
    pub pid: u32,
    pub name: String,
    pub cmd: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubInfo {
    pub repo: String,
    pub url: String,
    pub pulls: Vec<PullRequest>,
    pub recent_pulls: Vec<PullRequest>,
    pub issues: Vec<Issue>,
    pub fetched_at: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverview {
    pub root: String,
    pub base: String,
    pub branch: Option<String>,
    pub worktrees: Vec<Worktree>,
    pub github: Option<GitHubInfo>,
    pub github_error: Option<String>,
}

// ── Overview ──

/// The repo `path` is in: its linked worktrees and its GitHub data. `None` when `path` isn't in a git repo.
/// `force` asks GitHub again even within the 5 min cache. Blocks: git calls take well under a second, gh up
/// to 20 s (run alongside them).
pub fn overview(path: &str, force: bool) -> Option<RepoOverview> {
    let entries = parse_worktrees(&git(path, &["worktree", "list", "--porcelain"])?);
    let main = entries.first()?;
    let root = main.path.clone();
    let (base, base_ref) = base_branch(&root, main.branch.as_deref());
    let slug = git(&root, &["remote", "-v"]).and_then(|r| slug_from_remotes(&r));
    let procs = cwd_procs();
    let ((github, github_error), worktrees) = std::thread::scope(|s| {
        let gh = s.spawn(|| github(&root, slug.as_deref(), force));
        let handles: Vec<_> = entries[1..]
            .iter()
            .filter(|e| !e.bare)
            .map(|e| {
                let (base, base_ref, procs) = (&base, base_ref.as_deref(), &procs);
                s.spawn(move || worktree(e, base, base_ref, procs))
            })
            .collect();
        let worktrees = handles.into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>();
        (gh.join().unwrap_or_else(|_| (None, Some("GitHub lookup failed".into()))), worktrees)
    });
    Some(RepoOverview { root, base, branch: main.branch.clone(), worktrees, github, github_error })
}

/// Runs git in `dir`; its stdout when it exits 0 in time.
fn git(dir: &str, args: &[&str]) -> Option<String> {
    let mut all = vec!["--no-optional-locks", "-C", dir, "-c", "core.quotepath=off"];
    all.extend_from_slice(args);
    let o = exec(GIT, &all, GIT_TIMEOUT, |_| false).ok()?;
    o.status?.success().then_some(o.out)
}

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Default, PartialEq)]
pub struct WtEntry {
    pub path: String,
    pub head: String,
    /// `refs/heads/x` → `x`; `None` when detached (or bare).
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// The main checkout first, then the linked worktrees.
pub fn parse_worktrees(porcelain: &str) -> Vec<WtEntry> {
    let mut out: Vec<WtEntry> = Vec::new();
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            out.push(WtEntry { path: p.to_string(), ..Default::default() });
            continue;
        }
        let Some(e) = out.last_mut() else { continue };
        let (key, val) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "HEAD" => e.head = val.to_string(),
            "branch" => e.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string()),
            "detached" => e.detached = true,
            "bare" => e.bare = true,
            "locked" => e.locked = true,
            "prunable" => e.prunable = true,
            _ => {}
        }
    }
    out
}

/// The branch worktrees are compared with, and the ref to compare against: of the local branch and origin's,
/// the one that contains the other (local main when branches land by fast-forwarding it, origin's when local
/// main is stale; local when they diverged). No ref when neither exists.
fn base_branch(root: &str, main_branch: Option<&str>) -> (String, Option<String>) {
    let has = |r: &str| git(root, &["rev-parse", "--verify", "--quiet", r]).is_some();
    let base = git(root, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .and_then(|s| s.trim().strip_prefix("origin/").map(str::to_string))
        .filter(|s| !s.is_empty())
        .or_else(|| ["main", "master"].into_iter().find(|b| has(&format!("refs/heads/{b}"))).map(str::to_string))
        .or_else(|| main_branch.map(str::to_string))
        .unwrap_or_else(|| "main".into());
    let (local, remote) = (format!("refs/heads/{base}"), format!("refs/remotes/origin/{base}"));
    let base_ref = if has(&local) {
        let stale = has(&remote) && git(root, &["merge-base", "--is-ancestor", &local, &remote]).is_some();
        Some(if stale { remote } else { local })
    } else if has(&remote) {
        Some(remote)
    } else {
        None
    };
    (base, base_ref)
}

/// `%h<US>%s<US>%ct` → a commit (time in ms).
fn parse_commit(line: &str) -> Option<WorktreeCommit> {
    let mut f = line.splitn(3, '\x1f');
    let (hash, subject, at) = (f.next()?, f.next()?, f.next()?);
    Some(WorktreeCommit { hash: hash.into(), subject: subject.into(), at: at.trim().parse::<i64>().ok()? * 1000 })
}

const LOG_FORMAT: &str = "--format=%h%x1f%s%x1f%ct";

fn worktree(e: &WtEntry, base: &str, base_ref: Option<&str>, procs: &[Proc]) -> Worktree {
    let canon = std::fs::canonicalize(&e.path).unwrap_or_else(|_| PathBuf::from(&e.path));
    let mut w = Worktree {
        path: e.path.clone(),
        branch: e.branch.clone(),
        head: e.head.chars().take(7).collect(),
        subject: String::new(),
        committed_at: 0,
        ahead: 0,
        behind: 0,
        dirty: 0,
        changes: Vec::new(),
        merged: false,
        locked: e.locked,
        prunable: e.prunable,
        commits_ahead: Vec::new(),
        upstream: None,
        unpushed: None,
        procs: procs
            .iter()
            .filter(|p| p.cwd.starts_with(&canon))
            .take(PROCS_MAX)
            .map(|p| WorktreeProc { pid: p.pid, name: p.name.clone(), cmd: p.cmd.clone() })
            .collect(),
    };
    if e.prunable {
        return w;
    }
    let dir = e.path.as_str();
    // When status fails or times out the worktree may be dirty: it then never counts as merged.
    let status_ok = if let Some(st) = git(dir, &["status", "--porcelain=v1"]) {
        let lines: Vec<&str> = st.lines().filter(|l| !l.is_empty()).collect();
        w.dirty = lines.len() as u32;
        w.changes = lines.iter().take(CHANGES_MAX).map(|l| l.to_string()).collect();
        true
    } else {
        false
    };
    if let Some(c) = git(dir, &["log", "-1", LOG_FORMAT]).and_then(|l| parse_commit(l.trim_end_matches('\n'))) {
        (w.head, w.subject, w.committed_at) = (c.hash, c.subject, c.at);
    }
    if let Some(b) = base_ref {
        let counts = git(dir, &["rev-list", "--left-right", "--count", &format!("{b}...HEAD")]).and_then(|c| {
            let (l, r) = c.trim().split_once(char::is_whitespace)?;
            Some((l.trim().parse::<u32>().ok()?, r.trim().parse::<u32>().ok()?))
        });
        if let Some((behind, ahead)) = counts {
            (w.behind, w.ahead) = (behind, ahead);
            // A fresh branch with uncommitted work is ahead 0 too: only a clean one counts as merged.
            w.merged = ahead == 0 && status_ok && w.dirty == 0 && e.branch.as_deref().is_some_and(|br| br != base);
            if ahead > 0 {
                let n = COMMITS_MAX.to_string();
                w.commits_ahead = git(dir, &["log", LOG_FORMAT, "-n", &n, &format!("{b}..HEAD")])
                    .map(|l| l.lines().filter_map(parse_commit).collect())
                    .unwrap_or_default();
            }
        }
    }
    if e.branch.is_some() {
        w.upstream = git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if w.upstream.is_some() {
            w.unpushed = git(dir, &["rev-list", "--count", "@{u}..HEAD"]).and_then(|s| s.trim().parse().ok());
        }
    }
    w
}

// ── Processes working inside a worktree ──

struct Proc {
    pid: u32,
    name: String,
    cmd: String,
    cwd: PathBuf,
}

/// Its own sysinfo state (procs.rs's tracker keeps CPU state on another cadence), refreshed per overview.
static SYS: LazyLock<Mutex<Option<System>>> = LazyLock::new(|| Mutex::new(System::new().ok()));

/// Every process whose working folder is known, oldest pid first.
fn cwd_procs() -> Vec<Proc> {
    let Ok(mut guard) = SYS.lock() else { return Vec::new() };
    let Some(sys) = guard.as_mut() else { return Vec::new() };
    let kind = ProcessRefreshKind::nothing().with_cwd(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet);
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let mut out: Vec<Proc> = sys
        .processes()
        .iter()
        .filter_map(|(pid, p)| {
            let cwd = p.cwd().filter(|c| c != &Path::new("/"))?.to_path_buf();
            let name = p.name().to_string_lossy().into_owned();
            let cmd = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ");
            let cmd = if cmd.is_empty() { name.clone() } else { cmd.chars().take(CMD_MAX).collect() };
            Some(Proc { pid: pid.as_u32(), name, cmd, cwd })
        })
        .collect();
    out.sort_by_key(|p| p.pid);
    out
}

// ── GitHub ──

/// `owner/name` of a GitHub remote URL: `git@github.com:o/n.git`, `ssh://git@github.com/o/n.git`,
/// `https://github.com/o/n(.git)`. `None` for any other host.
pub fn github_slug(url: &str) -> Option<String> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?,
        None => {
            // scp-like: [user@]host:path
            let (a, p) = url.split_once(':')?;
            if a.contains('/') {
                return None;
            }
            (a, p)
        }
    };
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if !["github.com", "www.github.com", "ssh.github.com"].iter().any(|h| host.eq_ignore_ascii_case(h)) {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name)).then(|| format!("{owner}/{name}"))
}

/// The GitHub repo of `git remote -v` output: origin's if it is on GitHub, else the first GitHub remote's.
pub fn slug_from_remotes(remote_v: &str) -> Option<String> {
    let mut first = None;
    for line in remote_v.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else { continue };
        if let Some(slug) = github_slug(url) {
            if name == "origin" {
                return Some(slug);
            }
            first.get_or_insert(slug);
        }
    }
    first
}

#[derive(Clone)]
struct Cached {
    slug: String,
    github: Option<GitHubInfo>,
    error: Option<String>,
    /// Of the last attempt, good or failed.
    at: Instant,
}

static GH_CACHE: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(Default::default);

/// GitHub data for the repo at `root`: cached for 5 min unless `force`, the last good data kept on failure.
fn github(root: &str, slug: Option<&str>, force: bool) -> (Option<GitHubInfo>, Option<String>) {
    let Some(slug) = slug else { return (None, Some(NO_REMOTE.into())) };
    let prev = GH_CACHE.lock().ok().and_then(|c| c.get(root).cloned()).filter(|c| c.slug == slug);
    if let Some(c) = &prev {
        if !force && c.at.elapsed() < GH_TTL {
            return (c.github.clone(), c.error.clone());
        }
    }
    // The lock is not held while gh runs.
    let (github, error) = match fetch_github(slug) {
        Ok(g) => (Some(g), None),
        Err(e) => (prev.and_then(|c| c.github), Some(e)),
    };
    if let Ok(mut c) = GH_CACHE.lock() {
        let entry = Cached { slug: slug.into(), github: github.clone(), error: error.clone(), at: Instant::now() };
        c.insert(root.into(), entry);
    }
    (github, error)
}

/// Runs gh (the first of `GH_CLIS` that starts); its stdout, or a message for the panel.
fn gh(args: &[&str]) -> Result<String, String> {
    for cli in GH_CLIS {
        let Ok(o) = exec(cli, args, GH_TIMEOUT, |_| false) else { continue };
        return match o.status {
            None => Err("gh timed out".into()),
            Some(st) if st.success() => Ok(o.out),
            Some(_) => Err(gh_error(&o.err)),
        };
    }
    Err(GH_MISSING.into())
}

/// What the panel says when gh failed with `stderr`.
pub fn gh_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged") {
        return GH_SIGNED_OUT.into();
    }
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("gh failed");
    line.chars().take(200).collect()
}

/// `{nodes: [...]}` → `[...]`, all through `v`, so GraphQL connections read like gh's JSON lists.
fn flatten_nodes(v: Value) -> Value {
    match v {
        Value::Object(mut m) => {
            if m.len() == 1 && m.get("nodes").is_some_and(Value::is_array) {
                return flatten_nodes(m.remove("nodes").unwrap_or_default());
            }
            Value::Object(m.into_iter().map(|(k, x)| (k, flatten_nodes(x))).collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(flatten_nodes).collect()),
        x => x,
    }
}

/// One connection of `owner/name` (`selection` is e.g. `pullRequests(...) { nodes { ...pr } }`), its nodes.
fn gh_graphql(slug: &str, selection: &str, fragment: &str) -> Result<Vec<Value>, String> {
    let (owner, name) = slug.split_once('/').ok_or_else(|| format!("Not a GitHub repo: {slug}"))?;
    let query = format!(
        "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ list: {selection} }} }}\n{fragment}"
    );
    let (q, o, n) = (format!("query={query}"), format!("owner={owner}"), format!("name={name}"));
    let out = gh(&["api", "graphql", "-f", &q, "-f", &o, "-f", &n])?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("Unexpected gh output: {e}"))?;
    let repo = v.pointer("/data/repository").filter(|r| !r.is_null()).ok_or_else(|| {
        v.pointer("/errors/0/message").and_then(Value::as_str).unwrap_or("Repository not found on GitHub").to_string()
    })?;
    match flatten_nodes(repo.get("list").cloned().unwrap_or_default()) {
        Value::Array(a) => Ok(a),
        _ => Ok(Vec::new()),
    }
}

fn fetch_github(slug: &str) -> Result<GitHubInfo, String> {
    let order = "orderBy: {field: UPDATED_AT, direction: DESC}";
    let open = format!("pullRequests(states: OPEN, first: {OPEN_PRS}, {order}) {{ nodes {{ ...pr }} }}");
    let closed = format!("pullRequests(states: [CLOSED, MERGED], first: {CLOSED_PRS}, {order}) {{ nodes {{ ...pr }} }}");
    let issues = format!("issues(states: OPEN, first: {OPEN_ISSUES}, {order}) {{ nodes {{ {ISSUE_SELECTION} }} }}");
    let lost = || Err::<Vec<Value>, _>("gh failed".to_string());
    let (open, closed, issues) = std::thread::scope(|s| {
        let a = s.spawn(|| gh_graphql(slug, &open, PR_FRAGMENT));
        let b = s.spawn(|| gh_graphql(slug, &closed, PR_FRAGMENT));
        let c = s.spawn(|| gh_graphql(slug, &issues, ""));
        (a.join().unwrap_or_else(|_| lost()), b.join().unwrap_or_else(|_| lost()), c.join().unwrap_or_else(|_| lost()))
    });
    let mut pulls: Vec<PullRequest> = open?.iter().map(parse_pr).collect();
    pulls.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    // Asked for by last update (a late comment counts), kept by when they were merged or closed.
    let mut recent_pulls: Vec<PullRequest> = closed?.iter().map(parse_pr).collect();
    recent_pulls.sort_by_key(|p| std::cmp::Reverse(p.merged_at.or(p.closed_at).unwrap_or(0)));
    recent_pulls.truncate(RECENT_PRS);
    let mut issues: Vec<Issue> = issues?.iter().map(parse_issue).collect();
    issues.sort_by_key(|i| std::cmp::Reverse(i.updated_at));
    Ok(GitHubInfo {
        repo: slug.into(),
        url: format!("https://github.com/{slug}"),
        pulls,
        recent_pulls,
        issues,
        fetched_at: chrono::Utc::now().timestamp_millis(),
    })
}

// ── gh JSON → contract ──

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// An RFC 3339 time in unix ms; `None` when missing, null or zero.
fn ms(v: &Value, k: &str) -> Option<i64> {
    let t = v.get(k)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.timestamp_millis()).filter(|&m| m > 0)
}

fn author(v: &Value) -> String {
    v.pointer("/author/login").and_then(Value::as_str).unwrap_or("").to_string()
}

/// A list's length, or a GraphQL connection's `totalCount`.
fn count(v: &Value, k: &str) -> u32 {
    match v.get(k) {
        Some(Value::Array(a)) => a.len() as u32,
        Some(c) => num(c, "totalCount") as u32,
        None => 0,
    }
}

fn numbers(v: &Value, k: &str) -> Vec<u64> {
    arr(v, k).iter().filter_map(|x| x.get("number")?.as_u64()).collect()
}

fn labels(v: &Value) -> Vec<Label> {
    arr(v, "labels")
        .iter()
        .map(|l| {
            let c = text(l, "color");
            let c = c.trim_start_matches('#');
            Label { name: text(l, "name"), color: format!("#{}", if c.is_empty() { "8b949e" } else { c }) }
        })
        .collect()
}

/// Trimmed, CRLF → LF, at most 600 chars (the last one "…" when cut).
fn body(v: &Value) -> String {
    let b = text(v, "body").replace("\r\n", "\n");
    let b = b.trim();
    if b.chars().count() <= BODY_MAX {
        return b.to_string();
    }
    let mut cut: String = b.chars().take(BODY_MAX - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// statusCheckRollup → checks, deduped by name (the last wins), failing first, at most 20.
pub fn checks(rollup: &[Value]) -> Vec<PrCheck> {
    let mut out: Vec<PrCheck> = Vec::new();
    for c in rollup {
        let up = |k: &str| text(c, k).to_ascii_uppercase();
        let (name, state) = if let Some(ctx) = c.get("context").and_then(Value::as_str) {
            let st = match up("state").as_str() {
                "SUCCESS" => CheckState::Success,
                "FAILURE" | "ERROR" => CheckState::Failure,
                "PENDING" | "EXPECTED" => CheckState::Pending,
                _ => CheckState::Neutral,
            };
            (ctx.to_string(), st)
        } else {
            let st = if up("status") != "COMPLETED" {
                CheckState::Pending
            } else {
                match up("conclusion").as_str() {
                    "SUCCESS" => CheckState::Success,
                    "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => CheckState::Failure,
                    _ => CheckState::Neutral,
                }
            };
            (text(c, "name"), st)
        };
        if name.is_empty() {
            continue;
        }
        out.retain(|x| x.name != name);
        out.push(PrCheck { name, state });
    }
    out.sort_by_key(|c| c.state);
    out
}

pub fn parse_pr(v: &Value) -> PullRequest {
    // gh's flat statusCheckRollup, or the GraphQL one on the last commit.
    let rollup = match v.get("statusCheckRollup") {
        Some(r) => r.as_array().map_or(&[][..], Vec::as_slice),
        None => v.pointer("/lastCommit/0/commit/statusCheckRollup/contexts").and_then(Value::as_array).map_or(&[][..], Vec::as_slice),
    };
    let mut checks = checks(rollup);
    // Only neutral (skipped) checks count as passing, as on GitHub.
    let checks_state = checks.iter().map(|c| c.state).min().map(|s| if s == CheckState::Neutral { CheckState::Success } else { s });
    checks.truncate(CHECKS_MAX);
    let mut reviewers: Vec<Reviewer> = Vec::new();
    for r in arr(v, "latestReviews") {
        let state = text(r, "state").to_ascii_lowercase();
        let login = author(r);
        if state.is_empty() || state == "pending" || login.is_empty() || reviewers.iter().any(|x| x.login == login) {
            continue;
        }
        reviewers.push(Reviewer { login, state });
    }
    for r in arr(v, "reviewRequests") {
        let r = r.get("requestedReviewer").unwrap_or(r);
        let login = ["login", "name", "slug"].iter().map(|k| text(r, k)).find(|s| !s.is_empty());
        if let Some(login) = login.filter(|l| !reviewers.iter().any(|x| &x.login == l)) {
            reviewers.push(Reviewer { login, state: "pending".into() });
        }
    }
    PullRequest {
        number: num(v, "number"),
        title: text(v, "title"),
        url: text(v, "url"),
        author: author(v),
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state: match text(v, "state").as_str() {
            "MERGED" => PrState::Merged,
            "CLOSED" => PrState::Closed,
            _ => PrState::Open,
        },
        head_ref: text(v, "headRefName"),
        base_ref: text(v, "baseRefName"),
        created_at: ms(v, "createdAt").unwrap_or(0),
        updated_at: ms(v, "updatedAt").unwrap_or(0),
        review: match text(v, "reviewDecision").as_str() {
            "APPROVED" => Some(Review::Approved),
            "CHANGES_REQUESTED" => Some(Review::ChangesRequested),
            "REVIEW_REQUIRED" => Some(Review::ReviewRequired),
            _ => None,
        },
        checks_state,
        checks,
        additions: num(v, "additions"),
        deletions: num(v, "deletions"),
        changed_files: num(v, "changedFiles"),
        labels: labels(v),
        body: body(v),
        mergeable: match text(v, "mergeable").as_str() {
            "MERGEABLE" => Mergeable::Mergeable,
            "CONFLICTING" => Mergeable::Conflicting,
            _ => Mergeable::Unknown,
        },
        merge_state: Some(text(v, "mergeStateStatus").to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".into()),
        reviewers,
        commits: count(v, "commits"),
        comments: count(v, "comments"),
        closing_issues: numbers(v, "closingIssuesReferences"),
        auto_merge: v.get("autoMergeRequest").is_some_and(|a| !a.is_null()),
        merged_at: ms(v, "mergedAt"),
        closed_at: ms(v, "closedAt"),
    }
}

pub fn parse_issue(v: &Value) -> Issue {
    let sub = v.get("subIssuesSummary");
    let total = sub.map_or(0, |s| num(s, "total"));
    Issue {
        number: num(v, "number"),
        title: text(v, "title"),
        url: text(v, "url"),
        author: author(v),
        created_at: ms(v, "createdAt").unwrap_or(0),
        updated_at: ms(v, "updatedAt").unwrap_or(0),
        labels: labels(v),
        assignees: arr(v, "assignees").iter().map(|a| text(a, "login")).filter(|l| !l.is_empty()).collect(),
        comments: count(v, "comments"),
        body: body(v),
        milestone: v.pointer("/milestone/title").and_then(Value::as_str).map(str::to_string),
        issue_type: v.pointer("/issueType/name").and_then(Value::as_str).map(str::to_string),
        sub_issues: (total > 0).then(|| SubIssues { total, completed: sub.map_or(0, |s| num(s, "completed")) }),
        linked_pulls: numbers(v, "closedByPullRequestsReferences"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn worktree_porcelain() {
        let s = "worktree /r\nHEAD aaaaaaaaaa\nbranch refs/heads/main\n\n\
                 worktree /r/.claude/worktrees/a\nHEAD bbbbbbbbbb\nbranch refs/heads/feat/a\nlocked in use\n\n\
                 worktree /r/.claude/worktrees/d\nHEAD cccccccccc\ndetached\n\n\
                 worktree /gone\nHEAD dddddddddd\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n\n\
                 worktree /bare.git\nbare\n\n";
        let w = parse_worktrees(s);
        assert_eq!(w.len(), 5);
        assert_eq!((w[0].path.as_str(), w[0].branch.as_deref()), ("/r", Some("main")));
        assert_eq!(w[1].branch.as_deref(), Some("feat/a"));
        assert!(w[1].locked && !w[1].prunable);
        assert!(w[2].detached && w[2].branch.is_none() && w[2].head == "cccccccccc");
        assert!(w[3].prunable && !w[3].locked);
        assert!(w[4].bare && w[4].branch.is_none());
    }

    #[test]
    fn remote_urls_to_slugs() {
        let s = |u: &str| github_slug(u);
        assert_eq!(s("git@github.com:o/n.git").as_deref(), Some("o/n"));
        assert_eq!(s("git@github.com:o/n").as_deref(), Some("o/n"));
        assert_eq!(s("ssh://git@github.com/o/n.git").as_deref(), Some("o/n"));
        assert_eq!(s("ssh://git@ssh.github.com:443/o/n.git").as_deref(), Some("o/n"));
        assert_eq!(s("https://github.com/o/n").as_deref(), Some("o/n"));
        assert_eq!(s("https://github.com/o/n.git/").as_deref(), Some("o/n"));
        assert_eq!(s("https://user@github.com/o/my.repo.git").as_deref(), Some("o/my.repo"));
        assert_eq!(s("https://gitlab.com/o/n.git"), None);
        assert_eq!(s("git@bitbucket.org:o/n.git"), None);
        assert_eq!(s("/local/path/repo"), None);
        assert_eq!(s("https://github.com/o"), None);
        let remotes = "upstream\tgit@github.com:u/n.git (fetch)\norigin\thttps://gitlab.com/x/y (fetch)\n\
                       fork\thttps://github.com/f/n (fetch)\n";
        assert_eq!(slug_from_remotes(remotes).as_deref(), Some("u/n"));
        let remotes = "a\tgit@github.com:a/n.git (fetch)\norigin\tgit@github.com:o/n.git (fetch)\n";
        assert_eq!(slug_from_remotes(remotes).as_deref(), Some("o/n"));
        assert_eq!(slug_from_remotes("origin\t/srv/repo.git (fetch)\n"), None);
    }

    #[test]
    fn gh_errors() {
        assert_eq!(gh_error("To get started with GitHub CLI, please run:  gh auth login\n"), GH_SIGNED_OUT);
        assert_eq!(gh_error("\nHTTP 404: Not Found (https://api.github.com/graphql)\nmore"), "HTTP 404: Not Found (https://api.github.com/graphql)");
        assert_eq!(gh_error(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn pr_from_gh_json() {
        let long = format!("  {}\r\nend  ", "é".repeat(700));
        let v = json!({
            "number": 107, "title": "Repo panel", "url": "https://github.com/o/n/pull/107",
            "author": {"login": "danieledler"}, "isDraft": false, "state": "OPEN",
            "headRefName": "repo-panel", "baseRefName": "main",
            "createdAt": "2026-11-01T10:00:00Z", "updatedAt": "2026-11-02T10:00:00Z",
            "reviewDecision": "CHANGES_REQUESTED",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "FAILURE"},
                {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": ""},
                {"__typename": "CheckRun", "name": "skip", "status": "COMPLETED", "conclusion": "SKIPPED"},
                {"__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR"},
                {"__typename": "StatusContext", "context": "deploy", "state": "PENDING"},
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS"}
            ],
            "additions": 342, "deletions": 113, "changedFiles": 8,
            "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "x", "color": ""}],
            "body": long, "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY",
            "latestReviews": [
                {"author": {"login": "alice"}, "state": "CHANGES_REQUESTED"},
                {"author": {"login": "bob"}, "state": "PENDING"},
                {"author": {"login": "carol"}, "state": "APPROVED"}
            ],
            "reviewRequests": [{"__typename": "User", "login": "alice"}, {"__typename": "User", "login": "dave"},
                               {"__typename": "Team", "name": "core", "slug": "core"}],
            "commits": [{}, {}, {}], "comments": [{}],
            "closingIssuesReferences": [{"number": 12}, {"number": 14}],
            "autoMergeRequest": {"mergeMethod": "SQUASH"}, "mergedAt": null, "closedAt": null
        });
        let p = parse_pr(&v);
        let names: Vec<_> = p.checks.iter().map(|c| (c.name.as_str(), c.state)).collect();
        use CheckState::*;
        assert_eq!(
            names,
            vec![("ci/legacy", Failure), ("e2e", Pending), ("deploy", Pending), ("lint", Success), ("build", Success), ("skip", Neutral)]
        );
        assert_eq!(p.checks_state, Some(Failure));
        assert_eq!(p.review, Some(Review::ChangesRequested));
        assert_eq!(p.state, PrState::Open);
        assert_eq!(p.created_at, 1_793_527_200_000);
        assert_eq!(p.mergeable, Mergeable::Conflicting);
        assert_eq!(p.merge_state, "dirty");
        let rv: Vec<_> = p.reviewers.iter().map(|r| (r.login.as_str(), r.state.as_str())).collect();
        assert_eq!(rv, vec![("alice", "changes_requested"), ("carol", "approved"), ("dave", "pending"), ("core", "pending")]);
        assert_eq!(p.labels[0], Label { name: "bug".into(), color: "#d73a4a".into() });
        assert_eq!(p.labels[1].color, "#8b949e");
        assert_eq!(p.body.chars().count(), 600);
        assert!(p.body.starts_with('é') && p.body.ends_with('…'));
        assert_eq!((p.commits, p.comments, p.closing_issues.clone(), p.auto_merge), (3, 1, vec![12, 14], true));
        assert_eq!((p.merged_at, p.closed_at), (None, None));
        assert_eq!((p.additions, p.deletions, p.changed_files), (342, 113, 8));

        let v = json!({"number": 1, "state": "MERGED", "reviewDecision": "", "statusCheckRollup": [],
                       "mergedAt": "2026-11-01T16:41:17Z", "body": " short \r\n", "autoMergeRequest": null});
        let p = parse_pr(&v);
        assert_eq!((p.state, p.review, p.checks_state, p.auto_merge), (PrState::Merged, None, None, false));
        assert_eq!((p.mergeable, p.merge_state.as_str(), p.body.as_str()), (Mergeable::Unknown, "unknown", "short"));
        assert!(p.merged_at.is_some());
        // Only neutral checks roll up to success.
        let v = json!({"statusCheckRollup": [{"name": "s", "status": "COMPLETED", "conclusion": "SKIPPED"}]});
        assert_eq!(parse_pr(&v).checks_state, Some(Success));
    }

    #[test]
    fn pr_from_graphql() {
        let v = flatten_nodes(json!({
            "number": 7, "state": "OPEN",
            "commits": {"totalCount": 12}, "comments": {"totalCount": 4},
            "labels": {"nodes": [{"name": "bug", "color": "d73a4a"}]},
            "reviewRequests": {"nodes": [{"requestedReviewer": null}, {"requestedReviewer": {"login": "ana"}},
                                         {"requestedReviewer": {"slug": "core", "name": "Core"}}]},
            "closingIssuesReferences": {"nodes": [{"number": 3}]},
            "lastCommit": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"__typename": "StatusContext", "context": "ci/x", "state": "PENDING"}]}}}}]}
        }));
        let p = parse_pr(&v);
        assert_eq!((p.commits, p.comments, p.closing_issues.clone()), (12, 4, vec![3]));
        assert_eq!(p.labels.len(), 1);
        let logins: Vec<&str> = p.reviewers.iter().map(|r| r.login.as_str()).collect();
        assert_eq!(logins, ["ana", "Core"]);
        assert_eq!((p.checks.len(), p.checks_state), (2, Some(CheckState::Pending)));
        let v = flatten_nodes(json!({"comments": {"totalCount": 2}, "assignees": {"nodes": [{"login": "bo"}]}}));
        let i = parse_issue(&v);
        assert_eq!((i.comments, i.assignees), (2, vec!["bo".to_string()]));
    }

    #[test]
    fn issue_from_gh_json() {
        let v = json!({
            "number": 12, "title": "Crash", "url": "https://github.com/o/n/issues/12", "author": {"login": "eve"},
            "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-02T00:00:00Z",
            "labels": [{"name": "bug", "color": "d73a4a"}], "assignees": [{"login": "a"}, {"login": "b"}],
            "comments": [{}, {}], "body": "", "milestone": {"title": "v1"}, "issueType": {"name": "Bug"},
            "subIssuesSummary": {"total": 4, "completed": 1, "percentCompleted": 25},
            "closedByPullRequestsReferences": [{"number": 107}]
        });
        let i = parse_issue(&v);
        assert_eq!((i.number, i.author.as_str(), i.comments, i.body.as_str()), (12, "eve", 2, ""));
        assert_eq!(i.assignees, vec!["a", "b"]);
        assert_eq!((i.milestone.as_deref(), i.issue_type.as_deref()), (Some("v1"), Some("Bug")));
        assert_eq!(i.sub_issues, Some(SubIssues { total: 4, completed: 1 }));
        assert_eq!(i.linked_pulls, vec![107]);
        let v = json!({"number": 1, "milestone": null, "issueType": null,
                       "subIssuesSummary": {"total": 0, "completed": 0, "percentCompleted": 0}});
        let i = parse_issue(&v);
        assert_eq!((i.milestone, i.issue_type, i.sub_issues), (None, None, None));
    }

    #[test]
    fn serializes_to_the_contract() {
        let p = parse_pr(&json!({"reviewDecision": "REVIEW_REQUIRED", "mergeable": "MERGEABLE"}));
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["review"], "review_required");
        assert_eq!(j["mergeable"], "mergeable");
        assert_eq!(j["state"], "open");
        for k in ["isDraft", "headRef", "baseRef", "checksState", "changedFiles", "mergeState", "closingIssues", "autoMerge", "mergedAt"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        let i = serde_json::to_value(parse_issue(&json!({}))).unwrap();
        for k in ["issueType", "subIssues", "linkedPulls", "createdAt"] {
            assert!(i.get(k).is_some(), "{k}");
        }
    }

    /// Runs git for the test setup, isolated from the user's config.
    fn sh(dir: &Path, args: &[&str]) {
        let st = std::process::Command::new(GIT)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .output()
            .unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    }

    #[test]
    fn base_ref_is_the_newer_of_local_and_origin() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-base-test-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        sh(&dir, &["commit", "-q", "--allow-empty", "-m", "two"]);
        // Local main ahead of origin's (fast-forwarded here, not pushed yet): local.
        assert_eq!(base_branch(root, Some("main")).1.as_deref(), Some("refs/heads/main"));
        sh(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        sh(&dir, &["reset", "-q", "--hard", "HEAD~1"]);
        // Local main behind origin's (stale): origin's.
        assert_eq!(base_branch(root, Some("main")).1.as_deref(), Some("refs/remotes/origin/main"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn worktrees_of_a_real_repo() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-repo-test-{}-{nanos}", std::process::id()));
        let main = dir.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let write = |p: PathBuf, s: &str| std::fs::write(p, s).unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        write(main.join("a.txt"), "a");
        sh(&main, &["add", "a.txt"]);
        sh(&main, &["commit", "-q", "-m", "init"]);
        sh(&main, &["worktree", "add", "-q", "-b", "feat", "../wt-feat"]);
        let feat = dir.join("wt-feat");
        write(feat.join("b.txt"), "b");
        sh(&feat, &["add", "b.txt"]);
        sh(&feat, &["commit", "-q", "-m", "feat one"]);
        write(feat.join("c.txt"), "untracked");
        sh(&main, &["worktree", "add", "-q", "-b", "done", "../wt-done"]);
        let done = dir.join("wt-done");
        write(done.join("d.txt"), "d");
        sh(&done, &["add", "d.txt"]);
        sh(&done, &["commit", "-q", "-m", "done one"]);
        sh(&main, &["merge", "-q", "--ff-only", "done"]);

        let o = overview(main.to_str().unwrap(), false);
        let _ = std::fs::remove_dir_all(&dir);
        let o = o.expect("a git repo");
        assert_eq!((o.base.as_str(), o.branch.as_deref()), ("main", Some("main")));
        assert!(o.root.ends_with("/main"), "{}", o.root);
        assert_eq!((o.github, o.github_error.as_deref()), (None, Some(NO_REMOTE)));
        assert_eq!(o.worktrees.len(), 2);
        let f = o.worktrees.iter().find(|w| w.branch.as_deref() == Some("feat")).unwrap();
        assert_eq!((f.ahead, f.behind, f.dirty, f.merged), (1, 1, 1, false));
        assert_eq!(f.changes, vec!["?? c.txt"]);
        assert_eq!(f.subject, "feat one");
        assert!(f.committed_at > 0 && f.head.len() >= 7);
        assert_eq!(f.commits_ahead.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["feat one"]);
        assert_eq!((f.upstream.as_deref(), f.unpushed), (None, None));
        let d = o.worktrees.iter().find(|w| w.branch.as_deref() == Some("done")).unwrap();
        assert_eq!((d.ahead, d.behind, d.dirty, d.merged), (0, 0, 0, true));
        assert!(d.commits_ahead.is_empty());

        assert!(overview(std::env::temp_dir().to_str().unwrap(), false).is_none());
    }

    #[test]
    #[ignore = "live: reads this Mac's Navarch checkout and calls GitHub through gh"]
    fn repo_live() {
        let o = overview("/Users/daniel/dev/planning/Navarch", true).expect("a git repo");
        println!("root {} base {} branch {:?}", o.root, o.base, o.branch);
        for w in &o.worktrees {
            let name = w.path.rsplit('/').next().unwrap_or("");
            println!(
                "  {name} {:?} dirty {} ahead {} behind {} merged {} upstream {:?} procs {}",
                w.branch, w.dirty, w.ahead, w.behind, w.merged, w.upstream, w.procs.len()
            );
        }
        let g = o.github.as_ref();
        println!(
            "github {:?} pulls {:?} recent {:?} issues {:?} error {:?}",
            g.map(|g| &g.repo),
            g.map(|g| g.pulls.len()),
            g.map(|g| g.recent_pulls.len()),
            g.map(|g| g.issues.len()),
            o.github_error
        );
        for slug in ["mapequation/bioregions", "cli/cli"] {
            match fetch_github(slug) {
                Ok(g) => {
                    println!("{slug}: pulls {} recent {} issues {}", g.pulls.len(), g.recent_pulls.len(), g.issues.len());
                    for p in g.pulls.iter().chain(&g.recent_pulls).take(3) {
                        println!(
                            "  #{} {:?} checks {:?} ({}) commits {} comments {} merge {} {:?} reviewers {:?}",
                            p.number, p.state, p.checks_state, p.checks.len(), p.commits, p.comments, p.merge_state,
                            p.mergeable, p.reviewers
                        );
                    }
                    let recent: Vec<u64> = g.recent_pulls.iter().map(|p| p.number).collect();
                    println!("  recent {recent:?}");
                }
                Err(e) => println!("{slug} error: {e}"),
            }
        }
    }
}
