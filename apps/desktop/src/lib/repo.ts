// Cross-links a repo overview (worktrees, PRs, issues) with Claude sessions, for the project's Repo panel.
import type { Issue, PullRequest, RepoOverview, Session, Worktree } from "../api/types";

export interface LinkedWorktree {
  wt: Worktree;
  name: string; // basename of wt.path
  pr: PullRequest | null; // open PR from its branch, else its most recent merged/closed one
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

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `p` is `folder` or lies inside it. */
export function inFolder(p: string, folder: string): boolean {
  const a = trim(p);
  const f = trim(folder);
  return a === f || a.startsWith(f === "/" ? "/" : f + "/");
}

export function linkRepo(o: RepoOverview, sessions: Session[]): LinkedRepo {
  const gh = o.github;
  const open = gh?.pulls ?? [];
  const done = [...(gh?.recentPulls ?? [])].sort((a, b) => (b.mergedAt ?? b.closedAt ?? b.updatedAt) - (a.mergedAt ?? a.closedAt ?? a.updatedAt));

  // Each session goes to the worktree of the last folder it worked in that lies in one (deepest worktree wins).
  const bySession = new Map<Worktree, Session[]>();
  const byDepth = [...o.worktrees].sort((a, b) => b.path.length - a.path.length);
  for (const s of sessions) {
    if (s.archived) continue;
    const cwds = s.cwds?.length ? s.cwds : [s.cwd];
    for (let i = cwds.length - 1; i >= 0; i--) {
      const wt = byDepth.find((w) => inFolder(cwds[i], w.path));
      if (wt) {
        bySession.set(wt, [...(bySession.get(wt) ?? []), s]);
        break;
      }
    }
  }

  const worktrees: LinkedWorktree[] = o.worktrees.map((wt) => {
    const ss = (bySession.get(wt) ?? []).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const pr = wt.branch ? (open.find((p) => p.headRef === wt.branch) ?? done.find((p) => p.headRef === wt.branch) ?? null) : null;
    return {
      wt,
      name: trim(wt.path).split("/").pop() ?? wt.path,
      pr,
      sessions: ss,
      lastActivity: Math.max(wt.committedAt, ...ss.map((s) => s.lastActivityAt)),
    };
  });
  // An order that holds while sessions run (their lastActivityAt moves every 3 s scan, so rows would swap under
  // the pointer): worktrees with a working or waiting session first, then by last commit, then by path.
  const live = (w: LinkedWorktree) => (w.sessions.some((s) => s.status === "working" || s.status === "needs_input") ? 0 : 1);
  worktrees.sort((a, b) => live(a) - live(b) || b.wt.committedAt - a.wt.committedAt || a.wt.path.localeCompare(b.wt.path));

  const pulls: LinkedPull[] = open.map((pr) => ({ pr, worktree: worktrees.find((w) => w.wt.branch === pr.headRef) ?? null }));

  const issues: LinkedIssue[] = (gh?.issues ?? []).map((issue) => ({
    issue,
    pulls: open.filter((p) => issue.linkedPulls.includes(p.number) || p.closingIssues.includes(issue.number)),
  }));

  return { worktrees, pulls, issues };
}
