// The phone's backend: POST /api/<cmd> on the same origin (tailscale serve → Navarch's phone server).
// With ?mock in the URL, the desktop's in-memory mock stands in, so the UI runs without a Mac.
import type { Id, LimitAlerts, Session, Snapshot, Task, TaskPatch, Usage } from "../../../src/api/types";

/** The Mac can't be reached: network error, tunnel error page (530, 502…), or anything that isn't our JSON. */
export class Offline extends Error {
  constructor(msg = "Can't reach your Mac") {
    super(msg);
  }
}

/** The token was refused: the phone has to pair again. */
export class Unauthorized extends Error {
  constructor() {
    super("This phone isn't paired");
  }
}

export interface PhoneApi {
  ping(): Promise<{ ok: boolean }>;
  getSnapshot(): Promise<Snapshot>;
  getSessions(): Promise<Session[]>;
  getUsage(): Promise<Usage>;
  getLimitAlerts(): Promise<LimitAlerts>;
  createTask(projectId: Id, parentId: Id | null, title: string, afterId?: Id): Promise<Task>;
  updateTask(id: Id, patch: TaskPatch): Promise<Task>;
  deleteTask(id: Id): Promise<void>;
  restoreTask(id: Id): Promise<void>;
  setWeekTask(week: string, taskId: Id, on: boolean): Promise<void>;
  setPeriodTask(periodId: Id, taskId: Id, on: boolean): Promise<void>;
  /** Trades a pairing code for the token. Wrong or expired code → Error, not Unauthorized. */
  pair(code: string): Promise<string>;
}

export const isMock = new URLSearchParams(location.search).has("mock");

const TOKEN = "navarch-phone-token";

export function getToken(): string | null {
  if (isMock) return "mock";
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN, token);
    else localStorage.removeItem(TOKEN);
  } catch {
    /* private mode: the token lives for this page only */
  }
}

async function post<T>(cmd: string, args: Record<string, unknown> = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api/${cmd}`, { method: "POST", headers, body: JSON.stringify(args), cache: "no-store" });
  } catch {
    throw new Offline();
  }
  if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 504) throw new Offline();
  let body: unknown;
  try {
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw new Error();
    body = await res.json();
  } catch {
    throw new Offline();
  }
  if (res.status === 401 && auth) throw new Unauthorized();
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return body as T;
}

const httpApi: PhoneApi = {
  ping: () => post("ping"),
  getSnapshot: () => post("get_snapshot"),
  getSessions: () => post("get_sessions"),
  getUsage: () => post("get_usage"),
  getLimitAlerts: () => post("get_limit_alerts"),
  createTask: (projectId, parentId, title, afterId) => post("create_task", { projectId, parentId, title, afterId: afterId ?? null }),
  updateTask: (id, patch) => post("update_task", { id, patch }),
  deleteTask: (id) => post("delete_task", { id }),
  restoreTask: (id) => post("restore_task", { id }),
  setWeekTask: (week, taskId, on) => post("set_week_task", { week, taskId, on }),
  setPeriodTask: (periodId, taskId, on) => post("set_period_task", { periodId, taskId, on }),
  pair: async (code) => {
    const r = await post<{ token: string }>("pair", { code }, false).catch((e) => {
      throw e instanceof Offline ? e : new Error("Wrong or expired code. Make a new one on your Mac.");
    });
    return r.token;
  },
};

async function mock(): Promise<PhoneApi> {
  const { mockApi } = await import("../../../src/api/mock");
  const m = mockApi();
  return {
    ping: async () => ({ ok: true }),
    getSnapshot: () => m.getSnapshot(),
    getSessions: () => m.getSessions(),
    getUsage: () => m.getUsage(false),
    getLimitAlerts: () => m.getLimitAlerts(),
    createTask: (p, parent, title, after) => m.createTask(p, parent, title, after),
    updateTask: (id, patch) => m.updateTask(id, patch),
    deleteTask: (id) => m.deleteTask(id),
    restoreTask: (id) => m.restoreTask(id),
    setWeekTask: (w, t, on) => m.setWeekTask(w, t, on),
    setPeriodTask: (p, t, on) => m.setPeriodTask(p, t, on),
    pair: async () => "mock",
  };
}

/** Resolved once: the mock is only loaded (and bundled into its own chunk) for ?mock. */
const ready: Promise<PhoneApi> = isMock ? mock() : Promise.resolve(httpApi);

/** Every call goes through here, so callers don't care which backend answered. */
export const api: PhoneApi = new Proxy({} as PhoneApi, {
  get: (_, key: keyof PhoneApi) =>
    (...a: unknown[]) =>
      ready.then((impl) => (impl[key] as (...x: unknown[]) => Promise<unknown>)(...a)),
});
