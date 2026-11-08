import { create } from "zustand";
import { api, type Branch, type Id, type RepoGitHub, type RepoOverview, type RepoRef, type Session, type Snapshot, type SystemStats, type Usage } from "./api";
import { baseName } from "./lib/format";
import { buildModel, type Model } from "./lib/model";

export type View = { kind: "dashboard" } | { kind: "space"; spaceId: Id };

export interface Toast {
  id: number;
  text: string;
  tone?: "error";
  undo?: () => unknown;
}

/** An action ⌘Z can take back; Edit › Undo shows it as "Undo <label>". */
export interface Undoable {
  label: string;
  run: () => unknown;
}

interface UIPrefs {
  view: View;
  projectOfSpace: Record<Id, Id | undefined>;
  collapsed: Record<Id, true>;
  hideDone: boolean;
  /** Spaces whose projects are listed by latest session activity instead of their dragged order. */
  recentFirst: Record<Id, true>;
  /** The week log groups time by project instead of by task. */
  logByProject: boolean;
  /** The Repo panel at the bottom of a project: shown or folded, its height in px, whether its PR column lists open
   *  or recently merged PRs, and whether the merged list holds only the viewer's own. */
  repoPanel: RepoPanelPrefs;
  /** The repo the Repo panel shows, by project path (its root), for a folder holding several. */
  repoOfProject: Record<string, string>;
}

export interface RepoPanelPrefs {
  open: boolean;
  height: number;
  prView?: "open" | "merged"; // default open
  mine?: boolean; // default false
}

/** A repo's overview as last loaded. */
export interface RepoState {
  data: RepoOverview | null; // null: not loaded yet, or the folder isn't in a git repo
  loading: boolean; // a load with GitHub data is running
  error: string | null; // the last load failed (data stays from before)
  at: number; // ms of the last successful load, 0 before one
  ghAt: number; // ms of the last successful load with GitHub data, 0 before one (local-only loads keep its github)
}

interface State extends UIPrefs {
  ready: boolean;
  snap: Snapshot;
  sessions: Session[];
  sys: SystemStats | null;
  usage: Usage | null;
  /** A Claude Code sign-in is waiting for the browser. */
  signingIn: boolean;
  selectedTask: Id | null;
  editing: Id | null;
  toasts: Toast[];
  /** Session row to highlight briefly after it moved, so the eye can follow it. */
  flashSession: string | null;
  /** Repo overviews by repo root. */
  repos: Record<string, RepoState | undefined>;
  /** Git repos found in each project folder (`findRepos`), as last loaded. */
  repoLists: Record<string, { repos: RepoRef[]; at: number } | undefined>;
  /** Repo roots with a `git fetch` running (fetchRepo). */
  fetching: Record<string, true | undefined>;
  /** Branches with a `git push` running (pushBranch), by `pushKey(root, branch)`. */
  pushing: Record<string, true | undefined>;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  /** Run a backend mutation, reload the snapshot, and surface errors as toasts. */
  run: <T>(p: Promise<T>) => Promise<T | undefined>;
  /** A toast with `undo` also joins the undo history (⌘Z, Edit › Undo). */
  toast: (text: string, undo?: Undoable, tone?: "error") => void;
  dismiss: (id: number) => void;
  /** Undo the action behind that toast, or the newest undoable action. */
  undo: (toastId?: number) => void;
  flash: (sessionId: string) => void;
  setView: (v: View) => void;
  selectProject: (spaceId: Id, projectId: Id | undefined) => void;
  selectTask: (id: Id | null) => void;
  setEditing: (id: Id | null) => void;
  toggleCollapsed: (id: Id, open?: boolean) => void;
  setHideDone: (b: boolean) => void;
  setRecentFirst: (spaceId: Id, on: boolean) => void;
  setLogByProject: (b: boolean) => void;
  refreshUsage: (force: boolean) => Promise<void>;
  /** Opens Claude Code's sign-in in the browser; a toast says how it went. */
  signInClaude: () => Promise<void>;
  /** Load a repo's overview. A load of the same kind already running for it is left alone unless `force` (which
   *  also refetches GitHub data and toasts a failure; background loads fail silently). `github: false` reads only
   *  the local git side and keeps the GitHub data loaded before. */
  loadRepo: (path: string, force?: boolean, github?: boolean) => Promise<void>;
  /** `git fetch --prune` the repo whose main checkout is `root` (one at a time per repo), toast what it brought,
   *  then reload its overview: the local remote-tracking refs changed, the cached GitHub data didn't. */
  fetchRepo: (root: string) => Promise<void>;
  /** Push local branch `branch` of the repo whose main checkout is `root` to its upstream (fast-forward only; one
   *  at a time per branch), toast the outcome, then reload the overview. */
  pushBranch: (root: string, branch: string) => Promise<void>;
  setRepoPanel: (p: Partial<RepoPanelPrefs>) => void;
  /** Look for the git repos of a project folder. Fails silently (the old list stays); one at a time per folder. */
  findRepos: (projectPath: string) => Promise<void>;
  /** Pick which of a project folder's repos the Repo panel shows. */
  selectRepo: (projectPath: string, root: string) => void;
}

/** Key of a branch in `pushing`. */
export const pushKey = (root: string, branch: string) => `${root}\n${branch}`;

/** The repo the panel shows: the saved choice while the folder still holds it, else the first one. */
export function chosenRepo(list: RepoRef[], saved: string | undefined): RepoRef | undefined {
  return list.find((r) => r.root === saved) ?? list[0];
}

const PREFS = "navarch-ui";
const empty: Snapshot = { spaces: [], projects: [], tasks: [], periods: [], periodTasks: [], weekTasks: [] };

function loadPrefs(): UIPrefs {
  const base: UIPrefs = { view: { kind: "dashboard" }, projectOfSpace: {}, collapsed: {}, hideDone: false, recentFirst: {}, logByProject: false, repoPanel: { open: true, height: 300 }, repoOfProject: {} };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") };
  } catch {
    return base;
  }
}

let toastSeq = 0;
let started = false;
// Reloads can overlap (a phone's write and the desktop's own): only a newer one may replace the snapshot.
let reloadSeq = 0;
let appliedReload = 0;
// Repo loads in flight, by kind and path ("gh:<path>" or "local:<path>"): the newest one's number. An older one
// finishing later is dropped.
/** A git-side overview (`cached`) that arrived before gh answered, with no GitHub data cached in the backend (after a
 *  launch): keeps the GitHub data and the branches' GitHub fields already shown, rather than none until gh answers. */
function keepGitHub(d: RepoOverview, prev: RepoOverview | null): RepoOverview {
  if (d.github || !prev?.github) return d;
  const was = new Map(prev.branches.map((b) => [b.name, b]));
  const branches = d.branches.map((b): Branch => {
    const p = was.get(b.name);
    return p ? { ...b, onGitHub: p.onGitHub, newerOnGitHub: p.newerOnGitHub, githubNew: p.githubNew, ci: p.ci } : b;
  });
  return { ...d, github: prev.github, githubError: prev.githubError, branches };
}

const repoLoads = new Map<string, number>();
// The number of the newest load applied per path, so a local-only load that started before it is dropped.
const repoApplied = new Map<string, number>();
let repoSeq = 0;
// Project folders whose repo search is running.
const repoFinds = new Set<string>();

/** The repos' last overviews and the folders' repo lists, kept across launches so a project opened before draws its
 *  Repo panel at once (then refreshes, as on every visit): the `REPO_CACHE_MAX` most recently loaded repos. */
const REPO_CACHE = "navarch-repo-cache";
const REPO_CACHE_MAX = 8;
const REPO_CACHE_BYTES = 2_000_000;
interface RepoCache {
  repos: Record<string, Pick<RepoState, "data" | "at" | "ghAt">>;
  lists: Record<string, { repos: RepoRef[]; at: number } | undefined>;
}

function readRepoCache(): { repos: Record<string, RepoState | undefined>; repoLists: RepoCache["lists"] } {
  try {
    const c = JSON.parse(localStorage.getItem(REPO_CACHE) ?? "null") as RepoCache | null;
    if (!c?.repos) return { repos: {}, repoLists: {} };
    const repos = Object.fromEntries(Object.entries(c.repos).map(([k, r]) => [k, { ...r, loading: false, error: null }]));
    return { repos, repoLists: c.lists ?? {} };
  } catch {
    return { repos: {}, repoLists: {} };
  }
}

let repoCacheTimer: ReturnType<typeof setTimeout> | undefined;
/** Saves the cache a few seconds after the last change (loads land in bursts), newest repos first, within
 *  `REPO_CACHE_BYTES`. */
function saveRepoCache(repos: Record<string, RepoState | undefined>, lists: RepoCache["lists"]) {
  clearTimeout(repoCacheTimer);
  repoCacheTimer = setTimeout(() => {
    let kept = Object.entries(repos)
      .filter((e): e is [string, RepoState] => !!e[1]?.data)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, REPO_CACHE_MAX);
    try {
      for (;;) {
        const c: RepoCache = { repos: Object.fromEntries(kept.map(([k, r]) => [k, { data: r.data, at: r.at, ghAt: r.ghAt }])), lists };
        const json = JSON.stringify(c);
        if (json.length <= REPO_CACHE_BYTES || kept.length === 0) {
          localStorage.setItem(REPO_CACHE, json);
          return;
        }
        kept = kept.slice(0, -1);
      }
    } catch {
      // Storage full or unavailable: the panel just loads as before.
    }
  }, 3000);
}

// Undoable actions, newest last, keyed by the toast that announced them.
const undoStack: ({ id: number; text: string } & Undoable)[] = [];
const UNDO_DEPTH = 20;

const inTextField = () => !!document.activeElement?.closest("input, textarea, [contenteditable='true']");

let undoMenu = "";
/** Keep Edit › Undo naming what ⌘Z will do: the field's typing, the newest action, or nothing. */
function syncUndoMenu() {
  const top = undoStack.at(-1);
  const [text, enabled] = inTextField() ? ["Undo", true] : top ? [`Undo ${top.label}`, true] : ["Undo", false];
  if (undoMenu === `${enabled}${text}`) return;
  undoMenu = `${enabled}${text}`;
  api.setUndoMenu(text, enabled).catch(() => {});
}

export const useStore = create<State>((set, get) => ({
  ...loadPrefs(),
  ready: false,
  snap: empty,
  sessions: [],
  sys: null,
  usage: null,
  signingIn: false,
  selectedTask: null,
  editing: null,
  toasts: [],
  flashSession: null,
  ...readRepoCache(),
  fetching: {},
  pushing: {},

  init: async () => {
    if (started) return; // StrictMode runs effects twice in dev
    started = true;
    const [snap, sessions] = await Promise.all([api.getSnapshot(), api.getSessions()]);
    const view = get().view;
    const validView = view.kind === "dashboard" || snap.spaces.some((s) => s.id === view.spaceId);
    set({ snap, sessions, ready: true, view: validView ? view : { kind: "dashboard" } });
    // Claude can start a session Navarch launched in a temporary folder of its own; say so once.
    const setSessions = (sessions: Session[]) => {
      const known = new Set(get().sessions.filter((s) => s.launchPath).map((s) => s.id));
      set({ sessions });
      for (const s of sessions)
        if (s.launchPath && !known.has(s.id))
          get().toast(`Claude started “${s.title || "the new session"}” in a temporary folder. Move it to ${baseName(s.launchPath)} in Claude.`);
    };
    api.onSessions(setSessions);
    // A paired phone changed tasks over the phone API.
    api.onSnapshotChanged(() => {
      get().reload().catch(() => {});
    });
    api.onLimitAlert((summary) => {
      get().toast(`Usage limit close (${summary}): told running sessions to save their work and schedule their resume`);
      get().refreshUsage(false);
    });
    api.onClaudeSignIn((error) => {
      set({ signingIn: false });
      if (error) get().toast(`Claude Code sign-in didn’t finish: ${error}`, undefined, "error");
      else {
        get().toast("Signed in to Claude Code");
        get().refreshUsage(false);
      }
    });
    api.onPhoneServe((message, error) => get().toast(`Phone access: ${message}`, undefined, error ? "error" : undefined));
    // In a text field, undo means the field's own text history.
    api.onUndoRequest(() => {
      if (inTextField()) document.execCommand("undo");
      else get().undo();
    });
    // focusout fires before the next element has focus, so look a tick later.
    document.addEventListener("focusin", syncUndoMenu);
    document.addEventListener("focusout", () => setTimeout(syncUndoMenu));
    syncUndoMenu();
    const tickSys = async () => {
      try {
        set({ sys: await api.getSystemStats() });
      } catch {
        /* stats are best-effort */
      }
    };
    tickSys();
    setInterval(tickSys, 2000);
    setInterval(async () => setSessions(await api.getSessions()), 15000);
    // Cheap: this reads Navarch's cache, which asks Anthropic every 10 minutes, sooner near a threshold.
    get().refreshUsage(false);
    setInterval(() => get().refreshUsage(false), 60 * 1000);
    window.addEventListener("focus", () => get().refreshUsage(false));
  },

  reload: async () => {
    const n = ++reloadSeq;
    const snap = await api.getSnapshot();
    if (n < appliedReload) return;
    appliedReload = n;
    set({ snap });
  },

  run: async (p) => {
    try {
      const r = await p;
      await get().reload();
      return r;
    } catch (e) {
      get().toast(String(e), undefined, "error");
      await get().reload();
      return undefined;
    }
  },

  toast: (text, undo, tone) => {
    const id = ++toastSeq;
    if (undo) {
      undoStack.push({ id, text, ...undo });
      if (undoStack.length > UNDO_DEPTH) undoStack.shift();
      syncUndoMenu();
    }
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, undo: undo?.run, tone }] }));
    setTimeout(() => get().dismiss(id), undo ? 7000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  undo: (toastId) => {
    const i = toastId == null ? undoStack.length - 1 : undoStack.findIndex((u) => u.id === toastId);
    if (i < 0) {
      get().toast("Nothing to undo");
      return;
    }
    const [u] = undoStack.splice(i, 1);
    syncUndoMenu();
    get().dismiss(u.id);
    u.run();
    if (toastId == null) get().toast(`Undone: ${u.text}`);
  },
  flash: (flashSession) => {
    set({ flashSession });
    setTimeout(() => get().flashSession === flashSession && set({ flashSession: null }), 1600);
  },

  setView: (view) => set({ view, selectedTask: null, editing: null }),
  selectProject: (spaceId, projectId) =>
    set((s) => ({ projectOfSpace: { ...s.projectOfSpace, [spaceId]: projectId }, selectedTask: null, editing: null })),
  selectTask: (selectedTask) => set({ selectedTask }),
  setEditing: (editing) => set({ editing }),
  toggleCollapsed: (id, open) =>
    set((s) => {
      const collapsed = { ...s.collapsed };
      if (open ?? collapsed[id]) delete collapsed[id];
      else collapsed[id] = true;
      return { collapsed };
    }),
  setHideDone: (hideDone) => set({ hideDone }),
  setLogByProject: (logByProject) => set({ logByProject }),
  setRecentFirst: (spaceId, on) =>
    set((s) => {
      const recentFirst = { ...s.recentFirst };
      if (on) recentFirst[spaceId] = true;
      else delete recentFirst[spaceId];
      return { recentFirst };
    }),

  refreshUsage: async (force) => {
    try {
      set({ usage: await api.getUsage(force) });
    } catch (e) {
      set((s) => ({ usage: { fiveHour: null, sevenDay: null, fetchedAt: Date.now(), needsSignIn: false, signInEndsAt: null, ...s.usage, error: String(e) } }));
    }
  },

  signInClaude: async () => {
    set({ signingIn: true });
    try {
      await api.signInClaude();
    } catch (e) {
      set({ signingIn: false });
      get().toast(`Couldn’t start the Claude Code sign-in: ${e}`, undefined, "error");
    }
  },

  loadRepo: async (path, force = false, github = true) => {
    const key = `${github ? "gh" : "local"}:${path}`;
    if (repoLoads.has(key) && !force) return;
    const n = ++repoSeq;
    repoLoads.set(key, n);
    const patch = (p: (cur: RepoState) => Partial<RepoState>) =>
      set((s) => {
        const cur: RepoState = { data: null, loading: false, error: null, at: 0, ghAt: 0, ...s.repos[path] };
        return { repos: { ...s.repos, [path]: { ...cur, ...p(cur) } } };
      });
    const stale = () => repoLoads.get(key) !== n || (!github && (repoApplied.get(path) ?? 0) > n);
    if (github) {
      // The chosen repo: the git side (worktrees, and the branches compared with whatever GitHub data the backend has
      // cached) and the GitHub side (gh: seconds once its 5-min cache has run out) load at once, each drawn as it lands.
      patch(() => ({ loading: true }));
      let side: RepoGitHub | null = null; // this load's GitHub side, once it landed
      const withSide = (d: RepoOverview, g: RepoGitHub): RepoOverview => ({
        ...d, github: g.github, githubError: g.githubError, branches: g.branches, branchCount: g.branchCount,
      });
      const local = api.getRepoOverview(path, false, true, true).then((data) => {
        if (stale()) return;
        repoApplied.set(path, Math.max(n, repoApplied.get(path) ?? 0));
        patch((cur) => ({ data: data && (side ? withSide(data, side) : keepGitHub(data, cur.data)), error: null, at: Date.now() }));
      });
      const remote = api.getRepoGitHub(path, force).then((g) => {
        if (stale()) return;
        side = g;
        patch((cur) => ({ data: cur.data && g ? withSide(cur.data, g) : cur.data, ghAt: Date.now() }));
      });
      try {
        const failed = (await Promise.allSettled([local, remote])).find((r) => r.status === "rejected");
        if (stale()) return;
        const e = failed?.reason;
        patch(() => ({ loading: false, ...(failed ? { error: String(e) } : {}) }));
        if (failed && force) get().toast(`Couldn’t load the repo: ${e}`, undefined, "error");
      } finally {
        if (repoLoads.get(key) === n) repoLoads.delete(key);
      }
      return;
    }
    try {
      const data = await api.getRepoOverview(path, force, github);
      if (stale()) return;
      repoApplied.set(path, Math.max(n, repoApplied.get(path) ?? 0));
      const now = Date.now();
      // Local only: keep the GitHub side and the branches (only the chosen repo's loads read them) of the last such
      // load while it is fresh (the backend's 5-min cache), so a repo picked once and left doesn't show stale PRs on
      // its worktrees for the rest of the run, and picking it again doesn't flash an empty Branches column.
      patch((cur) => {
        const prev = now - cur.ghAt < 5 * 60_000 ? cur.data : null;
        const gh = { github: prev?.github ?? null, githubError: prev?.githubError ?? null };
        const br = { branches: prev?.branches ?? [], branchCount: prev?.branchCount ?? 0 };
        return { data: data && { ...data, ...gh, ...br }, error: null, at: now };
      });
    } catch (e) {
      if (repoLoads.get(key) !== n) return;
      patch(() => ({ error: String(e) }));
      if (force) get().toast(`Couldn’t load the repo: ${e}`, undefined, "error");
    } finally {
      if (repoLoads.get(key) === n) repoLoads.delete(key);
    }
  },
  fetchRepo: async (root) => {
    if (get().fetching[root]) return;
    const busy = (on: boolean) => set((s) => ({ fetching: { ...s.fetching, [root]: on || undefined } }));
    busy(true);
    const name =
      Object.values(get().repoLists).flatMap((l) => l?.repos ?? []).find((r) => r.root === root)?.name ?? baseName(root);
    try {
      const summary = await api.gitFetch(root);
      get().toast(`Fetched ${name}: ${summary}`);
      // Forced: supersedes a poll's load that read the refs before the fetch, and asks GitHub afresh.
      await get().loadRepo(root, true);
    } catch (e) {
      get().toast(`Couldn’t fetch ${name}: ${e}`, undefined, "error");
    } finally {
      busy(false);
    }
  },
  pushBranch: async (root, branch) => {
    const key = pushKey(root, branch);
    if (get().pushing[key]) return;
    const busy = (on: boolean) => set((s) => ({ pushing: { ...s.pushing, [key]: on || undefined } }));
    busy(true);
    try {
      get().toast(await api.gitPush(root, branch));
      await get().loadRepo(root, true);
    } catch (e) {
      get().toast(`Couldn’t push ${branch}: ${e}`, undefined, "error");
    } finally {
      busy(false);
    }
  },
  setRepoPanel: (p) => set((s) => ({ repoPanel: { ...s.repoPanel, ...p } })),
  findRepos: async (projectPath) => {
    if (repoFinds.has(projectPath)) return;
    repoFinds.add(projectPath);
    try {
      const repos = await api.findRepos(projectPath);
      set((s) => ({
        repoLists: { ...s.repoLists, [projectPath]: { repos, at: Date.now() } },
        // Several repos and none picked yet: pin the first one, so a later commit that reorders the list (most recent
        // first) doesn't switch the panel to another repo unasked.
        ...(repos.length > 1 && !s.repoOfProject[projectPath]
          ? { repoOfProject: { ...s.repoOfProject, [projectPath]: repos[0].root } }
          : {}),
      }));
    } catch {
      /* keep the old list */
    } finally {
      repoFinds.delete(projectPath);
    }
  },
  selectRepo: (projectPath, root) => set((s) => ({ repoOfProject: { ...s.repoOfProject, [projectPath]: root } })),
}));

useStore.subscribe((s) => {
  const prefs: UIPrefs = { view: s.view, projectOfSpace: s.projectOfSpace, collapsed: s.collapsed, hideDone: s.hideDone, recentFirst: s.recentFirst, logByProject: s.logByProject, repoPanel: s.repoPanel, repoOfProject: s.repoOfProject };
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch {
    /* prefs are a convenience */
  }
});

// One shared model per (snapshot, sessions) pair, so every component reads the same derived data.
let cached: { snap: Snapshot; sessions: Session[]; model: Model } | null = null;

export function useModel(): Model {
  const snap = useStore((s) => s.snap);
  const sessions = useStore((s) => s.sessions);
  if (!cached || cached.snap !== snap || cached.sessions !== sessions) cached = { snap, sessions, model: buildModel(snap, sessions) };
  return cached.model;
}

useStore.subscribe((s, prev) => {
  if (s.repos !== prev.repos || s.repoLists !== prev.repoLists) saveRepoCache(s.repos, s.repoLists);
});
