// The Repo panel under a project (spanning the project view and the Focus column): open PRs, issues, branches and git
// worktrees of the project's folder, cross-linked with Claude sessions. Rows are read-only (click opens on GitHub, reveals in Finder, or opens a session); hovering a
// row shows a hover card with the details.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, BadgeCheck, Check, ChevronDown, ChevronRight, CircleDot, Cloud, CloudDownload, CloudUpload, Copy, Eye, ExternalLink, FileDiff, FolderGit2, FolderOpen,
  GitBranch, GitCompare, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Laptop, Lock, MessageSquare, Minus, RefreshCw, SquareTerminal,
  TriangleAlert, X, Zap,
} from "lucide-react";
import { api, type Branch, type CheckState, type CommitChecks, type GitHubInfo, type Issue, type Label, type PrCheck, type PullRequest, type RepoOverview, type RepoRef, type Reviewer, type Session } from "../api";
import { chosenRepo, pushKey, useModel, useStore } from "../store";
import { baseName, plainText, relTime, shortPath } from "../lib/format";
import { branchOf, deletedOnGitHub, doneAt, linkProject, newerOnGitHub, newOnGitHub, remoteNews, type LinkedBranch, type LinkedIssue, type LinkedPull, type LinkedRepo, type LinkedWorktree, type RepoEntry } from "../lib/repo";
import { IconButton, Popover, STATUS_LABEL, StatusDot } from "./ui";
import { HoverCard, useHoverCard } from "./HoverCard";

const MIN_H = 120; // panel
const MIN_TOP = 160; // project view and Focus above it (styles.css caps .repo-panel's max-height to match)
const NARROW = 1000; // below this width the columns become tabs

type Col = "pulls" | "issues" | "branches" | "worktrees";

/** Fire-and-forget backend call that toasts its error (no snapshot reload, unlike `run`). */
function useAct() {
  const toast = useStore((s) => s.toast);
  return (p: Promise<unknown>) => void p.catch((e) => toast(String(e), undefined, "error"));
}

export function RepoPanel({ path }: { path: string }) {
  // The project folder may be a repo, sit inside one, or hold several (1–2 folders down): the panel shows one of them.
  const list = useStore((s) => s.repoLists[path]);
  const saved = useStore((s) => s.repoOfProject[path]);
  const findRepos = useStore((s) => s.findRepos);
  const selectRepo = useStore((s) => s.selectRepo);
  const repos = list?.repos ?? [];
  const chosen = chosenRepo(repos, saved);
  const root = chosen?.root ?? null;
  const repoStates = useStore((s) => s.repos);
  const st = root ? repoStates[root] : undefined;
  // The other repos of the project load without GitHub (local git only): the Worktrees column shows all of theirs.
  const otherKey = repos
    .filter((r) => r.root !== root)
    .map((r) => r.root)
    .join("\n");
  const sessions = useStore((s) => s.sessions);
  const loadRepo = useStore((s) => s.loadRepo);
  const panel = useStore((s) => s.repoPanel);
  const setRepoPanel = useStore((s) => s.setRepoPanel);
  const act = useAct();
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [tab, setTab] = useState<Col>("pulls");
  const [showDone, setShowDone] = useState(false);
  const [showStale, setShowStale] = useState(false);
  const hc = useHoverCard();
  const prView = panel.prView ?? "open";
  const mine = panel.mine ?? false;

  const data = st?.data ?? null;
  // Keep the panel open while the chosen repo's first overview loads (gh calls can take seconds), so the view above
  // doesn't jump.
  const loadingChosen = panel.open && root != null && !data && !st?.error && !(st && st.at > 0);
  const open = panel.open && (data != null || loadingChosen);

  // Look for the folder's repos on mount, when it changes and when the window comes back; load the chosen repo
  // when it changes, then poll it while the window is visible (slower while folded).
  useEffect(() => {
    void findRepos(path);
  }, [path, findRepos]);
  useEffect(() => {
    if (root) void loadRepo(root);
  }, [root, loadRepo]);
  useEffect(() => {
    for (const r of otherKey ? otherKey.split("\n") : []) void loadRepo(r, false, false);
  }, [otherKey, loadRepo]);
  // The chosen repo with GitHub (forced on Refresh), the others' local side for the Worktrees column.
  const loadAll = useCallback(
    (force = false) => {
      if (root) void loadRepo(root, force);
      for (const r of otherKey ? otherKey.split("\n") : []) void loadRepo(r, false, false);
    },
    [root, otherKey, loadRepo],
  );
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const iv = window.setInterval(() => visible() && loadAll(), panel.open ? 30_000 : 120_000);
    const onVis = () => {
      if (!visible()) return;
      void findRepos(path);
      loadAll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [path, loadAll, panel.open, findRepos]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data != null]);

  // Every loaded repo of the project, the chosen one included (its overview carries the GitHub data).
  const entries = useMemo(
    () => repos.flatMap((r): RepoEntry[] => {
      const o = repoStates[r.root]?.data;
      return o ? [{ ref: r, o }] : [];
    }),
    [repos, repoStates],
  );
  const linked = useMemo(() => (data ? linkProject(data, entries, sessions) : null), [data, entries, sessions]);
  const multi = repos.length > 1;

  // Loaded, and the folder neither is in a git repo nor holds one (or the chosen one is gone).
  if (list && repos.length === 0) return null;
  if (st && st.at > 0 && data === null && repos.length <= 1) return null;

  const gh = data?.github ?? null;
  // The chosen repo has local data (loaded while another was picked) but its GitHub data is still on the way.
  const ghLoading = !gh && !!st && st.ghAt === 0 && (st.loading || !st.error);
  const weekAgo = Date.now() - 7 * 864e5;
  const mergedWeek = gh ? gh.recentPulls.filter((p) => p.state === "merged" && (p.mergedAt ?? 0) >= weekAgo).length : 0;
  const h = Math.max(MIN_H, dragH ?? panel.height);

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!open || !data || e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    // The panel is a grid item of .app under the project view and Focus: the project view's height is the row above.
    const above = root.parentElement?.querySelector<HTMLElement>(":scope > .main") ?? null;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    hc.hide();
    const y0 = e.clientY;
    const h0 = root.offsetHeight;
    const max = Math.max(MIN_H, h0 + (above?.offsetHeight ?? 0) - MIN_TOP);
    const clamp = (y: number) => Math.round(Math.min(max, Math.max(MIN_H, h0 + y0 - y)));
    const el = e.currentTarget;
    let last = h0;
    const move = (ev: PointerEvent) => setDragH((last = clamp(ev.clientY)));
    // lostpointercapture follows pointerup and pointercancel, and also fires when capture ends any other way
    // (window blur mid-drag): the one cleanup path.
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("lostpointercapture", up);
      if (last !== h0) setRepoPanel({ height: last });
      setDragH(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("lostpointercapture", up);
  };
  const toggle = () => {
    hc.hide();
    // Folded, it polls only every 2 min: refresh on unfolding.
    if (!panel.open) loadAll();
    setRepoPanel({ open: !panel.open });
  };

  const fetchedAt = gh?.fetchedAt ?? st?.at ?? 0;
  const unpushed = data?.main?.unpushed ?? 0;
  const staleN = linked?.branches.stale.length ?? 0;
  const ctx: BrCtx | null = data ? { root: data.root, slug: gh?.repo ?? chosen?.github ?? null, remote: data.remote, base: data.base } : null;
  const fetching = useStore((s) => (root ? !!s.fetching[root] : false));
  const fetchRepo = useStore((s) => s.fetchRepo);
  // The base branch moved on GitHub since this clone last fetched: git status still says "up to date".
  const baseB = branchOf(data, data?.base ?? null);
  const baseNews = newerOnGitHub(baseB) ? baseB : null;
  const showStaleBranches = () => {
    hc.hide();
    if (!panel.open) loadAll();
    setRepoPanel({ open: true });
    setShowStale(true);
    setTab("branches");
    // After the section renders: bring its toggle to the top of the column.
    window.setTimeout(() => rootRef.current?.querySelector(".br-stale-toggle")?.scrollIntoView({ block: "start" }), 60);
  };
  const counts = linked
    ? [
        gh && plural(gh.pulls.length, "PR"),
        gh && plural(gh.issues.length, "issue"),
        plural(linked.worktrees.length, "worktree"),
      ].filter(Boolean)
    : [];

  return (
    <div
      ref={rootRef}
      className={`repo-panel ${open ? "" : "is-folded"} ${dragH != null ? "is-dragging" : ""}`}
      style={open ? { height: h } : undefined}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") hc.hide();
        e.stopPropagation();
      }}
    >
      <div
        className="repo-divider"
        onPointerDown={onDividerDown}
        onDoubleClick={() => data && toggle()}
        title={open && data ? "Drag to resize · double-click to fold" : data ? "Double-click to unfold" : undefined}
      />
      <div className="repo-head">
        <button type="button" className="section-toggle" onClick={() => data && toggle()} disabled={!data} aria-expanded={open}>
          <ChevronRight size={14} className={open ? "rot" : ""} />
          Repo
        </button>
        {repos.length > 1 && chosen && (
          <>
            <RepoPicker
              repos={repos}
              chosen={chosen}
              onPick={(r) => {
                hc.hide();
                selectRepo(path, r.root);
              }}
            />
            {(gh || chosen.github) && (
              <IconButton
                icon={<ExternalLink size={12} />}
                label={`Open ${gh?.repo ?? chosen.github} on GitHub`}
                className="repo-open-gh"
                onClick={() => act(api.openUrl(gh?.url ?? `https://github.com/${chosen.github}`))}
              />
            )}
          </>
        )}
        {data && (
          <>
            {repos.length > 1 ? null : gh ? (
              <button type="button" className="repo-name" title={`Open ${gh.url}`} onClick={() => act(api.openUrl(gh.url))}>
                {gh.repo}
              </button>
            ) : (
              <span className="repo-name is-plain" title={data.root}>{baseName(data.root)}</span>
            )}
            {data.branch && data.branch !== data.base && (
              <span className="repo-branch" title={`The main checkout is on ${data.branch}, not ${data.base}`}>on {data.branch}</span>
            )}
            <span className="repo-counts">
              {counts.join(" · ")}
              {mergedWeek > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="repo-merged-link"
                    title="Show recently merged pull requests"
                    onClick={() => {
                      hc.hide();
                      if (!panel.open) loadAll();
                      setRepoPanel({ open: true, prView: "merged" });
                      setTab("pulls");
                    }}
                  >
                    {mergedWeek} merged this week
                  </button>
                </>
              )}
              {unpushed > 0 && (
                <>
                  {" · "}
                  <span
                    className="c-amber"
                    title={`The main checkout has ${plural(unpushed, "local commit")} not pushed to ${data.main?.upstream ?? "its upstream"}`}
                  >
                    {unpushed} unpushed
                  </span>
                </>
              )}
              {baseNews && data.remote && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="repo-news-link"
                    title={`Not fetched yet: GitHub’s ${data.base} has ${baseNews.githubNew != null ? plural(baseNews.githubNew, "commit") : "commits"} that ${baseNews.remoteRef ?? `${data.remote}/${data.base}`} here doesn’t. Click to fetch (git fetch --prune ${data.remote}).`}
                    onClick={() => void fetchRepo(data.root)}
                  >
                    {baseNews.githubNew != null ? `GitHub has ${baseNews.githubNew} new on ${data.base}` : `${data.base} moved on GitHub`}
                  </button>
                </>
              )}
              {staleN > 0 && (
                <>
                  {" · "}
                  <button type="button" className="repo-stale-link" title={STALE_HINT} onClick={showStaleBranches}>
                    {staleN} stale branch{staleN === 1 ? "" : "es"}
                  </button>
                </>
              )}
            </span>
          </>
        )}
        {!data && (
          <span className="repo-counts">{st?.error ? "Couldn’t read the repo" : st && st.at > 0 ? "Not a git repo any more" : "Loading…"}</span>
        )}
        <span className="repo-head-end">
          {data?.githubError && gh && (
            <span className="repo-stale" title={`GitHub data from ${new Date(gh.fetchedAt).toLocaleString()}. Refresh failed: ${data.githubError}`}>
              <TriangleAlert size={12} /> stale
            </span>
          )}
          {fetchedAt > 0 && (
            <span className="repo-updated" title={`Updated ${new Date(fetchedAt).toLocaleString()}`}>updated {relTime(fetchedAt)}</span>
          )}
          {data?.remote && (
            <IconButton
              icon={<CloudDownload size={13} />}
              label={fetching ? `Fetching from ${data.remote}…` : fetchTitle(data.remote, data.fetchedAt)}
              className={`repo-fetch ${fetching ? "spin" : ""} ${baseNews ? "has-news" : ""}`}
              disabled={fetching}
              onClick={() => void fetchRepo(data.root)}
            />
          )}
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Refresh from git and GitHub"
            className={st?.loading ? "spin" : ""}
            onClick={() => {
              void findRepos(path);
              loadAll(true);
            }}
          />
        </span>
      </div>

      {open && linked && data && ctx && (
        <RepoBody
          linked={linked}
          o={data}
          ctx={ctx}
          showStale={showStale}
          setShowStale={setShowStale}
          gh={gh}
          githubError={data.githubError}
          ghLoading={ghLoading}
          root={data.root}
          multi={multi}
          prView={prView}
          setPrView={(v) => {
            hc.hide();
            setRepoPanel({ prView: v });
          }}
          mine={mine}
          setMine={(b) => {
            hc.hide();
            setRepoPanel({ mine: b });
          }}
          narrow={narrow}
          tab={tab}
          setTab={setTab}
          showDone={showDone}
          setShowDone={setShowDone}
          hc={hc}
        />
      )}

      {open && !data && <div className="repo-body is-loading"><div className="repo-note">Loading…</div></div>}

      {open && linked && ctx && hc.open && (
        <CardFor k={hc.open.key} linked={linked} gh={gh} root={data!.root} multi={multi} ctx={ctx} rect={hc.open.rect} hc={hc} />
      )}
    </div>
  );
}

type HC = ReturnType<typeof useHoverCard>;

/** Picks which of a folder's repos the panel shows; each item lists what's cached for it. */
function RepoPicker({ repos, chosen, onPick }: { repos: RepoRef[]; chosen: RepoRef; onPick: (r: RepoRef) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cached = useStore((s) => s.repos);
  const repoPart = chosen.github?.split("/").pop();
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`repo-pick ${open ? "is-active" : ""}`}
        title={`${chosen.root}\nSwitch between the ${repos.length} repos in this folder`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="repo-pick-name">{chosen.name}</span>
        {chosen.github && repoPart !== chosen.name && <span className="repo-pick-slug">{chosen.github}</span>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <Popover anchor={ref} anchorIsTrigger onClose={() => setOpen(false)} className="menu repo-menu">
          {repos.map((r) => {
            const o = cached[r.root]?.data;
            return (
              <button
                key={r.root}
                type="button"
                role="menuitemradio"
                aria-checked={r.root === chosen.root}
                className="menu-item repo-menu-item"
                title={r.root}
                onClick={() => {
                  setOpen(false);
                  if (r.root !== chosen.root) onPick(r);
                }}
              >
                <span className="menu-icon">{r.root === chosen.root && <Check size={14} />}</span>
                <span className="rm-main">
                  <span className="rm-top">
                    <span className="rm-name">{r.name}</span>
                    <span className="menu-hint" title={r.committedAt ? `Last commit ${new Date(r.committedAt).toLocaleString()}` : undefined}>
                      {r.committedAt ? relTime(r.committedAt) : "no commits"}
                    </span>
                  </span>
                  <span className="rm-sub">
                    <span className={r.github ? "rm-slug" : "rm-slug is-none"}>{r.github ?? "no GitHub remote"}</span>
                    {o && <span className="rm-counts">{overviewCounts(o)}</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </Popover>
      )}
    </>
  );
}

const overviewCounts = (o: RepoOverview) =>
  [
    o.github && plural(o.github.pulls.length, "PR"),
    o.github && plural(o.github.issues.length, "issue"),
    plural(o.worktrees.length, "worktree"),
  ]
    .filter(Boolean)
    .join(" · ");

function RepoBody({
  linked, o, ctx, showStale, setShowStale, gh, githubError, ghLoading, root, multi, prView, setPrView, mine, setMine, narrow, tab, setTab,
  showDone, setShowDone, hc,
}: {
  linked: LinkedRepo; o: RepoOverview; ctx: BrCtx; showStale: boolean; setShowStale: (b: boolean) => void; gh: GitHubInfo | null; githubError: string | null; ghLoading: boolean; root: string; multi: boolean;
  prView: "open" | "merged"; setPrView: (v: "open" | "merged") => void; mine: boolean; setMine: (b: boolean) => void;
  narrow: boolean; tab: Col; setTab: (c: Col) => void; showDone: boolean; setShowDone: (b: boolean) => void; hc: HC;
}) {
  const [showIdle, setShowIdle] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  const br = linked.branches;
  const ghNote = !gh && <div className="repo-note">{ghLoading ? "Loading GitHub data…" : (githubError ?? "No GitHub data")}</div>;
  const closed = (gh?.recentPulls ?? []).filter((p) => p.state === "closed");
  const merged = (gh?.recentPulls ?? []).filter((p) => p.state === "merged");
  const ownWt = (n: number) => linked.worktrees.find((w) => w.root === root && w.pr?.number === n) ?? null;
  const viewer = gh?.viewer ?? null;
  const prSwitch = gh && (
    <span className="repo-prview">
      <span className="seg seg-small" role="radiogroup" aria-label="Pull requests to list">
        <button type="button" role="radio" aria-checked={prView === "open"} className={prView === "open" ? "is-on" : ""} onClick={() => setPrView("open")}>
          Open <span className="count">{gh.pulls.length}</span>
        </button>
        <button type="button" role="radio" aria-checked={prView === "merged"} className={prView === "merged" ? "is-on" : ""} onClick={() => setPrView("merged")}>
          Merged
        </button>
      </span>
      {prView === "merged" && viewer && (
        <button
          type="button"
          className={`repo-mine ${mine ? "is-on" : ""}`}
          aria-pressed={mine}
          title={mine ? `Showing only PRs by ${viewer}. Click to show everyone’s.` : `Show only PRs by ${viewer}`}
          onClick={() => setMine(!mine)}
        >
          Mine
        </button>
      )}
    </span>
  );
  const cols: { id: Col; title: string; short?: string; n: number | null; head?: ReactNode; body: ReactNode }[] = [
    {
      id: "pulls",
      title: "Pull requests",
      short: "PRs",
      n: gh ? gh.pulls.length : null,
      head: prSwitch,
      body:
        ghNote ||
        (prView === "merged" && gh ? (
          <MergedList prs={mine && viewer ? merged.filter((p) => p.author === viewer) : merged} gh={gh} mine={mine && !!viewer} ownWt={ownWt} hc={hc} />
        ) : (
          <>
            {linked.pulls.length === 0 && <div className="repo-empty">No open pull requests</div>}
            {linked.pulls.map((lp) => (
              <PrRow key={lp.pr.number} lp={lp} hc={hc} />
            ))}
            {closed.length > 0 && (
              <>
                <button type="button" className="repo-sub-toggle" onClick={() => setShowDone(!showDone)}>
                  <ChevronRight size={12} className={showDone ? "rot" : ""} /> Recently closed <span className="count">{closed.length}</span>
                </button>
                {showDone && closed.map((pr) => <PrRow key={pr.number} lp={{ pr, worktree: ownWt(pr.number) }} hc={hc} done />)}
              </>
            )}
          </>
        )),
    },
    {
      id: "issues",
      title: "Issues",
      n: gh ? gh.issues.length : null,
      body:
        ghNote || (
          <>
            {linked.issues.length === 0 && <div className="repo-empty">No open issues</div>}
            {linked.issues.map((li) => (
              <IssueRow key={li.issue.number} li={li} hc={hc} />
            ))}
          </>
        ),
    },
    {
      id: "branches",
      title: "Branches",
      n: o.branchCount,
      body: (
        <>
          {br.active.map((lb) => (
            <BranchRow key={lb.b.name} lb={lb} ctx={ctx} hc={hc} />
          ))}
          {br.active.length === 0 && <div className="repo-empty">No local branches</div>}
          {br.remoteOnly.length > 0 && (
            <>
              <button
                type="button"
                className="repo-sub-toggle"
                aria-expanded={showRemote}
                title={`Branches only on ${o.remote ?? "the remote"}, with no local branch (e.g. other people’s PR branches)`}
                onClick={() => {
                  hc.hide();
                  setShowRemote(!showRemote);
                }}
              >
                <ChevronRight size={12} className={showRemote ? "rot" : ""} /> Remote only <span className="count">{br.remoteOnly.length}</span>
              </button>
              {showRemote && br.remoteOnly.map((lb) => <BranchRow key={lb.b.name} lb={lb} ctx={ctx} hc={hc} />)}
            </>
          )}
          {br.stale.length > 0 && (
            <>
              <button
                type="button"
                className="repo-sub-toggle br-stale-toggle"
                aria-expanded={showStale}
                title={STALE_HINT}
                onClick={() => {
                  hc.hide();
                  setShowStale(!showStale);
                }}
              >
                <ChevronRight size={12} className={showStale ? "rot" : ""} /> Stale <span className="count">{br.stale.length}</span>
              </button>
              {showStale && br.stale.map((lb) => <BranchRow key={lb.b.name} lb={lb} ctx={ctx} hc={hc} />)}
            </>
          )}
          {o.branchCount > o.branches.length && (
            <div className="repo-empty">
              Showing {o.branches.length} of {o.branchCount} branches
            </div>
          )}
        </>
      ),
    },
    {
      id: "worktrees",
      title: "Worktrees",
      n: linked.worktrees.length,
      body: (
        <>
          {linked.rows.map((lw) => (
            <WorktreeRow key={lw.wt.path} lw={lw} multi={multi} hc={hc} />
          ))}
          {linked.worktrees.length === 0 && (
            <div className="repo-empty">No worktrees besides the main checkout{multi ? "s" : ""}</div>
          )}
          {linked.idle.length > 0 && (
            <>
              <button
                type="button"
                className="repo-sub-toggle"
                aria-expanded={showIdle}
                title="Worktrees on the base branch or a detached HEAD with no changes, commits, processes or sessions"
                onClick={() => {
                  hc.hide();
                  setShowIdle(!showIdle);
                }}
              >
                <ChevronRight size={12} className={showIdle ? "rot" : ""} /> Idle <span className="count">{linked.idle.length}</span>
              </button>
              {showIdle && linked.idle.map((lw) => <WorktreeRow key={lw.wt.path} lw={lw} multi={multi} hc={hc} />)}
            </>
          )}
        </>
      ),
    },
  ];

  if (narrow) {
    const c = cols.find((x) => x.id === tab) ?? cols[0];
    return (
      <div className="repo-body is-tabs">
        <div className="repo-tabs" role="tablist">
          {cols.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={x.id === c.id} className={`repo-tab ${x.id === c.id ? "is-active" : ""}`} onClick={() => setTab(x.id)}>
              {x.title} {x.n != null && <span className="count">{x.n}</span>}
            </button>
          ))}
        </div>
        {c.head && <div className="repo-subhead">{c.head}</div>}
        <div className="repo-list" onScroll={hc.hide}>{c.body}</div>
      </div>
    );
  }
  return (
    <div className="repo-body">
      {cols.map((x) => (
        <div key={x.id} className="repo-col">
          <div className="repo-col-head">
            {x.head ? (
              <>
                {x.short ?? x.title}
                {x.head}
              </>
            ) : (
              <>
                {x.title} {x.n != null && <span className="count">{x.n}</span>}
              </>
            )}
          </div>
          <div className="repo-list" onScroll={hc.hide}>{x.body}</div>
        </div>
      ))}
    </div>
  );
}

/** Recently merged PRs, grouped by the day they were merged: an overview of what got done. */
function MergedList({
  prs, gh, mine, ownWt, hc,
}: { prs: PullRequest[]; gh: GitHubInfo; mine: boolean; ownWt: (n: number) => LinkedWorktree | null; hc: HC }) {
  const act = useAct();
  const groups: { label: string; prs: PullRequest[] }[] = [];
  const now = Date.now();
  for (const pr of [...prs].sort((a, b) => doneAt(b) - doneAt(a))) {
    const label = dayLabel(doneAt(pr), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.prs.push(pr);
    else groups.push({ label, prs: [pr] });
  }
  const q = `is:pr is:merged${mine && gh.viewer ? ` author:${gh.viewer}` : ""}`;
  return (
    <>
      {prs.length === 0 && <div className="repo-empty">{mine ? "None of your pull requests merged lately" : "No merged pull requests yet"}</div>}
      {groups.map((g) => (
        <div key={g.label} className="repo-day">
          <div className="repo-day-head">
            {g.label} <span className="count">{g.prs.length}</span>
          </div>
          {g.prs.map((pr) => (
            <MergedRow key={pr.number} pr={pr} viewer={gh.viewer} worktree={ownWt(pr.number)} hc={hc} />
          ))}
        </div>
      ))}
      <button type="button" className="repo-sub-toggle repo-more" onClick={() => act(api.openUrl(`${gh.url}/pulls?q=${encodeURIComponent(q)}`))}>
        <ExternalLink size={11} /> {prs.length > 0 ? "Older merged PRs" : "Merged PRs"} on GitHub
      </button>
    </>
  );
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Today, Yesterday, a weekday within the last 7 days, Last week, then the date. */
function dayLabel(ms: number, now: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(now) - day(ms)) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY.format(ms);
  if (days < 14) return "Last week";
  return MONTH_DAY.format(ms);
}

// ── rows ──

function PrRow({ lp, hc, done }: { lp: LinkedPull; hc: HC; done?: boolean }) {
  const act = useAct();
  const { pr, worktree } = lp;
  return (
    <div
      className={`repo-row ${done ? "is-done" : ""} ${hc.open?.key === `pr:${pr.number}` ? "is-hovered" : ""}`}
      role="link"
      onClick={() => act(api.openUrl(pr.url))}
      {...hc.row(`pr:${pr.number}`)}
    >
      <PrIcon pr={pr} />
      <div className="rr-main">
        <div className="rr-title">{pr.title}</div>
        <div className="rr-sub">
          <span className="rr-num">#{pr.number}</span>
          <span className="muted">{relTime(done ? (pr.mergedAt ?? pr.closedAt ?? pr.updatedAt) : pr.updatedAt)}</span>
          {worktree && (
            <span className="wt-chip" title={`Worktree ${worktree.name}`}>
              <FolderGit2 size={11} /> {worktree.name}
            </span>
          )}
          <span className="rr-marks">
            {pr.mergeable === "conflicting" && pr.state === "open" && (
              <span className="mark mark-red" title="Has merge conflicts">
                <TriangleAlert size={12} />
              </span>
            )}
            {!done && <ReviewMark pr={pr} />}
            {!done && pr.checksState && <CheckMark state={pr.checksState} title={checksSummary(pr.checks)} />}
          </span>
        </div>
      </div>
    </div>
  );
}

function MergedRow({ pr, viewer, worktree, hc }: { pr: PullRequest; viewer: string | null; worktree: LinkedWorktree | null; hc: HC }) {
  const act = useAct();
  const at = doneAt(pr);
  return (
    <div
      className={`repo-row ${hc.open?.key === `pr:${pr.number}` ? "is-hovered" : ""}`}
      role="link"
      onClick={() => act(api.openUrl(pr.url))}
      {...hc.row(`pr:${pr.number}`)}
    >
      <PrIcon pr={pr} />
      <div className="rr-main">
        <div className="rr-title">{pr.title}</div>
        <div className="rr-sub">
          <span className="rr-num">#{pr.number}</span>
          {pr.author !== viewer && <span className="rr-author">{pr.author}</span>}
          {pr.additions + pr.deletions > 0 && (
            <span className="rr-diff" title={`${plural(pr.changedFiles, "file")} changed`}>
              <span className="c-green">+{pr.additions.toLocaleString()}</span> <span className="c-red">−{pr.deletions.toLocaleString()}</span>
            </span>
          )}
          {worktree && (
            <span className="wt-chip" title={`Worktree ${worktree.name}`}>
              <FolderGit2 size={11} /> {worktree.name}
            </span>
          )}
          <span className="rr-marks">
            <span className="muted" title={`Merged ${new Date(at).toLocaleString()}`}>{relTime(at)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function IssueRow({ li, hc }: { li: LinkedIssue; hc: HC }) {
  const act = useAct();
  const { issue, pulls } = li;
  const shown = issue.labels.slice(0, 2);
  return (
    <div className={`repo-row ${hc.open?.key === `is:${issue.number}` ? "is-hovered" : ""}`} role="link" onClick={() => act(api.openUrl(issue.url))} {...hc.row(`is:${issue.number}`)}>
      <CircleDot size={14} className="ri-icon c-green" />
      <div className="rr-main">
        <div className="rr-title">{issue.title}</div>
        <div className="rr-sub">
          <span className="rr-num">#{issue.number}</span>
          <span className="muted">{relTime(issue.updatedAt)}</span>
          {shown.length > 0 && (
            <span className="rr-labels" title={issue.labels.map((l) => l.name).join(", ")}>
              {shown.map((l) => (
                <LabelChip key={l.name} l={l} />
              ))}
              {issue.labels.length > shown.length && <span className="muted">+{issue.labels.length - shown.length}</span>}
            </span>
          )}
          <span className="rr-marks">
            {pulls.length > 0 && (
              <span className="mark mark-green" title={`Pull request${pulls.length > 1 ? "s" : ""} ${pulls.map((p) => `#${p.number}`).join(", ")} will close it`}>
                <GitPullRequest size={12} />
                {pulls.length > 1 && pulls.length}
              </span>
            )}
            {issue.comments > 0 && (
              <span className="mark" title={plural(issue.comments, "comment")}>
                <MessageSquare size={11} /> {issue.comments}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Session dots that open the session on click. */
function SessionDots({ sessions }: { sessions: Session[] }) {
  const act = useAct();
  if (sessions.length === 0) return null;
  return (
    <span className="rr-dots">
      {sessions.slice(0, 4).map((s) => (
        <button
          key={s.id}
          type="button"
          className="dot-btn"
          title={`${s.title || "Untitled session"} — ${STATUS_LABEL[s.status]}. Click to open.`}
          onClick={(e) => {
            e.stopPropagation();
            act(api.openSession(s.id));
          }}
        >
          <StatusDot status={s.status} />
        </button>
      ))}
      {sessions.length > 4 && <span className="muted">+{sessions.length - 4}</span>}
    </span>
  );
}

/** ↑ commits not pushed and ↓ commits behind the upstream (as of the last fetch). */
function UpstreamMarks({ lw }: { lw: LinkedWorktree }) {
  const { wt } = lw;
  const up = wt.unpushed ?? 0;
  const down = wt.behindUpstream ?? 0;
  if (up === 0 && down === 0) return null;
  return (
    <>
      {up > 0 && (
        <span className="rr-ab c-amber" title={`${plural(up, "commit")} not pushed to ${wt.upstream}`}>
          <span><ArrowUp size={10} />{up}</span> <span className="rr-ab-label">not pushed</span>
        </span>
      )}
      {down > 0 && (
        <span className="rr-ab" title={`${plural(down, "commit")} on ${wt.upstream} not here, as of the last fetch`}>
          <span><ArrowDown size={10} />{down}</span> <span className="rr-ab-label">behind origin</span>
        </span>
      )}
    </>
  );
}

/** The Fetch button's tooltip. */
function fetchTitle(remote: string, fetchedAt: number | null): string {
  const when = fetchedAt ? `Last fetched ${relTime(fetchedAt)} (${new Date(fetchedAt).toLocaleString()})` : "Never fetched";
  return `Fetch from GitHub: git fetch --prune ${remote}. Updates ${remote}/* only; your branches and files stay as they are. ${when}`;
}

/** Fetch button for a hover card: fetches the repo whose main checkout is `root`; nothing when it has no remote. */
function FetchButton({ root }: { root: string }) {
  const o = useStore((s) => s.repos[root]?.data);
  const fetching = useStore((s) => !!s.fetching[root]);
  const fetchRepo = useStore((s) => s.fetchRepo);
  if (!o?.remote) return null;
  return (
    <button
      type="button"
      className={`btn btn-small btn-ghost ${fetching ? "spin" : ""}`}
      title={fetchTitle(o.remote, o.fetchedAt)}
      disabled={fetching}
      onClick={() => void fetchRepo(root)}
    >
      <CloudDownload size={12} /> {fetching ? "Fetching…" : "Fetch"}
    </button>
  );
}

/** Push button for a branch card: pushes its unpushed commits to its remote side (fast-forward only). Nothing for a
 *  branch with none, never pushed, or deleted on GitHub; disabled while the remote side has commits it doesn't. */
function PushButton({ root, b }: { root: string; b: Branch }) {
  const pushing = useStore((s) => !!s.pushing[pushKey(root, b.name)]);
  const fetching = useStore((s) => !!s.fetching[root]);
  const pushBranch = useStore((s) => s.pushBranch);
  const up = b.unpushed ?? 0;
  if (!b.local || !b.remoteRef || b.upstreamGone || deletedOnGitHub(b) || up === 0) return null;
  const blocked =
    (b.unpulled ?? 0) > 0
      ? `${b.remoteRef} has ${plural(b.unpulled!, "commit")} that ${b.name} doesn’t: pull or rebase first`
      : newerOnGitHub(b)
        ? `GitHub’s ${b.name} has commits that aren’t fetched yet: Fetch, then pull or rebase first`
        : null;
  return (
    <button
      type="button"
      className={`btn btn-small btn-ghost ${pushing ? "spin" : ""}`}
      title={
        blocked ??
        `Push ${plural(up, "commit")} to ${b.remoteRef}: git push of ${b.name} only, fast-forward (never forced), no tags`
      }
      disabled={pushing || fetching || !!blocked}
      onClick={() => void pushBranch(root, b.name)}
    >
      <CloudUpload size={12} /> {pushing ? "Pushing…" : "Push"}
    </button>
  );
}

/** "↓N on GitHub": commits on GitHub that this clone's remote-tracking branch doesn't have (not fetched yet). */
function GitHubNewsMark({ b, remote }: { b: Branch; remote: string | null }) {
  const ref = b.remoteRef ?? `${remote ?? "origin"}/${b.name}`;
  const n = b.githubNew;
  return (
    <span
      className="rr-ab c-amber"
      title={`Not fetched yet: GitHub has ${n != null ? plural(n, "commit") : "commits"} that this clone’s ${ref} doesn’t; Fetch brings them in, then pull/merge yourself`}
    >
      <span><ArrowDown size={10} />{n ?? ""}</span> <span className="rr-ab-label">on GitHub</span>
    </span>
  );
}

/** The main checkout's row: pinned first; its many idle sessions show only in the hover card. */
function MainRow({ lw, multi, hc }: { lw: LinkedWorktree; multi: boolean; hc: HC }) {
  const act = useAct();
  const { wt, sessions, base } = lw;
  const key = `wt:${wt.path}`;
  const running = sessions.filter((s) => s.running || s.status === "working" || s.status === "needs_input");
  const offBase = wt.branch !== base;
  const o = useStore((s) => s.repos[lw.root]?.data);
  const b = branchOf(o, wt.branch);
  const news = newerOnGitHub(b) ? b : null;
  const ciBad = b?.ci && b.ci.state !== "success";
  return (
    <div
      className={`repo-row is-main ${hc.open?.key === key ? "is-hovered" : ""}`}
      role="button"
      onClick={() => act(api.revealPath(wt.path))}
      {...hc.row(key)}
    >
      <Laptop size={14} className={`ri-icon ${running.some((s) => s.status === "working") ? "c-blue" : "muted"}`} />
      <div className="rr-main">
        <div className="rr-title">
          {multi && lw.repo && lw.repo.name !== lw.name && <span className="rr-repo" title={`In the repo ${lw.repo.root}`}>{lw.repo.name}</span>}
          {lw.name}
          <span className="tag tag-main" title={`The repo’s main checkout, ${wt.path}`}>main checkout</span>
        </div>
        <div className="rr-sub">
          {offBase ? (
            <span className="tag tag-amber" title={wt.branch ? `On ${wt.branch}, not ${base}` : `HEAD is detached at ${wt.head}, not on ${base}`}>
              {wt.branch ?? `detached ${wt.head}`}
            </span>
          ) : (
            <span className="muted">{wt.branch}</span>
          )}
          <UpstreamMarks lw={lw} />
          {news && <GitHubNewsMark b={news} remote={o?.remote ?? null} />}
          <CiMark b={b} slug={o?.github?.repo ?? null} />
          {wt.dirty > 0 && <span className="c-amber" title={`${plural(wt.dirty, "uncommitted change")}`}>+{wt.dirty}</span>}
          {wt.procs.length > 0 && (
            <span className="mark c-blue" title={`Running: ${wt.procs.map((p) => p.name).join(", ")}`}>
              <SquareTerminal size={12} /> {wt.procs.length}
            </span>
          )}
          {!offBase && !wt.dirty && !wt.unpushed && !wt.behindUpstream && wt.upstream && !news && !ciBad && (
            <span className="muted">· in sync with {wt.upstream}</span>
          )}
          <span className="rr-marks">
            <SessionDots sessions={running} />
          </span>
        </div>
      </div>
    </div>
  );
}

function WorktreeRow({ lw, multi, hc }: { lw: LinkedWorktree; multi: boolean; hc: HC }) {
  const act = useAct();
  if (lw.isMain) return <MainRow lw={lw} multi={multi} hc={hc} />;
  const { wt, pr, sessions, base } = lw;
  const key = `wt:${wt.path}`;
  return (
    <div
      className={`repo-row ${wt.prunable ? "is-done" : ""} ${hc.open?.key === key ? "is-hovered" : ""}`}
      role="button"
      onClick={() => act(api.revealPath(wt.path))}
      {...hc.row(key)}
    >
      <FolderGit2 size={14} className={`ri-icon ${sessions.some((s) => s.status === "working") ? "c-blue" : "muted"}`} />
      <div className="rr-main">
        <div className="rr-title">
          {multi && lw.repo && <span className="rr-repo" title={`In the repo ${lw.repo.root}`}>{lw.repo.name}</span>}
          {lw.name}
          {wt.branch && wt.branch !== lw.name && <span className="rr-branch">{wt.branch}</span>}
          {!wt.branch && <span className="rr-branch">detached {wt.head}</span>}
        </div>
        <div className="rr-sub">
          {wt.prunable ? (
            <span className="muted">folder missing</span>
          ) : (
            <>
              {wt.dirty > 0 && <span className="c-amber" title={`${plural(wt.dirty, "uncommitted change")}`}>+{wt.dirty}</span>}
              {(wt.ahead > 0 || wt.behind > 0) && (
                <span className="rr-ab" title={`${wt.ahead} ahead of, ${wt.behind} behind ${base}`}>
                  {wt.ahead > 0 && <span><ArrowUp size={10} />{wt.ahead}</span>}
                  {wt.behind > 0 && <span><ArrowDown size={10} />{wt.behind}</span>}
                </span>
              )}
              {wt.merged && <span className="tag tag-merged">merged</span>}
              {!wt.upstream && wt.ahead > 0 && <span className="tag tag-amber" title="This branch was never pushed">not pushed</span>}
              {(wt.behindUpstream ?? 0) > 0 && (
                <span className="rr-ab" title={`${plural(wt.behindUpstream!, "commit")} on ${wt.upstream} not here, as of the last fetch`}>
                  <span><ArrowDown size={10} />{wt.behindUpstream}</span> <span className="rr-ab-label">behind origin</span>
                </span>
              )}
              {wt.locked && <Lock size={11} className="muted" aria-label="Locked" />}
              {wt.procs.length > 0 && (
                <span className="mark c-blue" title={`Running: ${wt.procs.map((p) => p.name).join(", ")}`}>
                  <SquareTerminal size={12} /> {wt.procs.length}
                </span>
              )}
              <span className="muted" title={new Date(lw.lastActivity).toLocaleString()}>{relTime(lw.lastActivity)}</span>
            </>
          )}
          <span className="rr-marks">
            {pr && (
              <button
                type="button"
                className={`pr-chip pr-${prState(pr)}`}
                title={`${PR_LABEL[prState(pr)]}: ${pr.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  act(api.openUrl(pr.url));
                }}
              >
                <PrIcon pr={pr} size={11} /> #{pr.number}
              </button>
            )}
            <SessionDots sessions={sessions} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** What a branch row needs from its repo: the GitHub slug (links), the remote the remote side refers to, the base. */
interface BrCtx {
  root: string; // the repo's main checkout (Fetch)
  slug: string | null;
  remote: string | null;
  base: string;
}

const STALE_HINT =
  "Local branches that are merged, whose remote branch is gone, or whose PR merged with no commits since: safe to delete after a look";

/** The branch's name on GitHub when it is there: its remote-tracking branch on the GitHub remote, without "<remote>/". */
function ghBranch(b: Branch, ctx: BrCtx): string | null {
  const { remote, slug } = ctx;
  if (slug && newOnGitHub(b)) return b.name;
  if (b.onGitHub === false) return null;
  if (!slug || !remote || !b.remoteRef || b.upstreamGone || !b.remoteRef.startsWith(`${remote}/`)) return null;
  return b.remoteRef.slice(remote.length + 1);
}
const refPath = (name: string) => name.split("/").map(encodeURIComponent).join("/");
const treeUrl = (slug: string, name: string) => `https://github.com/${slug}/tree/${refPath(name)}`;
const compareUrl = (slug: string, base: string, name: string) => `https://github.com/${slug}/compare/${refPath(base)}...${refPath(name)}`;

/** Where a branch exists, for the row's presence icons. */
function whereLabel(b: Branch, remote: string | null): string {
  const onRemote = b.remoteRef && !b.upstreamGone;
  if (b.local && onRemote) return `Local branch, tracking ${b.remoteRef}`;
  if (b.local) return b.upstreamGone ? "Local branch; its remote branch was deleted" : `Local branch only, not on ${remote ?? "a remote"}`;
  if (!b.remoteRef) return newOnGitHub(b) ? `Only on GitHub, not fetched yet: no ${remote ?? "origin"}/${b.name} here` : "Not found";
  return `Only on ${b.remoteRef}, no local branch`;
}

/** The row's cloud icon tooltip, after whereLabel: what GitHub has that the local copy doesn't. */
function githubLabel(b: Branch): string {
  if (newOnGitHub(b)) return "";
  if (deletedOnGitHub(b)) return `. Deleted on GitHub since the last fetch; Fetch removes ${b.remoteRef}`;
  if (newerOnGitHub(b))
    return `. Not fetched yet: GitHub has ${b.githubNew != null ? plural(b.githubNew, "new commit") : "newer commits"} on it that ${b.remoteRef ?? "the local copy"} doesn’t`;
  return "";
}

function BranchRow({ lb, ctx, hc }: { lb: LinkedBranch; ctx: BrCtx; hc: HC }) {
  const act = useAct();
  const { b, pr, worktree, stale } = lb;
  const key = `br:${b.name}`;
  const isBase = b.name === ctx.base;
  const gh = ghBranch(b, ctx);
  const url = gh && ctx.slug ? treeUrl(ctx.slug, gh) : null;
  const folder = b.checkedOut;
  const onClick = url ? () => act(api.openUrl(url)) : folder ? () => act(api.revealPath(folder)) : undefined;
  const up = b.unpushed ?? 0;
  const down = b.unpulled ?? 0;
  const remote = ctx.remote ?? "origin";
  return (
    <div
      className={`repo-row br-row ${stale ? "is-done" : ""} ${onClick ? "" : "is-static"} ${hc.open?.key === key ? "is-hovered" : ""}`}
      role={url ? "link" : onClick ? "button" : undefined}
      onClick={onClick}
      {...hc.row(key)}
    >
      <GitBranch size={14} className={`ri-icon ${isBase ? "c-accent" : "muted"}`} />
      <div className="rr-main">
        <div className="rr-title br-name">
          <span className="br-name-text" title={b.name}>{b.name}</span>
          {isBase && <span className="tag tag-base" title="The base branch: ahead, behind and merged compare with it">base</span>}
          <span className="br-end">
              {pr && (
                <button
                  type="button"
                  className={`pr-chip pr-${prState(pr)}`}
                  title={`${PR_LABEL[prState(pr)]}: ${pr.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    act(api.openUrl(pr.url));
                  }}
                >
                  <PrIcon pr={pr} size={11} /> #{pr.number}
                </button>
              )}
            <span className="br-when" title={`Last commit ${new Date(b.committedAt).toLocaleString()}`}>{relTime(b.committedAt)}</span>
          </span>
        </div>
        <div className="rr-sub">
          <span className="br-where" title={whereLabel(b, ctx.remote) + githubLabel(b)}>
            {b.local && <Laptop size={12} />}
            {((b.remoteRef && !b.upstreamGone) || newOnGitHub(b)) && (
              <span className={`br-cloud ${newerOnGitHub(b) ? "has-news" : ""} ${newOnGitHub(b) ? "is-unfetched" : ""}`}>
                <Cloud size={12} />
              </span>
            )}
          </span>
          {newOnGitHub(b) && (
            <span className="tag tag-amber" title={`Created on GitHub since the last fetch: no ${remote}/${b.name} here yet. Fetch brings it in.`}>
              new on GitHub
            </span>
          )}
          {deletedOnGitHub(b) && (
            <span className="tag tag-red" title={`Deleted on GitHub since the last fetch; ${b.remoteRef} is still here until a fetch prunes it`}>
              deleted on GitHub
            </span>
          )}
          {up > 0 && (
            <span className="rr-ab c-amber" title={`${plural(up, "commit")} not pushed to ${b.remoteRef}`}>
              <span><ArrowUp size={10} />{up}</span> <span className="rr-ab-label">not pushed</span>
            </span>
          )}
          {down > 0 && (
            <span className="rr-ab" title={`${plural(down, "commit")} on ${b.remoteRef} not in the local branch, as of the last fetch`}>
              <span><ArrowDown size={10} />{down}</span> <span className="rr-ab-label">behind {remote}</span>
            </span>
          )}
          {b.upstreamGone && (
            <span className="tag tag-red" title={`Deleted on GitHub${pr?.state === "merged" ? ` after #${pr.number} merged` : ""}; the local branch is still here`}>
              gone
            </span>
          )}
          {b.local && !b.remoteRef && !b.upstreamGone && ctx.remote && !newOnGitHub(b) && (
            <span className="tag tag-amber" title={`Never pushed to ${ctx.remote}`}>not pushed</span>
          )}
          <CiMark b={b} slug={ctx.slug} />
          {!isBase && (b.ahead > 0 || b.behind > 0) && (
            <span className="rr-ab rr-ab-base" title={`${b.ahead} ahead of, ${b.behind} behind ${ctx.base}`}>
              {b.ahead > 0 && <span><ArrowUp size={10} />{b.ahead}</span>}
              {b.behind > 0 && <span><ArrowDown size={10} />{b.behind}</span>}
            </span>
          )}
          {b.merged && <span className="tag tag-merged" title={`All its commits are on ${ctx.base}`}>merged</span>}
          {folder && (
            <button
              type="button"
              className="wt-chip"
              title={`Checked out in ${worktree?.isMain ? "the main checkout" : "the worktree"} ${folder}. Click to reveal.`}
              onClick={(e) => {
                e.stopPropagation();
                act(api.revealPath(folder));
              }}
            >
              {worktree?.isMain ? <Laptop size={11} /> : <FolderGit2 size={11} />}
              {/* A worktree named after its branch shows as the icon alone. */}
              {(worktree?.isMain || (worktree?.name ?? baseName(folder)) !== b.name) && (
                <span className="wt-chip-text">{worktree?.isMain ? "main checkout" : (worktree?.name ?? baseName(folder))}</span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── hover cards ──

function CardFor({
  k, linked, gh, root, multi, ctx, rect, hc,
}: { k: string; linked: LinkedRepo; gh: GitHubInfo | null; root: string; multi: boolean; ctx: BrCtx; rect: DOMRect; hc: HC }) {
  let body: ReactNode = null;
  if (k.startsWith("pr:") && gh) {
    const n = Number(k.slice(3));
    const pr = gh.pulls.find((p) => p.number === n) ?? gh.recentPulls.find((p) => p.number === n);
    if (pr) {
      const wt = linked.pulls.find((x) => x.pr.number === n)?.worktree ?? linked.worktrees.find((w) => w.root === root && w.pr?.number === n) ?? null;
      body = <PrCard pr={pr} gh={gh} wt={wt} />;
    }
  } else if (k.startsWith("is:") && gh) {
    const li = linked.issues.find((x) => x.issue.number === Number(k.slice(3)));
    if (li) body = <IssueCard issue={li.issue} gh={gh} />;
  } else if (k.startsWith("wt:")) {
    const lw = [...linked.rows, ...linked.idle].find((w) => w.wt.path === k.slice(3));
    if (lw) body = <WorktreeCard lw={lw} multi={multi} />;
  } else if (k.startsWith("br:")) {
    const { active, remoteOnly, stale } = linked.branches;
    const lb = [...active, ...remoteOnly, ...stale].find((x) => x.b.name === k.slice(3));
    if (lb) body = <BranchCard lb={lb} ctx={ctx} />;
  }
  if (!body) return null;
  return (
    <HoverCard rect={rect} onEnter={hc.keep} onLeave={hc.hideSoon}>
      {body}
    </HoverCard>
  );
}

function PrCard({ pr, gh, wt }: { pr: PullRequest; gh: GitHubInfo; wt: LinkedWorktree | null }) {
  const act = useAct();
  const st = prState(pr);
  const issueUrl = (n: number) => `${gh.url}/issues/${n}`;
  const text = excerpt(pr.body);
  return (
    <div className="hc">
      <div className="hc-top">
        <span className={`pill pill-${st}`}>
          <PrIcon pr={pr} size={12} plain /> {PR_LABEL[st]}
        </span>
        <button type="button" className="hc-repo" onClick={() => act(api.openUrl(gh.url))}>{gh.repo}</button>
        <span className="hc-num">#{pr.number}</span>
        <When ms={pr.updatedAt} prefix="updated" />
      </div>
      <button type="button" className="hc-title" onClick={() => act(api.openUrl(pr.url))}>{pr.title}</button>
      <div className="hc-meta">
        <strong>{pr.author}</strong>{" "}
        {pr.state === "merged" ? `· ${plural(pr.commits, "commit")} merged` : pr.state === "closed" ? "wanted to merge" : "wants to merge"}
        {pr.state !== "merged" && ` ${plural(pr.commits, "commit")}`} into <code>{pr.baseRef}</code> from <code>{pr.headRef}</code>
      </div>
      <div className="hc-meta">
        opened <When ms={pr.createdAt} /> · <span className="c-green">+{pr.additions.toLocaleString()}</span>{" "}
        <span className="c-red">−{pr.deletions.toLocaleString()}</span> <DiffBar a={pr.additions} d={pr.deletions} /> · {plural(pr.changedFiles, "file")} ·{" "}
        {plural(pr.comments, "comment")}
      </div>

      <div className="hc-grid">
        <span className="hc-k">Merge</span>
        <span>
          <MergeLine pr={pr} />
        </span>

        {pr.state === "open" && (pr.review || pr.reviewers.length > 0) && (
          <>
            <span className="hc-k">Review</span>
            <span className="hc-v">
              {pr.review && <span className={`hc-review rv-${pr.review}`}>{REVIEW_LABEL[pr.review]}</span>}
              {pr.reviewers.map((r) => (
                <ReviewerChip key={r.login} r={r} />
              ))}
            </span>
          </>
        )}

        {pr.checks.length > 0 && (
          <>
            <span className="hc-k">Checks</span>
            <span className="hc-v hc-col">
              <span>{checksSummary(pr.checks)}</span>
              <ChecksList checks={pr.checks} />
            </span>
          </>
        )}

        {pr.labels.length > 0 && (
          <>
            <span className="hc-k">Labels</span>
            <span className="hc-v">
              {pr.labels.map((l) => (
                <LabelChip key={l.name} l={l} />
              ))}
            </span>
          </>
        )}

        {pr.closingIssues.length > 0 && (
          <>
            <span className="hc-k">Closes</span>
            <span className="hc-v">
              {pr.closingIssues.map((n) => {
                const is = gh.issues.find((i) => i.number === n);
                return (
                  <button key={n} type="button" className="hc-link" title={is?.title} onClick={() => act(api.openUrl(is?.url ?? issueUrl(n)))}>
                    <CircleDot size={11} className="c-green" /> #{n}
                    {is && pr.closingIssues.length === 1 && <span className="hc-ellipsis"> {is.title}</span>}
                  </button>
                );
              })}
            </span>
          </>
        )}
      </div>

      {text && <p className="hc-body"><span>{text}</span></p>}

      {wt && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            <FolderGit2 size={12} /> Worktree <strong>{wt.name}</strong>
            <span className="muted">
              {[wt.wt.dirty > 0 && plural(wt.wt.dirty, "uncommitted change"), wt.wt.unpushed ? `${wt.wt.unpushed} not pushed` : null, wt.wt.procs.length > 0 && `${wt.wt.procs.length} running`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <SessionList sessions={wt.sessions} />
        </div>
      )}

      <div className="hc-actions">
        <button type="button" className="btn btn-small" onClick={() => act(api.openUrl(pr.url))}>
          <ExternalLink size={12} /> Open on GitHub
        </button>
        {pr.state === "open" && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => act(api.openUrl(`${pr.url}/files`))}>
            <FileDiff size={12} /> Files
          </button>
        )}
        {wt && !wt.wt.prunable && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => act(api.revealPath(wt.wt.path))}>
            <FolderOpen size={12} /> Reveal worktree
          </button>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue, gh }: { issue: Issue; gh: GitHubInfo }) {
  const act = useAct();
  const text = excerpt(issue.body);
  const prs = issue.linkedPulls.length
    ? issue.linkedPulls
    : gh.pulls.filter((p) => p.closingIssues.includes(issue.number)).map((p) => p.number);
  const sub = issue.subIssues;
  return (
    <div className="hc">
      <div className="hc-top">
        <span className="pill pill-open">
          <CircleDot size={12} /> Open
        </span>
        <button type="button" className="hc-repo" onClick={() => act(api.openUrl(gh.url))}>{gh.repo}</button>
        <span className="hc-num">#{issue.number}</span>
        <When ms={issue.updatedAt} prefix="updated" />
      </div>
      <button type="button" className="hc-title" onClick={() => act(api.openUrl(issue.url))}>{issue.title}</button>
      <div className="hc-meta">
        <strong>{issue.author}</strong> opened <When ms={issue.createdAt} /> · {plural(issue.comments, "comment")}
      </div>

      <div className="hc-grid">
        {issue.issueType && (
          <>
            <span className="hc-k">Type</span>
            <span>{issue.issueType}</span>
          </>
        )}
        {issue.milestone && (
          <>
            <span className="hc-k">Milestone</span>
            <span>{issue.milestone}</span>
          </>
        )}
        {issue.labels.length > 0 && (
          <>
            <span className="hc-k">Labels</span>
            <span className="hc-v">
              {issue.labels.map((l) => (
                <LabelChip key={l.name} l={l} />
              ))}
            </span>
          </>
        )}
        <span className="hc-k">Assignees</span>
        <span className={issue.assignees.length ? "" : "muted"}>{issue.assignees.length ? issue.assignees.join(", ") : "No one"}</span>
        {sub && sub.total > 0 && (
          <>
            <span className="hc-k">Sub-issues</span>
            <span className="hc-progress">
              <span className="hc-bar">
                <span style={{ width: `${(100 * sub.completed) / sub.total}%` }} />
              </span>
              {sub.completed} of {sub.total} done
            </span>
          </>
        )}
        {prs.length > 0 && (
          <>
            <span className="hc-k">Fixed by</span>
            <span className="hc-v hc-col">
              {prs.map((n) => {
                const pr = gh.pulls.find((p) => p.number === n) ?? gh.recentPulls.find((p) => p.number === n);
                return (
                  <button key={n} type="button" className="hc-link" onClick={() => act(api.openUrl(pr?.url ?? `${gh.url}/pull/${n}`))}>
                    {pr ? <PrIcon pr={pr} size={12} /> : <GitPullRequest size={12} />} #{n}
                    {pr && <span className="hc-ellipsis"> {pr.title}</span>}
                    {pr && <span className={`hc-state c-${PR_COLOR[prState(pr)]}`}>{PR_LABEL[prState(pr)]}</span>}
                  </button>
                );
              })}
            </span>
          </>
        )}
      </div>

      {text && <p className="hc-body"><span>{text}</span></p>}

      <div className="hc-actions">
        <button type="button" className="btn btn-small" onClick={() => act(api.openUrl(issue.url))}>
          <ExternalLink size={12} /> Open on GitHub
        </button>
      </div>
    </div>
  );
}

function WorktreeCard({ lw, multi }: { lw: LinkedWorktree; multi: boolean }) {
  const act = useAct();
  const toast = useStore((s) => s.toast);
  const { wt, pr, base, isMain } = lw;
  const behindUp = wt.behindUpstream ?? 0;
  const o = useStore((s) => s.repos[lw.root]?.data);
  const ob = branchOf(o, wt.branch);
  // The main checkout keeps many idle sessions: the card lists the most recent ones.
  const sessions = isMain ? lw.sessions.slice(0, 5) : lw.sessions;
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(`Copied the ${what}`),
      (e) => toast(String(e), undefined, "error"),
    );
  return (
    <div className="hc">
      <div className="hc-top">
        {isMain ? (
          <span className="pill pill-wt">
            <Laptop size={12} /> Main checkout
          </span>
        ) : (
          <span className="pill pill-wt">
            <FolderGit2 size={12} /> Worktree
          </span>
        )}
        {wt.merged && <span className="pill pill-merged">Merged</span>}
        {wt.locked && (
          <span className="pill pill-muted">
            <Lock size={11} /> Locked
          </span>
        )}
        {wt.prunable && <span className="pill pill-closed">Folder missing</span>}
        {multi && lw.repo && (
          <span className="hc-repo is-plain" title={lw.repo.root}>
            {lw.repo.name}
          </span>
        )}
        <When ms={lw.lastActivity} prefix="active" />
      </div>
      <div className="hc-title is-static">{lw.name}</div>
      <button type="button" className="hc-path" title="Reveal in Finder" onClick={() => act(api.revealPath(wt.path))}>
        {shortPath(wt.path)}
      </button>

      <div className="hc-grid">
        <span className="hc-k">Branch</span>
        <span className="hc-v">
          {wt.branch ? <code>{wt.branch}</code> : <span className="muted">detached at {wt.head}</span>}
          {wt.branch &&
            (wt.upstream ? (
              <>
                → <code>{wt.upstream}</code>
                {wt.unpushed ? <span className="c-amber">{wt.unpushed} unpushed</span> : <span className="muted">pushed</span>}
                {behindUp > 0 && (
                  <span title="As of the last fetch: Fetch updates the remote-tracking branches">
                    {behindUp} behind origin <span className="muted">(as of the last fetch)</span>
                  </span>
                )}
              </>
            ) : (
              <NoTrackingBranch b={ob} />
            ))}
        </span>
        {!(isMain && wt.branch === base) && (
          <>
            <span className="hc-k">vs {base}</span>
            <span>
              {wt.ahead === 0 && wt.behind === 0
                ? "Up to date"
                : [wt.ahead > 0 && `${wt.ahead} ahead`, wt.behind > 0 && `${wt.behind} behind`].filter(Boolean).join(", ")}
              {wt.merged && <span className="muted"> · all commits are on {base}</span>}
            </span>
          </>
        )}
        <span className="hc-k">HEAD</span>
        <span className="hc-v hc-nowrap">
          <code>{wt.head}</code> <span className="hc-ellipsis">{wt.subject}</span> <When ms={wt.committedAt} />
        </span>
        {ob?.ci && <CommitChecksRows ci={ob.ci} head={wt.head} name={ob.name} slug={o?.github?.repo ?? null} />}
        {pr && (
          <>
            <span className="hc-k">PR</span>
            <button type="button" className="hc-link" onClick={() => act(api.openUrl(pr.url))}>
              <PrIcon pr={pr} size={12} /> #{pr.number} <span className="hc-ellipsis">{pr.title}</span>
              <span className={`hc-state c-${PR_COLOR[prState(pr)]}`}>{PR_LABEL[prState(pr)]}</span>
              {pr.state === "open" && pr.checksState && <CheckMark state={pr.checksState} title={checksSummary(pr.checks)} />}
            </button>
          </>
        )}
      </div>

      {wt.commitsAhead.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            Commits not on {base} <span className="count">{wt.ahead}</span>
          </div>
          <ul className="hc-commits">
            {wt.commitsAhead.slice(0, 10).map((c) => (
              <li key={c.hash}>
                <code>{c.hash}</code> <span className="hc-ellipsis">{c.subject}</span>
                <span className="muted" title={new Date(c.at).toLocaleString()}>{relTime(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(wt.unpushed ?? 0) > 0 && wt.commitsUnpushed.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            Not pushed to {wt.upstream} <span className="count c-amber">{wt.unpushed}</span>
          </div>
          <ul className="hc-commits">
            {wt.commitsUnpushed.slice(0, 10).map((c) => (
              <li key={c.hash}>
                <code>{c.hash}</code> <span className="hc-ellipsis">{c.subject}</span>
                <span className="muted" title={new Date(c.at).toLocaleString()}>{relTime(c.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {wt.dirty > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            Uncommitted changes <span className="count">{wt.dirty}</span>
          </div>
          <pre className="hc-changes">
            {wt.changes.slice(0, 10).join("\n")}
            {wt.dirty > 10 && `\n+${wt.dirty - 10} more`}
          </pre>
        </div>
      )}

      {wt.procs.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            <SquareTerminal size={12} className="c-blue" /> Still running here <span className="count">{wt.procs.length}</span>
          </div>
          <ul className="hc-procs">
            {wt.procs.map((p) => (
              <li key={p.pid} title={`pid ${p.pid}: ${p.cmd}`}>
                <strong>{p.name}</strong> <code className="hc-ellipsis">{p.cmd}</code>
              </li>
            ))}
          </ul>
          {!isMain && <div className="hc-hint">Stop these before removing the worktree.</div>}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            {isMain && lw.sessions.length > sessions.length ? "Latest Claude sessions" : "Claude sessions"}{" "}
            <span className="count">{lw.sessions.length}</span>
          </div>
          <SessionList sessions={sessions} />
        </div>
      )}

      {isMain && o?.remote && <FetchedLine o={o} branch={wt.branch} />}

      <div className="hc-actions">
        {!wt.prunable && (
          <button type="button" className="btn btn-small" onClick={() => act(api.revealPath(wt.path))}>
            <FolderOpen size={12} /> Reveal in Finder
          </button>
        )}
        {isMain && <FetchButton root={lw.root} />}
        <button type="button" className="btn btn-small btn-ghost" onClick={() => copy(wt.path, "path")}>
          <Copy size={12} /> Path
        </button>
        {wt.branch && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => copy(wt.branch!, "branch name")}>
            <Copy size={12} /> Branch
          </button>
        )}
      </div>
    </div>
  );
}

/** The main checkout card's "Last fetched" line, with what GitHub has that the clone hasn't fetched. Amber when the
 *  last fetch is over a week old and GitHub has news. */
function FetchedLine({ o, branch }: { o: RepoOverview; branch: string | null }) {
  const news = remoteNews(o);
  const at = o.fetchedAt;
  const old = !at || Date.now() - at > 7 * 864e5;
  const b = branchOf(o, branch);
  const parts = [
    newerOnGitHub(b) && b && (b.githubNew != null ? `${b.githubNew} new on ${b.name}` : `${b.name} moved`),
    news.newer.length - (newerOnGitHub(b) ? 1 : 0) > 0 && plural(news.newer.length - (newerOnGitHub(b) ? 1 : 0), "branch") + " moved",
    news.created.length > 0 && plural(news.created.length, "new branch"),
    news.deleted.length > 0 && `${news.deleted.length} deleted`,
  ].filter(Boolean);
  return (
    <div className={`hc-fetched ${old && news.any ? "c-amber" : "muted"}`} title={at ? new Date(at).toLocaleString() : undefined}>
      <CloudDownload size={12} /> {at ? `Last fetched ${relTime(at)}` : "Never fetched"}
      {parts.length > 0 && <> · GitHub has {parts.join(", ")}</>}
    </div>
  );
}

function BranchCard({ lb, ctx }: { lb: LinkedBranch; ctx: BrCtx }) {
  const act = useAct();
  const toast = useStore((s) => s.toast);
  const { b, pr, worktree, stale } = lb;
  const isBase = b.name === ctx.base;
  const gh = ghBranch(b, ctx);
  const slug = ctx.slug;
  const up = b.unpushed ?? 0;
  const down = b.unpulled ?? 0;
  const remoteLabel = slug ? "GitHub" : (ctx.remote ?? "a remote");
  const sessions = worktree ? (worktree.isMain ? worktree.sessions.slice(0, 5) : worktree.sessions) : [];
  const copy = () =>
    void navigator.clipboard.writeText(b.name).then(
      () => toast("Copied the branch name"),
      (e) => toast(String(e), undefined, "error"),
    );
  return (
    <div className="hc">
      <div className="hc-top">
        <span className="pill pill-wt">
          <GitBranch size={12} /> {isBase ? "Base branch" : "Branch"}
        </span>
        {b.merged && <span className="pill pill-merged">Merged</span>}
        {b.upstreamGone && <span className="pill pill-closed">Deleted on GitHub</span>}
        {deletedOnGitHub(b) && <span className="pill pill-closed">Deleted on GitHub</span>}
        {newOnGitHub(b) && <span className="pill pill-muted">Not fetched</span>}
        {stale && !b.merged && !b.upstreamGone && <span className="pill pill-muted">Stale</span>}
      </div>
      <div className="hc-title is-static br-card-name">{b.name}</div>
      <div className="hc-meta">
        <strong>{b.author}</strong> committed <When ms={b.committedAt} />
      </div>

      <div className="hc-grid">
        <span className="hc-k">{b.local ? "Local" : "Tip"}</span>
        <span className="hc-v hc-nowrap">
          <code>{b.head}</code> <span className="hc-ellipsis">{b.subject}</span>
        </span>

        <span className="hc-k">{slug ? "GitHub" : "Remote"}</span>
        <span className="hc-v">
          {newOnGitHub(b) ? (
            <span className="c-amber">New on GitHub, not fetched yet: no {ctx.remote ?? "origin"}/{b.name} here</span>
          ) : deletedOnGitHub(b) ? (
            <>
              <code>{b.remoteRef}</code>
              <span className="c-red">deleted on GitHub</span>
              <span className="muted">since the last fetch; Fetch removes the local copy</span>
            </>
          ) : b.upstreamGone ? (
            <span className="c-red">Deleted on GitHub{pr?.state === "merged" ? ` after #${pr.number} merged` : ""}</span>
          ) : b.remoteRef ? (
            <>
              <code>{b.remoteRef}</code>
              {b.local &&
                (up > 0 ? <span className="c-amber">{up} not pushed</span> : down === 0 && <span className="muted">in sync</span>)}
              {down > 0 && (
                <span title="As of the last fetch: Fetch updates the remote-tracking branches">
                  {down} behind <span className="muted">(as of the last fetch)</span>
                </span>
              )}
              {!b.local && <span className="muted">no local branch</span>}
              {newerOnGitHub(b) ? (
                <span className="c-amber" title={`GitHub’s ${b.name} has commits that ${b.remoteRef} here doesn’t: Fetch brings them in`}>
                  GitHub has {b.githubNew != null ? plural(b.githubNew, "new commit") : "newer commits"}, not fetched
                </span>
              ) : (
                b.onGitHub && <span className="muted">same as on GitHub</span>
              )}
            </>
          ) : (
            <span className={ctx.remote ? "c-amber" : "muted"}>Not on {remoteLabel}</span>
          )}
        </span>

        {b.ci && <CommitChecksRows ci={b.ci} head={b.head} name={b.name} slug={slug} />}

        {!isBase && (
          <>
            <span className="hc-k">vs {ctx.base}</span>
            <span>
              {b.ahead === 0 && b.behind === 0
                ? "Up to date"
                : [b.ahead > 0 && `${b.ahead} ahead`, b.behind > 0 && `${b.behind} behind`].filter(Boolean).join(", ")}
              {b.merged && <span className="muted"> · all commits are on {ctx.base}</span>}
            </span>
          </>
        )}

        {b.checkedOut && (
          <>
            <span className="hc-k">Checked out</span>
            <button type="button" className="hc-link" title={`Reveal ${b.checkedOut} in Finder`} onClick={() => act(api.revealPath(b.checkedOut!))}>
              {worktree?.isMain ? <Laptop size={12} /> : <FolderGit2 size={12} />}
              <span className="br-nowrap">{worktree?.isMain ? "Main checkout" : (worktree?.name ?? baseName(b.checkedOut))}</span>
              <span className="hc-ellipsis muted">{shortPath(b.checkedOut)}</span>
            </button>
          </>
        )}

        {pr && (
          <>
            <span className="hc-k">PR</span>
            <button type="button" className="hc-link" onClick={() => act(api.openUrl(pr.url))}>
              <PrIcon pr={pr} size={12} /> #{pr.number} <span className="hc-ellipsis">{pr.title}</span>
              <span className={`hc-state c-${PR_COLOR[prState(pr)]}`}>{PR_LABEL[prState(pr)]}</span>
              {pr.state === "open" && pr.checksState && <CheckMark state={pr.checksState} title={checksSummary(pr.checks)} />}
            </button>
          </>
        )}
      </div>

      {stale && <div className="hc-hint">{STALE_HINT}.</div>}

      {worktree && sessions.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            {worktree.isMain && worktree.sessions.length > sessions.length ? "Latest Claude sessions" : "Claude sessions"}{" "}
            <span className="count">{worktree.sessions.length}</span>
          </div>
          <SessionList sessions={sessions} />
        </div>
      )}

      <div className="hc-actions">
        <button type="button" className="btn btn-small" onClick={copy}>
          <Copy size={12} /> Copy name
        </button>
        {ctx.root && b.onGitHub !== null && <FetchButton root={ctx.root} />}
        {ctx.root && <PushButton root={ctx.root} b={b} />}
        {gh && slug && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => act(api.openUrl(treeUrl(slug, gh)))}>
            <ExternalLink size={12} /> Open on GitHub
          </button>
        )}
        {gh && slug && !isBase && !b.merged && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => act(api.openUrl(compareUrl(slug, ctx.base, gh)))}>
            <GitCompare size={12} /> Compare
          </button>
        )}
      </div>
    </div>
  );
}

function SessionList({ sessions }: { sessions: Session[] }) {
  const m = useModel();
  const act = useAct();
  if (sessions.length === 0) return <div className="hc-hint">No Claude sessions in it</div>;
  return (
    <div className="hc-sessions">
      {sessions.slice(0, 6).map((s) => {
        const task = s.taskId != null ? m.task.get(s.taskId) : undefined;
        return (
          <button key={s.id} type="button" className="hc-session" title="Open in Claude" onClick={() => act(api.openSession(s.id))}>
            <StatusDot status={s.status} />
            <span className="hc-session-main">
              <span className="hc-ellipsis hc-session-title">{s.title || "Untitled session"}</span>
              {task && <span className="hc-ellipsis muted">› {task.title}</span>}
            </span>
            <span className={`sr-status sr-status-${s.status}`}>{STATUS_LABEL[s.status]}</span>
            <span className="muted" title={new Date(s.lastActivityAt).toLocaleString()}>{relTime(s.lastActivityAt)}</span>
          </button>
        );
      })}
      {sessions.length > 6 && <div className="hc-hint">+{sessions.length - 6} more</div>}
    </div>
  );
}

// ── bits ──

type PrSt = "open" | "draft" | "merged" | "closed";
const prState = (pr: PullRequest): PrSt => (pr.state === "open" ? (pr.isDraft ? "draft" : "open") : pr.state);
const PR_LABEL: Record<PrSt, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const PR_COLOR: Record<PrSt, string> = { open: "green", draft: "muted", merged: "purple", closed: "red" };
const REVIEW_LABEL = { approved: "Approved", changes_requested: "Changes requested", review_required: "Review required" } as const;

function PrIcon({ pr, size = 14, plain }: { pr: PullRequest; size?: number; plain?: boolean }) {
  const st = prState(pr);
  const Icon = st === "merged" ? GitMerge : st === "closed" ? GitPullRequestClosed : st === "draft" ? GitPullRequestDraft : GitPullRequest;
  return <Icon size={size} className={plain ? "" : `ri-icon c-${PR_COLOR[st]}`} aria-label={PR_LABEL[st]} />;
}

function CheckMark({ state, title }: { state: CheckState; title?: string }) {
  const t = title ?? CHECK_LABEL[state];
  return (
    <span className="mark" title={t}>
      {state === "success" ? <Check size={12} className="c-green" /> : state === "failure" ? <X size={12} className="c-red" /> : state === "pending" ? <span className="check-pending" /> : <Minus size={12} className="muted" />}
    </span>
  );
}
const CHECK_LABEL: Record<CheckState, string> = { success: "Passed", failure: "Failed", pending: "Pending", neutral: "Skipped" };

/** A hover card's list of checks: the first six, failing first. */
function ChecksList({ checks }: { checks: PrCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <span className="hc-checks">
      {checks.slice(0, 6).map((c, i) => (
        <span key={`${i}:${c.name}`} className="hc-check">
          <CheckMark state={c.state} /> <span className="hc-ellipsis">{c.name}</span>
        </span>
      ))}
      {checks.length > 6 && <span className="muted">+{checks.length - 6} more</span>}
    </span>
  );
}

const checksUrl = (slug: string, oid: string) => `https://github.com/${slug}/commit/${oid}/checks`;

/** What failed or still runs, e.g. "deploy failed", "2 checks failed", "checks running". */
function ciLabel(ci: CommitChecks): string {
  if (ci.state === "pending") return "checks running";
  const failed = ci.checks.filter((c) => c.state === "failure");
  return failed.length === 1 ? `${failed[0].name} failed` : failed.length > 1 ? `${failed.length} checks failed` : "checks failed";
}

/** GitHub's checks on a branch's tip there, on a card: a red ✗ when they failed, an amber dot while they run, nothing
 *  once they pass. Opens the commit's checks on GitHub. */
function CiMark({ b, slug }: { b: Branch | null; slug: string | null }) {
  const act = useAct();
  const ci = b?.ci;
  if (!b || !ci || ci.state === "success" || ci.state === "neutral") return null;
  const failed = ci.state === "failure";
  const title = `${failed ? "Checks failed" : "Checks running"} on GitHub’s ${b.name} (${ci.oid.slice(0, 7)}): ${checksSummary(ci.checks)}${slug ? ". Click to open them on GitHub" : ""}`;
  const body = (
    <>
      {failed ? <X size={11} /> : <span className="check-pending" />}
      <span className="rr-ab-label">{ciLabel(ci)}</span>
    </>
  );
  return slug ? (
    <button
      type="button"
      className={`rr-ab ci-mark ${failed ? "c-red" : "c-amber"}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        act(api.openUrl(checksUrl(slug, ci.oid)));
      }}
    >
      {body}
    </button>
  ) : (
    <span className={`rr-ab ci-mark ${failed ? "c-red" : "c-amber"}`} title={title}>
      {body}
    </span>
  );
}

/** A hover card's Checks rows for a branch's tip on GitHub (`head`: the local tip's short hash, to say when GitHub's
 *  differs). */
function CommitChecksRows({ ci, head, name, slug }: { ci: CommitChecks; head: string; name: string; slug: string | null }) {
  const act = useAct();
  const short = ci.oid.slice(0, 7);
  const line = (
    <>
      <CheckMark state={ci.state} /> {checksSummary(ci.checks) || CHECK_LABEL[ci.state]} on <code>{short}</code>
      {!ci.oid.startsWith(head) && <span className="muted">(GitHub’s {name}, not this commit)</span>}
    </>
  );
  return (
    <>
      <span className="hc-k">Checks</span>
      <span className="hc-v hc-col">
        {slug ? (
          <button type="button" className="hc-link" title="Open the checks on GitHub" onClick={() => act(api.openUrl(checksUrl(slug, ci.oid)))}>
            {line}
          </button>
        ) : (
          <span>{line}</span>
        )}
        <ChecksList checks={ci.checks} />
      </span>
    </>
  );
}

/** A worktree hover's remote side when the branch has no upstream configured: compared with `<remote>/<name>` when
 *  that exists (the branch list's remote side), else never pushed; just the label without the branch list. */
function NoTrackingBranch({ b }: { b: Branch | null }) {
  const up = b?.unpushed ?? 0;
  const down = b?.unpulled ?? 0;
  return (
    <>
      <span className="muted" title={b?.remoteRef ? `git branch -u ${b.remoteRef} sets it` : "No upstream configured for this branch"}>
        no tracking branch
      </span>
      {!b ? null : b.remoteRef ? (
        <>
          · <code>{b.remoteRef}</code>
          {up > 0 ? <span className="c-amber">{up} not pushed</span> : down === 0 && <span className="muted">in sync</span>}
          {down > 0 && <span>{down} behind <span className="muted">(as of the last fetch)</span></span>}
        </>
      ) : (
        <span className="c-amber">not pushed</span>
      )}
    </>
  );
}

function ReviewMark({ pr }: { pr: PullRequest }) {
  if (pr.isDraft || !pr.review) return null;
  if (pr.review === "approved")
    return (
      <span className="mark c-green" title="Approved">
        <BadgeCheck size={12} />
      </span>
    );
  if (pr.review === "changes_requested")
    return (
      <span className="mark c-red" title="Changes requested">
        <FileDiff size={12} />
      </span>
    );
  return (
    <span className="mark" title="Review required">
      <Eye size={12} />
    </span>
  );
}

function ReviewerChip({ r }: { r: Reviewer }) {
  const icon =
    r.state === "approved" ? <Check size={11} className="c-green" /> :
    r.state === "changes_requested" ? <FileDiff size={11} className="c-red" /> :
    r.state === "commented" ? <MessageSquare size={11} className="muted" /> :
    r.state === "pending" ? <span className="check-pending" /> : <Minus size={11} className="muted" />;
  const label = { approved: "approved", changes_requested: "requested changes", commented: "commented", dismissed: "review dismissed", pending: "review requested" }[r.state];
  return (
    <span className="reviewer" title={`${r.login}: ${label}`}>
      {icon} {r.login}
    </span>
  );
}

function MergeLine({ pr }: { pr: PullRequest }) {
  if (pr.state === "merged") return <span className="c-purple">Merged {pr.mergedAt ? <When ms={pr.mergedAt} /> : null}</span>;
  if (pr.state === "closed") return <span className="c-red">Closed without merging {pr.closedAt ? <When ms={pr.closedAt} /> : null}</span>;
  const auto = pr.autoMerge && (
    <span className="tag tag-green">
      <Zap size={10} /> auto-merge on
    </span>
  );
  const s = pr.mergeable === "conflicting" ? "dirty" : pr.isDraft ? "draft" : pr.mergeState;
  const [tone, text] =
    s === "dirty" ? ["red", "Has conflicts with the base branch"]
    : s === "draft" ? ["muted", "Draft, not ready for review"]
    : s === "behind" ? ["amber", "Behind the base branch, needs an update"]
    : s === "blocked" ? ["amber", pr.review === "changes_requested" ? "Blocked: changes requested" : pr.review === "review_required" ? "Blocked: needs an approving review" : pr.checksState === "failure" || pr.checksState === "pending" ? "Blocked: required checks" : "Blocked by branch rules"]
    : s === "unstable" ? ["amber", "Mergeable, but some checks fail"]
    : s === "clean" || s === "has_hooks" ? ["green", "Ready to merge"]
    : ["muted", "Merge status unknown"];
  return (
    <span className="hc-v">
      <span className={`c-${tone}`}>{text}</span>
      {auto}
    </span>
  );
}

function LabelChip({ l }: { l: Label }) {
  return (
    <span className="label-chip" style={{ "--lc": l.color } as React.CSSProperties} title={l.name}>
      {l.name}
    </span>
  );
}

function DiffBar({ a, d }: { a: number; d: number }) {
  const t = a + d;
  if (!t) return null;
  const g = Math.round((5 * a) / t);
  return (
    <span className="diff-bar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < g ? "g" : "r"} />
      ))}
    </span>
  );
}

function When({ ms, prefix }: { ms: number; prefix?: string }) {
  return (
    <span className="hc-when" title={new Date(ms).toLocaleString()}>
      {prefix ? `${prefix} ` : ""}
      {relTime(ms)}
    </span>
  );
}

const CHECKS_MAX = 20;

function checksSummary(checks: { state: CheckState }[]): string {
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  return [
    n("success") && `${n("success")} passed`,
    n("failure") && `${n("failure")} failed`,
    n("pending") && `${n("pending")} pending`,
    n("neutral") && `${n("neutral")} skipped`,
  ]
    .filter(Boolean)
    .join(", ")
    // The backend sends at most CHECKS_MAX (20) checks, failing first; the rollup covers them all.
    .concat(checks.length >= CHECKS_MAX ? ` (first ${CHECKS_MAX})` : "");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** PR/issue body as plain text: no HTML comments, images, tags or checkbox marks. */
/** A description as plain text that keeps its line breaks (one per non-empty line), so headings and
 *  list items don't run into each other. */
const excerpt = (md: string) =>
  md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[ xX]\]\s*/g, "")
    .split("\n")
    .map(plainText)
    .filter(Boolean)
    .join("\n");
