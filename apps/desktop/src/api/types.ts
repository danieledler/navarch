// Shared contract between the React UI and the Rust backend (src-tauri).
// Rust structs serialize with serde(rename_all = "camelCase") to match these shapes.

export type Id = number;

export interface Space {
  id: Id;
  name: string;
  color: string; // CSS color, e.g. "#3b82f6"
  sort: number;
}

export interface Project {
  id: Id;
  spaceId: Id;
  name: string;
  path: string; // absolute folder path; sessions whose cwd is inside it belong to the project
  sort: number;
  createdAt: number; // ms since epoch
}

export type TaskStatus = "open" | "done";

export interface Task {
  id: Id;
  projectId: Id;
  parentId: Id | null;
  title: string;
  notes: string; // markdown, sent as context when a session is started for the task
  status: TaskStatus;
  deadline: string | null; // YYYY-MM-DD
  sort: number; // order among siblings (fractional, ascending)
  createdAt: number;
  doneAt: number | null;
}

/** OKR period, e.g. "2026 H2"; start/end are inclusive YYYY-MM-DD. */
export interface Period {
  id: Id;
  name: string;
  start: string;
  end: string;
}

/** Everything the planner owns, loaded in one call (small: hundreds of rows). */
export interface Snapshot {
  spaces: Space[];
  projects: Project[];
  tasks: Task[]; // soft-deleted tasks are excluded
  periods: Period[];
  periodTasks: { periodId: Id; taskId: Id }[];
  weekTasks: { week: string; taskId: Id }[]; // week = ISO week "2026-W44"
}

/**
 * working      – Claude is mid-turn and its process is alive
 * needs_input  – Claude asked a question / plan approval and waits for you
 * unread       – turn finished after you last looked at the session in Claude
 * idle         – turn finished and seen
 * stopped      – turn was cut off (process gone mid-turn)
 */
export type SessionStatus = "working" | "needs_input" | "unread" | "idle" | "stopped";

export interface SessionDay {
  day: string; // local date YYYY-MM-DD
  activeMs: number;
  tokens: number;
}

/** A Claude desktop Code-tab session, read from the app's local files. */
export interface Session {
  id: string; // desktop id "local_…", used in claude://code/continue?session=
  cliId: string; // transcript id (~/.claude/projects/*/<cliId>.jsonl)
  title: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  lastActivityAt: number;
  archived: boolean;
  status: SessionStatus;
  running: boolean;
  procs: number; // processes in the session's tree, plus jobs it left running detached
  cpu: number; // summed CPU % of those processes
  lastPrompt: string | null; // your last message
  lastReply: string | null; // Claude's latest text since that message
  tokens: number; // input + cache writes + output (cache reads excluded)
  tokenRate: number; // tokens of the messages written in the last minute, subagents included
  cacheRead: number;
  activeMs: number; // time with activity gaps <= 5 min
  days: SessionDay[]; // last 21 days
  taskId: Id | null; // linked Navarch task
  tempFolder: boolean; // Claude started it in a temporary folder of its own ("This computer")
  launchPath: string | null; // while it's there: the folder Navarch launched it for
}

export interface SystemStats {
  cpu: number; // total CPU usage 0–100
  cores: number[]; // per logical core, 0–100
  load1: number; // load averages: runnable threads over 1, 5, 15 min
  load5: number;
  load15: number;
  brand: string; // e.g. "Apple M3 Pro"
}

export interface BuildInfo {
  version: string;
  commit: string; // short hash the binary was built from
  branch: string;
  checkout: string; // repo or worktree folder it was built in
  dirty: number; // tracked files with uncommitted changes at build time
  builtAt: number; // unix ms
  devUi: boolean; // UI loaded live from the Vite dev server, not built in
  db: string; // database file: navarch.db, or a dev build's per-checkout copy
}

export interface CpuSample {
  t: number; // unix ms, one every 2 s, last 10 min
  cpu: number;
  load1: number;
}

export interface UsageWindow {
  percent: number; // 0–100
  resetsAt: string | null; // ISO timestamp
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  error: string | null;
  fetchedAt: number;
}

/** At these percentages Navarch tells running sessions to save their work and schedule their resume. */
export interface LimitAlerts {
  fiveHour: number;
  sevenDay: number;
  /** The alert sessions are getting now ("5h at 96%, resets at 14:30"), or null. */
  active: string | null;
  /** Whether ~/.claude/settings.json runs Navarch's limit hook, which hands alerts to sessions. */
  hookInstalled: boolean;
  /** False in dev builds: their alerts go to a file of their own that no hook reads. */
  live: boolean;
}

/** Fields that update_task may change. deadline "" clears it; parentId 0 moves to top level. */
export interface TaskPatch {
  title?: string;
  notes?: string;
  status?: TaskStatus;
  deadline?: string;
  parentId?: Id;
  sort?: number;
}
