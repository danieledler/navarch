import { useMemo, useState } from "react";
import { Check, ChevronRight, Folder, FolderInput, Search, Timer } from "lucide-react";
import type { Id, Session } from "../api";
import { useModel, useStore } from "../store";
import { addDays, dayStr, isoWeek, parseDay, today, weekLabel, weekNumber } from "../lib/dates";
import { baseName, fmtDuration, fmtTokens, parentPath, relTime } from "../lib/format";
import { isLive, needsAttention } from "../lib/model";
import { Badge, Menu, StatusDot } from "./ui";
import { SessionRow } from "./SessionRow";
import { useAddProject } from "./ProjectList";
import { useGoToTask } from "./FocusPanel";

export function Dashboard() {
  const m = useModel();
  const waiting = m.sessions
    .filter(needsAttention)
    .sort((a, b) => Number(b.status === "needs_input") - Number(a.status === "needs_input") || b.lastActivityAt - a.lastActivityAt);
  const d = new Date();

  return (
    <section className="main dashboard">
      <header className="main-head" data-tauri-drag-region>
        <div className="mh-title" data-tauri-drag-region>
          <h1>Overview</h1>
          <span className="muted">
            {d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · week {weekNumber(m.week)}
          </span>
        </div>
      </header>
      <div className="main-scroll">
        <SpaceCards />
        <div className="dash-cols">
          <div className="dash-card">
            <h3>
              Waiting for you <Badge n={waiting.length} />
            </h3>
            {waiting.length ? (
              waiting.map((s) => <SessionRow key={s.id} s={s} showContext compact />)
            ) : (
              <p className="hint">Nothing is waiting. Sessions that ask a question or finish a reply you haven’t read show up here.</p>
            )}
          </div>
          <WeekLog />
        </div>
        <Discover />
      </div>
    </section>
  );
}

function SpaceCards() {
  const m = useModel();
  const setView = useStore((s) => s.setView);
  return (
    <div className="space-cards">
      {m.spaces.map((sp) => {
        const projects = m.projects.filter((p) => p.spaceId === sp.id);
        const pids = new Set(projects.map((p) => p.id));
        const open = m.tasks.filter((t) => pids.has(t.projectId) && t.status === "open").length;
        const week = projects.reduce(
          (a, p) => {
            const t = m.projectTotal(p.id, m.weekStart);
            return { ms: a.ms + t.ms, tokens: a.tokens + t.tokens };
          },
          { ms: 0, tokens: 0 },
        );
        const live = m.sessions.filter((s) => !s.archived && isLive(s) && pids.has(m.projectOf.get(s.id) ?? -1));
        return (
          <button key={sp.id} type="button" className="space-card" onClick={() => setView({ kind: "space", spaceId: sp.id })}>
            <span className="sc-bar" style={{ background: sp.color }} />
            <div className="sc-top">
              <span className="sc-name">{sp.name}</span>
              <Badge n={m.attentionOfSpace.get(sp.id) ?? 0} />
            </div>
            <div className="sc-stats">
              <span><strong>{projects.length}</strong> projects</span>
              <span><strong>{open}</strong> open tasks</span>
            </div>
            <div className="sc-week">
              <Timer size={12} /> {fmtDuration(week.ms)} this week · {fmtTokens(week.tokens)} tokens
            </div>
            {live.length > 0 && (
              <div className="sc-live">
                {live.map((s) => <StatusDot key={s.id} status={s.status} size={7} />)} {live.length} running
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function WeekLog() {
  const m = useModel();
  const go = useGoToTask();
  const setView = useStore((s) => s.setView);
  const selectProject = useStore((s) => s.selectProject);
  const byProject = useStore((s) => s.logByProject);
  const setByProject = useStore((s) => s.setLogByProject);
  const [offset, setOffset] = useState(0);
  const start = addDays(m.weekStart, -7 * offset);
  const now = today();

  // Day by day, newest first: tasks finished and tasks worked on (time from their linked sessions).
  // By project, every session in the project counts, linked or not, so nothing is left loose.
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
    .filter((d) => d <= now)
    .reverse()
    .map((day) => {
      const projects = new Map<Id, { ms: number; done: number }>();
      if (byProject) {
        const row = (pid: Id) => projects.get(pid) ?? projects.set(pid, { ms: 0, done: 0 }).get(pid)!;
        for (const s of m.sessions) {
          const pid = m.projectOf.get(s.id);
          const ms = s.days.find((d) => d.day === day)?.activeMs ?? 0;
          if (pid != null && ms > 0) row(pid).ms += ms;
        }
        for (const t of m.tasks) if (t.doneAt && dayStr(new Date(t.doneAt)) === day) row(t.projectId).done++;
        const items = [...projects.entries()]
          .map(([id, r]) => ({ project: m.project.get(id)!, ...r }))
          .filter((r) => r.project)
          .sort((a, b) => b.ms - a.ms || b.done - a.done);
        return { day, items: [], projects: items, loose: 0, total: items.reduce((a, r) => a + r.ms, 0) };
      }
      const rows = new Map<Id, { ms: number; done: boolean }>();
      for (const [tid, list] of m.sessionsOfTask) {
        const ms = list.reduce((a, s) => a + (s.days.find((d) => d.day === day)?.activeMs ?? 0), 0);
        if (ms > 0) rows.set(tid, { ms, done: false });
      }
      for (const t of m.tasks)
        if (t.doneAt && dayStr(new Date(t.doneAt)) === day) rows.set(t.id, { ms: rows.get(t.id)?.ms ?? 0, done: true });
      const loose = m.sessions
        .filter((s) => s.taskId == null && m.projectOf.has(s.id))
        .reduce((a, s) => a + (s.days.find((d) => d.day === day)?.activeMs ?? 0), 0);
      const items = [...rows.entries()]
        .map(([id, r]) => ({ task: m.task.get(id)!, ...r }))
        .filter((r) => r.task)
        .sort((a, b) => Number(b.done) - Number(a.done) || b.ms - a.ms);
      return { day, items, projects: [], loose, total: items.reduce((a, r) => a + r.ms, 0) + loose };
    });
  const weekTotal = days.reduce((a, d) => a + d.total, 0);

  return (
    <div className="dash-card week-log">
      <h3>
        Week log
        <span className="log-toggles">
          <span className="seg">
            <button type="button" className={byProject ? "" : "is-on"} onClick={() => setByProject(false)}>Tasks</button>
            <button type="button" className={byProject ? "is-on" : ""} onClick={() => setByProject(true)}>Projects</button>
          </span>
          <span className="seg">
            <button type="button" className={offset === 0 ? "is-on" : ""} onClick={() => setOffset(0)}>This week</button>
            <button type="button" className={offset === 1 ? "is-on" : ""} onClick={() => setOffset(1)}>Last week</button>
          </span>
        </span>
      </h3>
      <div className="muted small log-range">
        W{weekNumber(isoWeek(start))} · {weekLabel(start)}
        {weekTotal > 0 && ` · ${fmtDuration(weekTotal)} in project sessions`}
      </div>
      {weekTotal === 0 && !days.some((d) => d.items.length || d.projects.length) && (
        <p className="hint">Nothing logged {offset ? "last" : "this"} week. Time from Claude sessions and finished tasks land here.</p>
      )}
      {days
        .filter((d) => d.items.length || d.projects.length || d.loose)
        .map((d) => (
          <div key={d.day} className="log-day">
            <div className="log-day-head">
              <span>{d.day === now ? "Today" : parseDay(d.day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</span>
              <span className="muted">{fmtDuration(d.total)}</span>
            </div>
            <ul className="mini-list">
              {d.items.map(({ task: t, ms, done }) => (
                <li key={t.id} onClick={() => go(t.id)}>
                  {done ? <Check size={13} className="ok" /> : <Timer size={13} className="muted" />}
                  <span className="ml-title">{t.title}</span>
                  <span className="muted small ml-proj">{m.project.get(t.projectId)?.name}</span>
                  <span className="small ml-time">{ms > 0 ? fmtDuration(ms) : done ? "done" : ""}</span>
                </li>
              ))}
              {d.projects.map(({ project: p, ms, done }) => (
                <li
                  key={p.id}
                  onClick={() => {
                    setView({ kind: "space", spaceId: p.spaceId });
                    selectProject(p.spaceId, p.id);
                  }}
                >
                  <Folder size={13} className="muted" />
                  <span className="ml-title">{p.name}</span>
                  {done > 0 && (
                    <span className="muted small ml-proj">
                      <Check size={12} className="ok" /> {done} done
                    </span>
                  )}
                  <span className="small ml-time">{ms > 0 ? fmtDuration(ms) : ""}</span>
                </li>
              ))}
              {d.loose > 0 && (
                <li className="ml-loose" title="Sessions in your projects that are not linked to a task">
                  <Timer size={13} className="muted" />
                  <span className="ml-title muted">Sessions without a task</span>
                  <span className="small ml-time muted">{fmtDuration(d.loose)}</span>
                </li>
              )}
            </ul>
          </div>
        ))}
    </div>
  );
}

/** Strip worktree suffixes so sessions in .claude/worktrees/* group with their repository. */
const folderOf = (cwd: string) => cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, "");

interface Group {
  folder: string;
  sessions: Session[];
  last: number;
  projectId: Id | undefined;
}

function Discover() {
  const m = useModel();
  const go = useStore((s) => s.setView);
  const selectProject = useStore((s) => s.selectProject);
  const addProject = useAddProject();
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [hideImported, setHideImported] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ folder: string; x: number; y: number } | null>(null);

  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    for (const s of m.sessions) {
      if (!archived && s.archived) continue;
      const pid = m.projectOf.get(s.id);
      const folder = pid != null ? m.project.get(pid)!.path : folderOf(s.cwd);
      const g = by.get(folder) ?? { folder, sessions: [], last: 0, projectId: pid };
      g.sessions.push(s);
      g.last = Math.max(g.last, s.lastActivityAt);
      by.set(folder, g);
    }
    const needle = q.trim().toLowerCase();
    return [...by.values()]
      .filter((g) => !(hideImported && g.projectId != null))
      .filter((g) => !needle || g.folder.toLowerCase().includes(needle) || g.sessions.some((s) => s.title.toLowerCase().includes(needle)))
      .map((g) => ({ ...g, sessions: [...g.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt) }))
      .sort((a, b) => b.last - a.last);
  }, [m, q, archived, hideImported]);

  const notImported = groups.filter((g) => g.projectId == null).length;

  return (
    <div className="dash-card discover">
      <h3>
        Discover sessions
        <span className="muted small">
          {groups.length} folders · {notImported} not in a space yet
        </span>
      </h3>
      <div className="discover-bar">
        <label className="search">
          <Search size={13} />
          <input placeholder="Filter folders or session titles" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="check-label"><input type="checkbox" checked={hideImported} onChange={(e) => setHideImported(e.target.checked)} /> Hide imported</label>
        <label className="check-label"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived</label>
      </div>
      <div className="groups">
        {groups.map((g) => {
          const p = g.projectId != null ? m.project.get(g.projectId) : undefined;
          const sp = p && m.space.get(p.spaceId);
          const isOpen = open[g.folder] ?? false;
          const active = g.sessions.filter((s) => isLive(s) || needsAttention(s));
          return (
            <div key={g.folder} className={`group ${isOpen ? "is-open" : ""}`}>
              <div className="group-head" onClick={() => setOpen({ ...open, [g.folder]: !isOpen })}>
                <ChevronRight size={14} className={`caret-icon ${isOpen ? "rot" : ""}`} />
                <span className="g-name">{baseName(g.folder)}</span>
                <span className="g-path" title={g.folder}>{parentPath(g.folder)}</span>
                <span className="g-dots">{active.slice(0, 5).map((s) => <StatusDot key={s.id} status={s.status} size={7} />)}</span>
                <span className="g-count">{g.sessions.length} session{g.sessions.length === 1 ? "" : "s"}</span>
                <span className="g-when">{relTime(g.last)}</span>
                {p && sp ? (
                  <button
                    type="button"
                    className="g-in"
                    onClick={(e) => {
                      e.stopPropagation();
                      go({ kind: "space", spaceId: sp.id });
                      selectProject(sp.id, p.id);
                    }}
                  >
                    <span className="space-dot" style={{ background: sp.color }} /> {sp.name} › {p.name}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (m.spaces.length === 1) addProject(m.spaces[0].id, g.folder);
                      else {
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({ folder: g.folder, x: r.right - 190, y: r.bottom + 4 });
                      }
                    }}
                  >
                    <FolderInput size={13} /> Import…
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="group-body">
                  {g.sessions.map((s) => (
                    <SessionRow key={s.id} s={s} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={m.spaces.map((sp) => ({
            label: `Import into ${sp.name}`,
            icon: <span className="space-dot" style={{ background: sp.color }} />,
            onSelect: () => addProject(sp.id, menu.folder),
          }))}
        />
      )}
    </div>
  );
}

