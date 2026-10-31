import { create } from "zustand";
import { api, type Id, type Session, type Snapshot, type SystemStats, type Usage } from "./api";
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
}

interface State extends UIPrefs {
  ready: boolean;
  snap: Snapshot;
  sessions: Session[];
  sys: SystemStats | null;
  usage: Usage | null;
  selectedTask: Id | null;
  editing: Id | null;
  toasts: Toast[];
  /** Session row to highlight briefly after it moved, so the eye can follow it. */
  flashSession: string | null;
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
}

const PREFS = "navarch-ui";
const empty: Snapshot = { spaces: [], projects: [], tasks: [], periods: [], periodTasks: [], weekTasks: [] };

function loadPrefs(): UIPrefs {
  const base: UIPrefs = { view: { kind: "dashboard" }, projectOfSpace: {}, collapsed: {}, hideDone: false, recentFirst: {}, logByProject: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") };
  } catch {
    return base;
  }
}

let toastSeq = 0;
let started = false;

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
  selectedTask: null,
  editing: null,
  toasts: [],
  flashSession: null,

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
    api.onLimitAlert((summary) => {
      get().toast(`Usage limit close (${summary}): told running sessions to save their work and schedule their resume`);
      get().refreshUsage(false);
    });
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
    get().refreshUsage(false);
    setInterval(() => get().refreshUsage(false), 5 * 60 * 1000);
    window.addEventListener("focus", () => get().refreshUsage(false));
  },

  reload: async () => set({ snap: await api.getSnapshot() }),

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
      set({ usage: { fiveHour: null, sevenDay: null, error: String(e), fetchedAt: Date.now() } });
    }
  },
}));

useStore.subscribe((s) => {
  const prefs: UIPrefs = { view: s.view, projectOfSpace: s.projectOfSpace, collapsed: s.collapsed, hideDone: s.hideDone, recentFirst: s.recentFirst, logByProject: s.logByProject };
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
