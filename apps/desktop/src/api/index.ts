import type { BuildInfo, CpuSample, Id, LimitAlerts, MobileAccess, PairingCode, Period, Project, Session, Snapshot, Space, SystemStats, Task, TaskPatch, Usage } from "./types";
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
  revealPath(path: string): Promise<void>;
  getSessions(): Promise<Session[]>;
  getSystemStats(): Promise<SystemStats>;
  getCpuHistory(): Promise<CpuSample[]>;
  getBuildInfo(): Promise<BuildInfo>;
  getUsage(force: boolean): Promise<Usage>;
  getLimitAlerts(): Promise<LimitAlerts>;
  setLimitThresholds(fiveHour: number, sevenDay: number): Promise<LimitAlerts>;
  /** A usage-limit alert went out to running sessions; the payload is its summary. */
  onLimitAlert(cb: (summary: string) => void): void;
  onSessions(cb: (s: Session[]) => void): () => void;
  /** A paired phone changed tasks over the phone API: reload the snapshot. Returns the unsubscribe. */
  onSnapshotChanged(cb: () => void): () => void;
  getMobileAccess(): Promise<MobileAccess>;
  /** Starts or stops the phone API on 127.0.0.1 and saves the setting; the first enable creates the token. */
  setMobileAccess(enabled: boolean, publicUrl: string): Promise<MobileAccess>;
  /** A single-use code, valid 10 minutes, that a phone trades for the token. Fails while access is off. */
  newPairingCode(): Promise<PairingCode>;
  /** A new token: every paired phone has to pair again. */
  resetMobileToken(): Promise<MobileAccess>;
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
  return {
    getSnapshot: () => call("get_snapshot"),
    createSpace: (name, color) => call("create_space", { name, color }),
    updateSpace: (id, name, color) => call("update_space", { id, name, color }),
    deleteSpace: (id) => call("delete_space", { id }),
    createProject: (spaceId, path, name) => call("create_project", { spaceId, path, name: name ?? null }),
    updateProject: (id, name, spaceId) => call("update_project", { id, name: name ?? null, spaceId: spaceId ?? null }),
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
    getSessions: () => call("get_sessions"),
    getSystemStats: () => call("get_system_stats"),
    getCpuHistory: () => call("get_cpu_history"),
    getBuildInfo: () => call("get_build_info"),
    getUsage: (force) => call("get_usage", { force }),
    getLimitAlerts: () => call("get_limit_alerts"),
    setLimitThresholds: (fiveHour, sevenDay) => call("set_limit_thresholds", { thresholds: { fiveHour, sevenDay } }),
    onLimitAlert: (cb) => {
      event.then((e) => e.listen<string>("limit-alert", (ev) => cb(ev.payload)));
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
    onSnapshotChanged: (cb) => {
      let un: (() => void) | undefined;
      let dead = false;
      event.then((e) => e.listen("snapshot-changed", () => cb())).then((u) => {
        if (dead) u();
        else un = u;
      });
      return () => {
        dead = true;
        un?.();
      };
    },
    getMobileAccess: () => call("get_mobile_access"),
    setMobileAccess: (enabled, publicUrl) => call("set_mobile_access", { enabled, publicUrl }),
    newPairingCode: () => call("new_pairing_code"),
    resetMobileToken: () => call("reset_mobile_token"),
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
