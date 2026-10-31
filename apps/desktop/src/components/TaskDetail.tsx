import { useEffect, useState } from "react";
import { CalendarDays, MessageSquarePlus, Star, X } from "lucide-react";
import { api, type Task } from "../api";
import { useModel, useStore } from "../store";
import { fmtDuration, fmtTokens } from "../lib/format";
import { SessionRow } from "./SessionRow";
import { useTaskActions } from "./taskActions";

/**
 * The task's sessions, always listed under its row. When the task is selected (open),
 * notes, deadline and goal toggles and the sessions header expand above them.
 */
export function TaskDetail({ task: t, depth, open }: { task: Task; depth: number; open: boolean }) {
  const m = useModel();
  const run = useStore((s) => s.run);
  const actions = useTaskActions();
  const [notes, setNotes] = useState(t.notes);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => setNotes(t.notes), [t.id, t.notes]);
  useEffect(() => {
    if (!open) setShowArchived(false);
  }, [open]);

  const all = m.sessionsOfTask.get(t.id) ?? [];
  const active = all.filter((s) => !s.archived);
  const archived = all.filter((s) => s.archived);
  // Archived ones go last, so they read as history below the live list.
  const sessions = showArchived ? [...active, ...archived] : active;
  const unassigned = (m.sessionsOfProject.get(t.projectId) ?? []).filter((s) => s.taskId == null && !s.archived);
  const total = m.taskTotal(t.id);
  const week = m.taskTotal(t.id, m.weekStart);
  const prog = m.descendants(t.id).length ? m.progress(t.id) : null;
  const inPeriod = m.periodTasks.has(t.id);
  const inWeek = m.weekTasks(m.week).has(t.id);

  if (!open && !sessions.length) return null;
  return (
    <div className={`task-detail ${open ? "is-open" : ""}`} style={{ marginLeft: 44 + depth * 22 }} onClick={(e) => e.stopPropagation()}>
      {open && (
        <>
          <textarea
            className="notes"
            placeholder="Notes and context — sent to Claude when you start a session for this task"
            value={notes}
            rows={Math.min(8, Math.max(2, notes.split("\n").length))}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== t.notes && run(api.updateTask(t.id, { notes }))}
          />
          <div className="detail-bar">
            <label className="deadline-field" title="Deadline">
              <CalendarDays size={14} />
              {!t.deadline && <span className="muted">Deadline</span>}
              <input type="date" value={t.deadline ?? ""} onChange={(e) => actions.setDeadline(t, e.target.value)} />
              {t.deadline && (
                <button type="button" className="icon-btn" aria-label="Clear deadline" onClick={() => actions.setDeadline(t, "")}>
                  <X size={13} />
                </button>
              )}
            </label>
            <button type="button" className={`toggle ${inPeriod ? "is-on goal" : ""}`} onClick={() => actions.togglePeriod(t)}
              title={m.period ? `Goal for ${m.period.name}` : "Set up an OKR period first"}>
              <Star size={13} fill={inPeriod ? "currentColor" : "none"} /> OKR goal
            </button>
            <button type="button" className={`toggle ${inWeek ? "is-on" : ""}`} onClick={() => actions.toggleWeek(t)}>
              <CalendarDays size={13} /> This week
            </button>
            <span className="detail-stats">
              {prog && <span>{prog.done}/{prog.total} subtasks done</span>}
              {total.ms > 0 && (
                <span title="Including subtasks">
                  {fmtDuration(total.ms)} · {fmtTokens(total.tokens)} tokens
                  {week.ms > 0 && week.ms < total.ms && <span className="muted"> ({fmtDuration(week.ms)} this week)</span>}
                </span>
              )}
            </span>
          </div>
          <div className="detail-sessions-head">
            <span className="sec-label">Sessions{active.length > 0 && <span className="count">{active.length}</span>}</span>
            {archived.length > 0 && (
              <button type="button" className="link" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Hide" : "Show"} {archived.length} archived
              </button>
            )}
            <span className="row-fill" />
            {unassigned.length > 0 && (
              <select
                className="assign"
                value=""
                onChange={(e) => {
                  const s = unassigned.find((u) => u.id === e.target.value);
                  if (s) actions.linkSession(s, t.id);
                }}
              >
                <option value="">Link existing…</option>
                {unassigned.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn btn-small btn-primary" onClick={() => actions.startSession(t)} title="Open Claude in this project with the task as context (⌘↵)">
              <MessageSquarePlus size={13} /> New session
            </button>
          </div>
        </>
      )}
      {sessions.length > 0 && (
        <div className="detail-sessions">
          {sessions.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
