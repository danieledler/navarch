// The Repo panel at the bottom of a project: open PRs, issues and git worktrees of the project's folder, cross-linked
// with Claude sessions. Rows are read-only (click opens on GitHub, reveals in Finder, or opens a session); hovering a
// row shows a hover card with the details.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, BadgeCheck, Check, ChevronDown, ChevronRight, CircleDot, Copy, Eye, ExternalLink, FileDiff, FolderGit2, FolderOpen,
  GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Lock, MessageSquare, Minus, RefreshCw, SquareTerminal,
  TriangleAlert, X, Zap,
} from "lucide-react";
import { api, type CheckState, type GitHubInfo, type Issue, type Label, type PullRequest, type RepoOverview, type RepoRef, type Reviewer, type Session } from "../api";
import { chosenRepo, useModel, useStore } from "../store";
import { baseName, plainText, relTime, shortPath } from "../lib/format";
import { linkRepo, type LinkedIssue, type LinkedPull, type LinkedRepo, type LinkedWorktree } from "../lib/repo";
import { IconButton, Popover, STATUS_LABEL, StatusDot } from "./ui";
import { HoverCard, useHoverCard } from "./HoverCard";

const MIN_H = 120; // panel
const MIN_TOP = 160; // task tree above it
const NARROW = 760; // below this width the three columns become tabs

type Col = "pulls" | "issues" | "worktrees";

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
  const st = useStore((s) => (root ? s.repos[root] : undefined));
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
  const hc = useHoverCard();

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
    const visible = () => document.visibilityState === "visible";
    const iv = window.setInterval(() => visible() && root && void loadRepo(root), panel.open ? 30_000 : 120_000);
    const onVis = () => {
      if (!visible()) return;
      void findRepos(path);
      if (root) void loadRepo(root);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [path, root, panel.open, loadRepo, findRepos]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data != null]);

  const linked = useMemo(() => (data ? linkRepo(data, sessions) : null), [data, sessions]);

  // Loaded, and the folder neither is in a git repo nor holds one (or the chosen one is gone).
  if (list && repos.length === 0) return null;
  if (st && st.at > 0 && data === null && repos.length <= 1) return null;

  const gh = data?.github ?? null;
  const h = Math.max(MIN_H, dragH ?? panel.height);

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!open || !data || e.button !== 0) return;
    const root = rootRef.current;
    const above = root?.previousElementSibling as HTMLElement | null;
    if (!root) return;
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
    if (!panel.open && root) void loadRepo(root);
    setRepoPanel({ open: !panel.open });
  };

  const fetchedAt = gh?.fetchedAt ?? st?.at ?? 0;
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
            <span className="repo-counts">{counts.join(" · ")}</span>
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
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Refresh from git and GitHub"
            className={st?.loading ? "spin" : ""}
            onClick={() => {
              void findRepos(path);
              if (root) void loadRepo(root, true);
            }}
          />
        </span>
      </div>

      {open && linked && data && (
        <RepoBody
          linked={linked}
          gh={gh}
          githubError={data.githubError}
          base={data.base}
          narrow={narrow}
          tab={tab}
          setTab={setTab}
          showDone={showDone}
          setShowDone={setShowDone}
          hc={hc}
        />
      )}

      {open && !data && <div className="repo-body is-loading"><div className="repo-note">Loading…</div></div>}

      {open && linked && hc.open && (
        <CardFor k={hc.open.key} linked={linked} gh={gh} base={data!.base} rect={hc.open.rect} hc={hc} />
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
  linked, gh, githubError, base, narrow, tab, setTab, showDone, setShowDone, hc,
}: {
  linked: LinkedRepo; gh: GitHubInfo | null; githubError: string | null; base: string; narrow: boolean;
  tab: Col; setTab: (c: Col) => void; showDone: boolean; setShowDone: (b: boolean) => void; hc: HC;
}) {
  const ghNote = !gh && <div className="repo-note">{githubError ?? "No GitHub data"}</div>;
  const recent = gh?.recentPulls ?? [];
  const cols: { id: Col; title: string; n: number | null; body: ReactNode }[] = [
    {
      id: "pulls",
      title: "Pull requests",
      n: gh ? gh.pulls.length : null,
      body:
        ghNote || (
          <>
            {linked.pulls.length === 0 && <div className="repo-empty">No open pull requests</div>}
            {linked.pulls.map((lp) => (
              <PrRow key={lp.pr.number} lp={lp} hc={hc} />
            ))}
            {recent.length > 0 && (
              <>
                <button type="button" className="repo-sub-toggle" onClick={() => setShowDone(!showDone)}>
                  <ChevronRight size={12} className={showDone ? "rot" : ""} /> Recently merged or closed <span className="count">{recent.length}</span>
                </button>
                {showDone &&
                  recent.map((pr) => (
                    <PrRow key={pr.number} lp={{ pr, worktree: linked.worktrees.find((w) => w.pr?.number === pr.number) ?? null }} hc={hc} done />
                  ))}
              </>
            )}
          </>
        ),
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
      id: "worktrees",
      title: "Worktrees",
      n: linked.worktrees.length,
      body: (
        <>
          {linked.worktrees.length === 0 && (
            <div className="repo-empty">No worktrees besides the main checkout</div>
          )}
          {linked.worktrees.map((lw) => (
            <WorktreeRow key={lw.wt.path} lw={lw} base={base} hc={hc} />
          ))}
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
        <div className="repo-list" onScroll={hc.hide}>{c.body}</div>
      </div>
    );
  }
  return (
    <div className="repo-body">
      {cols.map((x) => (
        <div key={x.id} className="repo-col">
          <div className="repo-col-head">
            {x.title} {x.n != null && <span className="count">{x.n}</span>}
          </div>
          <div className="repo-list" onScroll={hc.hide}>{x.body}</div>
        </div>
      ))}
    </div>
  );
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

function WorktreeRow({ lw, base, hc }: { lw: LinkedWorktree; base: string; hc: HC }) {
  const act = useAct();
  const { wt, pr, sessions } = lw;
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
            {sessions.length > 0 && (
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
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── hover cards ──

function CardFor({ k, linked, gh, base, rect, hc }: { k: string; linked: LinkedRepo; gh: GitHubInfo | null; base: string; rect: DOMRect; hc: HC }) {
  let body: ReactNode = null;
  if (k.startsWith("pr:") && gh) {
    const n = Number(k.slice(3));
    const pr = gh.pulls.find((p) => p.number === n) ?? gh.recentPulls.find((p) => p.number === n);
    if (pr) {
      const wt = linked.pulls.find((x) => x.pr.number === n)?.worktree ?? linked.worktrees.find((w) => w.pr?.number === n) ?? null;
      body = <PrCard pr={pr} gh={gh} wt={wt} />;
    }
  } else if (k.startsWith("is:") && gh) {
    const li = linked.issues.find((x) => x.issue.number === Number(k.slice(3)));
    if (li) body = <IssueCard issue={li.issue} gh={gh} />;
  } else if (k.startsWith("wt:")) {
    const lw = linked.worktrees.find((w) => w.wt.path === k.slice(3));
    if (lw) body = <WorktreeCard lw={lw} base={base} />;
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
        <strong>{pr.author}</strong> wants to merge {plural(pr.commits, "commit")} into <code>{pr.baseRef}</code> from <code>{pr.headRef}</code>
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
              <span className="hc-checks">
                {pr.checks.slice(0, 6).map((c, i) => (
                  <span key={`${i}:${c.name}`} className="hc-check">
                    <CheckMark state={c.state} /> <span className="hc-ellipsis">{c.name}</span>
                  </span>
                ))}
                {pr.checks.length > 6 && <span className="muted">+{pr.checks.length - 6} more</span>}
              </span>
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

function WorktreeCard({ lw, base }: { lw: LinkedWorktree; base: string }) {
  const act = useAct();
  const toast = useStore((s) => s.toast);
  const { wt, pr } = lw;
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast(`Copied the ${what}`),
      (e) => toast(String(e), undefined, "error"),
    );
  return (
    <div className="hc">
      <div className="hc-top">
        <span className="pill pill-wt">
          <FolderGit2 size={12} /> Worktree
        </span>
        {wt.merged && <span className="pill pill-merged">Merged</span>}
        {wt.locked && (
          <span className="pill pill-muted">
            <Lock size={11} /> Locked
          </span>
        )}
        {wt.prunable && <span className="pill pill-closed">Folder missing</span>}
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
                {wt.unpushed ? <span className="c-amber">{wt.unpushed} not pushed</span> : <span className="muted">pushed</span>}
              </>
            ) : (
              <span className="c-amber">not pushed</span>
            ))}
        </span>
        <span className="hc-k">vs {base}</span>
        <span>
          {wt.ahead === 0 && wt.behind === 0
            ? "Up to date"
            : [wt.ahead > 0 && `${wt.ahead} ahead`, wt.behind > 0 && `${wt.behind} behind`].filter(Boolean).join(", ")}
          {wt.merged && <span className="muted"> · all commits are on {base}</span>}
        </span>
        <span className="hc-k">HEAD</span>
        <span className="hc-v hc-nowrap">
          <code>{wt.head}</code> <span className="hc-ellipsis">{wt.subject}</span> <When ms={wt.committedAt} />
        </span>
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
          <div className="hc-hint">Stop these before removing the worktree.</div>
        </div>
      )}

      {lw.sessions.length > 0 && (
        <div className="hc-sec">
          <div className="hc-sec-head">
            Claude sessions <span className="count">{lw.sessions.length}</span>
          </div>
          <SessionList sessions={lw.sessions} />
        </div>
      )}

      <div className="hc-actions">
        {!wt.prunable && (
          <button type="button" className="btn btn-small" onClick={() => act(api.revealPath(wt.path))}>
            <FolderOpen size={12} /> Reveal in Finder
          </button>
        )}
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
