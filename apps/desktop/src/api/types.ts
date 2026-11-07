// Shared contract between the React UI and the Rust backend (src-tauri).
// Rust structs serialize with serde(rename_all = "camelCase") to match these shapes.

export type Id = number;

export interface Space {
  id: Id;
  name: string;
  color: string; // CSS color, e.g. "#3b82f6"
  sort: number;
}

export interface Project {
  id: Id;
  spaceId: Id;
  name: string;
  path: string; // absolute folder path; sessions whose cwd is inside it belong to the project
  sort: number;
  createdAt: number; // ms since epoch
}

export type TaskStatus = "open" | "done";

export interface Task {
  id: Id;
  projectId: Id;
  parentId: Id | null;
  title: string;
  notes: string; // markdown, sent as context when a session is started for the task
  status: TaskStatus;
  deadline: string | null; // YYYY-MM-DD
  sort: number; // order among siblings (fractional, ascending)
  createdAt: number;
  doneAt: number | null;
}

/** OKR period, e.g. "2026 H2"; start/end are inclusive YYYY-MM-DD. */
export interface Period {
  id: Id;
  name: string;
  start: string;
  end: string;
}

/** Everything the planner owns, loaded in one call (small: hundreds of rows). */
export interface Snapshot {
  spaces: Space[];
  projects: Project[];
  tasks: Task[]; // soft-deleted tasks are excluded
  periods: Period[];
  periodTasks: { periodId: Id; taskId: Id }[];
  weekTasks: { week: string; taskId: Id }[]; // week = ISO week "2026-W44"
}

/**
 * working      – Claude is mid-turn and its process is alive
 * needs_input  – Claude asked a question / plan approval and waits for you
 * unread       – turn finished after you last looked at the session in Claude
 * idle         – turn finished and seen
 * stopped      – turn was cut off (process gone mid-turn)
 */
export type SessionStatus = "working" | "needs_input" | "unread" | "idle" | "stopped";

export interface SessionDay {
  day: string; // local date YYYY-MM-DD
  activeMs: number;
  tokens: number;
}

/** A Claude desktop Code-tab session, read from the app's local files. */
export interface Session {
  id: string; // desktop id "local_…", used in claude://code/continue?session=
  cliId: string; // transcript id (~/.claude/projects/*/<cliId>.jsonl)
  title: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  lastActivityAt: number;
  archived: boolean;
  status: SessionStatus;
  running: boolean;
  procs: number; // processes in the session's tree, plus jobs it left running detached
  cpu: number; // summed CPU % of those processes
  lastPrompt: string | null; // your last message
  lastReply: string | null; // Claude's latest text since that message
  tokens: number; // input + cache writes + output (cache reads excluded)
  tokenRate: number; // tokens of the messages written in the last minute, subagents included
  cacheRead: number;
  activeMs: number; // time with activity gaps <= 5 min
  days: SessionDay[]; // last 21 days
  taskId: Id | null; // linked Navarch task
  tempFolder: boolean; // Claude started it in a temporary folder of its own ("This computer")
  launchPath: string | null; // while it's there: the folder Navarch launched it for
  remoteId?: string; // the app's latest bridgeSessionIds entry: the session's id for remote control
  /** Folders its transcript worked in (the `cwd` of its turns), distinct, most recent last, at most 8. A session
   *  that works in a worktree keeps the main checkout as `cwd`; only these show the worktree. */
  cwds: string[];
}

export interface SystemStats {
  cpu: number; // total CPU usage 0–100
  cores: number[]; // per logical core, 0–100
  load1: number; // load averages: runnable threads over 1, 5, 15 min
  load5: number;
  load15: number;
  brand: string; // e.g. "Apple M3 Pro"
}

export interface BuildInfo {
  version: string;
  commit: string; // short hash the binary was built from
  branch: string;
  checkout: string; // repo or worktree folder it was built in
  dirty: number; // tracked files with uncommitted changes at build time
  builtAt: number; // unix ms
  devUi: boolean; // UI loaded live from the Vite dev server, not built in
  db: string; // database file: navarch.db, or a dev build's per-checkout copy
}

export interface CpuSample {
  t: number; // unix ms, one every 2 s, last 10 min
  cpu: number;
  load1: number;
}

export interface UsageWindow {
  percent: number; // 0–100
  resetsAt: string | null; // ISO timestamp
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  error: string | null;
  fetchedAt: number;
  /** Claude Code is signed out, or its sign-in expired and couldn't be renewed: only a new sign-in helps. */
  needsSignIn: boolean;
  /** When Claude Code's sign-in runs out (ms), as of the last good request. */
  signInEndsAt: number | null;
}

/** At these percentages Navarch tells running sessions to save their work and schedule their resume. */
export interface LimitAlerts {
  fiveHour: number;
  sevenDay: number;
  /** The alert sessions are getting now ("5h at 96%, resets at 14:30"), or null. */
  active: string | null;
  /** Whether ~/.claude/settings.json runs Navarch's limit hook, which hands alerts to sessions. */
  hookInstalled: boolean;
  /** False in dev builds: their alerts go to a file of their own that no hook reads. */
  live: boolean;
}

/** Fields that update_task may change. deadline "" clears it; parentId 0 moves to top level. */
export interface TaskPatch {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  deadline?: string;
  parentId?: Id;
  sort?: number;
}

/** Phone access: a local server on 127.0.0.1 that tailscale serve or a Cloudflare tunnel exposes. */
export interface MobileAccess {
  enabled: boolean;
  running: boolean; // listening on 127.0.0.1:port
  port: number; // 47820 in the installed app, 47821 in every other build
  publicUrl: string; // the URL the phone opens; its host passes the server's Host check
  error: string | null; // e.g. the port is taken
  pairedAt: string | null; // RFC 3339, last successful pairing
  lastSeenAt: string | null; // RFC 3339, last request with the token since launch
}

/** This Mac on Tailscale, from `tailscale status --json`; detectTailscale returns null without the CLI. */
export interface Tailscale {
  running: boolean; // connected to the tailnet
  dnsName: string | null; // MagicDNS name, e.g. "mac.tail1234.ts.net"; null while logged out
}

/** Where Tailscale Serve sends https://<this Mac>/: nothing, this build's phone server, another Navarch build's, or anything else. */
export type ServeRoute = "none" | "ours" | "navarch" | "other";

/** Tailscale Serve against this build's phone port, from `tailscale serve status --json`. */
export interface TailscaleServe {
  cli: boolean; // the Tailscale CLI answered
  running: boolean; // connected to the tailnet
  dnsName: string | null; // e.g. "mac.tail1234.ts.net"
  route: ServeRoute | null; // null without the CLI, while disconnected, or when serve status can't be read
  target: string | null; // the route's target as Tailscale shows it, e.g. "http://127.0.0.1:47820"
  auto: boolean; // the installed app points Serve at itself when phone access is on; dev builds only on request
  loginUrl: string | null; // Serve needs HTTPS enabled for the tailnet: this login.tailscale.com page does it
  changed: string | null; // what this call changed, for a toast
  error: string | null;
}

/** A single-use code the phone trades for its token at POST /api/pair. */
export interface PairingCode {
  code: string; // 6 characters, no 0/O/1/I/L
  expiresAt: string; // RFC 3339, 10 minutes after it was made
}

// ── Repo overview (get_repo_overview): a project folder's git worktrees and its GitHub PRs and issues ──

export type CheckState = "success" | "failure" | "pending" | "neutral";

export interface PrCheck {
  name: string; // check run name or status context
  state: CheckState;
}

export interface Label {
  name: string;
  color: string; // "#rrggbb"
}

export interface PullRequest {
  number: number;
  title: string;
  url: string; // https://github.com/…
  author: string; // login
  isDraft: boolean;
  state: "open" | "merged" | "closed";
  headRef: string; // branch it merges from
  baseRef: string; // branch it merges into
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
  review: "approved" | "changes_requested" | "review_required" | null;
  checksState: CheckState | null; // rolled up: any failure → failure, else any pending → pending, else success; null: no checks
  checks: PrCheck[]; // failing first, then pending, then the rest; at most 20
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: Label[];
  body: string; // description, at most 600 chars, "" when empty
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** GitHub's mergeStateStatus, lowercased: clean, behind (base moved on), blocked (rules/reviews), dirty
   *  (conflicts), unstable (failing non-required checks), draft, has_hooks, unknown. */
  mergeState: string;
  reviewers: Reviewer[]; // latest review per person, then still-requested reviewers as "pending"
  commits: number;
  comments: number;
  closingIssues: number[]; // issues it closes when merged
  autoMerge: boolean; // auto-merge is enabled
  mergedAt: number | null; // unix ms
  closedAt: number | null; // unix ms
}

export interface Reviewer {
  login: string; // user login, or team name for a requested team
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  labels: Label[];
  assignees: string[]; // logins
  comments: number;
  body: string; // at most 600 chars
  milestone: string | null;
  issueType: string | null; // e.g. Bug, Feature (GitHub issue types)
  subIssues: { total: number; completed: number } | null; // null: no sub-issues
  linkedPulls: number[]; // PRs that close it when merged
}

export interface Worktree {
  path: string; // absolute
  branch: string | null; // null when HEAD is detached
  head: string; // short commit hash
  subject: string; // subject of the HEAD commit
  committedAt: number; // unix ms of the HEAD commit
  ahead: number; // commits on HEAD not on the base branch
  behind: number; // commits on the base branch not on HEAD
  dirty: number; // uncommitted entries (lines of `git status --porcelain`, untracked included)
  changes: string[]; // the first 20 of those lines, e.g. " M apps/desktop/src/App.tsx"
  merged: boolean; // a branch other than base whose commits are all on base (ahead == 0)
  locked: boolean;
  prunable: boolean; // its folder is gone
  commitsAhead: WorktreeCommit[]; // the commits on HEAD not on base, newest first, at most 10
  upstream: string | null; // tracking branch, e.g. "origin/repo-panel"; null when the branch was never pushed
  unpushed: number | null; // commits not on upstream; null without upstream
  procs: WorktreeProc[]; // processes whose working folder is inside it (dev servers, watchers), at most 10
}

export interface WorktreeCommit {
  hash: string; // short
  subject: string;
  at: number; // unix ms
}

export interface WorktreeProc {
  pid: number;
  name: string; // process name, e.g. node, cargo, navarch
  cmd: string; // command line, at most 160 chars
}

export interface GitHubInfo {
  repo: string; // "owner/name"
  url: string; // https://github.com/owner/name
  pulls: PullRequest[]; // open, most recently updated first
  recentPulls: PullRequest[]; // the 15 most recently merged or closed, to label worktrees whose PR is done
  issues: Issue[]; // open, most recently updated first
  fetchedAt: number; // unix ms of the gh calls behind this
}

/** What `get_repo_overview` returns for a folder inside a git repo (null for any other folder). */
export interface RepoOverview {
  root: string; // the repo's main checkout
  base: string; // branch worktrees are compared with: origin's default branch if known, else main/master
  branch: string | null; // the main checkout's current branch
  worktrees: Worktree[]; // linked worktrees, main checkout excluded
  github: GitHubInfo | null; // last good GitHub data (may be older than a failed refresh)
  githubError: string | null; // why there is no fresh GitHub data: gh missing, not signed in, no GitHub remote, or gh's error
}
