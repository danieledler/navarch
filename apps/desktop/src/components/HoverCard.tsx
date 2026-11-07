import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const SHOW_MS = 350; // hover this long before a card opens
const SWITCH_MS = 120; // moving to another row while a card is open
const HIDE_MS = 150; // grace period to move the pointer from the row into the card

/**
 * One hover card at a time for a list of rows. Spread `row(key)` on each row; render `<HoverCard>` for `open.key`.
 * The card opens after a short hover, stays while the pointer is in it, and closes on leave, `hide()` or Escape.
 */
export function useHoverCard() {
  const [open, setOpen] = useState<{ key: string; rect: DOMRect } | null>(null);
  const showT = useRef(0);
  const hideT = useRef(0);
  const isOpen = useRef(false);
  isOpen.current = open != null;

  const hide = useCallback(() => {
    clearTimeout(showT.current);
    clearTimeout(hideT.current);
    setOpen(null);
  }, []);
  const hideSoon = useCallback(() => {
    clearTimeout(showT.current);
    clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => setOpen(null), HIDE_MS);
  }, []);
  const keep = useCallback(() => clearTimeout(hideT.current), []);

  useEffect(() => () => {
    clearTimeout(showT.current);
    clearTimeout(hideT.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Capture phase, so Escape closes the card without also reaching ProjectView's Escape (deselect task).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      hide();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [open, hide]);

  const row = (key: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      clearTimeout(showT.current);
      clearTimeout(hideT.current);
      showT.current = window.setTimeout(() => setOpen({ key, rect: el.getBoundingClientRect() }), isOpen.current ? SWITCH_MS : SHOW_MS);
    },
    onMouseLeave: hideSoon,
    onMouseDown: hide,
  });

  return { open, row, hide, hideSoon, keep };
}

/** Floating card beside an anchor rect: below it when it fits, else above, always inside the window. */
export function HoverCard({ rect, onEnter, onLeave, children }: { rect: DOMRect; onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const gap = 6;
      const vh = window.innerHeight;
      const h = el.scrollHeight;
      const below = vh - rect.bottom - gap - 8;
      const above = rect.top - gap - 8;
      let top: number;
      let maxHeight = vh - 16;
      if (h <= below) top = rect.bottom + gap;
      else if (h <= above) top = rect.top - gap - h;
      else if (above > below) {
        maxHeight = above;
        top = 8;
      } else {
        maxHeight = below;
        top = rect.bottom + gap;
      }
      const left = Math.max(8, Math.min(rect.left + 12, window.innerWidth - el.offsetWidth - 8));
      setPos((p) => (p && p.left === left && p.top === top && p.maxHeight === maxHeight ? p : { left, top, maxHeight }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rect]);

  return createPortal(
    <div
      ref={ref}
      className="hover-card"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: -9999, top: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
