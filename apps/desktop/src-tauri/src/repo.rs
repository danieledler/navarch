//! The Repo panel's data (`get_repo_overview`): a project folder's git worktrees, compared with the base
//! branch, and its GitHub pull requests and issues through the `gh` CLI. Nothing runs in the background: only
//! when the UI asks. git runs as /usr/bin/git (5 s timeout, never through a shell, no optional locks so a
//! working session's index.lock is never taken); gh signs in on its own (its token is never read here) and its
//! data is cached 5 min per repo.

use crate::tailscale::{exec, exec_env};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
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
/// `PR_FRAGMENT` for merged and closed PRs: without checks, review requests and mergeability, which a done PR
/// doesn't need and which cost the most (on cli/cli 50 PRs take ~2.5 s this way, ~7.5 s with them).
const CLOSED_PR_FRAGMENT: &str = "fragment pr on PullRequest {
  number title url author { login } isDraft state headRefName baseRefName createdAt updatedAt mergedAt closedAt
  reviewDecision additions deletions changedFiles body
  labels(first: 20) { nodes { name color } }
  latestReviews(first: 20) { nodes { author { login } state } }
  commits { totalCount }
  comments { totalCount }
  closingIssuesReferences(first: 10) { nodes { number } }
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
/// Closed PRs asked for (most recently updated first, with `CLOSED_PR_FRAGMENT`), of which the `RECENT_PRS` last
/// merged or closed are kept.
const CLOSED_PRS: u32 = 50;
const RECENT_PRS: usize = 30;
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
    /// Upstream commits not on HEAD, as of the last fetch (Navarch never fetches); `None` without upstream.
    pub behind_upstream: Option<u32>,
    /// The commits on HEAD not on upstream, newest first, at most `COMMITS_MAX`; empty without upstream.
    pub commits_unpushed: Vec<WorktreeCommit>,
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
    /// Login of the account gh is signed in as.
    pub viewer: Option<String>,
    pub issues: Vec<Issue>,
    pub fetched_at: i64,
    /// GitHub's branch tips, compared with the remote-tracking refs on every load (not in the contract).
    #[serde(skip)]
    pub tips: Option<GitHubTips>,
}

/// GitHub's branches as of the last gh query: the first 100 by name (`TIPS_SELECTION`), plus the default branch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitHubTips {
    pub heads: Vec<GitHubHead>,
    /// `heads` holds every branch GitHub has (its list wasn't cut at 100).
    pub complete: bool,
    pub default_branch: Option<String>,
    /// Commits on the default branch.
    pub default_commits: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitHubHead {
    pub name: String,
    pub oid: String,
    /// Unix ms of the tip commit; 0 when unknown.
    pub at: i64,
    pub subject: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverview {
    pub root: String,
    pub base: String,
    pub branch: Option<String>,
    /// The main checkout itself; its dirty/changes leave out linked worktree folders, its procs the processes
    /// inside them, and it is never merged.
    /// The main checkout; `None` when the repo's main entry is bare (a bare repo with worktrees only).
    pub main: Option<Worktree>,
    pub worktrees: Vec<Worktree>,
    /// Local branches and `remote`'s, one entry per name: base first, then the newest tip; at most `BRANCHES_MAX`
    /// (local ones kept before remote-only ones). Empty with `with_github: false`.
    pub branches: Vec<Branch>,
    /// Branches before the cap.
    pub branch_count: usize,
    /// The remote the branches' remote side refers to: the GitHub one (origin preferred), else origin.
    pub remote: Option<String>,
    /// Unix ms of the last fetch from any remote (FETCH_HEAD's time); `None` if never fetched.
    pub fetched_at: Option<i64>,
    pub github: Option<GitHubInfo>,
    pub github_error: Option<String>,
}

/// A branch name with its local and remote side (`Branch` in types.ts).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub local: bool,
    /// The local branch's upstream (`origin/x`), else `<remote>/<name>` if that exists.
    pub remote_ref: Option<String>,
    /// The upstream is configured but no longer exists.
    pub upstream_gone: bool,
    pub head: String,
    pub subject: String,
    pub author: String,
    pub committed_at: i64,
    pub ahead: u32,
    pub behind: u32,
    pub merged: bool,
    /// Local commits not on `remote_ref`; `None` without both sides.
    pub unpushed: Option<u32>,
    /// `remote_ref` commits not on the local branch; `None` without both sides.
    pub unpulled: Option<u32>,
    pub checked_out: Option<String>,
    /// GitHub has this branch now (last gh query); `None` without GitHub data, or when GitHub's list was cut and
    /// it isn't in it.
    #[serde(rename = "onGitHub")]
    pub on_github: Option<bool>,
    /// GitHub's tip isn't in the local remote-tracking branch yet: a fetch would bring commits.
    #[serde(rename = "newerOnGitHub")]
    pub newer_on_github: bool,
    /// How many commits that is, when known (the base branch).
    pub github_new: Option<u32>,
}

const BRANCHES_MAX: usize = 80;

// ── Overview ──

/// The repo `path` is in: its linked worktrees and its GitHub data. `None` when `path` isn't in a git repo.
/// `force` asks GitHub again even within the 5 min cache; `with_github: false` skips GitHub (no gh, no cache;
/// `github` and `github_error` are `None`) and the branches (empty, count 0: only the chosen repo shows them). Blocks: git calls take well under a second, gh up to 20 s (run
/// alongside them).
pub fn overview(path: &str, force: bool, with_github: bool) -> Option<RepoOverview> {
    let entries = parse_worktrees(&git(path, &["worktree", "list", "--porcelain"])?);
    let main = entries.first()?;
    let root = main.path.clone();
    let (base, base_ref) = base_branch(&root, main.branch.as_deref());
    let remote_v = git(&root, &["remote", "-v"]);
    let slug = remote_v.as_deref().and_then(slug_from_remotes);
    let remote = remote_v.as_deref().and_then(github_remote);
    let procs = cwd_procs();
    let linked: Vec<&WtEntry> = entries[1..].iter().filter(|e| !e.bare).collect();
    // The main checkout leaves out the linked worktrees' folders (often inside it, in .claude/worktrees).
    let linked_dirs: Vec<PathBuf> = linked.iter().map(|e| canonical(&e.path)).collect();
    let checked_out: HashMap<String, String> = entries
        .iter()
        .filter(|e| !e.bare && !e.prunable)
        .filter_map(|e| Some((e.branch.clone()?, e.path.clone())))
        .collect();
    let common = common_dir(&root);
    let fetched_at = common.as_deref().and_then(fetched_at);
    let ((github, github_error), main_wt, worktrees, (mut branches, mut branch_count, remote_oids)) = std::thread::scope(|s| {
        let gh = with_github.then(|| s.spawn(|| github(&root, slug.as_deref(), force)));
        let (base, base_ref, procs, linked_dirs) = (&base, base_ref.as_deref(), &procs, &linked_dirs);
        let (root, remote, checked_out) = (&root, remote.as_deref(), &checked_out);
        let br = with_github.then(|| s.spawn(move || branches(root, base, base_ref, remote, checked_out)));
        let main_h = (!main.bare).then(|| {
            s.spawn(move || {
                let mut w = worktree(main, base, base_ref, procs, linked_dirs);
                w.merged = false;
                w
            })
        });
        let handles: Vec<_> = linked.iter().map(|&e| s.spawn(move || worktree(e, base, base_ref, procs, &[]))).collect();
        let worktrees = handles.into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>();
        let main_wt = main_h.and_then(|h| h.join().ok());
        let gh = gh.map_or((None, None), |h| h.join().unwrap_or_else(|_| (None, Some("GitHub lookup failed".into()))));
        (gh, main_wt, worktrees, br.map(|h| h.join().unwrap_or_default()).unwrap_or_default())
    });
    let gh_tips = github.as_ref().and_then(|g| Some((g.tips.as_ref()?, g.fetched_at)));
    if let (Some((tips, tips_at)), Some(remote)) = (gh_tips, remote.as_deref()) {
        // Read after the refs were: a change in between only makes the comparison more cautious.
        let refs_at = common.as_deref().and_then(|c| remote_refs_changed_at(c, remote));
        let shallow = common.as_deref().is_some_and(|c| c.join("shallow").exists());
        let added = github_tips(&root, remote, &base, &mut branches, &remote_oids, tips, (tips_at, refs_at), shallow);
        if added > 0 {
            branch_count += added;
            sort_branches(&mut branches, &base);
            branches = cap_branches(branches, &base);
        }
    }
    // A fresh branch with uncommitted work in its checkout is ahead 0 too: not merged (as for worktrees).
    for b in branches.iter_mut().filter(|b| b.merged) {
        let dirty = main_wt.iter().chain(&worktrees).any(|w| Some(&w.path) == b.checked_out.as_ref() && w.dirty > 0);
        b.merged = !dirty;
    }
    Some(RepoOverview {
        root,
        base,
        branch: main.branch.clone(),
        main: main_wt,
        worktrees,
        branches,
        branch_count,
        remote,
        fetched_at,
        github,
        github_error,
    })
}

// ── Branches ──

/// One ref of the branches' `for-each-ref`.
#[derive(Debug, Default, PartialEq)]
struct RefRow {
    refname: String,
    /// Full object name of the tip.
    oid: String,
    /// Its first 7 characters.
    head: String,
    /// Unix ms of the tip commit.
    at: i64,
    author: String,
    /// Full upstream ref (`refs/remotes/origin/x`), "" without one.
    upstream: String,
    /// `[ahead 1, behind 2]`, `[gone]`, or "" (in sync, or no upstream).
    track: String,
    /// Tip commits not on the base ref, and base commits not on the tip (0, 0 without a base ref).
    ahead: u32,
    behind: u32,
    subject: String,
}

/// The `for-each-ref` format: NUL between fields, the subject last, RS (0x1e) after each record.
fn branch_format(base_ref: Option<&str>) -> String {
    let ab = base_ref.map_or(String::new(), |b| format!("%(ahead-behind:{b})"));
    format!(
        "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(authorname)%00%(upstream)%00\
         %(upstream:track)%00{ab}%00%(subject)%1e"
    )
}

fn parse_refs(out: &str) -> Vec<RefRow> {
    out.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            let mut f = rec.splitn(8, '\0');
            let refname = f.next().filter(|r| r.starts_with("refs/"))?.to_string();
            let oid = f.next()?.to_string();
            let head = oid.chars().take(7).collect();
            let at = f.next()?.trim().parse::<i64>().unwrap_or(0) * 1000;
            let (author, upstream, track) = (f.next()?.to_string(), f.next()?.to_string(), f.next()?.to_string());
            let (ahead, behind) = f.next()?.split_once(' ').map_or((0, 0), |(a, b)| {
                (a.trim().parse().unwrap_or(0), b.trim().parse().unwrap_or(0))
            });
            let subject = f.next().unwrap_or("").to_string();
            Some(RefRow { refname, oid, head, at, author, upstream, track, ahead, behind, subject })
        })
        .collect()
}

/// `[ahead 1, behind 2]` → (1, 2); "" → (0, 0).
fn parse_track(track: &str) -> (u32, u32) {
    let (mut ahead, mut behind) = (0, 0);
    for part in track.trim_matches(['[', ']']).split(',') {
        let mut w = part.split_whitespace();
        match (w.next(), w.next().and_then(|n| n.parse().ok())) {
            (Some("ahead"), Some(v)) => ahead = v,
            (Some("behind"), Some(v)) => behind = v,
            _ => {}
        }
    }
    (ahead, behind)
}

/// The branches of `rows` merged by name, sorted, uncapped. A local branch takes its remote upstream (or
/// `<remote>/<name>`) as its remote side; unpushed/unpulled come from the upstream's track, and stay `None` when
/// the remote side is not the upstream (counted afterwards).
fn build_branches(
    rows: Vec<RefRow>,
    base: &str,
    has_base: bool,
    remote: Option<&str>,
    checked_out: &HashMap<String, String>,
) -> Vec<Branch> {
    let prefix = remote.map(|r| format!("refs/remotes/{r}/"));
    let remote_name = |refname: &str| prefix.as_deref().and_then(|p| refname.strip_prefix(p)).map(str::to_string);
    let mut locals = Vec::new();
    let mut remotes: HashMap<String, RefRow> = HashMap::new();
    for row in rows {
        if let Some(n) = row.refname.strip_prefix("refs/heads/") {
            locals.push((n.to_string(), row));
        } else if let Some(n) = remote_name(&row.refname).filter(|n| n != "HEAD") {
            remotes.insert(n, row);
        }
    }
    let mut used: std::collections::HashSet<String> = locals.iter().map(|(n, _)| n.clone()).collect();
    let merged = |name: &str, ahead: u32| has_base && name != base && ahead == 0;
    let mut out: Vec<Branch> = locals
        .into_iter()
        .map(|(name, r)| {
            let upstream = r.upstream.strip_prefix("refs/remotes/").filter(|u| !u.is_empty());
            let gone = upstream.is_some() && r.track.trim() == "[gone]";
            let (remote_ref, counts) = match upstream.filter(|_| !gone) {
                Some(u) => {
                    used.extend(remote_name(&r.upstream));
                    (Some(u.to_string()), Some(parse_track(&r.track)))
                }
                None => (remotes.contains_key(&name).then(|| format!("{}/{name}", remote.unwrap_or_default())), None),
            };
            Branch {
                local: true,
                remote_ref,
                upstream_gone: gone,
                merged: merged(&name, r.ahead),
                unpushed: counts.map(|c| c.0),
                unpulled: counts.map(|c| c.1),
                checked_out: checked_out.get(&name).cloned(),
                on_github: None,
                newer_on_github: false,
                github_new: None,
                head: r.head,
                subject: r.subject,
                author: r.author,
                committed_at: r.at,
                ahead: r.ahead,
                behind: r.behind,
                name,
            }
        })
        .collect();
    out.extend(remotes.into_iter().filter(|(n, _)| !used.contains(n)).map(|(name, r)| Branch {
        local: false,
        remote_ref: Some(format!("{}/{name}", remote.unwrap_or_default())),
        upstream_gone: false,
        merged: merged(&name, r.ahead),
        unpushed: None,
        unpulled: None,
        checked_out: None,
        on_github: None,
        newer_on_github: false,
        github_new: None,
        head: r.head,
        subject: r.subject,
        author: r.author,
        committed_at: r.at,
        ahead: r.ahead,
        behind: r.behind,
        name,
    }));
    sort_branches(&mut out, base);
    out
}

/// Base first, then the newest tip.
fn sort_branches(all: &mut [Branch], base: &str) {
    all.sort_by(|a, b| {
        (a.name != base).cmp(&(b.name != base)).then(b.committed_at.cmp(&a.committed_at)).then_with(|| a.name.cmp(&b.name))
    });
}

/// Base and the local branches first, then the newest remote-only ones, at most `BRANCHES_MAX` (so the stale local
/// ones and those checked out survive a crowd of others' branches); `all` sorted as `build_branches` leaves it.
fn cap_branches(mut all: Vec<Branch>, base: &str) -> Vec<Branch> {
    let keep = |b: &Branch| b.local || b.name == base;
    let mut room = BRANCHES_MAX.saturating_sub(all.iter().filter(|b| keep(b)).count());
    all.retain(|b| {
        keep(b) || {
            let k = room > 0;
            room = room.saturating_sub(1);
            k
        }
    });
    all.truncate(BRANCHES_MAX);
    all
}

/// The repo's local branches and `remote`'s, with one `for-each-ref`, plus one `rev-list` per shown local branch
/// whose remote side is not its upstream (pushed without `-u`). (branches, count before the cap). A git without
/// `%(ahead-behind:)` (before 2.41) gets a second `for-each-ref` without it: ahead/behind 0, nothing merged.
/// Also the tips of all of `remote`'s remote-tracking branches by name (full object names, shown or not).
fn branches(
    root: &str,
    base: &str,
    base_ref: Option<&str>,
    remote: Option<&str>,
    checked_out: &HashMap<String, String>,
) -> (Vec<Branch>, usize, HashMap<String, String>) {
    let remote_pat = remote.map(|r| format!("refs/remotes/{r}"));
    let refs = |base_ref: Option<&str>| {
        let format = branch_format(base_ref);
        let mut args = vec!["for-each-ref", format.as_str(), "refs/heads"];
        args.extend(remote_pat.as_deref());
        git(root, &args)
    };
    let (out, has_base) = match refs(base_ref) {
        Some(out) => (out, base_ref.is_some()),
        None if base_ref.is_some() => match refs(None) {
            Some(out) => (out, false),
            None => return Default::default(),
        },
        None => return Default::default(),
    };
    let rows = parse_refs(&out);
    let prefix = remote.map(|r| format!("refs/remotes/{r}/"));
    let remote_oids: HashMap<String, String> = rows
        .iter()
        .filter_map(|r| Some((r.refname.strip_prefix(prefix.as_deref()?)?.to_string(), r.oid.clone())))
        .filter(|(n, _)| n != "HEAD")
        .collect();
    let all = build_branches(rows, base, has_base, remote, checked_out);
    let count = all.len();
    let mut all = cap_branches(all, base);
    let todo: Vec<usize> =
        (0..all.len()).filter(|&i| all[i].local && all[i].remote_ref.is_some() && all[i].unpushed.is_none()).collect();
    let counts = par_map(&todo, |&i| {
        let b = &all[i];
        let range = format!("refs/heads/{}...refs/remotes/{}", b.name, b.remote_ref.as_deref().unwrap_or_default());
        git(root, &["rev-list", "--left-right", "--count", &range]).and_then(|c| left_right(&c))
    });
    for (i, c) in todo.into_iter().zip(counts) {
        if let Some((unpushed, unpulled)) = c {
            (all[i].unpushed, all[i].unpulled) = (Some(unpushed), Some(unpulled));
        }
    }
    (all, count, remote_oids)
}

// ── GitHub's branch tips vs the last fetch ──

/// The git dir all of the repo's worktrees share.
fn common_dir(root: &str) -> Option<PathBuf> {
    let dir = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    Some(PathBuf::from(dir.trim()))
}

fn mtime_ms(p: &Path) -> Option<i64> {
    let t = std::fs::symlink_metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Unix ms of the newest FETCH_HEAD (written by every fetch): each worktree has its own, the main checkout's in
/// `<common>/`, a linked one's in `<common>/worktrees/<name>/`. `None` if the repo was never fetched.
fn fetched_at(common: &Path) -> Option<i64> {
    let linked = std::fs::read_dir(common.join("worktrees")).into_iter().flatten().flatten();
    std::iter::once(common.join("FETCH_HEAD")).chain(linked.map(|e| e.path().join("FETCH_HEAD"))).filter_map(|p| mtime_ms(&p)).max()
}

/// Newest mtime in a directory tree, directories included (creating or deleting a ref changes its directory's).
fn tree_mtime(p: &Path) -> Option<i64> {
    let mut newest = mtime_ms(p)?;
    for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
        let t = if e.file_type().is_ok_and(|t| t.is_dir()) { tree_mtime(&e.path()) } else { mtime_ms(&e.path()) };
        newest = newest.max(t.unwrap_or(0));
    }
    Some(newest)
}

/// Unix ms of the last change to `remote`'s remote-tracking refs here (a fetch, a push, a deleted branch): their
/// loose refs and reflogs, and the FETCH_HEADs. `None` if none of them exist.
fn remote_refs_changed_at(common: &Path, remote: &str) -> Option<i64> {
    let refs = Path::new("refs").join("remotes").join(remote);
    [tree_mtime(&common.join(&refs)), tree_mtime(&common.join("logs").join(&refs)), fetched_at(common)].into_iter().flatten().max()
}

/// A full object name (SHA-1 or SHA-256), so GitHub's data never reaches git as anything else.
fn is_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `compare_github` with git answering: one `rev-list --no-walk --ignore-missing` for which of GitHub's tips are
/// here at all, then `merge-base --is-ancestor` for those present; `rev-list --count` for the base. Returns how
/// many GitHub-only branches it appended. `times`: as `compare_github`'s. In a `shallow` clone the local commit
/// count covers only the shallow history, so the base gets no count.
#[allow(clippy::too_many_arguments)]
fn github_tips(
    root: &str,
    remote: &str,
    base: &str,
    branches: &mut Vec<Branch>,
    remote_oids: &HashMap<String, String>,
    tips: &GitHubTips,
    times: (i64, Option<i64>),
    shallow: bool,
) -> usize {
    let contained = |pairs: &[(&str, &str)]| -> Vec<bool> {
        let mut args = vec!["rev-list", "--no-walk", "--ignore-missing"];
        args.extend(pairs.iter().map(|p| p.0));
        let present: HashSet<String> =
            git(root, &args).map(|o| o.lines().map(|l| l.trim().to_string()).collect()).unwrap_or_default();
        par_map(pairs, |(gh, local)| {
            present.contains(*gh) && git(root, &["merge-base", "--is-ancestor", gh, local]).is_some()
        })
    };
    let count = |name: &str| {
        let r = format!("refs/remotes/{remote}/{name}");
        if shallow {
            return None;
        }
        git(root, &["rev-list", "--count", &r]).and_then(|c| c.trim().parse().ok())
    };
    let added = compare_github(branches, remote_oids, tips, times, base, contained, count);
    let n = added.len();
    branches.extend(added);
    n
}

/// Marks `branches` against GitHub's `tips`: `on_github`, `newer_on_github`, and `github_new` for the base.
/// `remote_oids`: the GitHub remote's remote-tracking tips by name (all of them, shown or not). `contained` gets
/// every (GitHub tip, remote-tracking tip) pair that differs, at once, and says whether GitHub's tip is already in
/// the remote-tracking branch (the object is here and an ancestor). `count(name)`: commits on the remote-tracking
/// branch. Returns entries for GitHub's branches with no local or remote-tracking ref (created since the last
/// fetch), not yet sorted or capped. `(tips_at, refs_at)`: Unix ms of GitHub's snapshot and of the last change to
/// the remote-tracking refs (`remote_refs_changed_at`). When the refs changed after the snapshot (a push, a deleted
/// branch, a fetch since), a branch on one side only may just have been created or deleted: no presence verdicts
/// then, only the comparison of tips both sides have (an older GitHub tip is an ancestor, so not newer).
fn compare_github(
    branches: &mut [Branch],
    remote_oids: &HashMap<String, String>,
    tips: &GitHubTips,
    (tips_at, refs_at): (i64, Option<i64>),
    base: &str,
    contained: impl FnOnce(&[(&str, &str)]) -> Vec<bool>,
    count: impl FnOnce(&str) -> Option<u64>,
) -> Vec<Branch> {
    let current = refs_at.is_none_or(|t| t <= tips_at);
    let gh: HashMap<&str, &GitHubHead> =
        tips.heads.iter().filter(|h| is_oid(&h.oid)).map(|h| (h.name.as_str(), h)).collect();
    let mut pairs: Vec<(usize, &str, &str)> = Vec::new();
    for (i, b) in branches.iter_mut().enumerate() {
        b.github_new = None;
        b.newer_on_github = false;
        let Some(h) = gh.get(b.name.as_str()) else {
            b.on_github = (tips.complete && current).then_some(false);
            continue;
        };
        match remote_oids.get(&b.name) {
            Some(l) if *l == h.oid => b.on_github = Some(true),
            Some(l) => {
                b.on_github = Some(true);
                pairs.push((i, h.oid.as_str(), l.as_str()));
            }
            // GitHub has it, the remote-tracking ref doesn't exist: a fetch would make it (unless it was just
            // deleted on GitHub, which a snapshot older than the refs can't tell).
            None => (b.on_github, b.newer_on_github) = if current { (Some(true), true) } else { (None, false) },
        }
    }
    if !pairs.is_empty() {
        let asked: Vec<(&str, &str)> = pairs.iter().map(|p| (p.1, p.2)).collect();
        let have = contained(&asked);
        for (k, (i, _, _)) in pairs.iter().enumerate() {
            branches[*i].newer_on_github = !have.get(k).copied().unwrap_or(false);
        }
    }
    let is_default = tips.default_branch.as_deref() == Some(base);
    let known: HashSet<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    let added: Vec<Branch> = tips
        .heads
        .iter()
        .filter(|h| current && is_oid(&h.oid) && !known.contains(h.name.as_str()) && !remote_oids.contains_key(&h.name))
        .map(|h| Branch {
            name: h.name.clone(),
            local: false,
            remote_ref: None,
            upstream_gone: false,
            head: h.oid.chars().take(7).collect(),
            subject: h.subject.clone(),
            author: String::new(),
            committed_at: h.at,
            ahead: 0,
            behind: 0,
            merged: false,
            unpushed: None,
            unpulled: None,
            checked_out: None,
            on_github: Some(true),
            newer_on_github: true,
            // Never fetched: all of GitHub's commits are new.
            github_new: (is_default && h.name == base).then_some(tips.default_commits).flatten().map(|c| c as u32),
        })
        .collect();
    if is_default {
        if let Some(b) = branches.iter_mut().find(|b| b.name == base && b.newer_on_github && remote_oids.contains_key(base)) {
            // Inconsistent (say, a force push that dropped commits): unknown.
            b.github_new = tips.default_commits.zip(count(base)).and_then(|(gh, here)| {
                u32::try_from(gh.saturating_sub(here)).ok().filter(|&n| n > 0)
            });
        }
    }
    added
}

// ── Fetch ──

const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// `git fetch --prune` of the GitHub remote (as `RepoOverview.remote`) in the repo whose main checkout is `root`:
/// only remote-tracking refs (and tags) change. Never prompts: ssh in batch mode (unless the repo or user configures
/// its own ssh command), no credential prompts; 60 s timeout. A one-line summary of what changed, or git's error.
pub fn git_fetch(root: &str) -> Result<String, String> {
    let wt = git(root, &["worktree", "list", "--porcelain"]).ok_or("Not a git repo")?;
    let entries = parse_worktrees(&wt);
    entries
        .first()
        .filter(|e| !e.bare && canonical(&e.path) == canonical(root))
        .ok_or("Not the main checkout of a repo")?;
    let remote = git(root, &["remote", "-v"]).as_deref().and_then(github_remote).ok_or("No remote to fetch from")?;
    let own_ssh = git(root, &["config", "core.sshCommand"]).is_some_and(|c| !c.trim().is_empty())
        || ["GIT_SSH_COMMAND", "GIT_SSH"].iter().any(|v| std::env::var_os(v).is_some());
    let mut args = vec!["-C", root, "-c", "credential.interactive=never"];
    if !own_ssh {
        args.extend(["-c", "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15"]);
    }
    args.extend(["fetch", "--prune", "--porcelain", "--no-recurse-submodules", "--", remote.as_str()]);
    let env = [("GIT_TERMINAL_PROMPT", "0"), ("SSH_ASKPASS_REQUIRE", "never")];
    let o = exec_env(GIT, &args, &env, FETCH_TIMEOUT, |_| false).map_err(|e| format!("git didn't start: {e}"))?;
    match o.status {
        None => Err(format!("git fetch timed out after {} s", FETCH_TIMEOUT.as_secs())),
        Some(st) if st.success() => {
            let updates = parse_fetch(&o.out, &remote);
            let count = |old: &str, new: &str| git(root, &["rev-list", "--count", &format!("{old}..{new}")]).and_then(|c| c.trim().parse().ok());
            Ok(fetch_summary(&updates, count))
        }
        Some(_) => Err(fetch_error(&o.err)),
    }
}

/// One ref update of `git fetch --porcelain`.
#[derive(Debug, PartialEq)]
struct RefUpdate {
    /// ' ' fast-forward, '+' forced, '-' pruned, '*' new, 't' tag moved, '!' rejected, '=' unchanged.
    flag: char,
    old: String,
    new: String,
    /// The branch name for `remote`'s refs; the full ref otherwise (`refs/tags/v1`).
    name: String,
    branch: bool,
}

/// `<flag> <old> <new> <ref>` lines → updates (`remote/HEAD` left out).
fn parse_fetch(out: &str, remote: &str) -> Vec<RefUpdate> {
    let prefix = format!("refs/remotes/{remote}/");
    out.lines()
        .filter_map(|l| {
            let flag = l.chars().next()?;
            let mut f = l.get(1..)?.trim_start().splitn(3, ' ');
            let (old, new, r) = (f.next()?.to_string(), f.next()?.to_string(), f.next()?.trim());
            let (name, branch) = match r.strip_prefix(&prefix) {
                Some(n) => (n.to_string(), true),
                None => (r.to_string(), false),
            };
            (name != "HEAD" || !branch).then_some(RefUpdate { flag, old, new, name, branch })
        })
        .collect()
}

/// "main +3 · feat rewritten · 2 new branches · 1 deleted · 1 new tag", or "Already up to date".
/// `count(old, new)`: commits in old..new.
fn fetch_summary(updates: &[RefUpdate], count: impl Fn(&str, &str) -> Option<u64>) -> String {
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts: Vec<String> = Vec::new();
    let moved: Vec<&RefUpdate> = updates.iter().filter(|u| u.branch && matches!(u.flag, ' ' | '+' | '!')).collect();
    for u in moved.iter().take(3) {
        parts.push(match u.flag {
            ' ' => count(&u.old, &u.new).map_or(format!("{} updated", u.name), |n| format!("{} +{n}", u.name)),
            '+' => format!("{} rewritten", u.name),
            _ => format!("{} rejected", u.name),
        });
    }
    if moved.len() > 3 {
        parts.push(format!("{} more updated", moved.len() - 3));
    }
    let n = |flag: char, branch: bool| updates.iter().filter(|u| u.flag == flag && u.branch == branch).count();
    let (new, gone, tags) = (n('*', true), n('-', true), n('*', false));
    if new > 0 {
        parts.push(plural(new, "new branch", "new branches"));
    }
    if gone > 0 {
        parts.push(format!("{gone} deleted"));
    }
    if tags > 0 {
        parts.push(plural(tags, "new tag", "new tags"));
    }
    if parts.is_empty() { "Already up to date".into() } else { parts.join(" · ") }
}

/// git's stderr → its first two meaningful lines (no hints), at most 300 characters.
fn fetch_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .take(2)
        .collect();
    let msg = if lines.is_empty() { "git fetch failed".to_string() } else { lines.join(" ") };
    msg.chars().take(300).collect()
}

// ── Repos of a project folder ──

/// One git repo of a project folder (`RepoRef` in types.ts).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub root: String,
    pub rel: String,
    pub name: String,
    pub github: Option<String>,
    pub committed_at: i64,
}

/// Folders never searched for repos (besides dot-folders): dependencies, build output, environments.
const SKIP_DIRS: &[&str] =
    &["node_modules", "target", "dist", "build", "venv", "env", "__pycache__", "Pods", "vendor", "site-packages"];
/// Directory entries read at most while looking for repos, so a huge folder costs little.
const MAX_ENTRIES: usize = 2000;
const MAX_REPOS: usize = 12;

/// The git repos of a project folder: the one it is in (rel ""), then those 1–2 folders below it and those owning
/// the worktrees in `<path>/.claude/worktrees/*` (sessions start in the project folder, so their worktrees sit
/// there even for a repo elsewhere), worktrees resolved to their main checkout and duplicates dropped, most
/// recent commit first, at most 12 (the session-worktree repos always kept). Local only.
pub fn find_repos(path: &str) -> Vec<RepoRef> {
    // Git reports real paths (/private/var/… for /var/…), so compare against the real folder.
    let base = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let (containing_id, containing) = main_checkout(path).unzip();
    // (dir, owns a worktree in <path>/.claude/worktrees): those repos are kept past the cap, or their worktrees
    // would drop out of the Worktrees column.
    let candidates: Vec<(PathBuf, bool)> = repo_dirs(&base)
        .into_iter()
        .map(|d| (d, false))
        .chain(session_worktrees(&base).into_iter().map(|d| (d, true)))
        .collect();
    // (identity, root, session) triples; worktrees of one bare repo share the identity, so keep one root per repo
    // (the lexicographically first worktree).
    let mut found: Vec<(String, String, bool)> =
        par_map(&candidates, |(d, s)| d.to_str().and_then(main_checkout).map(|(id, r)| (id, r, *s)))
            .into_iter()
            .flatten()
            .collect();
    found.sort();
    found.dedup_by(|a, b| {
        let same = a.0 == b.0;
        if same {
            b.2 |= a.2;
        }
        same
    });
    found.retain(|(id, _, _)| Some(id) != containing_id.as_ref());
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let rel_of = |root: &str| match Path::new(root).strip_prefix(&base) {
        Ok(r) => r.to_string_lossy().into_owned(),
        Err(_) => match home.as_deref().and_then(|h| root.strip_prefix(h)) {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
            _ => root.to_string(),
        },
    };
    let all: Vec<(String, String, bool)> = containing
        .iter()
        .map(|r| (r.clone(), String::new(), false))
        .chain(found.iter().map(|(_, r, s)| (r.clone(), rel_of(r), *s)))
        .collect();
    let mut out = par_map(&all, |(root, rel, session)| {
        let github = git(root, &["remote", "-v"]).and_then(|r| slug_from_remotes(&r));
        let committed_at =
            git(root, &["log", "-1", "--format=%ct"]).and_then(|s| s.trim().parse::<i64>().ok()).map_or(0, |s| s * 1000);
        let name = if rel.is_empty() { root.rsplit('/').next().unwrap_or(root).to_string() } else { rel.clone() };
        (RepoRef { root: root.clone(), rel: rel.clone(), name, github, committed_at }, *session)
    });
    let first = (containing.is_some() as usize).min(out.len());
    out[first..].sort_by(|(a, _), (b, _)| b.committed_at.cmp(&a.committed_at).then_with(|| a.rel.cmp(&b.rel)));
    // Cap the others at what is left after the containing and session-worktree repos.
    let mut room = MAX_REPOS.saturating_sub(first + out.iter().filter(|(_, s)| *s).count());
    out.into_iter()
        .enumerate()
        .filter(|(i, (_, session))| {
            *i < first || *session || {
                let keep = room > 0;
                room = room.saturating_sub(1);
                keep
            }
        })
        .map(|(_, (r, _))| r)
        .collect()
}

/// The repo `dir` is in, as (identity, root): the identity is the main entry's path (the bare repo when the main
/// one is bare, shared by all its worktrees), the root its main checkout (the worktree itself when the main one is bare).
fn main_checkout(dir: &str) -> Option<(String, String)> {
    let entries = parse_worktrees(&git(dir, &["worktree", "list", "--porcelain"])?);
    let e = entries.first()?;
    let root = if !e.bare {
        e.path.clone()
    } else {
        git(dir, &["rev-parse", "--show-toplevel"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?
    };
    Some((e.path.clone(), root))
}

/// Folders 1–2 levels below `base` that hold a `.git` (a folder, or a file for worktrees and submodules).
/// Skips dot-folders, `SKIP_DIRS` and symlinks; reads at most `MAX_ENTRIES` entries in all.
fn repo_dirs(base: &Path) -> Vec<PathBuf> {
    let mut seen = 0;
    let mut subdirs = |dir: &Path| -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
        let mut out = vec![];
        for e in rd.flatten() {
            if seen >= MAX_ENTRIES {
                break;
            }
            seen += 1;
            let name = e.file_name();
            let name = name.to_string_lossy();
            // DirEntry::file_type doesn't follow symlinks, so a link to a folder isn't a dir here.
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) || !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            out.push(e.path());
        }
        out.sort();
        out
    };
    let is_repo = |d: &Path| d.join(".git").symlink_metadata().is_ok();
    let mut found = vec![];
    for d1 in subdirs(base) {
        if is_repo(&d1) {
            found.push(d1.clone());
        }
        found.extend(subdirs(&d1).into_iter().filter(|d2| is_repo(d2)));
    }
    found
}

/// Folders in `base/.claude/worktrees` that hold a `.git` file (linked worktrees), sorted.
fn session_worktrees(base: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(base.join(".claude/worktrees")) else { return vec![] };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .take(MAX_ENTRIES)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|d| d.join(".git").symlink_metadata().is_ok_and(|m| m.is_file()))
        .collect();
    out.sort();
    out
}

/// `f` over `items` on up to 8 threads, results in order.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    const THREADS: usize = 8;
    let n = THREADS.min(items.len()).max(1);
    let f = &f;
    let mut parts: Vec<Vec<(usize, R)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..n)
            .map(|k| s.spawn(move || items.iter().enumerate().skip(k).step_by(n).map(|(i, t)| (i, f(t))).collect()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut all: Vec<(usize, R)> = parts.drain(..).flatten().collect();
    all.sort_by_key(|(i, _)| *i);
    all.into_iter().map(|(_, r)| r).collect()
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

/// Git reports real paths (/private/var/… for /var/…); processes' cwds are real paths too.
fn canonical(p: &str) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p))
}

/// One worktree's state. `exclude`: folders of linked worktrees, for the main checkout (empty for linked ones),
/// whose processes and untracked entries it leaves out.
fn worktree(e: &WtEntry, base: &str, base_ref: Option<&str>, procs: &[Proc], exclude: &[PathBuf]) -> Worktree {
    let canon = canonical(&e.path);
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
        behind_upstream: None,
        commits_unpushed: Vec::new(),
        procs: procs
            .iter()
            .filter(|p| p.cwd.starts_with(&canon) && !exclude.iter().any(|x| p.cwd.starts_with(x)))
            .take(PROCS_MAX)
            .map(|p| WorktreeProc { pid: p.pid, name: p.name.clone(), cmd: p.cmd.clone() })
            .collect(),
    };
    if e.prunable {
        return w;
    }
    let dir = e.path.as_str();
    // When status fails or times out the worktree may be dirty: it then never counts as merged.
    let status_ok = if let Some(lines) = status(dir, &canon, exclude) {
        w.dirty = lines.len() as u32;
        w.changes = lines.into_iter().take(CHANGES_MAX).collect();
        true
    } else {
        false
    };
    if let Some(c) = git(dir, &["log", "-1", LOG_FORMAT]).and_then(|l| parse_commit(l.trim_end_matches('\n'))) {
        (w.head, w.subject, w.committed_at) = (c.hash, c.subject, c.at);
    }
    if let Some(b) = base_ref {
        let counts = git(dir, &["rev-list", "--left-right", "--count", &format!("{b}...HEAD")]).and_then(|c| left_right(&c));
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
            if let Some((behind, ahead)) = git(dir, &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
                .and_then(|c| left_right(&c))
            {
                (w.behind_upstream, w.unpushed) = (Some(behind), Some(ahead));
                if ahead > 0 {
                    let n = COMMITS_MAX.to_string();
                    w.commits_unpushed = git(dir, &["log", LOG_FORMAT, "-n", &n, "@{u}..HEAD"])
                        .map(|l| l.lines().filter_map(parse_commit).collect())
                        .unwrap_or_default();
                }
            }
        }
    }
    w
}

/// `rev-list --left-right --count` output → (left, right).
fn left_right(out: &str) -> Option<(u32, u32)> {
    let (l, r) = out.trim().split_once(char::is_whitespace)?;
    Some((l.trim().parse().ok()?, r.trim().parse().ok()?))
}

/// The lines of `git status --porcelain=v1` in `dir` (canonical `canon`), leaving out the `exclude` folders that
/// are inside it. Those are linked worktrees: a nested checkout shows as one untracked `?? <folder>/` entry, and
/// when its parent folder is untracked too (an unignored `.claude/` holding `.claude/worktrees/*`) as that parent.
/// Pathspec excludes (`:(exclude,literal)<rel>`) drop the worktree entries themselves; an untracked parent that
/// holds anything else still shows, collapsed (`?? .claude/`), so each such parent is listed again with `-uall`
/// (its untracked files one by one, worktrees still excluded). An untracked parent holding only worktrees is
/// gone either way. `None` when git fails.
fn status(dir: &str, canon: &Path, exclude: &[PathBuf]) -> Option<Vec<String>> {
    let rels: Vec<String> = exclude
        .iter()
        .filter_map(|x| x.strip_prefix(canon).ok())
        .filter(|r| !r.as_os_str().is_empty())
        .map(|r| r.to_string_lossy().into_owned())
        .collect();
    let excludes: Vec<String> = rels.iter().map(|r| format!(":(exclude,literal){r}")).collect();
    let run = |extra: &[&str], paths: &[&str]| -> Option<Vec<String>> {
        let mut args = vec!["status", "--porcelain=v1"];
        args.extend_from_slice(extra);
        if !excludes.is_empty() {
            args.push("--");
            args.extend_from_slice(paths);
            args.extend(excludes.iter().map(String::as_str));
        }
        Some(git(dir, &args)?.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())
    };
    let lines = run(&[], &["."])?;
    if rels.is_empty() {
        return Some(lines);
    }
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        // An untracked folder that holds a worktree: list what else is in it.
        let holds_worktree = l
            .strip_prefix("?? ")
            .map(|p| p.trim_matches('"'))
            .filter(|p| p.ends_with('/'))
            .filter(|p| rels.iter().any(|r| r.starts_with(p)));
        match holds_worktree {
            Some(p) => out.extend(run(&["-uall"], &[&format!(":(literal){}", p.trim_end_matches('/'))])?),
            None => out.push(l),
        }
    }
    Some(out)
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
            // Claude's own processes are sessions, shown as such: `claude`, and the desktop app's `disclaimer`
            // wrapper that launches it.
            if name == "claude" || (name == "disclaimer" && cmd.contains("/claude")) {
                return None;
            }
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

/// The remote whose branches the overview lists, from `git remote -v` output: origin if it is on GitHub, else the
/// first GitHub remote, else origin; `None` without either.
pub fn github_remote(remote_v: &str) -> Option<String> {
    let (mut first, mut origin) = (None, false);
    for line in remote_v.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else { continue };
        let gh = github_slug(url).is_some();
        if name == "origin" {
            if gh {
                return Some(name.into());
            }
            origin = true;
        } else if gh {
            first.get_or_insert_with(|| name.to_string());
        }
    }
    first.or_else(|| origin.then(|| "origin".into()))
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

/// The repository fields asked along with the issues: GitHub's branch tips (`GitHubTips`).
const TIPS_SELECTION: &str = "defaultBranchRef { name target { oid ... on Commit { history(first: 0) { totalCount } } } }
  heads: refs(refPrefix: \"refs/heads/\", first: 100) { totalCount nodes { name target { oid ... on Commit { committedDate messageHeadline } } } }";

/// One connection of `owner/name` (`selection` is e.g. `pullRequests(...) { nodes { ...pr } }`), its nodes, and
/// the login gh is signed in as (asked along, free); `extra` repository fields come back in the third value (the
/// repository object, nodes flattened).
type GraphQl = (Vec<Value>, Option<String>, Value);
fn gh_graphql(slug: &str, selection: &str, extra: &str, fragment: &str) -> Result<GraphQl, String> {
    let (owner, name) = slug.split_once('/').ok_or_else(|| format!("Not a GitHub repo: {slug}"))?;
    let query = format!(
        "query($owner: String!, $name: String!) {{ viewer {{ login }} repository(owner: $owner, name: $name) {{ list: {selection} {extra} }} }}\n{fragment}"
    );
    let (q, o, n) = (format!("query={query}"), format!("owner={owner}"), format!("name={name}"));
    let out = gh(&["api", "graphql", "-f", &q, "-f", &o, "-f", &n])?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("Unexpected gh output: {e}"))?;
    let repo = v.pointer("/data/repository").filter(|r| !r.is_null()).ok_or_else(|| {
        v.pointer("/errors/0/message").and_then(Value::as_str).unwrap_or("Repository not found on GitHub").to_string()
    })?;
    let viewer = v.pointer("/data/viewer/login").and_then(Value::as_str).filter(|l| !l.is_empty()).map(String::from);
    let mut repo = flatten_nodes(repo.clone());
    match repo.get_mut("list").map(Value::take) {
        Some(Value::Array(a)) => Ok((a, viewer, repo)),
        _ => Ok((Vec::new(), viewer, repo)),
    }
}

/// `TIPS_SELECTION`'s answer (nodes flattened) → GitHub's branch tips; `None` without a `heads` list.
pub fn parse_tips(repo: &Value) -> Option<GitHubTips> {
    let refs = repo.get("heads")?;
    let total = refs.get("totalCount").and_then(Value::as_u64).unwrap_or(0) as usize;
    let mut heads: Vec<GitHubHead> = arr(refs, "nodes")
        .iter()
        .map(|n| {
            let t = n.get("target").unwrap_or(&Value::Null);
            GitHubHead { name: text(n, "name"), oid: text(t, "oid"), at: ms(t, "committedDate").unwrap_or(0), subject: text(t, "messageHeadline") }
        })
        .filter(|h| !h.name.is_empty())
        .collect();
    let complete = heads.len() >= total;
    let d = repo.get("defaultBranchRef").filter(|d| !d.is_null());
    let default_branch = d.map(|d| text(d, "name")).filter(|n| !n.is_empty());
    let target = d.and_then(|d| d.get("target"));
    let default_commits = target.and_then(|t| t.pointer("/history/totalCount")).and_then(Value::as_u64);
    // Past the cut, the default branch still counts.
    if let (Some(name), Some(t)) = (&default_branch, target) {
        if !heads.iter().any(|h| &h.name == name) {
            heads.push(GitHubHead { name: name.clone(), oid: text(t, "oid"), ..Default::default() });
        }
    }
    Some(GitHubTips { heads, complete, default_branch, default_commits })
}

fn fetch_github(slug: &str) -> Result<GitHubInfo, String> {
    // The snapshot's time is when it was asked for: refs changed while gh ran count as newer (compare_github).
    let asked_at = chrono::Utc::now().timestamp_millis();
    let order = "orderBy: {field: UPDATED_AT, direction: DESC}";
    let open = format!("pullRequests(states: OPEN, first: {OPEN_PRS}, {order}) {{ nodes {{ ...pr }} }}");
    let closed = format!("pullRequests(states: [CLOSED, MERGED], first: {CLOSED_PRS}, {order}) {{ nodes {{ ...pr }} }}");
    let issues = format!("issues(states: OPEN, first: {OPEN_ISSUES}, {order}) {{ nodes {{ {ISSUE_SELECTION} }} }}");
    let lost = || Err::<GraphQl, _>("gh failed".to_string());
    let (open, closed, issues) = std::thread::scope(|s| {
        let a = s.spawn(|| gh_graphql(slug, &open, "", PR_FRAGMENT));
        let b = s.spawn(|| gh_graphql(slug, &closed, "", CLOSED_PR_FRAGMENT));
        let c = s.spawn(|| gh_graphql(slug, &issues, TIPS_SELECTION, ""));
        (a.join().unwrap_or_else(|_| lost()), b.join().unwrap_or_else(|_| lost()), c.join().unwrap_or_else(|_| lost()))
    });
    let ((open, v1, _), (closed, v2, _), (issues, v3, repo)) = (open?, closed?, issues?);
    let viewer = v1.or(v2).or(v3);
    let mut pulls: Vec<PullRequest> = open.iter().map(parse_pr).collect();
    pulls.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    // Asked for by last update (a late comment counts), kept by when they were merged or closed.
    let mut recent_pulls: Vec<PullRequest> = closed.iter().map(parse_pr).collect();
    recent_pulls.sort_by_key(|p| std::cmp::Reverse(p.merged_at.max(p.closed_at).unwrap_or(0)));
    recent_pulls.truncate(RECENT_PRS);
    let mut issues: Vec<Issue> = issues.iter().map(parse_issue).collect();
    issues.sort_by_key(|i| std::cmp::Reverse(i.updated_at));
    Ok(GitHubInfo {
        repo: slug.into(),
        url: format!("https://github.com/{slug}"),
        pulls,
        recent_pulls,
        viewer,
        issues,
        fetched_at: asked_at,
        tips: parse_tips(&repo),
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

        let o = overview(main.to_str().unwrap(), false, true);
        let local = overview(main.to_str().unwrap(), false, false);
        let _ = std::fs::remove_dir_all(&dir);
        let local = local.expect("a git repo");
        assert_eq!((local.github, local.github_error, local.worktrees.len()), (None, None, 2));
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
        // The main checkout: clean (its sibling worktrees aren't inside it), never merged, no upstream.
        let m = o.main.as_ref().expect("main checkout");
        assert!(m.path.ends_with("/main") && m.branch.as_deref() == Some("main"), "{m:?}");
        assert_eq!((m.dirty, m.merged, m.subject.as_str()), (0, false, "done one"));
        assert_eq!((m.upstream.as_deref(), m.unpushed, m.behind_upstream), (None, None, None));
        assert!(m.commits_unpushed.is_empty());
        let (jm, jw) = (serde_json::to_value(m).unwrap(), serde_json::to_value(&o.worktrees[0]).unwrap());
        for k in ["behindUpstream", "commitsUnpushed"] {
            assert!(jm.get(k).is_some() && jw.get(k).is_some(), "{k}");
        }

        assert!(overview(std::env::temp_dir().to_str().unwrap(), false, true).is_none());
    }

    #[test]
    fn a_bare_main_entry_has_no_main_checkout() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-bare-test-{}-{nanos}", std::process::id()));
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        sh(&src, &["init", "-q", "-b", "main"]);
        sh(&src, &["commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&dir, &["clone", "-q", "--bare", src.to_str().unwrap(), "b.git"]);
        sh(&dir.join("b.git"), &["worktree", "add", "-q", "-b", "x", "../w1"]);
        let o = overview(dir.join("w1").to_str().unwrap(), false, false).expect("overview");
        assert!(o.main.is_none());
        assert_eq!(o.worktrees.len(), 1);
        assert_eq!(o.worktrees[0].branch.as_deref(), Some("x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn main_checkout_vs_upstream_and_inner_worktrees() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-main-test-{}-{nanos}", std::process::id()));
        let (origin, main, other) = (dir.join("origin.git"), dir.join("main"), dir.join("other"));
        for d in [&origin, &main] {
            std::fs::create_dir_all(d).unwrap();
        }
        sh(&origin, &["init", "-q", "--bare", "-b", "main"]);
        sh(&main, &["init", "-q", "-b", "main"]);
        sh(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&main, &["remote", "add", "origin", origin.to_str().unwrap()]);
        sh(&main, &["push", "-q", "-u", "origin", "main"]);
        // Someone else pushes a commit; the main checkout fetches it but doesn't merge.
        sh(&dir, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        sh(&other, &["commit", "-q", "--allow-empty", "-m", "theirs"]);
        sh(&other, &["push", "-q", "origin", "main"]);
        sh(&main, &["fetch", "-q"]);
        // Two local commits not pushed.
        sh(&main, &["commit", "-q", "--allow-empty", "-m", "mine 1"]);
        sh(&main, &["commit", "-q", "--allow-empty", "-m", "mine 2"]);
        // A worktree in an unignored .claude/worktrees: not the main checkout's change.
        std::fs::create_dir_all(main.join(".claude/worktrees")).unwrap();
        sh(&main, &["worktree", "add", "-q", "-b", "x", ".claude/worktrees/x"]);
        let only_worktrees = overview(main.to_str().unwrap(), false, false);
        // An untracked file beside it is.
        std::fs::write(main.join(".claude/other.txt"), "o").unwrap();
        let with_other = overview(main.to_str().unwrap(), false, false);
        let _ = std::fs::remove_dir_all(&dir);

        let o = only_worktrees.expect("a git repo");
        let m = o.main.as_ref().expect("main checkout");
        assert_eq!(m.upstream.as_deref(), Some("origin/main"));
        assert_eq!((m.unpushed, m.behind_upstream, m.dirty), (Some(2), Some(1), 0), "{:?}", m.changes);
        assert_eq!(m.commits_unpushed.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["mine 2", "mine 1"]);
        assert_eq!(o.worktrees.len(), 1);
        let x = &o.worktrees[0];
        assert_eq!((x.branch.as_deref(), x.upstream.as_deref(), x.behind_upstream), (Some("x"), None, None));
        let m = with_other.expect("a git repo").main.expect("main checkout");
        assert_eq!((m.dirty, m.changes), (1, vec!["?? .claude/other.txt".to_string()]));
    }

    #[test]
    fn branch_refs_parse_and_merge_by_name() {
        let rec = |f: [&str; 8]| format!("{}\x1e\n", f.join("\0"));
        let out = [
            rec(["refs/heads/main", "aaa1111", "100", "Ann", "refs/remotes/origin/main", "", "0 0", "base"]),
            rec(["refs/heads/feat", "bbb2222", "300", "Bo", "refs/remotes/origin/feat", "[ahead 2, behind 1]", "3 1", "say \"hi\"\tand\ttabs; [x]"]),
            rec(["refs/heads/old", "ccc3333", "50", "Cy", "refs/remotes/origin/old", "[gone]", "0 4", "merged one"]),
            rec(["refs/heads/solo", "ddd4444", "200", "Di", "", "", "1 0", ""]),
            rec(["refs/remotes/origin/HEAD", "aaa1111", "100", "Ann", "", "", "0 0", "base"]),
            rec(["refs/remotes/origin/main", "aaa1111", "100", "Ann", "", "", "0 0", "base"]),
            rec(["refs/remotes/origin/feat", "eee5555", "250", "Bo", "", "", "1 1", "x"]),
            rec(["refs/remotes/origin/theirs", "fff6666", "400", "Ed", "", "", "2 0", "their work"]),
        ]
        .concat();
        let rows = parse_refs(&out);
        assert_eq!(rows.len(), 8);
        assert_eq!(rows[1].subject, "say \"hi\"\tand\ttabs; [x]");
        assert_eq!((rows[1].at, rows[1].ahead, rows[1].behind), (300_000, 3, 1));
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1));
        assert_eq!(parse_track("[behind 5]"), (0, 5));
        assert_eq!(parse_track(""), (0, 0));
        let co = HashMap::from([("feat".to_string(), "/w/feat".to_string())]);
        let b = build_branches(rows, "main", true, Some("origin"), &co);
        let names: Vec<&str> = b.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["main", "theirs", "feat", "solo", "old"]);
        let get = |n: &str| b.iter().find(|b| b.name == n).unwrap();
        let f = get("feat");
        assert_eq!((f.remote_ref.as_deref(), f.unpushed, f.unpulled), (Some("origin/feat"), Some(2), Some(1)));
        assert_eq!((f.checked_out.as_deref(), f.head.as_str(), f.merged), (Some("/w/feat"), "bbb2222", false));
        let o = get("old");
        assert_eq!((o.upstream_gone, o.remote_ref.as_deref(), o.unpushed, o.merged), (true, None, None, true));
        let t = get("theirs");
        assert_eq!((t.local, t.remote_ref.as_deref(), t.unpushed, t.merged), (false, Some("origin/theirs"), None, false));
        let s = get("solo");
        assert_eq!((s.local, s.remote_ref.as_deref(), s.unpushed, s.merged), (true, None, None, false));
        assert!(!get("main").merged);
        // Without a remote, remote refs are ignored; without a base ref nothing counts as merged.
        let b = build_branches(parse_refs(&out), "main", false, None, &HashMap::new());
        assert_eq!(b.len(), 4);
        assert!(b.iter().all(|b| b.local && !b.merged));
        let j = serde_json::to_value(&b[0]).unwrap();
        for k in ["remoteRef", "upstreamGone", "committedAt", "checkedOut", "unpulled"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        // Over the cap, remote-only branches go first: every local one stays, however old.
        let mut many = vec![rec(["refs/heads/main", "aaa1111", "100", "Ann", "", "", "0 0", "base"])];
        many.extend((0..5).map(|i| rec([format!("refs/heads/old{i}").as_str(), "ccc3333", "1", "Cy", "", "", "0 0", "old"])));
        let theirs: Vec<String> = (0..100).map(|i| format!("refs/remotes/origin/t{i:03}")).collect();
        let ats: Vec<String> = (0..100).map(|i| (1000 + i).to_string()).collect();
        many.extend((0..100).map(|i| rec([theirs[i].as_str(), "fff6666", ats[i].as_str(), "Ed", "", "", "1 0", "theirs"])));
        let all = build_branches(parse_refs(&many.concat()), "main", true, Some("origin"), &HashMap::new());
        assert_eq!(all.len(), 106);
        let kept = cap_branches(all, "main");
        assert_eq!(kept.len(), BRANCHES_MAX);
        assert_eq!(kept[0].name, "main");
        assert_eq!(kept.iter().filter(|b| b.local).count(), 6);
        assert_eq!(kept[1].name, "t099"); // newest remote-only first, the old locals last
        assert!(kept[BRANCHES_MAX - 5..].iter().all(|b| b.local && b.name.starts_with("old")));
        assert!(!kept.iter().any(|b| b.name == "t025"));
        assert_eq!(github_remote("up\tgit@github.com:a/b.git (fetch)\norigin\thttps://gitlab.com/a/b (fetch)").as_deref(), Some("up"));
        assert_eq!(github_remote("origin\thttps://gitlab.com/a/b (fetch)").as_deref(), Some("origin"));
        assert_eq!(github_remote("other\thttps://gitlab.com/a/b (fetch)"), None);
    }

    #[test]
    fn branches_of_a_real_repo() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-branches-test-{}-{nanos}", std::process::id()));
        let (origin, main, other) = (dir.join("origin.git"), dir.join("main"), dir.join("other"));
        for d in [&origin, &main] {
            std::fs::create_dir_all(d).unwrap();
        }
        let commit = |m: &str| sh(&main, &["commit", "-q", "--allow-empty", "-m", m]);
        sh(&origin, &["init", "-q", "--bare", "-b", "main"]);
        sh(&main, &["init", "-q", "-b", "main"]);
        commit("one");
        sh(&main, &["remote", "add", "origin", origin.to_str().unwrap()]);
        sh(&main, &["push", "-q", "-u", "origin", "main"]);
        // merged: landed on main by fast-forward.
        sh(&main, &["checkout", "-q", "-b", "merged"]);
        commit("m");
        sh(&main, &["checkout", "-q", "main"]);
        sh(&main, &["merge", "-q", "--ff-only", "merged"]);
        sh(&main, &["push", "-q", "origin", "main"]);
        // pushed: pushed with -u, then one more local commit.
        sh(&main, &["checkout", "-q", "-b", "pushed", "main"]);
        commit("p1");
        sh(&main, &["push", "-q", "-u", "origin", "pushed"]);
        commit("p2");
        // local: never pushed.
        sh(&main, &["checkout", "-q", "-b", "local", "main"]);
        commit("l1");
        // gone: pushed, then deleted on the remote and pruned.
        sh(&main, &["checkout", "-q", "-b", "gone", "main"]);
        commit("g1");
        sh(&main, &["push", "-q", "-u", "origin", "gone"]);
        sh(&main, &["push", "-q", "origin", "--delete", "gone"]);
        sh(&main, &["fetch", "-q", "--prune"]);
        // noup: pushed without -u, then one more local commit.
        sh(&main, &["checkout", "-q", "-b", "noup", "main"]);
        commit("n1");
        sh(&main, &["push", "-q", "origin", "noup"]);
        commit("n2");
        sh(&main, &["checkout", "-q", "main"]);
        // theirs: pushed from another clone, fetched here.
        sh(&dir, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        sh(&other, &["checkout", "-q", "-b", "theirs"]);
        sh(&other, &["commit", "-q", "--allow-empty", "-m", "t1"]);
        sh(&other, &["push", "-q", "origin", "theirs"]);
        sh(&main, &["fetch", "-q"]);
        sh(&main, &["worktree", "add", "-q", "-b", "wt", "../wt"]);
        // dirty: a fresh branch with uncommitted work, so not merged.
        sh(&main, &["worktree", "add", "-q", "-b", "dirty", "../dirty"]);
        std::fs::write(dir.join("dirty/x.txt"), "x").unwrap();
        // Branches come only with with_github (the remote is a local path, so no gh runs).
        let o = overview(main.to_str().unwrap(), false, true);
        let local = overview(main.to_str().unwrap(), false, false);
        let _ = std::fs::remove_dir_all(&dir);

        let local = local.expect("a git repo");
        assert_eq!((local.branches.len(), local.branch_count), (0, 0));
        let o = o.expect("a git repo");
        assert_eq!(o.remote.as_deref(), Some("origin"));
        let names: Vec<&str> = o.branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(o.branch_count, 9, "{names:?}");
        assert_eq!(names[0], "main");
        let get = |n: &str| o.branches.iter().find(|b| b.name == n).unwrap_or_else(|| panic!("{n} in {names:?}"));
        let m = get("main");
        assert_eq!((m.local, m.remote_ref.as_deref(), m.unpushed, m.unpulled, m.merged), (true, Some("origin/main"), Some(0), Some(0), false));
        assert!(m.checked_out.as_deref().is_some_and(|p| p.ends_with("/main")), "{m:?}");
        let p = get("pushed");
        assert_eq!((p.remote_ref.as_deref(), p.unpushed, p.unpulled, p.ahead, p.behind), (Some("origin/pushed"), Some(1), Some(0), 2, 0));
        assert_eq!((p.subject.as_str(), p.author.as_str(), p.checked_out.as_deref()), ("p2", "t", None));
        let l = get("local");
        assert_eq!((l.remote_ref.as_deref(), l.unpushed, l.unpulled, l.upstream_gone, l.ahead), (None, None, None, false, 1));
        let g = get("gone");
        assert_eq!((g.upstream_gone, g.remote_ref.as_deref(), g.unpushed), (true, None, None));
        let n = get("noup");
        assert_eq!((n.remote_ref.as_deref(), n.unpushed, n.unpulled), (Some("origin/noup"), Some(1), Some(0)));
        let t = get("theirs");
        assert_eq!((t.local, t.remote_ref.as_deref(), t.ahead, t.unpushed, t.merged), (false, Some("origin/theirs"), 1, None, false));
        let md = get("merged");
        assert_eq!((md.merged, md.ahead, md.local), (true, 0, true));
        let w = get("wt");
        assert!(w.checked_out.as_deref().is_some_and(|p| p.ends_with("/wt")) && w.merged, "{w:?}");
        let d = get("dirty");
        assert!(d.checked_out.as_deref().is_some_and(|p| p.ends_with("/dirty")) && !d.merged, "{d:?}");
    }

    fn br(name: &str, local: bool, remote_ref: Option<&str>) -> Branch {
        Branch {
            name: name.into(),
            local,
            remote_ref: remote_ref.map(String::from),
            upstream_gone: false,
            head: String::new(),
            subject: String::new(),
            author: String::new(),
            committed_at: 0,
            ahead: 0,
            behind: 0,
            merged: false,
            unpushed: None,
            unpulled: None,
            checked_out: None,
            on_github: None,
            newer_on_github: false,
            github_new: None,
        }
    }

    #[test]
    fn branches_compared_with_github_tips() {
        let oid = |c: char| c.to_string().repeat(40);
        let head = |n: &str, c: char| GitHubHead { name: n.into(), oid: oid(c), at: 5_000, subject: format!("{n} tip") };
        // Local remote-tracking tips: main and stale at a; feat at b; ours (local newer) at c; gone (deleted on GitHub).
        let remote_oids: HashMap<String, String> =
            [("main", 'a'), ("stale", 'a'), ("feat", 'b'), ("ours", 'c'), ("gone", 'd')].map(|(n, c)| (n.to_string(), oid(c))).into();
        let mut tips = GitHubTips {
            heads: vec![head("main", '1'), head("stale", '2'), head("feat", 'b'), head("ours", '3'), head("fresh", '4')],
            complete: true,
            default_branch: Some("main".into()),
            default_commits: Some(10),
        };
        let fresh = || {
            vec![
                br("main", true, Some("origin/main")),
                br("stale", false, Some("origin/stale")),
                br("feat", true, Some("origin/feat")),
                br("ours", false, Some("origin/ours")),
                br("gone", true, Some("origin/gone")),
                br("solo", true, None),
            ]
        };
        // GitHub's 1 (main) and 2 (stale) aren't here (missing objects); 3 is an ancestor of our c.
        let asked = std::cell::RefCell::new(Vec::new());
        let contained = |pairs: &[(&str, &str)]| {
            asked.borrow_mut().extend(pairs.iter().map(|p| p.0.chars().next().unwrap()));
            pairs.iter().map(|(gh, _)| gh.starts_with('3')).collect()
        };
        let mut b = fresh();
        let added = compare_github(&mut b, &remote_oids, &tips, (100, Some(50)), "main", contained, |n| (n == "main").then_some(7));
        let get = |b: &[Branch], n: &str| {
            let x = b.iter().find(|x| x.name == n).unwrap();
            (x.on_github, x.newer_on_github, x.github_new)
        };
        assert_eq!(get(&b, "main"), (Some(true), true, Some(3)), "GitHub newer, object missing: 10 - 7 new");
        assert_eq!(get(&b, "stale"), (Some(true), true, None), "newer, but not the base: no count");
        assert_eq!(get(&b, "feat"), (Some(true), false, None), "equal");
        assert_eq!(get(&b, "ours"), (Some(true), false, None), "remote-tracking newer: GitHub's tip is an ancestor");
        assert_eq!(get(&b, "gone"), (Some(false), false, None), "deleted on GitHub");
        assert_eq!(get(&b, "solo"), (Some(false), false, None), "never pushed");
        assert_eq!(asked.borrow().as_slice(), &['1', '2', '3'], "only differing tips are checked, in one call");
        assert_eq!(added.len(), 1, "created on GitHub");
        let f = &added[0];
        assert_eq!((f.name.as_str(), f.local, f.remote_ref.as_deref(), f.on_github, f.newer_on_github), ("fresh", false, None, Some(true), true));
        assert_eq!((f.head.as_str(), f.subject.as_str(), f.committed_at), ("4444444", "fresh tip", 5_000));
        // A count that doesn't add up (GitHub has fewer commits than here, say after a force push): unknown.
        let mut b = fresh();
        let contained_none = |p: &[(&str, &str)]| vec![false; p.len()];
        compare_github(&mut b, &remote_oids, &tips, (100, Some(50)), "main", contained_none, |_| Some(12));
        assert_eq!(get(&b, "main"), (Some(true), true, None));
        // The refs changed after GitHub's snapshot (a push, a deleted branch, a fetch): no created/deleted verdicts,
        // tips both sides have still compare. "lost" is a local branch whose remote-tracking ref was just deleted.
        let mut b = fresh();
        b.push(br("lost", true, None));
        tips.heads.push(head("lost", 'e'));
        let added = compare_github(&mut b, &remote_oids, &tips, (100, Some(150)), "main", contained_none, |_| Some(7));
        assert!(added.is_empty(), "{added:?}");
        assert_eq!(get(&b, "gone"), (None, false, None));
        assert_eq!(get(&b, "solo"), (None, false, None));
        assert_eq!(get(&b, "lost"), (None, false, None));
        assert_eq!(get(&b, "feat"), (Some(true), false, None));
        assert_eq!(get(&b, "main"), (Some(true), true, Some(3)));
        // Never-touched refs (no loose refs, reflogs or FETCH_HEAD) trust the snapshot.
        let mut b = fresh();
        b.push(br("lost", true, None));
        compare_github(&mut b, &remote_oids, &tips, (100, None), "main", contained_none, |_| None);
        assert_eq!((get(&b, "gone"), get(&b, "lost")), ((Some(false), false, None), (Some(true), true, None)));
        tips.heads.pop();
        // GitHub's list was cut: branches missing from it are unknown, not deleted; those in it still compare.
        tips.complete = false;
        let mut b = fresh();
        compare_github(&mut b, &remote_oids, &tips, (100, Some(50)), "main", |p| vec![false; p.len()], |_| None);
        assert_eq!(get(&b, "gone"), (None, false, None));
        assert_eq!(get(&b, "solo"), (None, false, None));
        assert_eq!(get(&b, "feat"), (Some(true), false, None));
        assert_eq!(get(&b, "main"), (Some(true), true, None));
    }

    #[test]
    fn github_tips_from_graphql() {
        let repo = flatten_nodes(json!({
            "list": {"nodes": []},
            "defaultBranchRef": {"name": "trunk", "target": {"oid": "f".repeat(40), "history": {"totalCount": 12562}}},
            "heads": {"totalCount": 3, "nodes": [
                {"name": "a", "target": {"oid": "a".repeat(40), "committedDate": "2026-11-01T10:00:00Z", "messageHeadline": "A"}},
                {"name": "b", "target": {"oid": "b".repeat(40)}}
            ]}
        }));
        let t = parse_tips(&repo).unwrap();
        assert!(!t.complete);
        assert_eq!((t.default_branch.as_deref(), t.default_commits), (Some("trunk"), Some(12562)));
        let names: Vec<&str> = t.heads.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "trunk"], "the default branch is kept past the cut");
        assert_eq!((t.heads[0].subject.as_str(), t.heads[0].at > 0, t.heads[1].at), ("A", true, 0));
        assert!(parse_tips(&json!({})).is_none());
        // The tips stay out of the contract.
        let g = GitHubInfo {
            repo: "o/n".into(),
            url: String::new(),
            pulls: vec![],
            recent_pulls: vec![],
            viewer: None,
            issues: vec![],
            fetched_at: 0,
            tips: Some(t),
        };
        assert!(serde_json::to_value(&g).unwrap().get("tips").is_none());
        let j = serde_json::to_value(br("x", true, None)).unwrap();
        for k in ["onGitHub", "newerOnGitHub", "githubNew"] {
            assert!(j.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn fetch_output_summarized() {
        let z = "0".repeat(40);
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let out = format!(
            "  {a} {b} refs/remotes/origin/main\n+ {a} {b} refs/remotes/origin/wip\n* {z} {b} refs/remotes/origin/new1\n\
             * {z} {b} refs/remotes/origin/new2\n- {a} {z} refs/remotes/origin/old\n* {z} {a} refs/tags/v1\n\
             * {z} {a} refs/remotes/origin/HEAD\n"
        );
        let u = parse_fetch(&out, "origin");
        assert_eq!(u.len(), 6);
        assert_eq!((u[0].flag, u[0].name.as_str(), u[0].branch), (' ', "main", true));
        assert_eq!((u[5].name.as_str(), u[5].branch), ("refs/tags/v1", false));
        assert_eq!(fetch_summary(&u, |_, _| Some(3)), "main +3 · wip rewritten · 2 new branches · 1 deleted · 1 new tag");
        assert_eq!(fetch_summary(&[], |_, _| None), "Already up to date");
        let err = "hint: x\ngit@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure";
        assert_eq!(fetch_error(err), "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository.");
        assert_eq!(fetch_error(&"x".repeat(500)).len(), 300);
    }

    #[test]
    fn git_fetch_of_a_real_repo() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-fetch-test-{}-{nanos}", std::process::id()));
        let (origin, main, other) = (dir.join("origin.git"), dir.join("main"), dir.join("other"));
        for d in [&origin, &main] {
            std::fs::create_dir_all(d).unwrap();
        }
        sh(&origin, &["init", "-q", "--bare", "-b", "main"]);
        sh(&main, &["init", "-q", "-b", "main"]);
        sh(&main, &["commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&main, &["remote", "add", "origin", origin.to_str().unwrap()]);
        sh(&main, &["push", "-q", "-u", "origin", "main"]);
        sh(&main, &["push", "-q", "origin", "main:side"]);
        sh(&dir, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        sh(&other, &["commit", "-q", "--allow-empty", "-m", "two"]);
        sh(&other, &["push", "-q", "origin", "main"]);
        let root = main.to_str().unwrap();
        let before = overview(root, false, false).unwrap().fetched_at;
        let first = git_fetch(root);
        let fetched = overview(root, false, false).unwrap().fetched_at;
        let second = git_fetch(root);
        sh(&other, &["push", "-q", "origin", "--delete", "side"]);
        let third = git_fetch(root);
        sh(&main, &["worktree", "add", "-q", "-b", "wt", "../wt"]);
        let in_worktree = git_fetch(dir.join("wt").to_str().unwrap());
        let not_root = git_fetch(dir.to_str().unwrap());
        // A fetch in a linked worktree writes that worktree's own FETCH_HEAD, and it counts too.
        std::fs::remove_file(main.join(".git/FETCH_HEAD")).unwrap();
        let none = overview(root, false, false).unwrap().fetched_at;
        sh(&dir.join("wt"), &["fetch", "-q", "origin"]);
        let from_wt = overview(root, false, false).unwrap().fetched_at;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(first.as_deref(), Ok("main +1"));
        assert_eq!(second.as_deref(), Ok("Already up to date"));
        assert_eq!(third.as_deref(), Ok("1 deleted"));
        assert!(fetched.is_some_and(|t| Some(t) > before.or(Some(0))), "{before:?} {fetched:?}");
        assert!(in_worktree.is_err() && not_root.is_err(), "{in_worktree:?} {not_root:?}");
        assert!(none.is_none() && from_wt.is_some(), "{none:?} {from_wt:?}");
    }

    #[test]
    #[ignore = "live: compares ChessCabin/rchess's remote-tracking branches with GitHub through gh (no fetch)"]
    fn github_tips_live() {
        let root = "/Users/daniel/dev/projects/romelandaschack/ChessCabin/rchess";
        let t = Instant::now();
        let o = overview(root, true, true).expect("a git repo");
        let at = o.fetched_at.and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.to_rfc3339());
        let base = o.branches.iter().find(|b| b.name == o.base);
        let unfetched: Vec<&str> =
            o.branches.iter().filter(|b| b.on_github == Some(true) && b.remote_ref.is_none() && !b.local).map(|b| b.name.as_str()).collect();
        let deleted = o.branches.iter().filter(|b| b.on_github == Some(false) && b.remote_ref.is_some()).count();
        let newer = o.branches.iter().filter(|b| b.newer_on_github).count();
        println!("fetchedAt {at:?} error {:?} ({} ms)", o.github_error, t.elapsed().as_millis());
        println!("base {} newerOnGitHub {:?} githubNew {:?}", o.base, base.map(|b| b.newer_on_github), base.and_then(|b| b.github_new));
        println!("on GitHub, not fetched {unfetched:?}; deleted on GitHub {deleted}; newer {newer}; branches {}", o.branch_count);
    }

    #[test]
    #[ignore = "live: reads this Mac's infomap and Navarch branches (and their GitHub data, which branches need)"]
    fn branches_live() {
        for root in ["/Users/daniel/dev/projects/icelab/paper-projects/generative-mapequation/infomap", "/Users/daniel/dev/planning/Navarch"] {
            let t = Instant::now();
            let o = overview(root, false, true).expect("a git repo");
            println!("{root}: remote {:?} branchCount {} ({} ms)", o.remote, o.branch_count, t.elapsed().as_millis());
            for b in o.branches.iter().take(8) {
                let co = b.checked_out.as_deref().map(|p| p.rsplit('/').next().unwrap_or(p));
                println!(
                    "  {} local={} {:?} +{}/-{} push={:?} pull={:?} gone={} merged={} co={co:?}",
                    b.name, b.local, b.remote_ref, b.ahead, b.behind, b.unpushed, b.unpulled, b.upstream_gone, b.merged
                );
            }
        }
    }

    #[test]
    fn finds_repos_below_a_folder() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("navarch-find-test-{}-{nanos}", std::process::id()));
        let repo = |rel: &str| {
            let d = dir.join(rel);
            std::fs::create_dir_all(&d).unwrap();
            sh(&d, &["init", "-q", "-b", "main"]);
            sh(&d, &["commit", "-q", "--allow-empty", "-m", "init"]);
        };
        for r in ["project/a", "project/b/c", "project/.hidden/r", "project/node_modules/x", "project/d/e/f"] {
            repo(r);
        }
        sh(&dir.join("project/a"), &["worktree", "add", "-q", "-b", "feat", "../wt"]);
        // The project folder is itself inside a repo, with a repo below it.
        repo("outer");
        repo("outer/sub/g");
        // A repo elsewhere with a worktree in the project's .claude/worktrees (where sessions put them); a plain
        // repo there is no worktree and stays unlisted.
        repo("elsewhere/r");
        std::fs::create_dir_all(dir.join("project/.claude/worktrees")).unwrap();
        sh(&dir.join("elsewhere/r"), &["worktree", "add", "-q", "-b", "x", "../../project/.claude/worktrees/x"]);
        repo("project/.claude/worktrees/plain");

        let project = dir.join("project");
        let found = find_repos(project.to_str().unwrap());
        let outer = find_repos(dir.join("outer/sub").to_str().unwrap());
        std::fs::create_dir_all(dir.join("empty/x/y")).unwrap();
        let none = find_repos(dir.join("empty").to_str().unwrap());
        let _ = std::fs::remove_dir_all(&dir);

        let mut rels: Vec<&str> = found.iter().map(|r| r.rel.as_str()).collect();
        rels.sort();
        assert_eq!(found.len(), 3, "{found:?}");
        let r = found.iter().find(|r| r.root.ends_with("/elsewhere/r")).expect("the worktree's repo");
        assert!(r.rel.ends_with("/elsewhere/r") && r.name == r.rel, "{r:?}");
        rels.retain(|&x| x != r.rel);
        assert_eq!(rels, vec!["a", "b/c"], "{found:?}");
        let a = found.iter().find(|r| r.rel == "a").unwrap();
        assert!(a.root.ends_with("/project/a") && a.name == "a" && a.github.is_none() && a.committed_at > 0, "{a:?}");

        assert_eq!(outer.iter().map(|r| r.rel.as_str()).collect::<Vec<_>>(), vec!["", "g"], "{outer:?}");
        assert!(outer[0].root.ends_with("/outer") && outer[0].name == "outer", "{outer:?}");

        assert!(none.is_empty(), "{none:?}");
    }

    #[test]
    #[ignore = "live: lists the repos of this Mac's project folders"]
    fn find_repos_live() {
        for p in ["/Users/daniel/dev/projects/icelab/paper-projects/bioregions2", "/Users/daniel/dev/planning/Navarch"] {
            println!("{p}");
            for r in find_repos(p) {
                println!("  {:?} name {} github {:?} committed {}", r.rel, r.name, r.github, r.committed_at > 0);
            }
        }
    }

    #[test]
    #[ignore = "live: reads this Mac's Navarch and bioregions checkouts, no GitHub"]
    fn main_checkout_live() {
        let o = overview("/Users/daniel/dev/planning/Navarch", false, false).expect("a git repo");
        let m = o.main.as_ref().expect("main checkout");
        println!(
            "Navarch main {:?} unpushed {:?} behindUpstream {:?} dirty {} commitsUnpushed {} procs {:?}",
            m.branch,
            m.unpushed,
            m.behind_upstream,
            m.dirty,
            m.commits_unpushed.len(),
            m.procs.iter().map(|p| &p.name).collect::<Vec<_>>()
        );
        let names: Vec<&str> = o.worktrees.iter().map(|w| w.path.rsplit('/').next().unwrap_or("")).collect();
        println!("  worktrees {names:?}");
        let b = overview("/Users/daniel/dev/projects/icelab/paper-projects/bioregions2/bioregions", false, false)
            .expect("a git repo");
        println!("bioregions main dirty {:?} changes {:?} worktrees {}", b.main.as_ref().map(|m| m.dirty), b.main.as_ref().map(|m| &m.changes), b.worktrees.len());
    }

    #[test]
    #[ignore = "live: reads this Mac's Navarch checkout and calls GitHub through gh"]
    fn repo_live() {
        let o = overview("/Users/daniel/dev/planning/Navarch", true, true).expect("a git repo");
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
                    let merged = g.recent_pulls.iter().filter(|p| p.state == PrState::Merged).count();
                    println!(
                        "{slug}: pulls {} recent {} (merged {merged}) issues {} viewer {:?}",
                        g.pulls.len(),
                        g.recent_pulls.len(),
                        g.issues.len(),
                        g.viewer
                    );
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
