import type { BuildInfo, CpuSample, Id, LimitAlerts, MobileAccess, PairingCode, Tailscale, TailscaleServe, Period, Project, RepoGitHub, RepoOverview, RepoRef, Session, Snapshot, Space, SystemStats, Task, TaskPatch, Usage } from "./types";
import { mockApi } from "./mock";

export * from "./types";

/** Every backend call the UI makes. Implemented by Tauri commands, or by an in-memory mock in a plain browser. */
export interface Api {
  getSnapshot(): Promise<Snapshot>;
  createSpace(name: string, color: string): Promise<Space>;
  updateSpace(id: Id, name: string, color: string): Promise<void>;
  deleteSpace(id: Id): Promise<void>;
  createProject(spaceId: Id, path: string, name?: string): Promise<Project>;
  updateProject(id: Id, name?: string, spaceId?: Id): Promise<void>;
  /** Points a project at its folder's new place, once the folder was moved and Claude's records of it updated. */
  changeProjectFolder(id: Id, path: string): Promise<Project>;
  /** Puts a space's projects in this order. */
  reorderProjects(ids: Id[]): Promise<void>;
  deleteProject(id: Id): Promise<void>;
  createTask(projectId: Id, parentId: Id | null, title: string, afterId?: Id): Promise<Task>;
  updateTask(id: Id, patch: TaskPatch): Promise<Task>;
  deleteTask(id: Id): Promise<void>;
  restoreTask(id: Id): Promise<void>;
  createPeriod(name: string, start: string, end: string): Promise<Period>;
  updatePeriod(id: Id, name: string, start: string, end: string): Promise<void>;
  deletePeriod(id: Id): Promise<void>;
  setPeriodTask(periodId: Id, taskId: Id, on: boolean): Promise<void>;
  setWeekTask(week: string, taskId: Id, on: boolean): Promise<void>;
  linkSession(sessionId: string, taskId: Id | null): Promise<void>;
  openNewSession(folder: string, prompt: string, taskId?: Id): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  /** Worktrees of the git repo holding `path`, with its GitHub PRs and issues (via `gh`); null if `path` is in no
   *  git repo. GitHub data is cached ~5 min per repo; `force` fetches it again now. `github: false` reads only
   *  the local git side (no gh call; `github` and `githubError` come back null). */
  /** `github: false`: the local git side only, no branches. `cached: true`: with the branches, and GitHub data only
   *  from the backend's cache (no gh call), to draw the panel while a full load waits for gh. */
  getRepoOverview(path: string, force: boolean, github?: boolean, cached?: boolean): Promise<RepoOverview | null>;
  /** gh's data (cached 5 min unless `force`) and the branches compared with it; no worktrees. */
  getRepoGitHub(path: string, force: boolean): Promise<RepoGitHub | null>;
  /** Git repos of a project folder: the repo it is in (first), then repos 1–2 folders below it (dot-folders,
   *  node_modules and the like skipped; worktrees resolved to their main checkout; duplicates dropped), plus the
   *  repos of worktrees in `<path>/.claude/worktrees/*` (sessions start in the project folder, so their worktrees
   *  may sit there even when the repo is elsewhere); most recent commit first, at most 12. Empty when there is
   *  none. Local only, no network. */
  findRepos(path: string): Promise<RepoRef[]>;
  /** `git fetch --prune <remote>` in the repo whose main checkout is `root` (the GitHub remote, as RepoOverview.remote):
   *  updates only its remote-tracking branches, never local branches or files. No prompts (fails instead when a
   *  password or passphrase would be needed); 60 s timeout. Resolves with a one-line summary of what changed, e.g.
   *  "main +3 · 2 new branches · 1 deleted", or "Already up to date"; rejects with git's error. */
  gitFetch(root: string): Promise<string>;
  /** Pushes local branch `branch` of the repo whose main checkout is `root` to its remote side (Branch.remoteRef):
   *  its upstream, else the GitHub remote's branch of the same name. That ref only, fast-forward only (never forced),
   *  no tags. Refuses a branch never pushed, one whose upstream is gone, and one behind its remote side. No prompts;
   *  60 s timeout. Resolves with e.g. "Pushed 3 commits to origin/x"; rejects with git's error. */
  gitPush(root: string, branch: string): Promise<string>;
  /** Opens a https://github.com/ link in the default browser. */
  openUrl(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  getSessions(): Promise<Session[]>;
  getSystemStats(): Promise<SystemStats>;
  getCpuHistory(): Promise<CpuSample[]>;
  getBuildInfo(): Promise<BuildInfo>;
  getUsage(force: boolean): Promise<Usage>;
  getLimitAlerts(): Promise<LimitAlerts>;
  setLimitThresholds(fiveHour: number, sevenDay: number): Promise<LimitAlerts>;
  /** Starts Claude Code's sign-in (`claude auth login`), which opens the browser; onClaudeSignIn hears how it ended. */
  signInClaude(): Promise<void>;
  /** A sign-in ended: null when it worked, else why not. */
  onClaudeSignIn(cb: (error: string | null) => void): void;
  /** A usage-limit alert went out to running sessions; the payload is its summary. */
  onLimitAlert(cb: (summary: string) => void): void;
  /** The installed app's launch-time Tailscale Serve change or failure. */
  onPhoneServe(cb: (message: string, error: boolean) => void): void;
  onSessions(cb: (s: Session[]) => void): () => void;
  /** A paired phone changed tasks over the phone API: reload the snapshot. Returns the unsubscribe. */
  onSnapshotChanged(cb: () => void): () => void;
  /** Phone access changed behind the UI's back: a phone paired, the pairing code locked, the server stopped. */
  onMobileChanged(cb: () => void): () => void;
  getMobileAccess(): Promise<MobileAccess>;
  /** Starts or stops the phone API on 127.0.0.1 and saves the setting; the first enable creates the token. */
  setMobileAccess(enabled: boolean | null, publicUrl: string): Promise<MobileAccess>;
  /** A single-use code, valid 10 minutes, that a phone trades for the token. Fails while access is off. */
  newPairingCode(): Promise<PairingCode>;
  /** A new token: every paired phone has to pair again. */
  resetMobileToken(): Promise<MobileAccess>;
  /** This Mac's Tailscale name, for the public URL; null when the Tailscale CLI isn't installed. Takes up to 2 s. */
  detectTailscale(): Promise<Tailscale | null>;
  /** Where Tailscale Serve sends https://<this Mac>/, against this build's phone port. Takes a few seconds. */
  tailscaleServeStatus(): Promise<TailscaleServe>;
  /** Points https://<this Mac>/ at this build's phone server (takes another target only with replace), or removes it if ours. Up to ~15 s. */
  tailscaleServe(on: boolean, replace: boolean): Promise<TailscaleServe>;
  /** Opens a login.tailscale.com link `tailscale serve` printed, to enable HTTPS for the tailnet. */
  openTailscaleLogin(url: string): Promise<void>;
  /** Edit › Undo or ⌘Z. The app's menu item owns ⌘Z, so the webview never sees the keystroke. */
  onUndoRequest(cb: () => void): void;
  /** Name what Edit › Undo will undo ("Undo Link “x”"), or grey it out. */
  setUndoMenu(text: string, enabled: boolean): Promise<void>;
  pickFolder(): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function tauriApi(): Api {
  // Loaded lazily so the browser build never touches Tauri globals.
  const core = import("@tauri-apps/api/core");
  const event = import("@tauri-apps/api/event");
  const dialog = import("@tauri-apps/plugin-dialog");
  const call = async <T>(cmd: string, args?: Record<string, unknown>) => (await core).invoke<T>(cmd, args);
  /** Listens to an event without a payload; the returned function stops listening, even before it started. */
  const listenBare = (name: string, cb: () => void) => {
    let un: (() => void) | undefined;
    let dead = false;
    event.then((e) => e.listen(name, () => cb())).then((u) => {
      if (dead) u();
      else un = u;
    });
    return () => {
      dead = true;
      un?.();
    };
  };
  return {
    getSnapshot: () => call("get_snapshot"),
    createSpace: (name, color) => call("create_space", { name, color }),
    updateSpace: (id, name, color) => call("update_space", { id, name, color }),
    deleteSpace: (id) => call("delete_space", { id }),
    createProject: (spaceId, path, name) => call("create_project", { spaceId, path, name: name ?? null }),
    updateProject: (id, name, spaceId) => call("update_project", { id, name: name ?? null, spaceId: spaceId ?? null }),
    changeProjectFolder: (id, path) => call("change_project_folder", { id, path }),
    reorderProjects: (ids) => call("reorder_projects", { ids }),
    deleteProject: (id) => call("delete_project", { id }),
    createTask: (projectId, parentId, title, afterId) =>
      call("create_task", { projectId, parentId, title, afterId: afterId ?? null }),
    updateTask: (id, patch) => call("update_task", { id, patch }),
    deleteTask: (id) => call("delete_task", { id }),
    restoreTask: (id) => call("restore_task", { id }),
    createPeriod: (name, start, end) => call("create_period", { name, start, end }),
    updatePeriod: (id, name, start, end) => call("update_period", { id, name, start, end }),
    deletePeriod: (id) => call("delete_period", { id }),
    setPeriodTask: (periodId, taskId, on) => call("set_period_task", { periodId, taskId, on }),
    setWeekTask: (week, taskId, on) => call("set_week_task", { week, taskId, on }),
    linkSession: (sessionId, taskId) => call("link_session", { sessionId, taskId }),
    openNewSession: (folder, prompt, taskId) => call("open_new_session", { folder, prompt, taskId: taskId ?? null }),
    openSession: (sessionId) => call("open_session", { sessionId }),
    revealPath: (path) => call("reveal_path", { path }),
    getRepoOverview: (path, force, github = true, cached = false) => call("get_repo_overview", { path, force, github, cached }),
    getRepoGitHub: (path, force) => call("get_repo_github", { path, force }),
    findRepos: (path) => call("find_repos", { path }),
    gitFetch: (root) => call("git_fetch", { root }),
    gitPush: (root, branch) => call("git_push", { root, branch }),
    openUrl: (url) => call("open_url", { url }),
    getSessions: () => call("get_sessions"),
    getSystemStats: () => call("get_system_stats"),
    getCpuHistory: () => call("get_cpu_history"),
    getBuildInfo: () => call("get_build_info"),
    getUsage: (force) => call("get_usage", { force }),
    getLimitAlerts: () => call("get_limit_alerts"),
    setLimitThresholds: (fiveHour, sevenDay) => call("set_limit_thresholds", { thresholds: { fiveHour, sevenDay } }),
    signInClaude: () => call("sign_in_claude"),
    onClaudeSignIn: (cb) => {
      event.then((e) => e.listen<string | null>("claude-sign-in", (ev) => cb(ev.payload)));
    },
    onLimitAlert: (cb) => {
      event.then((e) => e.listen<string>("limit-alert", (ev) => cb(ev.payload)));
    },
    onPhoneServe: (cb) => {
      event.then((e) => e.listen<{ message: string; error: boolean }>("phone-serve", (ev) => cb(ev.payload.message, ev.payload.error)));
    },
    onSessions: (cb) => {
      let un: (() => void) | undefined;
      let dead = false;
      event.then((e) => e.listen<Session[]>("sessions-updated", (ev) => cb(ev.payload))).then((u) => {
        if (dead) u();
        else un = u;
      });
      return () => {
        dead = true;
        un?.();
      };
    },
    onSnapshotChanged: (cb) => listenBare("snapshot-changed", cb),
    onMobileChanged: (cb) => listenBare("mobile-changed", cb),
    getMobileAccess: () => call("get_mobile_access"),
    setMobileAccess: (enabled, publicUrl) => call("set_mobile_access", { enabled, publicUrl }),
    newPairingCode: () => call("new_pairing_code"),
    resetMobileToken: () => call("reset_mobile_token"),
    detectTailscale: () => call("detect_tailscale"),
    tailscaleServeStatus: () => call("tailscale_serve_status"),
    tailscaleServe: (on, replace) => call("tailscale_serve", { on, replace }),
    openTailscaleLogin: (url) => call("open_tailscale_login", { url }),
    onUndoRequest: (cb) => {
      event.then((e) => e.listen("menu-undo", cb));
    },
    setUndoMenu: (text, enabled) => call("set_undo_menu", { text, enabled }),
    pickFolder: async () => {
      const r = await (await dialog).open({ directory: true, multiple: false, title: "Choose a project folder" });
      return typeof r === "string" ? r : null;
    },
    confirm: async (message) => (await dialog).ask(message, { title: "Navarch", kind: "warning" }),
  };
}

export const api: Api = isTauri ? tauriApi() : mockApi();
