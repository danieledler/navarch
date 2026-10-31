import { useRef, useState } from "react";
import { FolderOpen, FolderPlus, History, MoreHorizontal, Pencil, Trash2, ArrowRightLeft, Cpu, Zap } from "lucide-react";
import { api, type Id, type Project } from "../api";
import { useModel, useStore } from "../store";
import { deadlineInfo, fmtDuration, fmtTokens, parentTail } from "../lib/format";
import { isLive } from "../lib/model";
import { Badge, IconButton, InlineInput, MenuButton, StatusDot } from "./ui";
import { cpuTone } from "./CpuPopover";

export function useAddProject() {
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const selectProject = useStore((s) => s.selectProject);
  return async (spaceId: Id, path?: string) => {
    const folder = path ?? (await api.pickFolder());
    if (!folder) return;
    const p = await run(api.createProject(spaceId, folder));
    if (p) {
      selectProject(spaceId, p.id);
      toast(`Added ${p.name}`);
    }
    return p;
  };
}

/** A card being dragged: its index before and after the drop, the pointer's offset, and the height of one slot. */
interface Drag {
  from: number;
  to: number;
  dy: number;
  size: number;
}

export function ProjectList({ spaceId }: { spaceId: Id }) {
  const m = useModel();
  const run = useStore((s) => s.run);
  const selected = useStore((s) => s.projectOfSpace[spaceId]);
  const selectProject = useStore((s) => s.selectProject);
  const setView = useStore((s) => s.setView);
  const recent = useStore((s) => !!s.recentFirst[spaceId]);
  const setRecentFirst = useStore((s) => s.setRecentFirst);
  const addProject = useAddProject();
  const listRef = useRef<HTMLDivElement>(null);
  const justDragged = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Shown instead of the computed order while a reorder saves, or while the pointer is over a recent-first list.
  const [held, setHeld] = useState<Id[] | null>(null);
  const space = m.space.get(spaceId);
  const projects = m.projects.filter((p) => p.spaceId === spaceId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  if (recent) {
    const at = new Map(projects.map((p) => [p.id, Math.max(0, ...(m.sessionsOfProject.get(p.id) ?? []).map((s) => s.lastActivityAt))]));
    projects.sort((a, b) => at.get(b.id)! - at.get(a.id)!);
  }
  if (held) {
    const rank = (id: Id) => held.indexOf(id) + 1 || Infinity;
    projects.sort((a, b) => rank(a.id) - rank(b.id));
  }
  const weekOf = new Map(projects.map((p) => [p.id, m.projectTotal(p.id, m.weekStart).ms]));
  const week = [...weekOf.values()].reduce((a, ms) => a + ms, 0);

  const reorder = async (ids: Id[]) => {
    setHeld(ids);
    await run(api.reorderProjects(ids));
    setHeld(null);
  };

  const nudge = (id: Id, by: number) => {
    const ids = projects.map((p) => p.id);
    const i = ids.indexOf(id);
    if (recent || !ids[i + by]) return;
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    reorder(ids);
  };

  const startDrag = (e: React.PointerEvent, id: Id) => {
    if (recent || e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const list = listRef.current!;
    const cards = [...list.querySelectorAll<HTMLElement>(":scope > .project-card")];
    const mids = cards.map((c) => c.getBoundingClientRect()).map((r) => r.top + r.height / 2);
    const ids = projects.map((p) => p.id);
    const from = ids.indexOf(id);
    const size = cards[from].offsetHeight + parseFloat(getComputedStyle(list).rowGap);
    const y0 = e.clientY;
    let d: Drag | null = null;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!d && Math.abs(dy) < 4) return;
      const to = mids.filter((y, i) => i !== from && y < mids[from] + dy).length;
      setDrag((d = { from, to, dy, size }));
    };
    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape);
      if (!d) return;
      setDrag(null);
      // The click that ends a drag shouldn't also select the card.
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false));
      if (commit && d.to !== d.from) {
        ids.splice(d.to, 0, ...ids.splice(d.from, 1));
        reorder(ids);
      }
    };
    const drop = () => stop(true);
    const cancel = () => stop(false);
    const escape = (ev: KeyboardEvent) => ev.key === "Escape" && stop(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape);
  };

  // Cards between the dragged card's old and new place slide over to make room.
  const offset = (i: number) =>
    !drag ? 0
    : i === drag.from ? drag.dy
    : drag.from < i && i <= drag.to ? -drag.size
    : drag.to <= i && i < drag.from ? drag.size
    : 0;

  return (
    <aside className="projects">
      <header className="col-head" data-tauri-drag-region>
        <span className="space-dot" style={{ background: space?.color }} />
        <h2 data-tauri-drag-region>{space?.name}</h2>
        {week > 0 && (
          <span className="muted small" title="Active time in this space this week">
            {fmtDuration(week)} this week
          </span>
        )}
        {projects.length > 1 && (
          <IconButton
            icon={<History size={15} />}
            label={recent ? "Sorted by latest session activity. Click to use your own order." : "Sort by latest session activity"}
            active={recent}
            className="sort-toggle"
            onClick={() => setRecentFirst(spaceId, !recent)}
          />
        )}
      </header>
      <div
        ref={listRef}
        className={`project-cards ${drag ? "is-sorting" : ""}`}
        // Recent-first order holds still under the pointer, so a card can't move away as you click it.
        onPointerEnter={() => recent && setHeld(projects.map((p) => p.id))}
        onPointerLeave={() => recent && setHeld(null)}
      >
        {projects.map((p, i) => (
          <ProjectCard
            key={p.id}
            project={p}
            active={p.id === selected}
            onSelect={() => !justDragged.current && selectProject(spaceId, p.id)}
            weekMs={weekOf.get(p.id)!}
            spaceWeekMs={week}
            offset={offset(i)}
            lifted={drag?.from === i}
            onPointerDown={(e) => startDrag(e, p.id)}
            onNudge={(by) => nudge(p.id, by)}
          />
        ))}
        {!projects.length && (
          <div className="empty-col">
            <p>Projects are folders you work on with Claude.</p>
            <button type="button" className="btn btn-primary" onClick={() => addProject(spaceId)}>
              <FolderPlus size={15} /> Add a project folder
            </button>
            <button type="button" className="link" onClick={() => setView({ kind: "dashboard" })}>
              or import one from your Claude sessions
            </button>
          </div>
        )}
      </div>
      {projects.length > 0 && (
        <button type="button" className="add-project" onClick={() => addProject(spaceId)}>
          <FolderPlus size={15} /> Add project folder
        </button>
      )}
    </aside>
  );
}

function ProjectCard({
  project: p, active, onSelect, weekMs, spaceWeekMs, offset, lifted, onPointerDown, onNudge,
}: {
  project: Project;
  active: boolean;
  onSelect: () => void;
  weekMs: number; // active time here this week
  spaceWeekMs: number; // the same summed over the space's projects
  offset: number;
  lifted: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onNudge: (by: number) => void;
}) {
  const m = useModel();
  const run = useStore((s) => s.run);
  const selectProject = useStore((s) => s.selectProject);
  const [renaming, setRenaming] = useState(false);
  const tasks = m.tasks.filter((t) => t.projectId === p.id);
  const open = tasks.filter((t) => t.status === "open");
  const next = open.filter((t) => t.deadline).sort((a, b) => a.deadline!.localeCompare(b.deadline!))[0];
  const sessions = (m.sessionsOfProject.get(p.id) ?? []).filter((s) => !s.archived);
  const live = sessions.filter((s) => isLive(s) || s.status === "unread");
  const attention = m.attentionOfProject.get(p.id) ?? 0;
  const cpu = m.cpuOfProject.get(p.id) ?? 0;
  const rate = m.tokenRateOfProject.get(p.id) ?? 0;
  const cores = useStore((s) => s.sys?.cores.length ?? 0);
  const tone = cores ? cpuTone(cpu / cores) : "";
  const toneClass = tone === "hot" ? "tone-hot" : tone === "warm" ? "tone-warn" : "";
  const dl = next?.deadline ? deadlineInfo(next.deadline) : null;
  const space = m.space.get(p.spaceId);
  const share = spaceWeekMs ? weekMs / spaceWeekMs : 0;
  const weekTitle = `${fmtDuration(weekMs)} active here this week, ${Math.round(share * 100)}% of the ${fmtDuration(spaceWeekMs)} in ${space?.name ?? "this space"}`;

  return (
    <div className={`project-card ${active ? "is-active" : ""} ${lifted ? "is-lifted" : ""}`} onClick={onSelect} role="button" tabIndex={0}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
        else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target === e.currentTarget) {
          e.preventDefault();
          onNudge(e.key === "ArrowUp" ? -1 : 1);
        }
      }}>
      <div className="pc-top">
        {renaming ? (
          <InlineInput
            initial={p.name}
            onCommit={(v) => {
              setRenaming(false);
              if (v && v !== p.name) run(api.updateProject(p.id, v));
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="pc-name">{p.name}</span>
        )}
        <Badge n={attention} title={`${attention} session${attention === 1 ? "" : "s"} waiting for you`} />
        <MenuButton
          icon={<MoreHorizontal size={15} />}
          label="Project actions"
          className="pc-menu"
          items={[
            { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
            { label: "Reveal in Finder", icon: <FolderOpen size={14} />, onSelect: () => run(api.revealPath(p.path)) },
            ...m.spaces
              .filter((s) => s.id !== p.spaceId)
              .map((s) => ({
                label: `Move to ${s.name}`,
                icon: <ArrowRightLeft size={14} />,
                onSelect: async () => {
                  await run(api.updateProject(p.id, undefined, s.id));
                  selectProject(p.spaceId, undefined);
                },
              })),
            "sep",
            {
              label: "Remove from Navarch",
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: async () => {
                if (await api.confirm(`Remove ${p.name} and its ${tasks.length} tasks from Navarch? The folder itself is not touched.`))
                  run(api.deleteProject(p.id));
              },
            },
          ]}
        />
      </div>
      {/* The path gives way to the live load; the planning row below keeps its room. */}
      <div className="pc-sub">
        <span className="pc-path" title={p.path}>{parentTail(p.path)}</span>
        {rate > 0 && (
          <span className="pc-rate" title={`Sessions here wrote ${rate.toLocaleString()} tokens in the last minute, subagents included`}>
            <Zap size={11} /> {fmtTokens(rate)}/min
          </span>
        )}
        {cpu >= 1 && (
          <span
            className={`pc-cpu ${toneClass}`}
            title={`Sessions here are using ${cpu.toFixed(0)}% CPU, about ${(cpu / 100).toFixed(1)} ${cores ? `of ${cores} ` : ""}cores, detached jobs included`}
          >
            <Cpu size={11} /> {cpu.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="pc-meta">
        <span>{open.length ? `${open.length} open` : tasks.length ? "All done" : "No tasks"}</span>
        {dl && (
          <span className={`chip chip-${dl.tone}`} title={`Next deadline: ${next!.title}`}>
            {dl.label}
          </span>
        )}
        <span className="pc-end">
          {weekMs > 0 && <span className="pc-week" title={weekTitle}>{fmtDuration(weekMs)}</span>}
          {live.length > 0 && (
            <span className="pc-dots">
              {live.slice(0, 5).map((s) => (
                <StatusDot key={s.id} status={s.status} size={7} />
              ))}
            </span>
          )}
        </span>
      </div>
      {weekMs > 0 && (
        <div className="pc-share" title={weekTitle}>
          <span style={{ width: `${Math.max(share * 100, 2)}%`, background: space?.color }} />
        </div>
      )}
    </div>
  );
}
