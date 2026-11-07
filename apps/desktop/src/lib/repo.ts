// Cross-links repo overviews (worktrees, PRs, issues) with Claude sessions, for the project's Repo panel.
import type { GitHubInfo, Issue, PullRequest, RepoOverview, RepoRef, Session, Worktree } from "../api/types";

export interface LinkedWorktree {
  wt: Worktree;
  name: string; // basename of wt.path
  root: string; // the main checkout of the repo it belongs to
  repo: RepoRef | null; // that repo as the project's repo list has it (null when linked from one overview alone)
  base: string; // that repo's base branch, which ahead/behind/merged compare against
  pr: PullRequest | null; // open PR from its branch, else its most recent merged/closed one (from its own repo's GitHub data)
  sessions: Session[]; // non-archived sessions working in it, newest lastActivityAt first
  lastActivity: number; // max of its HEAD commit time and its sessions' last activity (shown, not sorted by: it moves every scan)
}

export interface LinkedPull {
  pr: PullRequest;
  worktree: LinkedWorktree | null; // the worktree on its head branch
}

export interface LinkedIssue {
  issue: Issue;
  pulls: PullRequest[]; // open PRs that close it
}

export interface LinkedRepo {
  worktrees: LinkedWorktree[];
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

/** The worktrees of several repos (duplicates by path dropped), each with its sessions and its own repo's PR. A
 *  session goes to the worktree of the last folder it worked in that lies in one (deepest worktree wins, across all
 *  repos). Ordered so rows hold still while sessions run (their lastActivityAt moves every 3 s scan): worktrees with
 *  a working or waiting session first, then by last commit, then by path. */
export function linkWorktrees(entries: RepoEntry[], sessions: Session[]): LinkedWorktree[] {
  const seen = new Set<string>();
  const all: { wt: Worktree; e: RepoEntry }[] = [];
  for (const e of entries)
    for (const wt of e.o.worktrees) {
      if (seen.has(wt.path)) continue;
      seen.add(wt.path);
      all.push({ wt, e });
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

  const worktrees: LinkedWorktree[] = all.map(({ wt, e }) => {
    const ss = (bySession.get(wt) ?? []).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return {
      wt,
      name: trim(wt.path).split("/").pop() ?? wt.path,
      root: e.o.root,
      repo: e.ref,
      base: e.o.base,
      pr: prOf(wt.branch, e.o.github),
      sessions: ss,
      lastActivity: Math.max(wt.committedAt, ...ss.map((s) => s.lastActivityAt)),
    };
  });
  const live = (w: LinkedWorktree) => (w.sessions.some((s) => s.status === "working" || s.status === "needs_input") ? 0 : 1);
  worktrees.sort((a, b) => live(a) - live(b) || b.wt.committedAt - a.wt.committedAt || a.wt.path.localeCompare(b.wt.path));
  return worktrees;
}

/** The Repo panel's rows for a project: PRs and issues of the chosen repo (`chosen`, null while it isn't loaded),
 *  worktrees of all its repos (`entries`, which should include the chosen one). */
export function linkProject(chosen: RepoOverview | null, entries: RepoEntry[], sessions: Session[]): LinkedRepo {
  const worktrees = linkWorktrees(entries, sessions);
  const gh = chosen?.github ?? null;
  const open = gh?.pulls ?? [];
  const own = chosen ? worktrees.filter((w) => w.root === chosen.root) : [];
  const pulls: LinkedPull[] = open.map((pr) => ({ pr, worktree: own.find((w) => w.wt.branch === pr.headRef) ?? null }));
  const issues: LinkedIssue[] = (gh?.issues ?? []).map((issue) => ({
    issue,
    pulls: open.filter((p) => issue.linkedPulls.includes(p.number) || p.closingIssues.includes(issue.number)),
  }));
  return { worktrees, pulls, issues };
}

/** One repo's overview cross-linked with sessions. */
export function linkRepo(o: RepoOverview, sessions: Session[]): LinkedRepo {
  return linkProject(o, [{ ref: null, o }], sessions);
}
