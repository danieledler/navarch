// In-memory backend used when the UI runs in a plain browser (vite dev without Tauri).
// Mirrors the Rust commands closely enough to exercise every UI flow, on the demo dataset in ./demo.ts.
// Add ?reset to the URL to reseed.
import type { Api } from "./index";
import type { CpuSample, Id, LimitAlerts, Session, Snapshot, SystemStats, Task, Usage } from "./types";
import { DEMO_PICK_FOLDER, demoSessions, demoSnapshot } from "./demo";

const KEY = "navarch-mock-v2";

interface DB extends Snapshot {
  nextId: number;
  deleted: { id: Id; stamp: number; task: Task }[];
  links: Record<string, Id>;
}

const seed = (): DB => ({ ...demoSnapshot(), deleted: [], links: {} });

function load(): DB {
  if (typeof location !== "undefined" && location.search.includes("reset")) localStorage.removeItem(KEY);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  return seed();
}

const mockSessions = (db: DB): Session[] => demoSessions(db, db.links);

/** A 10-core machine: a few busy efficiency-style cores, a build burst every few minutes, kernel-style load averages. */
function cpuSim() {
  const n = 10;
  const decay = (sec: number) => 1 - Math.exp(-2 / sec);
  let cores = Array.from({ length: n }, () => 8);
  let loads = [2.2, 2.4, 2.5];
  let latest: SystemStats;
  const history: CpuSample[] = [];
  const step = (t: number) => {
    const burst = Math.sin(t / 7e4) > 0.8 ? 70 : 0;
    cores = cores.map((c, i) => {
      const target = i < 4 ? 22 : 5 + burst * (0.6 + 0.4 * Math.random());
      return Math.max(0, Math.min(100, c * 0.5 + target * 0.5 + (Math.random() - 0.5) * 14));
    });
    const cpu = cores.reduce((a, c) => a + c, 0) / n;
    const runnable = (cpu / 100) * n * 1.15;
    loads = loads.map((l, i) => l + (runnable - l) * decay([60, 300, 900][i]));
    latest = { cpu, cores, load1: loads[0], load5: loads[1], load15: loads[2], brand: "Apple M3 Pro" };
    history.push({ t, cpu, load1: loads[0] });
    if (history.length > 300) history.shift();
  };
  const now = Date.now();
  for (let t = now - 10 * 6e4; t <= now; t += 2000) step(t);
  const tick = () => {
    while (history[history.length - 1].t + 2000 <= Date.now()) step(history[history.length - 1].t + 2000);
  };
  return {
    stats: () => (tick(), latest),
    history: () => (tick(), [...history]),
  };
}

export function mockApi(): Api {
  const cpu = cpuSim();
  const db = load();
  let limitAlerts: LimitAlerts = { fiveHour: 95, sevenDay: 98, active: null, hookInstalled: false, live: false };
  const save = () => localStorage.setItem(KEY, JSON.stringify(db));
  const snap = (): Snapshot => ({
    spaces: db.spaces, projects: db.projects, tasks: db.tasks, periods: db.periods,
    periodTasks: db.periodTasks, weekTasks: db.weekTasks,
  });
  const listeners = new Set<(s: Session[]) => void>();
  const emit = () => listeners.forEach((cb) => cb(mockSessions(db)));
  const nid = () => db.nextId++;
  const ok = async () => save();
  const kids = (id: Id): Task[] => db.tasks.filter((t) => t.parentId === id).flatMap((t) => [t, ...kids(t.id)]);
  const siblings = (projectId: Id, parentId: Id | null) =>
    db.tasks.filter((t) => t.projectId === projectId && t.parentId === parentId).sort((a, b) => a.sort - b.sort);

  return {
    getSnapshot: async () => structuredClone(snap()),
    createSpace: async (name, color) => {
      const s = { id: nid(), name, color, sort: db.spaces.length + 1 };
      db.spaces.push(s);
      save();
      return s;
    },
    updateSpace: async (id, name, color) => {
      Object.assign(db.spaces.find((s) => s.id === id)!, { name, color });
      return ok();
    },
    deleteSpace: async (id) => {
      if (db.projects.some((p) => p.spaceId === id)) throw "Space has projects";
      db.spaces = db.spaces.filter((s) => s.id !== id);
      return ok();
    },
    createProject: async (spaceId, path, name) => {
      if (db.projects.some((p) => p.path === path)) throw "That folder is already a project";
      const p = { id: nid(), spaceId, path, name: name ?? path.split("/").pop()!, sort: db.projects.length, createdAt: Date.now() };
      db.projects.push(p);
      save();
      emit();
      return p;
    },
    updateProject: async (id, name, spaceId) => {
      const p = db.projects.find((x) => x.id === id)!;
      if (name) p.name = name;
      if (spaceId) p.spaceId = spaceId;
      return ok();
    },
    reorderProjects: async (ids) => {
      ids.forEach((id, i) => (db.projects.find((p) => p.id === id)!.sort = i + 1));
      return ok();
    },
    deleteProject: async (id) => {
      db.projects = db.projects.filter((p) => p.id !== id);
      db.tasks = db.tasks.filter((t) => t.projectId !== id);
      return ok();
    },
    createTask: async (projectId, parentId, title, afterId) => {
      const sibs = siblings(projectId, parentId);
      let sort = (sibs.at(-1)?.sort ?? 0) + 1;
      if (afterId != null) {
        const i = sibs.findIndex((t) => t.id === afterId);
        if (i >= 0) sort = sibs[i + 1] ? (sibs[i].sort + sibs[i + 1].sort) / 2 : sibs[i].sort + 1;
      }
      const t: Task = { id: nid(), projectId, parentId, title, notes: "", status: "open", deadline: null, sort, createdAt: Date.now(), doneAt: null };
      db.tasks.push(t);
      save();
      return t;
    },
    updateTask: async (id, patch) => {
      const t = db.tasks.find((x) => x.id === id)!;
      if (patch.title !== undefined) t.title = patch.title;
      if (patch.notes !== undefined) t.notes = patch.notes;
      if (patch.deadline !== undefined) t.deadline = patch.deadline || null;
      if (patch.sort !== undefined) t.sort = patch.sort;
      if (patch.parentId !== undefined) {
        const np = patch.parentId || null;
        if (np === id || (np && kids(id).some((k) => k.id === np))) throw "Cannot move a task under itself";
        t.parentId = np;
      }
      if (patch.status) {
        t.status = patch.status;
        t.doneAt = patch.status === "done" ? Date.now() : null;
      }
      save();
      return { ...t };
    },
    deleteTask: async (id) => {
      const stamp = Date.now();
      const gone = [db.tasks.find((t) => t.id === id)!, ...kids(id)];
      db.deleted.push(...gone.map((task) => ({ id: task.id, stamp, task })));
      db.tasks = db.tasks.filter((t) => !gone.includes(t));
      return ok();
    },
    restoreTask: async (id) => {
      const stamp = db.deleted.find((d) => d.id === id)?.stamp;
      const back = db.deleted.filter((d) => d.stamp === stamp);
      db.tasks.push(...back.map((d) => d.task));
      db.deleted = db.deleted.filter((d) => d.stamp !== stamp);
      return ok();
    },
    createPeriod: async (name, start, end) => {
      const p = { id: nid(), name, start, end };
      db.periods.push(p);
      save();
      return p;
    },
    updatePeriod: async (id, name, start, end) => {
      Object.assign(db.periods.find((p) => p.id === id)!, { name, start, end });
      return ok();
    },
    deletePeriod: async (id) => {
      db.periods = db.periods.filter((p) => p.id !== id);
      return ok();
    },
    setPeriodTask: async (periodId, taskId, on) => {
      db.periodTasks = db.periodTasks.filter((x) => !(x.periodId === periodId && x.taskId === taskId));
      if (on) db.periodTasks.push({ periodId, taskId });
      return ok();
    },
    setWeekTask: async (week, taskId, on) => {
      db.weekTasks = db.weekTasks.filter((x) => !(x.week === week && x.taskId === taskId));
      if (on) db.weekTasks.push({ week, taskId });
      return ok();
    },
    linkSession: async (sessionId, taskId) => {
      if (taskId == null) delete db.links[sessionId];
      else db.links[sessionId] = taskId;
      save();
      emit();
    },
    // In a production build (the site's live demo) these reject, so run() shows why nothing happened.
    openNewSession: async (folder, prompt) => {
      if (import.meta.env.PROD) throw "In the app this starts a session in Claude's Code tab. The demo can't launch Claude.";
      console.info("[mock] claude://code/new", { folder, prompt });
    },
    openSession: async (sessionId) => {
      if (import.meta.env.PROD) throw "In the app this opens the session in Claude's Code tab. The demo can't launch Claude.";
      console.info("[mock] claude://code/continue", sessionId);
    },
    revealPath: async (path) => {
      if (import.meta.env.PROD) throw "In the app this shows the folder in Finder. The demo has no real folders.";
      console.info("[mock] reveal", path);
    },
    getSessions: async () => mockSessions(db),
    getSystemStats: async () => cpu.stats(),
    getCpuHistory: async () => cpu.history(),
    // From Vite's dev server: the red dev label. In a production build (the site's live demo): a plain "demo".
    getBuildInfo: async () => ({
      version: "0.1.0", commit: import.meta.env.DEV ? "mock" : "demo", branch: "main", checkout: __UI_CHECKOUT__, dirty: 0, builtAt: Date.now(),
      devUi: import.meta.env.DEV, db: "mock data in localStorage",
    }),
    getLimitAlerts: async () => limitAlerts,
    setLimitThresholds: async (fiveHour, sevenDay) => (limitAlerts = { ...limitAlerts, fiveHour, sevenDay }),
    onLimitAlert: () => {},
    getUsage: async (): Promise<Usage> => {
      // ?usage=hot shows over-pace tones, ?usage=zero a fresh window, ?usage=error the unavailable state.
      const mode = new URLSearchParams(location.search).get("usage");
      const at = (ms: number) => new Date(Date.now() + ms).toISOString();
      if (mode === "error") return { fiveHour: null, sevenDay: null, error: "Claude Code login expired", fetchedAt: Date.now() };
      const hot = mode === "hot";
      if (mode === "zero")
        return { fiveHour: { percent: 0, resetsAt: at(299 * 6e4) }, sevenDay: { percent: 0.4, resetsAt: at(167 * 36e5) }, error: null, fetchedAt: Date.now() };
      return {
        fiveHour: { percent: hot ? 78 : 2, resetsAt: at((hot ? 180 : 250) * 6e4) },
        sevenDay: { percent: hot ? 64 : 41, resetsAt: at((hot ? 72 : 45) * 36e5) },
        error: null,
        fetchedAt: Date.now() - 2 * 6e4,
      };
    },
    onSessions: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onUndoRequest: (cb) => {
      // No native menu in a browser: take ⌘Z / Ctrl+Z ourselves, as the app's Edit menu does.
      document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          cb();
        }
      });
    },
    setUndoMenu: async () => {},
    pickFolder: async () => {
      const p = window.prompt("Folder path (mock picker)", DEMO_PICK_FOLDER);
      return p || null;
    },
    confirm: async (message) => window.confirm(message),
  };
}
