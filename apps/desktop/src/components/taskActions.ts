import { api, type Id, type Session, type Task } from "../api";
import { useModel, useStore } from "../store";
import { baseName } from "../lib/format";
import { sessionPrompt } from "../lib/model";

/** A title quoted for the Edit menu, short enough to keep the menu narrow. */
const named = (title: string) => `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;

/** Task mutations shared by the tree, the detail panel and the focus panel. */
export function useTaskActions() {
  const m = useModel();
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const setEditing = useStore((s) => s.setEditing);
  const selectTask = useStore((s) => s.selectTask);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const flash = useStore((s) => s.flash);

  return {
    toggleDone: async (t: Task) => {
      const status = t.status === "done" ? "open" : "done";
      await run(api.updateTask(t.id, { status }));
      if (status === "done") toast(`Done: ${t.title}`, {
          label: `Mark Done ${named(t.title)}`,
          run: () => run(api.updateTask(t.id, { status: "open" })),
        });
    },
    addChild: async (t: Task) => {
      const c = await run(api.createTask(t.projectId, t.id, ""));
      if (!c) return;
      toggleCollapsed(t.id, true);
      selectTask(c.id);
      setEditing(c.id);
    },
    addSibling: async (t: Task) => {
      const c = await run(api.createTask(t.projectId, t.parentId, "", t.id));
      if (!c) return;
      selectTask(c.id);
      setEditing(c.id);
    },
    addTop: async (projectId: number) => {
      const c = await run(api.createTask(projectId, null, ""));
      if (!c) return;
      selectTask(c.id);
      setEditing(c.id);
    },
    remove: async (t: Task) => {
      const n = m.descendants(t.id).length;
      await run(api.deleteTask(t.id));
      selectTask(null);
      toast(`Deleted “${t.title || "untitled"}”${n ? ` and ${n} subtask${n === 1 ? "" : "s"}` : ""}`, {
        label: `Delete ${named(t.title || "untitled")}`,
        run: () => run(api.restoreTask(t.id)),
      });
    },
    startSession: async (t: Task) => {
      const p = m.project.get(t.projectId)!;
      if (!(await run(api.openNewSession(p.path, sessionPrompt(m, t), t.id).then(() => true)))) return;
      toast(`Claude opened with the task as context. Pick the folder ${baseName(p.path)} in Claude, then send it; the session links to this task.`);
    },
    togglePeriod: async (t: Task) => {
      if (!m.period) {
        toast("Set up an OKR period first (right panel)", undefined, "error");
        return;
      }
      const on = !m.periodTasks.has(t.id);
      await run(api.setPeriodTask(m.period.id, t.id, on));
      toast(on ? `Goal for ${m.period.name}: ${t.title}` : `Removed from ${m.period.name} goals`);
    },
    toggleWeek: async (t: Task) => {
      const on = !m.weekTasks(m.week).has(t.id);
      await run(api.setWeekTask(m.week, t.id, on));
    },
    setDeadline: (t: Task, deadline: string) => run(api.updateTask(t.id, { deadline })),
    linkSession: async (s: Session, taskId: Id | null) => {
      const prev = s.taskId;
      await run(api.linkSession(s.id, taskId));
      const t = taskId != null ? m.task.get(taskId) : undefined;
      if (t) {
        // Open the task so the session lands in view instead of vanishing from the list it left.
        for (const a of m.ancestors(t.id)) toggleCollapsed(a.id, true);
        selectTask(t.id);
      }
      flash(s.id);
      toast(t ? `Linked “${s.title}” to ${t.title}` : `Unlinked “${s.title}”`, {
        label: `${t ? "Link" : "Unlink"} ${named(s.title)}`,
        run: () => run(api.linkSession(s.id, prev)),
      });
    },
  };
}
