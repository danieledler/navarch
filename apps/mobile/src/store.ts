// Phone state: the Mac's snapshot, sessions and usage, polled while the app is on screen,
// cached in localStorage so a sleeping Mac still leaves something to read.
import { useMemo } from "react";
import { create } from "zustand";
import type { Session, Snapshot, Task, TaskPatch, Usage } from "@desktop/api/types";
import { buildModel, type Model } from "@desktop/lib/model";
import { api, getToken, isMock, Offline, setToken, Unauthorized } from "./api";

export interface Toast {
  id: number;
  text: string;
  tone?: "error";
  undo?: () => unknown;
}

export interface PhoneState {
  /** Null until paired; "mock" with ?mock. */
  token: string | null;
  /** Why the pairing screen is showing again, e.g. the Mac reset its token. */
  pairNote: string | null;
  snap: Snapshot | null;
  sessions: Session[];
  usage: Usage | null;
  /** When the Mac last answered (ms); with `offline`, the age of what's on screen. */
  updatedAt: number | null;
  offline: boolean;
  /** False until the Mac answers once after launch: until then the screen shows the cache. */
  fresh: boolean;
  /** Why the last poll failed, when the Mac answered with an error; cleared by the next good poll. */
  pollError: string | null;
  loading: boolean;
  toasts: Toast[];
  refresh: () => Promise<void>;
  pair: (code: string) => Promise<void>;
  unpair: () => void;
  /** Run a mutation, then refresh; failures become an error toast and resolve to undefined. */
  run: <T>(p: () => Promise<T>) => Promise<T | undefined>;
  /** Marks done or reopens, at once on screen, with an Undo toast that restores the previous status. */
  setStatus: (t: Task, status: Task["status"]) => Promise<void>;
  toast: (text: string, undo?: () => unknown, tone?: "error") => void;
  dismiss: (id: number) => void;
}

const CACHE = "navarch-phone-cache";
export const POLL_MS = 15_000;

interface Cache {
  snap: Snapshot;
  sessions: Session[];
  usage: Usage | null;
  at: number;
}

function loadCache(): Cache | null {
  if (isMock) return null;
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? "null");
  } catch {
    return null;
  }
}

function saveCache(c: Cache | null) {
  if (isMock) return;
  try {
    if (c) localStorage.setItem(CACHE, JSON.stringify(c));
    else localStorage.removeItem(CACHE);
  } catch {
    /* full or private: the next poll fills the screen anyway */
  }
}

const cached = loadCache();
let toastSeq = 0;
// A poll that started before a local edit would put the old value back: count edits and drop such polls.
let edits = 0;
let inflight: Promise<void> | null = null;
// While a mutation is on its way, polls would read the old value: they wait for its own refresh.
let pending = 0;

export const useStore = create<PhoneState>((set, get) => {
  const fail = (e: unknown) => {
    if (e instanceof Unauthorized) {
      setToken(null);
      saveCache(null);
      set({ token: null, snap: null, sessions: [], usage: null, updatedAt: null, pairNote: "Navarch on your Mac no longer knows this phone. Pair it again." });
    } else if (e instanceof Offline) {
      set({ offline: true });
    } else {
      get().toast(e instanceof Error ? e.message : String(e), undefined, "error");
    }
  };

  return {
    token: getToken(),
    pairNote: null,
    snap: cached?.snap ?? null,
    sessions: cached?.sessions ?? [],
    usage: cached?.usage ?? null,
    updatedAt: cached?.at ?? null,
    offline: false,
    fresh: false,
    pollError: null,
    loading: false,
    toasts: [],

    refresh: () => {
      if (!get().token || pending) return Promise.resolve();
      inflight ??= (async () => {
        const startEdits = edits;
        const token = get().token;
        set({ loading: true });
        try {
          const [snap, sessions, usage] = await Promise.all([
            api.getSnapshot(),
            api.getSessions(),
            api.getUsage().catch((e) => {
              if (e instanceof Unauthorized || e instanceof Offline) throw e;
              return get().usage; // usage is extra: its failure mustn't hide the rest
            }),
          ]);
          if (get().token !== token) return; // unpaired (or paired again) meanwhile: this answer is stale
          if (edits !== startEdits) return; // an edit's own refresh follows
          const at = Date.now();
          set({ snap, sessions, usage, updatedAt: at, offline: false, fresh: true, pollError: null });
          saveCache({ snap, sessions, usage, at });
        } catch (e) {
          if (get().token !== token) return;
          // A poll's error is a state shown in the banner, not a toast every 15 s.
          if (e instanceof Unauthorized || e instanceof Offline) fail(e);
          else set({ pollError: e instanceof Error ? e.message : String(e) });
        } finally {
          set({ loading: false });
          inflight = null;
        }
      })();
      return inflight;
    },

    pair: async (code) => {
      const token = await api.pair(code.trim().toUpperCase());
      setToken(token);
      set({ token, pairNote: null });
      await get().refresh();
    },

    unpair: () => {
      setToken(null);
      saveCache(null);
      set({ token: null, pairNote: null, snap: null, sessions: [], usage: null, updatedAt: null, offline: false, fresh: false, pollError: null });
    },

    run: async (p) => {
      edits++;
      pending++;
      try {
        const r = await p();
        return r;
      } catch (e) {
        fail(e);
        if (e instanceof Offline) get().toast("Your Mac is offline: that change wasn't saved", undefined, "error");
        return undefined;
      } finally {
        pending--;
        await waitIdle();
        await get().refresh();
      }
    },

    setStatus: async (t, status) => {
      const prev = t.status;
      if (prev === status) return;
      const patchLocal = (s: Task["status"], doneAt: number | null) =>
        set((st) =>
          st.snap ? { snap: { ...st.snap, tasks: st.snap.tasks.map((x) => (x.id === t.id ? { ...x, status: s, doneAt } : x)) } } : {},
        );
      // On screen at once; put back if the Mac didn't take it (offline, the refresh can't correct it).
      const apply = async (s: Task["status"], back: Pick<Task, "status" | "doneAt">) => {
        patchLocal(s, s === "done" ? Date.now() : null);
        const patch: TaskPatch = { status: s };
        const r = await get().run(() => api.updateTask(t.id, patch));
        if (r === undefined) patchLocal(back.status, back.doneAt);
        return r;
      };
      const ok = await apply(status, { status: prev, doneAt: t.doneAt });
      if (ok === undefined) return;
      get().toast(status === "done" ? `Done: ${t.title}` : `Reopened: ${t.title}`, () => apply(prev, ok));
    },

    toast: (text, undo, tone) => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-1), { id, text, undo, tone }] }));
      setTimeout(() => get().dismiss(id), undo ? 6000 : 3500);
    },
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});

/** Lets a poll that's already on its way finish before an edit's refresh starts. */
const waitIdle = () => inflight?.catch(() => {}) ?? Promise.resolve();

let started = false;
/** Polls every 15 s while the app is visible; refreshes when it comes back to the foreground. */
export function startPolling() {
  if (started) return;
  started = true;
  const tick = () => {
    if (document.visibilityState === "visible") useStore.getState().refresh();
  };
  tick();
  setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
  window.addEventListener("online", tick);
}

/** The derived model, rebuilt only when the snapshot or the sessions change. */
export function useModel(): Model | null {
  const snap = useStore((s) => s.snap);
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => (snap ? buildModel(snap, sessions) : null), [snap, sessions]);
}
