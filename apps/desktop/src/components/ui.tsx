import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { SessionStatus } from "../api";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: "Working",
  needs_input: "Needs your input",
  unread: "New reply",
  idle: "Idle",
  stopped: "Interrupted",
};

export function StatusDot({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  return <span className={`dot dot-${status}`} style={{ width: size, height: size }} title={STATUS_LABEL[status]} />;
}

export function Badge({ n, title }: { n: number; title?: string }) {
  if (!n) return null;
  return (
    <span className="badge" title={title}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function IconButton({
  icon, label, onClick, active, className = "", disabled,
}: {
  icon: ReactNode; label: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; className?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "is-active" : ""} ${className}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      {icon}
    </button>
  );
}

type Anchor = RefObject<HTMLElement | null> | { x: number; y: number };

/** Floating layer anchored below an element (or at a point), closed by outside click or Escape. */
export function Popover({
  anchor, onClose, children, align = "start", side = "bottom", anchorIsTrigger = false, className = "",
}: {
  anchor: Anchor; onClose: () => void; children: ReactNode; align?: "start" | "end"; side?: "bottom" | "top";
  /** The anchor is the button that toggles this popover; leave clicks on it to that button. */
  anchorIsTrigger?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      let x: number, y: number;
      if ("current" in anchor) {
        const r = anchor.current?.getBoundingClientRect();
        if (!r) return;
        x = align === "end" ? r.right - el.offsetWidth : r.left;
        y = side === "top" ? r.top - el.offsetHeight - 6 : r.bottom + 4;
      } else {
        x = anchor.x;
        y = anchor.y;
      }
      x = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8));
      if (y + el.offsetHeight > window.innerHeight - 8) y = window.innerHeight - el.offsetHeight - 8;
      y = Math.max(8, y);
      setPos((p) => (p && p.left === x && p.top === y ? p : { left: x, top: y }));
    };
    place();
    // Content can change height while open (e.g. usage error -> data); keep the popover attached to its anchor.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, align, side]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorIsTrigger && "current" in anchor && anchor.current?.contains(t)) return;
      if (ref.current && !ref.current.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const timer = setTimeout(() => document.addEventListener("mousedown", down));
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose, anchor, anchorIsTrigger]);

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  hint?: string;
}

export function Menu({
  items, onClose, anchor, align, anchorIsTrigger,
}: {
  items: (MenuItem | "sep")[]; onClose: () => void; anchor: Anchor; align?: "start" | "end"; anchorIsTrigger?: boolean;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} anchorIsTrigger={anchorIsTrigger} className="menu">
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={`menu-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </Popover>
  );
}

/** Menu opened from its own trigger button. */
export function MenuButton({ icon, label, items, align = "end", className }: { icon: ReactNode; label: string; items: (MenuItem | "sep")[]; align?: "start" | "end"; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`icon-btn ${open ? "is-active" : ""} ${className ?? ""}`}
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {icon}
      </button>
      {open && <Menu anchor={ref} anchorIsTrigger align={align} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

export const SPACE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];

export function initials(name: string) {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0][0] : words[0][0] + words[1][0]).toUpperCase();
}

/** Text input that commits on Enter/blur and cancels on Escape. */
export function InlineInput({
  initial, placeholder, onCommit, onCancel, className = "",
}: {
  initial: string; placeholder?: string; onCommit: (v: string) => void; onCancel: () => void; className?: string;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  return (
    <input
      autoFocus
      className={`inline-input ${className}`}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          done.current = true;
          onCommit(v.trim());
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onCommit(v.trim());
      }}
    />
  );
}
