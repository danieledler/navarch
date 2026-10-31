import { useRef, useState } from "react";
import { Check, Clock, MoreHorizontal, Pencil, Pin, Plus, Target, Timer, Trash2 } from "lucide-react";
import { api, type Id, type Period, type Task } from "../api";
import { useModel, useStore } from "../store";
import { addDays, daysBetween, isoWeek, shortDate, today, weekLabel, weekNumber } from "../lib/dates";
import { deadlineInfo, fmtDuration } from "../lib/format";
import { isLive, needsAttention, weekItems, type WeekReason } from "../lib/model";
import { MenuButton, Popover, StatusDot } from "./ui";
import { useTaskActions } from "./taskActions";

export function useGoToTask() {
  const m = useModel();
  const setView = useStore((s) => s.setView);
  const selectProject = useStore((s) => s.selectProject);
  const selectTask = useStore((s) => s.selectTask);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  return (taskId: Id) => {
    const t = m.task.get(taskId);
    const p = t && m.project.get(t.projectId);
    if (!t || !p) return;
    setView({ kind: "space", spaceId: p.spaceId });
    selectProject(p.spaceId, p.id);
    for (const a of m.ancestors(t.id)) toggleCollapsed(a.id, true);
    selectTask(t.id);
    setTimeout(() => document.getElementById(`task-${t.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  };
}

/** Right column: OKR period goals → this week → what's running now, for the current space (or everything). */
export function FocusPanel({ spaceId }: { spaceId: Id | null }) {
  const m = useModel();
  const scope = new Set(m.projects.filter((p) => spaceId == null || p.spaceId === spaceId).map((p) => p.id));
  const inScope = (t: Task) => scope.has(t.projectId);

  return (
    <aside className="focus">
      <header className="col-head" data-tauri-drag-region>
        <h2 data-tauri-drag-region>Focus</h2>
        <span className="muted small" data-tauri-drag-region>{spaceId == null ? "All spaces" : m.space.get(spaceId)?.name}</span>
      </header>
      <div className="focus-scroll">
        <PeriodSection inScope={inScope} />
        <WeekSection scope={scope} />
        <NowSection scope={scope} />
      </div>
    </aside>
  );
}

function PeriodSection({ inScope }: { inScope: (t: Task) => boolean }) {
  const m = useModel();
  const go = useGoToTask();
  const run = useStore((s) => s.run);
  const headRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<Period | "new" | null>(null);
  const p = m.period;

  if (!p) {
    const t = today();
    const half = Number(t.slice(5, 7)) >= 7 ? "H2" : "H1";
    const halfEnd = `${t.slice(0, 4)}-${half === "H1" ? "06-30" : "12-31"}`;
    const create = (name: string, end: string) => run(api.createPeriod(name, t, end));
    return (
      <section className="focus-sec">
        <div className="sec-label"><Target size={13} /> OKR period</div>
        <div className="setup">
          <p>Set the 3–6 month period your goals belong to.</p>
          <div className="setup-btns">
            <button type="button" className="btn" onClick={() => create(`${t.slice(0, 4)} ${half}`, halfEnd)}>
              Rest of {half}
            </button>
            <button type="button" className="btn" onClick={() => create(`${shortDate(t)} – ${shortDate(addDays(t, 91))}`, addDays(t, 91))}>
              Next 3 months
            </button>
            <button type="button" className="btn" onClick={() => create(`${shortDate(t)} – ${shortDate(addDays(t, 182))}`, addDays(t, 182))}>
              Next 6 months
            </button>
          </div>
        </div>
      </section>
    );
  }

  const len = Math.max(1, daysBetween(p.start, p.end));
  const elapsed = Math.min(len, Math.max(0, daysBetween(p.start, today())));
  const left = daysBetween(today(), p.end);
  const goals = m.tasks.filter((t) => m.periodTasks.has(t.id) && inScope(t));
  const goalIds = new Set(goals.flatMap((g) => [g.id, ...m.descendants(g.id).map((d) => d.id)]));
  const deadlines = m.tasks
    .filter((t) => inScope(t) && t.status === "open" && t.deadline && t.deadline >= today() && t.deadline <= p.end && !goalIds.has(t.id))
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!))
    .slice(0, 5);

  return (
    <section className="focus-sec">
      <div className="sec-label" ref={headRef}>
        <Target size={13} /> OKR period
        <span className="sec-fill" />
        <MenuButton
          icon={<MoreHorizontal size={14} />}
          label="Period actions"
          items={[
            { label: "Edit period", icon: <Pencil size={14} />, onSelect: () => setEditing(p) },
            { label: "New period", icon: <Plus size={14} />, onSelect: () => setEditing("new") },
            "sep",
            { label: "Delete period", icon: <Trash2 size={14} />, danger: true, onSelect: async () => (await api.confirm(`Delete the period ${p.name}? Its goal markings are removed; tasks stay.`)) && run(api.deletePeriod(p.id)) },
          ]}
        />
      </div>
      <div className="period-head">
        <span className="period-name">{p.name}</span>
        <span className="muted small">{left >= 0 ? `${left} days left` : "ended"}</span>
      </div>
      <div className="period-bar" title={`${shortDate(p.start)} – ${shortDate(p.end)}, day ${elapsed} of ${len}`}>
        <span style={{ width: `${(100 * elapsed) / len}%` }} />
      </div>
      {goals.length ? (
        <ul className="goal-list">
          {goals.map((g) => (
            <GoalItem key={g.id} task={g} onClick={() => go(g.id)} />
          ))}
        </ul>
      ) : (
        <p className="hint">Star <span className="goal-star">★</span> a task to make it a goal for {p.name}.</p>
      )}
      {deadlines.length > 0 && (
        <>
          <div className="sub-label">Upcoming deadlines</div>
          <ul className="mini-list">
            {deadlines.map((t) => {
              const d = deadlineInfo(t.deadline!);
              return (
                <li key={t.id} onClick={() => go(t.id)}>
                  <div className="wl-main">
                    <span className="wl-title">{t.title}</span>
                    <span className="wl-meta">
                      {m.project.get(t.projectId)?.name}
                      {t.parentId != null && ` › ${m.task.get(t.parentId)?.title}`}
                    </span>
                  </div>
                  <span className={`chip chip-${d.tone}`}>{d.label}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {editing && (
        <PeriodEditor anchor={headRef} period={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

function GoalItem({ task: t, onClick }: { task: Task; onClick: () => void }) {
  const m = useModel();
  const prog = m.progress(t.id);
  const p = m.project.get(t.projectId);
  const dl = t.deadline ? deadlineInfo(t.deadline) : null;
  const pct = prog.total ? (100 * prog.done) / prog.total : 0;
  return (
    <li className={`goal ${t.status === "done" ? "is-done" : ""}`} onClick={onClick}>
      <div className="goal-top">
        <span className="goal-title">{t.title}</span>
        {dl && t.status === "open" && <span className={`chip chip-${dl.tone}`}>{dl.label}</span>}
      </div>
      <div className="goal-meta">
        <span className="muted">{p?.name}</span>
        <span className="goal-bar"><span style={{ width: `${pct}%` }} /></span>
        <span className="muted small">{prog.done}/{prog.total}</span>
      </div>
    </li>
  );
}

const REASON: Record<WeekReason, { icon: React.ReactNode; label: string }> = {
  pinned: { icon: <Pin size={11} />, label: "Pinned to this week" },
  deadline: { icon: <Clock size={11} />, label: "Due this week" },
  worked: { icon: <Timer size={11} />, label: "Worked on this week" },
  done: { icon: <Check size={11} />, label: "Finished this week" },
};

function WeekSection({ scope }: { scope: Set<Id> }) {
  const m = useModel();
  const go = useGoToTask();
  const actions = useTaskActions();
  const items = weekItems(m, m.weekStart, scope);
  return (
    <section className="focus-sec">
      <div className="sec-label">
        <Pin size={13} /> This week <span className="muted">· W{weekNumber(isoWeek(m.weekStart))}</span>
        <span className="sec-fill" />
        <span className="muted small">{weekLabel(m.weekStart)}</span>
      </div>
      {items.length ? (
        <ul className="week-list">
          {items.map(({ task: t, reasons, ms }) => (
            <li key={t.id} className={t.status === "done" ? "is-done" : ""} onClick={() => go(t.id)}>
              <button
                type="button"
                className={`check ${t.status === "done" ? "is-checked" : ""}`}
                aria-label={t.status === "done" ? "Mark as open" : "Mark as done"}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleDone(t);
                }}
              >
                {t.status === "done" && <Check size={11} strokeWidth={3} />}
              </button>
              <div className="wl-main">
                <span className="wl-title">{t.title}</span>
                <span className="wl-meta">
                  {m.project.get(t.projectId)?.name}
                  {reasons.map((r) => (
                    <span key={r} className={`reason reason-${r}`} title={REASON[r].label}>
                      {REASON[r].icon}
                      {r === "worked" ? fmtDuration(ms) : r === "deadline" && t.deadline ? deadlineInfo(t.deadline).label : ""}
                    </span>
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Pin tasks to the week, or just start working: tasks you work on, finish or have due show up here.</p>
      )}
    </section>
  );
}

function NowSection({ scope }: { scope: Set<Id> }) {
  const m = useModel();
  const run = useStore((s) => s.run);
  const live = m.sessions
    .filter((s) => !s.archived && (isLive(s) || needsAttention(s)) && scope.has(m.projectOf.get(s.id) ?? -1))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.lastActivityAt - a.lastActivityAt);
  return (
    <section className="focus-sec">
      <div className="sec-label">
        <Timer size={13} /> Now
      </div>
      {live.length ? (
        <ul className="now-list">
          {live.map((s) => {
            const t = s.taskId != null ? m.task.get(s.taskId) : null;
            return (
              <li key={s.id} onClick={() => run(api.openSession(s.id))} title="Open in Claude">
                <StatusDot status={s.status} />
                <div className="wl-main">
                  <span className="wl-title">{s.title}</span>
                  <span className="wl-meta">{t ? t.title : m.project.get(m.projectOf.get(s.id)!)?.name}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hint">No sessions running or waiting for you.</p>
      )}
    </section>
  );
}

const rank = (s: string) => (s === "needs_input" ? 0 : s === "unread" ? 1 : 2);

function PeriodEditor({ anchor, period, onClose }: { anchor: React.RefObject<HTMLElement | null>; period: Period | null; onClose: () => void }) {
  const run = useStore((s) => s.run);
  const t = today();
  const [name, setName] = useState(period?.name ?? "");
  const [start, setStart] = useState(period?.start ?? t);
  const [end, setEnd] = useState(period?.end ?? addDays(t, 91));
  const valid = name.trim() && start && end && start <= end;
  const save = () => {
    if (!valid) return;
    if (period) run(api.updatePeriod(period.id, name.trim(), start, end));
    else run(api.createPeriod(name.trim(), start, end));
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="period-editor">
      <div className="pop-title">{period ? "Edit OKR period" : "New OKR period"}</div>
      <input autoFocus className="field" placeholder="e.g. 2027 H1" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      <div className="date-pair">
        <label>From<input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>To<input type="date" className="field" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!valid} onClick={save}>Save</button>
      </div>
    </Popover>
  );
}
