import { Check, CalendarCheck } from "lucide-react";
import type { Id, Task } from "@desktop/api/types";
import { deadlineInfo, fmtDuration } from "@desktop/lib/format";
import { weekItems, type Model, type WeekReason } from "@desktop/lib/model";
import { useStore } from "./store";

type Item = { task: Task; reasons: WeekReason[]; ms: number };

/** This week's tasks across every project, grouped by project in space and project order. */
export function Week({ m }: { m: Model }) {
  const items = weekItems(m, m.weekStart, new Set(m.projects.map((p) => p.id)));
  const groups = new Map<Id, Item[]>();
  for (const it of items) (groups.get(it.task.projectId) ?? groups.set(it.task.projectId, []).get(it.task.projectId)!).push(it);
  const spaceSort = (pid: Id) => m.space.get(m.project.get(pid)?.spaceId ?? -1)?.sort ?? 0;
  const order = [...groups.keys()].sort((a, b) => spaceSort(a) - spaceSort(b) || (m.project.get(a)?.sort ?? 0) - (m.project.get(b)?.sort ?? 0));

  if (!items.length)
    return (
      <div className="empty">
        <CalendarCheck size={36} />
        <strong>Nothing planned this week</strong>
        Pin tasks to the week on your Mac, or give them a deadline this week.
      </div>
    );

  return (
    <>
      {order.map((pid) => {
        const p = m.project.get(pid);
        const sp = p ? m.space.get(p.spaceId) : undefined;
        return (
          <div key={pid} className="section">
            <div className="section-label">
              {sp && <span className="space-dot" style={{ background: sp.color }} />}
              {p?.name ?? "Project"}
              {sp && m.spaces.length > 1 && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· {sp.name}</span>}
            </div>
            <div className="group">
              {groups.get(pid)!.map((it) => (
                <TaskRow key={it.task.id} m={m} it={it} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function TaskRow({ m, it }: { m: Model; it: Item }) {
  const setStatus = useStore((s) => s.setStatus);
  const t = it.task;
  const done = t.status === "done";
  const crumbs = m.ancestors(t.id).map((a) => a.title).join(" › ");
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
        {crumbs && <div className="crumbs">{crumbs}</div>}
        {(it.reasons.includes("pinned") || due || it.ms > 0) && (
          <div className="chips">
            {it.reasons.includes("pinned") && <span className="chip chip-pinned">Pinned</span>}
            {due && (
              <span className={`chip ${due.tone === "later" ? "" : `chip-${due.tone}`}`}>
                {due.days < -1 ? due.label : `Due ${Math.abs(due.days) <= 1 ? due.label.toLowerCase() : due.label}`}
              </span>
            )}
            {it.ms > 0 && <span className="chip">{fmtDuration(it.ms)} worked</span>}
          </div>
        )}
      </div>
    </div>
  );
}
