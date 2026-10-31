import { useRef, useState } from "react";
import { LayoutGrid, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Space } from "../api";
import { useModel, useStore } from "../store";
import { Badge, Menu, Popover, SPACE_COLORS, initials } from "./ui";

export function SpaceRail() {
  const m = useModel();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const run = useStore((s) => s.run);
  const toast = useStore((s) => s.toast);
  const addRef = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ space: Space; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ space: Space; x: number; y: number } | null>(null);

  const remove = async (s: Space) => {
    if (m.projects.some((p) => p.spaceId === s.id)) {
      toast(`Move or remove the projects in ${s.name} first`, undefined, "error");
      return;
    }
    await run(api.deleteSpace(s.id));
    if (view.kind === "space" && view.spaceId === s.id) setView({ kind: "dashboard" });
  };

  return (
    <nav className="rail" data-tauri-drag-region>
      <div className="rail-top" data-tauri-drag-region />
      <RailButton
        active={view.kind === "dashboard"}
        label="Overview of all spaces"
        badge={m.attentionTotal}
        onClick={() => setView({ kind: "dashboard" })}
      >
        <LayoutGrid size={20} />
      </RailButton>
      <div className="rail-sep" />
      {m.spaces.map((s) => (
        <RailButton
          key={s.id}
          active={view.kind === "space" && view.spaceId === s.id}
          label={s.name}
          color={s.color}
          badge={m.attentionOfSpace.get(s.id) ?? 0}
          onClick={() => setView({ kind: "space", spaceId: s.id })}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ space: s, x: e.clientX, y: e.clientY });
          }}
        >
          {initials(s.name)}
        </RailButton>
      ))}
      <button ref={addRef} type="button" className="rail-add" title="New space" aria-label="New space" onClick={() => setAdding(true)}>
        <Plus size={18} />
      </button>
      {adding && (
        <SpaceEditor
          anchor={addRef}
          anchorIsTrigger
          onClose={() => setAdding(false)}
          onSave={async (name, color) => {
            const s = await run(api.createSpace(name, color));
            if (s) setView({ kind: "space", spaceId: s.id });
          }}
        />
      )}
      {menu && (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename or recolor…", icon: <Pencil size={14} />, onSelect: () => setEditing(menu) },
            "sep",
            { label: "Delete space", icon: <Trash2 size={14} />, danger: true, onSelect: () => remove(menu.space) },
          ]}
        />
      )}
      {editing && (
        <SpaceEditor
          anchor={{ x: editing.x, y: editing.y }}
          space={editing.space}
          onClose={() => setEditing(null)}
          onSave={(name, color) => run(api.updateSpace(editing.space.id, name, color))}
        />
      )}
    </nav>
  );
}

function RailButton({
  children, active, label, color, badge, onClick, onContextMenu,
}: {
  children: React.ReactNode; active: boolean; label: string; color?: string; badge: number;
  onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className={`rail-item ${active ? "is-active" : ""}`}>
      <span className="rail-pill" />
      <button
        type="button"
        className="rail-btn"
        style={color ? { background: color } : undefined}
        title={label}
        aria-label={label}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {children}
      </button>
      <span className="rail-badge">
        <Badge n={badge} title={`${badge} session${badge === 1 ? "" : "s"} waiting for you`} />
      </span>
    </div>
  );
}

function SpaceEditor({
  anchor, anchorIsTrigger, space, onClose, onSave,
}: {
  anchor: React.RefObject<HTMLElement | null> | { x: number; y: number };
  anchorIsTrigger?: boolean;
  space?: Space;
  onClose: () => void;
  onSave: (name: string, color: string) => unknown;
}) {
  const [name, setName] = useState(space?.name ?? "");
  const [color, setColor] = useState(space?.color ?? SPACE_COLORS[2]);
  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim(), color);
    onClose();
  };
  return (
    <Popover anchor={anchor} anchorIsTrigger={anchorIsTrigger} onClose={onClose} className="space-editor">
      <div className="pop-title">{space ? "Edit space" : "New space"}</div>
      <input
        autoFocus
        className="field"
        placeholder="e.g. Work, Personal, Teaching"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <div className="swatches">
        {SPACE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch ${c === color ? "is-active" : ""}`}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={save}>
          {space ? "Save" : "Create space"}
        </button>
      </div>
    </Popover>
  );
}
