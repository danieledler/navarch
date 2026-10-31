// Derived, read-only view of the snapshot + live sessions: trees, rollups, attention counts.
import type { Id, Period, Project, Session, Snapshot, Space, Task } from "../api";
import { addDays, isoWeek, today, weekStart } from "./dates";

export interface Totals {
  ms: number;
  tokens: number;
}

const ATTENTION = new Set(["needs_input", "unread"]);
export const needsAttention = (s: Session) => !s.archived && ATTENTION.has(s.status);
export const isLive = (s: Session) => s.status === "working" || s.status === "needs_input";

export interface Model {
  spaces: Space[];
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  space: Map<Id, Space>;
  project: Map<Id, Project>;
  task: Map<Id, Task>;
  children: (projectId: Id, parentId: Id | null) => Task[];
  ancestors: (taskId: Id) => Task[];
  descendants: (taskId: Id) => Task[];
  projectOf: Map<string, Id>; // session id -> project id
  sessionsOfTask: Map<Id, Session[]>; // direct links only
  sessionsOfProject: Map<Id, Session[]>;
  taskTotal: (taskId: Id, from?: string, to?: string) => Totals; // including subtasks
  projectTotal: (projectId: Id, from?: string, to?: string) => Totals;
  progress: (taskId: Id) => { done: number; total: number };
  attentionOfSpace: Map<Id, number>;
  attentionOfProject: Map<Id, number>;
  attentionTotal: number;
  cpuOfProject: Map<Id, number>; // summed CPU % of its sessions' processes, detached jobs included
  tokenRateOfProject: Map<Id, number>; // tokens its sessions wrote in the last minute
  period: Period | null; // the period covering today, else the latest one
  periodTasks: Set<Id>;
  week: string;
  weekStart: string;
  weekTasks: (week: string) => Set<Id>;
}

export function sessionTotal(s: Session, from?: string, to?: string): Totals {
  if (!from) return { ms: s.activeMs, tokens: s.tokens };
  let ms = 0;
  let tokens = 0;
  for (const d of s.days) {
    if (d.day >= from && d.day <= (to ?? "9999")) {
      ms += d.activeMs;
      tokens += d.tokens;
    }
  }
  return { ms, tokens };
}

export function buildModel(snap: Snapshot, sessions: Session[]): Model {
  const space = new Map(snap.spaces.map((s) => [s.id, s]));
  const project = new Map(snap.projects.map((p) => [p.id, p]));
  const task = new Map(snap.tasks.map((t) => [t.id, t]));

  const kids = new Map<string, Task[]>();
  for (const t of snap.tasks) {
    const k = `${t.projectId}:${t.parentId ?? 0}`;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(t);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort - b.sort);
  const children = (projectId: Id, parentId: Id | null) => kids.get(`${projectId}:${parentId ?? 0}`) ?? [];

  const ancestors = (id: Id) => {
    const out: Task[] = [];
    let t = task.get(id);
    while (t?.parentId != null) {
      t = task.get(t.parentId);
      if (t) out.unshift(t);
    }
    return out;
  };
  const descendants = (id: Id): Task[] => {
    const t = task.get(id);
    return t ? children(t.projectId, id).flatMap((c) => [c, ...descendants(c.id)]) : [];
  };

  // Longest matching folder wins, so nested projects and .claude/worktrees resolve correctly.
  const byLength = [...snap.projects].sort((a, b) => b.path.length - a.path.length);
  const projectOf = new Map<string, Id>();
  const sessionsOfProject = new Map<Id, Session[]>();
  const sessionsOfTask = new Map<Id, Session[]>();
  for (const s of sessions) {
    const linked = s.taskId != null ? task.get(s.taskId) : undefined;
    const cwd = s.launchPath ?? s.cwd;
    const p = linked ? project.get(linked.projectId) : byLength.find((p) => cwd === p.path || cwd.startsWith(p.path + "/"));
    if (p) {
      projectOf.set(s.id, p.id);
      (sessionsOfProject.get(p.id) ?? sessionsOfProject.set(p.id, []).get(p.id)!).push(s);
    }
    if (linked) (sessionsOfTask.get(linked.id) ?? sessionsOfTask.set(linked.id, []).get(linked.id)!).push(s);
  }
  for (const list of [...sessionsOfProject.values(), ...sessionsOfTask.values()])
    list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const sum = (list: Session[], from?: string, to?: string) =>
    list.reduce<Totals>(
      (acc, s) => {
        const t = sessionTotal(s, from, to);
        return { ms: acc.ms + t.ms, tokens: acc.tokens + t.tokens };
      },
      { ms: 0, tokens: 0 },
    );
  const taskTotal = (id: Id, from?: string, to?: string) =>
    sum([id, ...descendants(id).map((d) => d.id)].flatMap((tid) => sessionsOfTask.get(tid) ?? []), from, to);
  const projectTotal = (id: Id, from?: string, to?: string) => sum(sessionsOfProject.get(id) ?? [], from, to);

  const progress = (id: Id) => {
    const ds = descendants(id);
    if (!ds.length) return { done: task.get(id)?.status === "done" ? 1 : 0, total: 1 };
    return { done: ds.filter((d) => d.status === "done").length, total: ds.length };
  };

  const attentionOfProject = new Map<Id, number>();
  const attentionOfSpace = new Map<Id, number>();
  let attentionTotal = 0;
  for (const s of sessions) {
    const pid = projectOf.get(s.id);
    if (pid == null || !needsAttention(s)) continue;
    const sid = project.get(pid)!.spaceId;
    attentionOfProject.set(pid, (attentionOfProject.get(pid) ?? 0) + 1);
    attentionOfSpace.set(sid, (attentionOfSpace.get(sid) ?? 0) + 1);
    attentionTotal++;
  }

  const cpuOfProject = new Map<Id, number>();
  const tokenRateOfProject = new Map<Id, number>();
  for (const [pid, list] of sessionsOfProject) {
    const cpu = list.reduce((a, s) => a + s.cpu, 0);
    if (cpu > 0) cpuOfProject.set(pid, cpu);
    const rate = list.reduce((a, s) => a + s.tokenRate, 0);
    if (rate > 0) tokenRateOfProject.set(pid, rate);
  }

  const t = today();
  const sortedPeriods = [...snap.periods].sort((a, b) => b.start.localeCompare(a.start));
  const period = sortedPeriods.find((p) => p.start <= t && t <= p.end) ?? sortedPeriods[0] ?? null;
  const periodTasks = new Set(snap.periodTasks.filter((x) => x.periodId === period?.id).map((x) => x.taskId));

  const weekTasks = (week: string) => new Set(snap.weekTasks.filter((w) => w.week === week).map((w) => w.taskId));

  return {
    spaces: [...snap.spaces].sort((a, b) => a.sort - b.sort),
    projects: snap.projects,
    tasks: snap.tasks,
    sessions,
    space, project, task, children, ancestors, descendants,
    projectOf, sessionsOfTask, sessionsOfProject, taskTotal, projectTotal, progress,
    attentionOfSpace, attentionOfProject, attentionTotal, cpuOfProject, tokenRateOfProject,
    period, periodTasks,
    week: isoWeek(t),
    weekStart: weekStart(t),
    weekTasks,
  };
}

export type WeekReason = "pinned" | "deadline" | "worked" | "done";

/**
 * Tasks that belong to a week: pinned by you, due that week, worked on in a linked session, or finished.
 * Ancestors of a listed task are dropped when the task itself is listed, to keep the list short.
 */
export function weekItems(m: Model, start: string, projectIds?: Set<Id>) {
  const end = addDays(start, 6);
  const week = isoWeek(start);
  const pinned = m.weekTasks(week);
  const startMs = new Date(`${start}T00:00:00`).getTime();
  const endMs = new Date(`${end}T23:59:59`).getTime();
  const out = new Map<Id, { task: Task; reasons: WeekReason[]; ms: number }>();
  const add = (t: Task, r: WeekReason) => {
    if (projectIds && !projectIds.has(t.projectId)) return;
    const e = out.get(t.id) ?? { task: t, reasons: [], ms: 0 };
    if (!e.reasons.includes(r)) e.reasons.push(r);
    out.set(t.id, e);
  };
  for (const t of m.tasks) {
    if (pinned.has(t.id)) add(t, "pinned");
    if (t.deadline && t.deadline >= start && t.deadline <= end && t.status === "open") add(t, "deadline");
    if (t.doneAt && t.doneAt >= startMs && t.doneAt <= endMs) add(t, "done");
  }
  for (const [tid, list] of m.sessionsOfTask) {
    const ms = list.reduce((a, s) => a + sessionTotal(s, start, end).ms, 0);
    const t = m.task.get(tid);
    if (t && ms > 0) {
      add(t, "worked");
      const e = out.get(tid);
      if (e) e.ms = ms;
    }
  }
  return [...out.values()].sort(
    (a, b) => Number(a.task.status === "done") - Number(b.task.status === "done") || b.ms - a.ms || a.task.id - b.task.id,
  );
}

/** Context text put in the Claude composer when starting a session for a task. */
export function sessionPrompt(m: Model, t: Task): string {
  const p = m.project.get(t.projectId)!;
  const sp = m.space.get(p.spaceId);
  const chain = [...m.ancestors(t.id).map((a) => a.title), t.title].join(" › ");
  const lines = [`Navarch task #${t.id}: ${t.title}`, `Context: ${sp?.name ?? ""} › ${p.name} › ${chain}`];
  if (t.deadline) lines.push(`Deadline: ${t.deadline}`);
  const open = m.children(t.projectId, t.id).filter((c) => c.status === "open");
  if (open.length) lines.push(`Open subtasks: ${open.map((c) => c.title).join("; ")}`);
  if (t.notes.trim()) lines.push("", t.notes.trim());
  return lines.join("\n") + "\n\n";
}
