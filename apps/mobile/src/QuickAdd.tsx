import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { Id } from "../../../src/api/types";
import type { Model } from "../../../src/lib/model";
import { api } from "./api";
import { useStore } from "./store";

const LAST_PROJECT = "navarch-phone-last-project";

function loadLast(): Id | null {
  try {
    const v = Number(localStorage.getItem(LAST_PROJECT));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveLast(id: Id) {
  try {
    localStorage.setItem(LAST_PROJECT, String(id));
  } catch {
    /* private mode: it just isn't remembered */
  }
}

/** Keeps a bottom sheet above the iOS keyboard, which covers fixed elements instead of shrinking the layout. */
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
  return inset;
}

/** New top-level task in a project, pinned to this week unless switched off; the toast's Undo deletes it. */
export function QuickAdd({ m, close }: { m: Model; close: () => void }) {
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const inset = useKeyboardInset();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<Id | null>(() => {
    const last = loadLast();
    return last != null && m.project.has(last) ? last : (m.projects[0]?.id ?? null);
  });

  // Spaces in rail order, each with its projects in list order.
  const spaces = [...m.spaces].sort((a, b) => a.sort - b.sort);
  const bySpace = spaces
    .map((s) => ({ s, ps: m.projects.filter((p) => p.spaceId === s.id).sort((a, b) => a.sort - b.sort) }))
    .filter((g) => g.ps.length);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || projectId == null || busy) return;
    setBusy(true);
    saveLast(projectId);
    const week = m.week;
    let pinned = false;
    const task = await run(async () => {
      const created = await api.createTask(projectId, null, t);
      // Once created, the task exists: a failed pin must not keep the sheet open for a duplicate retry.
      if (pin) pinned = await api.setWeekTask(week, created.id, true).then(() => true, () => false);
      return created;
    });
    setBusy(false);
    if (!task) return; // run already showed why
    close();
    const where = m.project.get(projectId)?.name ?? "project";
    const text = pinned ? `Added to this week: ${t}` : pin ? `Added to ${where}, but not pinned to this week: ${t}` : `Added to ${where}: ${t}`;
    toast(text, () => run(() => api.deleteTask(task.id)), pin && !pinned ? "error" : undefined);
  };

  if (!bySpace.length)
    return (
      <>
        <div className="scrim" onClick={close} />
        <div className="sheet" role="dialog" aria-label="New task">
          <div className="sheet-grip" />
          <h2>New task</h2>
          <p>Add a project on your Mac first: tasks live in projects.</p>
          <button type="button" className="btn-plain" onClick={close}>
            Close
          </button>
        </div>
      </>
    );

  return (
    <>
      <div className="scrim" onClick={close} />
      <form className="sheet" role="dialog" aria-label="New task" onSubmit={submit} style={inset ? { bottom: inset } : undefined}>
        <div className="sheet-grip" />
        <div className="sheet-bar">
          <button type="button" className="btn-plain" onClick={close}>
            Cancel
          </button>
          <h2>New task</h2>
          <button type="submit" className="btn-plain btn-strong" disabled={!title.trim() || busy}>
            Add
          </button>
        </div>
        <input
          ref={input}
          className="field"
          type="text"
          placeholder="What needs doing?"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="sentences"
        />
        <div className="group form-group">
          <label className="form-row">
            <span>Project</span>
            <select value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))}>
              {bySpace.map(({ s, ps }) =>
                bySpace.length > 1 ? (
                  <optgroup key={s.id} label={s.name}>
                    {ps.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  ps.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                ),
              )}
            </select>
            <ChevronsUpDown size={16} className="muted select-chev" aria-hidden />
          </label>
          <label className="form-row">
            <span>Pin to this week</span>
            <input type="checkbox" className="switch" checked={pin} onChange={(e) => setPin(e.target.checked)} />
          </label>
        </div>
      </form>
    </>
  );
}
