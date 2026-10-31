import { useStore } from "./store";

/** Above the tab bar; an Undo button runs the toast's undo once and closes it. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === "error" ? "toast-error" : ""}`}>
          <span className="toast-text">{t.text}</span>
          {t.undo ? (
            <button
              type="button"
              onClick={() => {
                dismiss(t.id);
                t.undo?.();
              }}
            >
              Undo
            </button>
          ) : (
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              OK
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
