import { useEffect, useRef, useState } from "react";
import { CalendarDays, Check, ChevronRight, MoreHorizontal, Play, Plus, Star, Trash2 } from "lucide-react";
import { api, type Id, type Task } from "../api";
import { useModel, useStore } from "../store";
import { deadlineInfo, fmtDuration, fmtTokens } from "../lib/format";
import { isLive, needsAttention, type Model } from "../lib/model";
import { IconButton, MenuButton, StatusDot } from "./ui";
import { useTaskActions } from "./taskActions";
import { TaskDetail } from "./TaskDetail";

export interface Row {
  task: Task;
  depth: number;
  hasKids: boolean;
}

export function visibleRows(m: Model, projectId: Id, collapsed: Record<Id, true>, hideDone: boolean): Row[] {
  const rows: Row[] = [];
  const walk = (parent: Id | null, depth: number) => {
    for (const t of m.children(projectId, parent)) {
      if (hideDone && t.status === "done") continue;
      const hasKids = m.children(projectId, t.id).length > 0;
      rows.push({ task: t, depth, hasKids });
      if (hasKids && !collapsed[t.id]) walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function TaskTree({ projectId, rows }: { projectId: Id; rows: Row[] }) {
  const selected = useStore((s) => s.selectedTask);
  const editing = useStore((s) => s.editing);
  const actions = useTaskActions();

  return (
    <div className="tree" role="tree">
      {rows.map((r, i) => (
        <div key={r.task.id}>
          <TaskRow row={r} rows={rows} index={i} selected={selected === r.task.id} editing={editing === r.task.id} />
          <TaskDetail task={r.task} depth={r.depth} open={selected === r.task.id && editing !== r.task.id} />
        </div>
      ))}
      <button type="button" className="add-task" onClick={() => actions.addTop(projectId)}>
        <Plus size={15} /> Add task
      </button>
      {editing != null && (
        <div className="kbd-hint">
          <kbd>↵</kbd> new task <kbd>Tab</kbd> make subtask <kbd>⇧Tab</kbd> outdent <kbd>⌥↑↓</kbd> reorder <kbd>Esc</kbd> done
        </div>
      )}
    </div>
  );
}

function TaskRow({ row, rows, index, selected, editing }: { row: Row; rows: Row[]; index: number; selected: boolean; editing: boolean }) {
  const { task: t, depth, hasKids } = row;
  const m = useModel();
  const collapsed = useStore((s) => !!s.collapsed[t.id]);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const selectTask = useStore((s) => s.selectTask);
  const setEditing = useStore((s) => s.setEditing);
  const actions = useTaskActions();

  const total = m.taskTotal(t.id);
  const sessions = [t.id, ...m.descendants(t.id).map((d) => d.id)].flatMap((id) => m.sessionsOfTask.get(id) ?? []);
  const live = sessions.filter((s) => !s.archived && (isLive(s) || needsAttention(s)));
  const dl = t.deadline ? deadlineInfo(t.deadline) : null;
  const inPeriod = m.periodTasks.has(t.id);
  const inWeek = m.weekTasks(m.week).has(t.id);
  const prog = hasKids ? m.progress(t.id) : null;

  return (
    <div
      className={`task-row ${selected ? "is-selected" : ""} ${t.status === "done" ? "is-done" : ""} ${editing ? "is-editing" : ""}`}
      style={{ paddingLeft: 10 + depth * 22 }}
      id={`task-${t.id}`}
      role="treeitem"
      aria-selected={selected}
      onClick={(e) => {
        e.stopPropagation();
        selectTask(selected && !editing ? null : t.id);
      }}
      onDoubleClick={() => setEditing(t.id)}
    >
      {hasKids ? (
        <button
          type="button"
          className={`caret ${collapsed ? "" : "is-open"}`}
          aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(t.id);
          }}
        >
          <ChevronRight size={14} />
        </button>
      ) : (
        <span className="caret-space" />
      )}
      <button
        type="button"
        className={`check ${t.status === "done" ? "is-checked" : ""}`}
        aria-label={t.status === "done" ? "Mark as open" : "Mark as done"}
        title={t.status === "done" ? "Mark as open" : "Mark as done"}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleDone(t);
        }}
      >
        {t.status === "done" && <Check size={11} strokeWidth={3} />}
      </button>
      {editing ? (
        <TitleEditor task={t} rows={rows} index={index} />
      ) : (
        <span className={`task-title ${t.title ? "" : "is-empty"}`}>{t.title || "Untitled"}</span>
      )}
      {!editing && (
        <span className="task-chips">
          {prog && prog.total > 0 && (
            <span className="progress-mini" title={`${prog.done} of ${prog.total} subtasks done`}>
              <span style={{ width: `${(100 * prog.done) / prog.total}%` }} />
            </span>
          )}
          {dl && t.status === "open" && <span className={`chip chip-${dl.tone}`} title={`Deadline ${t.deadline}`}>{dl.label}</span>}
          {inPeriod && <Star size={13} className="goal-star" fill="currentColor" aria-label="OKR goal" />}
          {inWeek && <span className="chip chip-week" title="Pinned to this week">This week</span>}
        </span>
      )}
      <span className="row-fill" />
      {live.length > 0 && (
        <span className="row-dots" title={`${live.length} active session${live.length === 1 ? "" : "s"}`}>
          {live.slice(0, 4).map((s) => (
            <StatusDot key={s.id} status={s.status} size={7} />
          ))}
        </span>
      )}
      <span className="row-actions">
        <IconButton icon={<Plus size={15} />} label="Add subtask" onClick={() => actions.addChild(t)} />
        <IconButton icon={<Play size={14} />} label="Start a Claude session for this task" onClick={() => actions.startSession(t)} />
        <IconButton
          icon={<Star size={14} />}
          label={inPeriod ? "Remove from OKR goals" : "Make it a goal for this OKR period"}
          active={inPeriod}
          onClick={() => actions.togglePeriod(t)}
        />
        <IconButton icon={<CalendarDays size={14} />} label={inWeek ? "Unpin from this week" : "Pin to this week"} active={inWeek} onClick={() => actions.toggleWeek(t)} />
        <MenuButton
          icon={<MoreHorizontal size={15} />}
          label="More"
          items={[
            { label: "Rename", onSelect: () => setEditing(t.id), hint: "↵" },
            { label: "Add task below", icon: <Plus size={14} />, onSelect: () => actions.addSibling(t) },
            "sep",
            { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => actions.remove(t), hint: "⌫" },
          ]}
        />
      </span>
      <span className="row-total" title={total.ms ? `${fmtDuration(total.ms)} · ${total.tokens.toLocaleString()} tokens, including subtasks` : undefined}>
        {total.ms > 0 && (
          <>
            {fmtDuration(total.ms)} <span className="muted">· {fmtTokens(total.tokens)}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** Outliner-style title editing: Enter adds a sibling, Tab/Shift-Tab indent, arrows move between rows. */
function TitleEditor({ task: t, rows, index }: { task: Task; rows: Row[]; index: number }) {
  const m = useModel();
  const run = useStore((s) => s.run);
  const setEditing = useStore((s) => s.setEditing);
  const selectTask = useStore((s) => s.selectTask);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const [draft, setDraft] = useState(t.title);
  const handled = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const pid = t.projectId;
  const sibs = m.children(pid, t.parentId);
  const i = sibs.findIndex((x) => x.id === t.id);

  /** Save the title; a brand-new task left empty is discarded. Returns false if the task was discarded. */
  const commit = async (extra: Parameters<typeof api.updateTask>[1] = {}) => {
    handled.current = true;
    const title = draft.trim();
    if (!title && !t.title && !m.children(pid, t.id).length) {
      await run(api.deleteTask(t.id));
      return false;
    }
    const patch = { ...extra, ...(title && title !== t.title ? { title } : {}) };
    if (Object.keys(patch).length) await run(api.updateTask(t.id, patch));
    return true;
  };

  // Moving a row re-orders DOM nodes, which can drop focus; stay in edit mode and refocus.
  const keepEditing = () => {
    setEditing(t.id);
    requestAnimationFrame(() => {
      ref.current?.focus();
      handled.current = false;
    });
  };

  const editRow = (j: number) => {
    const r = rows[j];
    if (r) {
      selectTask(r.task.id);
      setEditing(r.task.id);
    } else setEditing(null);
  };

  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    const k = e.key;
    if (k === "Enter") {
      e.preventDefault();
      if (!(await commit())) return setEditing(null);
      const c = await run(api.createTask(pid, t.parentId, "", t.id));
      if (c) {
        selectTask(c.id);
        setEditing(c.id);
      }
    } else if (k === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (i <= 0) return;
      const prev = sibs[i - 1];
      const last = m.children(pid, prev.id).at(-1);
      toggleCollapsed(prev.id, true);
      await commit({ parentId: prev.id, sort: (last?.sort ?? 0) + 1 });
      keepEditing();
    } else if (k === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (t.parentId == null) return;
      const parent = m.task.get(t.parentId)!;
      const ps = m.children(pid, parent.parentId);
      const next = ps[ps.findIndex((x) => x.id === parent.id) + 1];
      await commit({ parentId: parent.parentId ?? 0, sort: next ? (parent.sort + next.sort) / 2 : parent.sort + 1 });
      keepEditing();
    } else if (e.altKey && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      const up = k === "ArrowUp";
      if (up ? i <= 0 : i >= sibs.length - 1) return;
      const sort = up
        ? sibs[i - 2] ? (sibs[i - 2].sort + sibs[i - 1].sort) / 2 : sibs[i - 1].sort - 1
        : sibs[i + 2] ? (sibs[i + 1].sort + sibs[i + 2].sort) / 2 : sibs[i + 1].sort + 1;
      await commit({ sort });
      keepEditing();
    } else if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const kept = await commit();
      editRow(k === "ArrowUp" ? index - 1 : kept ? index + 1 : index);
    } else if (k === "Escape") {
      e.preventDefault();
      await commit();
      setEditing(null);
    } else if (k === "Backspace" && draft === "" && !m.children(pid, t.id).length) {
      e.preventDefault();
      handled.current = true;
      await run(api.deleteTask(t.id));
      editRow(index - 1);
    }
  };

  return (
    <input
      ref={ref}
      className="title-input"
      value={draft}
      placeholder="Task name"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (!handled.current) commit().then(() => setEditing(null));
      }}
    />
  );
}
