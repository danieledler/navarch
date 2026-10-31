import { Check, Target } from "lucide-react";
import type { Task } from "../../../src/api/types";
import { daysBetween, shortDate, today } from "../../../src/lib/dates";
import { deadlineInfo } from "../../../src/lib/format";
import type { Model } from "../../../src/lib/model";
import { useStore } from "./store";

/** "12 days left" / "ends today" / "ended", for the header and the period card. */
export function periodLeft(m: Model): string | undefined {
  const p = m.period;
  if (!p) return undefined;
  const left = daysBetween(today(), p.end);
  return left > 1 ? `${left} days left` : left === 1 ? "1 day left" : left === 0 ? "ends today" : "ended";
}

/** The current OKR period's goals (tasks starred on the Mac), with their progress; tick one off like on Week. */
export function Goals({ m }: { m: Model }) {
  const p = m.period;
  if (!p)
    return (
      <div className="empty">
        <Target size={36} />
        <strong>No OKR period yet</strong>
        Set up the 3–6 month period your goals belong to on your Mac, in the Focus column.
      </div>
    );

  const len = Math.max(1, daysBetween(p.start, p.end));
  const elapsed = Math.min(len, Math.max(0, daysBetween(p.start, today())));
  const goals = m.tasks.filter((t) => m.periodTasks.has(t.id));
  const open = goals.filter((g) => g.status !== "done");
  const done = goals.filter((g) => g.status === "done");

  return (
    <>
      <div className="section">
        <div className="group period-card">
          <div className="period-top">
            <span className="period-name">{p.name}</span>
            <span className="muted">{periodLeft(m)}</span>
          </div>
          <div className="meter" role="img" aria-label={`Day ${elapsed} of ${len}`}>
            <span style={{ width: `${(100 * elapsed) / len}%` }} />
          </div>
          <div className="period-dates muted">
            <span>{shortDate(p.start)}</span>
            <span>
              Day {elapsed} of {len}
            </span>
            <span>{shortDate(p.end)}</span>
          </div>
        </div>
      </div>
      {!goals.length ? (
        <div className="empty">
          <Target size={36} />
          <strong>No goals for {p.name}</strong>
          Star a task on your Mac to make it a goal for this period.
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="section">
              <div className="section-label">Goals · {open.length} open</div>
              <div className="group">
                {open.map((g) => (
                  <GoalRow key={g.id} m={m} t={g} />
                ))}
              </div>
            </div>
          )}
          {done.length > 0 && (
            <div className="section">
              <div className="section-label">Reached · {done.length}</div>
              <div className="group">
                {done.map((g) => (
                  <GoalRow key={g.id} m={m} t={g} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function GoalRow({ m, t }: { m: Model; t: Task }) {
  const setStatus = useStore((s) => s.setStatus);
  const done = t.status === "done";
  const prog = m.progress(t.id);
  const leaf = !m.descendants(t.id).length;
  const pct = (100 * prog.done) / Math.max(1, prog.total);
  const project = m.project.get(t.projectId);
  const sp = project ? m.space.get(project.spaceId) : undefined;
  const crumbs = [project?.name, ...m.ancestors(t.id).map((a) => a.title)].filter(Boolean).join(" › ");
  const due = t.deadline && !done ? deadlineInfo(t.deadline) : null;
  return (
    <div className={`task-row ${done ? "is-done" : ""}`}>
      <button
        type="button"
        className="check"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${t.title}` : `Mark ${t.title} done`}
        onClick={() => setStatus(t, done ? "open" : "done")}
      >
        <span className="check-box">
          <Check size={15} strokeWidth={3} />
        </span>
      </button>
      <div className="task-main">
        <div className="task-title">{t.title}</div>
        <div className="crumbs">
          {sp && <span className="space-dot" style={{ background: sp.color, marginRight: 6 }} />}
          {crumbs}
        </div>
        <div className="goal-progress">
          <span className="meter meter-thin" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="muted">{leaf ? (done ? "Done" : "No subtasks") : `${prog.done}/${prog.total} done`}</span>
          {due && <span className={`chip ${due.tone === "later" ? "" : `chip-${due.tone}`}`}>{due.label}</span>}
        </div>
      </div>
    </div>
  );
}
