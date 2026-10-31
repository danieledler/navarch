import { useEffect, useRef } from "react";
import { Cpu, ExternalLink, Link2Off, MoreHorizontal } from "lucide-react";
import { api, type Id, type Session, type Task } from "../api";
import { useModel, useStore } from "../store";
import { baseName, fmtDuration, fmtTokens, plainText, relTime } from "../lib/format";
import type { Model } from "../lib/model";
import { MenuButton, STATUS_LABEL, StatusDot } from "./ui";
import { useTaskActions } from "./taskActions";

/** Tasks of a project in tree order, for "assign to task" pickers. */
export function flatTasks(m: Model, projectId: Id): { task: Task; depth: number }[] {
  const out: { task: Task; depth: number }[] = [];
  const walk = (parent: Id | null, depth: number) => {
    for (const t of m.children(projectId, parent)) {
      out.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * One Claude session: status, title and stats on the first line; your last message and Claude's latest reply below.
 * showContext adds "project › task" (or the folder) for lists that mix projects.
 */
export function SessionRow({ s, assignProject, showContext, compact }: { s: Session; assignProject?: Id; showContext?: boolean; compact?: boolean }) {
  const m = useModel();
  const actions = useTaskActions();
  const run = useStore((st) => st.run);
  const flashing = useStore((st) => st.flashSession === s.id);
  const ref = useRef<HTMLDivElement>(null);
  const pid = m.projectOf.get(s.id);
  const project = pid != null ? m.project.get(pid) : undefined;
  const task = s.taskId != null ? m.task.get(s.taskId) : undefined;
  const link = (taskId: Id | null) => actions.linkSession(s, taskId);

  useEffect(() => {
    if (flashing) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flashing]);

  return (
    <div ref={ref} className={`session-row status-${s.status} ${s.archived ? "is-archived" : ""} ${flashing ? "is-flash" : ""}`} onDoubleClick={() => run(api.openSession(s.id))}>
      <StatusDot status={s.status} />
      <div className="sr-main">
        <div className="sr-line">
          <span className="sr-name">{s.title || "Untitled session"}</span>
          {s.archived ? <span className="sr-status">Archived</span> : <span className={`sr-status sr-status-${s.status}`}>{STATUS_LABEL[s.status]}</span>}
          {s.tempFolder && (
            <span
              className="sr-temp"
              title={`Claude started this session in a temporary folder${project ? ` instead of ${project.path}` : ""}. Move it to the project folder in Claude so it works on the project's files.`}
            >
              Temp folder
            </span>
          )}
          <span className="sr-stats">
            {s.procs > 0 && (!compact || s.status === "working" || s.cpu >= 1) && (
              <span className="sr-cpu" title={`${s.procs} process${s.procs === 1 ? "" : "es"} using ${s.cpu.toFixed(0)}% CPU`}>
                <Cpu size={12} /> {s.procs} · {s.cpu.toFixed(0)}%
              </span>
            )}
            {!compact && <span title="Active time">{fmtDuration(s.activeMs)}</span>}
            {!compact && (
              <span title={`${s.tokens.toLocaleString()} tokens (+${fmtTokens(s.cacheRead)} cache reads)`}>{fmtTokens(s.tokens)} tok</span>
            )}
            <span className="muted" title={new Date(s.lastActivityAt).toLocaleString()}>{relTime(s.lastActivityAt)}</span>
          </span>
        </div>
        <div className="sr-line sr-sub">
          {showContext && (
            <span className="sr-context">
              {project ? project.name : baseName(s.cwd)}
              {task && <> › {task.title}</>}
            </span>
          )}
          {s.lastPrompt && (
            <span className="sr-prompt" title={s.lastPrompt}>
              <span className="sr-you">You:</span> {s.lastPrompt}
            </span>
          )}
        </div>
        {s.lastReply && (
          <div className="sr-line sr-sub">
            <span className="sr-prompt" title={s.lastReply}>
              <span className="sr-you">Claude:</span> {plainText(s.lastReply)}
            </span>
          </div>
        )}
      </div>
      <div className="sr-actions">
        {assignProject != null && (
          <select
            className="assign"
            value=""
            onChange={(e) => e.target.value && link(Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
            title="Assign this session to a task so its time and tokens count there"
          >
            <option value="">Assign to task…</option>
            {flatTasks(m, assignProject).map(({ task: t, depth }) => (
              <option key={t.id} value={t.id}>
                {" ".repeat(depth)}
                {t.title}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-small sr-open" title="Open in Claude" onClick={() => run(api.openSession(s.id))}>
          <ExternalLink size={13} /> Open
        </button>
        {s.taskId != null && assignProject == null && (
          <MenuButton
            icon={<MoreHorizontal size={14} />}
            label="Session actions"
            items={[{ label: "Unlink from task", icon: <Link2Off size={14} />, onSelect: () => link(null) }]}
          />
        )}
      </div>
    </div>
  );
}
