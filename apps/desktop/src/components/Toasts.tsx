import { X } from "lucide-react";
import { useStore } from "../store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  const undo = useStore((s) => s.undo);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === "error" ? "is-error" : ""}`}>
          <span className="toast-text">{t.text}</span>
          {t.undo && (
            <button type="button" className="toast-undo" onClick={() => undo(t.id)}>
              Undo
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
