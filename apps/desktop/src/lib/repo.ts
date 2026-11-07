// Cross-links repo overviews (worktrees, branches, PRs, issues) with Claude sessions, for the project's Repo panel.
import type { Branch, GitHubInfo, Issue, PullRequest, RepoOverview, RepoRef, Session, Worktree } from "../api/types";

export interface LinkedWorktree {
  wt: Worktree;
  name: string; // basename of wt.path
  root: string; // the main checkout of the repo it belongs to
  repo: RepoRef | null; // that repo as the project's repo list has it (null when linked from one overview alone)
  base: string; // that repo's base branch, which ahead/behind/merged compare against
  pr: PullRequest | null; // open PR from its branch, else its most recent merged/closed one (from its own repo's GitHub data)
  sessions: Session[]; // non-archived sessions working in it, newest lastActivityAt first
  lastActivity: number; // max of its HEAD commit time and its sessions' last activity (shown, not sorted by: it moves every scan)
  isMain: boolean; // the repo's main checkout (wt.path = root), not a linked worktree
}

export interface LinkedPull {
  pr: PullRequest;
  worktree: LinkedWorktree | null; // the worktree on its head branch
}

export interface LinkedIssue {
  issue: Issue;
  pulls: PullRequest[]; // open PRs that close it
}

export interface LinkedBranch {
  b: Branch;
  pr: PullRequest | null; // open PR from it, else its most recently merged or closed one
  worktree: LinkedWorktree | null; // the worktree or main checkout that has it checked out (wt.path === b.checkedOut)
  stale: boolean; // see linkBranches
}

/** The Branches column, in the overview's order (base first, then newest tip first). */
export interface LinkedBranches {
  active: LinkedBranch[]; // base first, then local branches that aren't stale and local+remote ones
  /** Local, not base, not checked out, and merged into base, its upstream gone, or its PR done with the branch
   *  untouched since (no newer commit, nothing unpushed) and the PR merged or the branch has nothing beyond base. */
  stale: LinkedBranch[];
  remoteOnly: LinkedBranch[]; // only on the remote (e.g. other authors' PR branches), base aside
}

export interface LinkedRepo {
  branches: LinkedBranches; // of the chosen repo only (empty while it isn't loaded)
  rows: LinkedWorktree[]; // the Worktrees column: main checkouts (see linkWorktrees), then active linked worktrees
  idle: LinkedWorktree[]; // idle linked worktrees, folded away below the rows
  worktrees: LinkedWorktree[]; // every linked worktree (rows and idle, main checkouts left out): the column's count
  pulls: LinkedPull[];
  issues: LinkedIssue[];
}

/** A repo of the project with its overview as last loaded. */
export interface RepoEntry {
  ref: RepoRef | null;
  o: RepoOverview;
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `p` is `folder` or lies inside it. */
export function inFolder(p: string, folder: string): boolean {
  const a = trim(p);
  const f = trim(folder);
  return a === f || a.startsWith(f === "/" ? "/" : f + "/");
}

/** A PR's merge or close time, else its last update. */
export const doneAt = (p: PullRequest) => p.mergedAt ?? p.closedAt ?? p.updatedAt;

/** The PR of a branch: an open one, else its most recently merged or closed one. */
function prOf(branch: string | null, gh: GitHubInfo | null): PullRequest | null {
  if (!branch || !gh) return null;
  const done = gh.recentPulls.filter((p) => p.headRef === branch).sort((a, b) => doneAt(b) - doneAt(a));
  return gh.pulls.find((p) => p.headRef === branch) ?? done[0] ?? null;
}

/** The branches of one repo, each with its PR and the checkout that has it (from `worktrees`, the LinkedWorktree
 *  rows of that repo, main checkout included), split into active, stale and remote-only. */
export function linkBranches(o: RepoOverview, worktrees: LinkedWorktree[]): LinkedBranches {
  const out: LinkedBranches = { active: [], stale: [], remoteOnly: [] };
  const base: LinkedBranch[] = [];
  for (const b of o.branches) {
    const pr = b.name === o.base ? null : prOf(b.name, o.github);
    const worktree = b.checkedOut ? (worktrees.find((w) => trim(w.wt.path) === trim(b.checkedOut!)) ?? null) : null;
    // A finished PR counts only for a branch that hasn't moved since (a reused branch has new work), and a closed,
    // unmerged one only when the branch has nothing beyond base (else its commits may exist nowhere else).
    const prDone = !!pr && pr.state !== "open" && b.committedAt <= doneAt(pr) && !(b.unpushed ?? 0);
    const stale =
      b.local && b.name !== o.base && !b.checkedOut &&
      (b.merged || b.upstreamGone || (prDone && (pr!.state === "merged" || b.ahead === 0)));
    const lb: LinkedBranch = { b, pr, worktree, stale };
    if (stale) out.stale.push(lb);
    else if (b.name === o.base) base.push(lb);
    else if (!b.local) out.remoteOnly.push(lb);
    else out.active.push(lb);
  }
  out.active.unshift(...base);
  return out;
}

/** The rows of the Worktrees column. */
export interface WorktreeRows {
  rows: LinkedWorktree[];
  idle: LinkedWorktree[];
  worktrees: LinkedWorktree[]; // the linked worktrees among rows and idle
}

/** A main checkout worth a row when its repo isn't the picked one: uncommitted changes, unpushed commits, behind its
 *  upstream, or not on the base branch. */
export const mainNotable = (lw: LinkedWorktree) =>
  lw.wt.dirty > 0 || (lw.wt.unpushed ?? 0) > 0 || (lw.wt.behindUpstream ?? 0) > 0 || lw.wt.branch !== lw.base;

/** A linked worktree with nothing going on: detached or on the base branch, clean, no commits beyond base, nothing
 *  running, no sessions, not locked (e.g. a build checkout like `.claude/worktrees/release`). */
export const isIdle = (lw: LinkedWorktree) =>
  !lw.isMain && !lw.wt.prunable && !lw.wt.locked && (lw.wt.branch == null || lw.wt.branch === lw.base) &&
  lw.wt.dirty === 0 && lw.wt.ahead === 0 && lw.wt.procs.length === 0 && lw.sessions.length === 0;

/** The main checkouts and worktrees of several repos (duplicates by path dropped), each with its sessions and its own
 *  repo's PR. A session goes to the checkout of the last folder it worked in that lies in one (deepest wins, across
 *  all repos, main checkouts included). Rows: the main checkout of `picked` (a repo root) first, then other repos'
 *  main checkouts that are notable (mainNotable), then the linked worktrees that aren't idle (isIdle), ordered so
 *  rows hold still while sessions run (their lastActivityAt moves every 3 s scan): worktrees with a working or
 *  waiting session first, then by last commit, then by path. Idle ones come apart, in the same order. */
export function linkWorktrees(entries: RepoEntry[], sessions: Session[], picked: string | null = null): WorktreeRows {
  const seen = new Set<string>();
  const all: { wt: Worktree; e: RepoEntry; isMain: boolean }[] = [];
  for (const e of entries)
    for (const [wt, isMain] of [[e.o.main, true] as const, ...e.o.worktrees.map((w) => [w, false] as const)]) {
      if (!wt || seen.has(wt.path)) continue;
      seen.add(wt.path);
      all.push({ wt, e, isMain });
    }

  const bySession = new Map<Worktree, Session[]>();
  const byDepth = [...all].sort((a, b) => b.wt.path.length - a.wt.path.length);
  for (const s of sessions) {
    if (s.archived) continue;
    const cwds = s.cwds?.length ? s.cwds : [s.cwd];
    for (let i = cwds.length - 1; i >= 0; i--) {
      const hit = byDepth.find((x) => inFolder(cwds[i], x.wt.path));
      if (hit) {
        bySession.set(hit.wt, [...(bySession.get(hit.wt) ?? []), s]);
        break;
      }
    }
  }

  const linked: LinkedWorktree[] = all.map(({ wt, e, isMain }) => {
    const ss = (bySession.get(wt) ?? []).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return {
      wt,
      name: trim(wt.path).split("/").pop() ?? wt.path,
      root: e.o.root,
      repo: e.ref,
      base: e.o.base,
      // A main checkout on the base branch has no PR of its own.
      pr: isMain && wt.branch === e.o.base ? null : prOf(wt.branch, e.o.github),
      sessions: ss,
      lastActivity: Math.max(wt.committedAt, ...ss.map((s) => s.lastActivityAt)),
      isMain,
    };
  });
  const live = (w: LinkedWorktree) => (w.sessions.some((s) => s.status === "working" || s.status === "needs_input") ? 0 : 1);
  const order = (a: LinkedWorktree, b: LinkedWorktree) =>
    live(a) - live(b) || b.wt.committedAt - a.wt.committedAt || a.wt.path.localeCompare(b.wt.path);
  const mains = linked.filter((w) => w.isMain);
  const worktrees = linked.filter((w) => !w.isMain).sort(order);
  const own = mains.find((w) => w.root === picked);
  return {
    rows: [
      ...(own ? [own] : []),
      ...mains.filter((w) => w !== own && mainNotable(w)),
      ...worktrees.filter((w) => !isIdle(w)),
    ],
    idle: worktrees.filter(isIdle),
    worktrees,
  };
}

/** The Repo panel's rows for a project: PRs and issues of the chosen repo (`chosen`, null while it isn't loaded),
 *  worktrees of all its repos (`entries`, which should include the chosen one). */
export function linkProject(chosen: RepoOverview | null, entries: RepoEntry[], sessions: Session[]): LinkedRepo {
  const { rows, idle, worktrees } = linkWorktrees(entries, sessions, chosen?.root ?? null);
  const gh = chosen?.github ?? null;
  const open = gh?.pulls ?? [];
  // A PR's head branch may be checked out in a linked worktree or in the main checkout.
  const own = chosen ? [...rows, ...idle].filter((w) => w.root === chosen.root) : [];
  const pulls: LinkedPull[] = open.map((pr) => ({ pr, worktree: own.find((w) => w.wt.branch === pr.headRef) ?? null }));
  const issues: LinkedIssue[] = (gh?.issues ?? []).map((issue) => ({
    issue,
    pulls: open.filter((p) => issue.linkedPulls.includes(p.number) || p.closingIssues.includes(issue.number)),
  }));
  const branches = chosen ? linkBranches(chosen, own) : { active: [], stale: [], remoteOnly: [] };
  return { branches, rows, idle, worktrees, pulls, issues };
}

/** One repo's overview cross-linked with sessions. */
export function linkRepo(o: RepoOverview, sessions: Session[]): LinkedRepo {
  return linkProject(o, [{ ref: null, o }], sessions);
}
