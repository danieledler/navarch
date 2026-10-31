import { useEffect, useState } from "react";
import { ChevronRight, Eye, EyeOff, FolderOpen, MessageSquarePlus } from "lucide-react";
import { api, type Id } from "../api";
import { useModel, useStore } from "../store";
import { baseName, fmtDuration, fmtTokens, shortPath } from "../lib/format";
import { SessionRow } from "./SessionRow";
import { TaskTree, visibleRows } from "./TaskTree";
import { useTaskActions } from "./taskActions";

export function ProjectView({ projectId }: { projectId: Id }) {
  const m = useModel();
  const p = m.project.get(projectId)!;
  const collapsed = useStore((s) => s.collapsed);
  const hideDone = useStore((s) => s.hideDone);
  const setHideDone = useStore((s) => s.setHideDone);
  const selected = useStore((s) => s.selectedTask);
  const editing = useStore((s) => s.editing);
  const selectTask = useStore((s) => s.selectTask);
  const setEditing = useStore((s) => s.setEditing);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const newSession = async () => {
    if (!(await run(api.openNewSession(p.path, "").then(() => true)))) return;
    toast(`Claude opened a new session. Pick the folder ${baseName(p.path)} in Claude, then send your first message.`);
  };
  const actions = useTaskActions();
  const [showLoose, setShowLoose] = useState(true);

  const rows = visibleRows(m, projectId, collapsed, hideDone);
  const tasks = m.tasks.filter((t) => t.projectId === projectId);
  const total = m.projectTotal(projectId);
  const week = m.projectTotal(projectId, m.weekStart);
  const sessions = (m.sessionsOfProject.get(projectId) ?? []).filter((s) => !s.archived);
  const loose = sessions.filter((s) => s.taskId == null);
  const doneCount = tasks.filter((t) => t.status === "done").length;

  // Keyboard control of the selected task when no field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (editing != null || el.closest("input, textarea, select, .popover")) return;
      const i = rows.findIndex((r) => r.task.id === selected);
      const cur = rows[i]?.task;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
        if (next) selectTask(next.task.id);
      } else if (!cur) {
        return;
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        actions.startSession(cur);
      } else if (e.key === "Enter") {
        e.preventDefault();
        setEditing(cur.id);
      } else if (e.key === " ") {
        e.preventDefault();
        actions.toggleDone(cur);
      } else if (e.key === "Tab") {
        e.preventDefault();
        actions.addChild(cur);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        actions.remove(cur);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        toggleCollapsed(cur.id, e.key === "ArrowRight");
      } else if (e.key === "Escape") {
        selectTask(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <section className="main" onClick={() => editing == null && selectTask(null)}>
      <header className="main-head" data-tauri-drag-region>
        <div className="mh-title" data-tauri-drag-region>
          <h1>{p.name}</h1>
          <div className="mh-sub">
            <button type="button" className="path-btn" title={`Reveal ${p.path} in Finder`} onClick={() => run(api.revealPath(p.path))}>
              <FolderOpen size={12} /> {shortPath(p.path)}
            </button>
            <span className="mh-stats" title="Active time and tokens of all Claude sessions in this folder">
              {total.ms > 0 ? (
                <>
                  <strong>{fmtDuration(week.ms)}</strong> this week · {fmtDuration(total.ms)} total · {fmtTokens(total.tokens)} tokens
                </>
              ) : (
                "No Claude activity yet"
              )}
            </span>
          </div>
        </div>
        <div className="mh-actions">
          {doneCount > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => setHideDone(!hideDone)} title={hideDone ? "Show finished tasks" : "Hide finished tasks"}>
              {hideDone ? <Eye size={14} /> : <EyeOff size={14} />} {hideDone ? `Show done (${doneCount})` : "Hide done"}
            </button>
          )}
          <button type="button" className="btn" onClick={newSession} title="New Claude session in this folder, not tied to a task">
            <MessageSquarePlus size={14} /> New session
          </button>
        </div>
      </header>

      <div className="main-scroll">
        {tasks.length === 0 ? (
          <EmptyProject projectId={projectId} />
        ) : (
          <TaskTree projectId={projectId} rows={rows} />
        )}

        {loose.length > 0 && (
          <div className="loose">
            <button type="button" className="section-toggle" onClick={(e) => { e.stopPropagation(); setShowLoose(!showLoose); }}>
              <ChevronRight size={14} className={showLoose ? "rot" : ""} />
              Sessions without a task <span className="count">{loose.length}</span>
              <span className="muted small">— assign them so their time counts toward a task</span>
            </button>
            {showLoose && (
              <div className="loose-list" onClick={(e) => e.stopPropagation()}>
                {loose.map((s) => (
                  <SessionRow key={s.id} s={s} assignProject={projectId} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyProject({ projectId }: { projectId: Id }) {
  const actions = useTaskActions();
  return (
    <div className="empty-main" onClick={(e) => e.stopPropagation()}>
      <h3>What is the main goal for this project?</h3>
      <p className="muted">
        Start with something big, like <em>Submit the manuscript</em>, then break it down. Press <kbd>Tab</kbd> on a new line to
        make it a subtask.
      </p>
      <button type="button" className="btn btn-primary" onClick={() => actions.addTop(projectId)}>
        Add the first task
      </button>
    </div>
  );
}
