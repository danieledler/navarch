import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { api, type LimitAlerts, type UsageWindow } from "../api";
import { useStore } from "../store";
import { fmtUntil, relTime } from "../lib/format";
import { usagePaces, type Pace } from "../lib/pace";
import { Popover } from "./ui";

/** Claude plan limits in detail: a ring per window and how usage compares with an even pace. */
export function UsagePopover({ anchor, onClose }: { anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const usage = useStore((s) => s.usage);
  const refreshUsage = useStore((s) => s.refreshUsage);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const paces = usagePaces(usage);
  const stale = !!usage?.error && !!(usage.fiveHour || usage.sevenDay);
  const refresh = async () => {
    setBusy(true);
    await refreshUsage(true);
    setBusy(false);
  };

  return (
    <Popover anchor={anchor} anchorIsTrigger onClose={onClose} side="top" align="end" className="usage-pop">
      <div className="up-head">
        <span className="pop-title">Claude plan usage</span>
        <button type="button" className={`icon-btn ${busy ? "spin" : ""}`} aria-label="Refresh usage" title="Refresh" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      {usage?.error && (
        <p className={`up-error ${usage.needsSignIn ? "is-error" : "is-warn"}`}>
          <TriangleAlert size={14} aria-hidden />
          <span>{usage.error}</span>
        </p>
      )}
      {usage?.needsSignIn && <SignIn />}
      {(!usage?.error || stale) && (
        <div className={`up-body ${stale ? "is-stale" : ""}`}>
          <div className="up-rings">
            <Ring label="5h" pace={paces.fiveHour} window={usage?.fiveHour ?? null} />
            <Ring label="Weekly" pace={paces.sevenDay} window={usage?.sevenDay ?? null} />
          </div>
          <PaceBar label="Session pacing" pace={paces.fiveHour} window="5-hour window" />
          <PaceBar label="Weekly pacing" pace={paces.sevenDay} window="week" />
        </div>
      )}
      <LimitAlertsRow />
      <div className="up-foot">
        {usage ? `Updated ${relTime(usage.fetchedAt)}` : "Loading…"}
        {usage?.signInEndsAt && !usage.needsSignIn && (
          <span title={`Claude Code's sign-in runs out ${new Date(usage.signInEndsAt).toLocaleString()}; then it has to sign in again.`}>
            {" · "}signed in until {new Date(usage.signInEndsAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </span>
        )}
      </div>
    </Popover>
  );
}

/** The fix for a sign-out: `claude auth login`, which opens Claude's sign-in page in the browser. */
function SignIn() {
  const signingIn = useStore((s) => s.signingIn);
  const signIn = useStore((s) => s.signInClaude);
  return (
    <div className="up-signin">
      <button type="button" className="btn btn-primary" onClick={signIn}>
        {signingIn ? "Open the sign-in page again" : "Sign in to Claude Code"}
      </button>
      <p className="hint">
        {signingIn
          ? "Finish signing in in the browser tab that opened. Navarch picks it up from there."
          : "Opens Claude’s sign-in page in your browser, as claude auth login does in Terminal."}
      </p>
    </div>
  );
}

const R = 46;
const C = 2 * Math.PI * R;
const STROKE = 9;

/** Dash length for a round-capped arc: the caps add STROKE/2 at each end, so trim them off. */
const arcLength = (pct: number) => (pct >= 100 ? C : Math.max(0.01, (C * pct) / 100 - STROKE));

function Ring({ label, pace, window: w }: { label: string; pace: Pace | null; window: UsageWindow | null }) {
  const pct = pace?.percent ?? 0;
  const glow = `glow-${useId().replace(/[^\w-]/g, "")}`;
  const arc = pace && Math.round(pct) > 0 && {
    cx: 54, cy: 54, r: R,
    strokeDasharray: `${arcLength(pct)} ${C}`,
    transform: "rotate(-90 54 54)",
  };
  return (
    <div className="ring" title={w?.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
      <svg viewBox="0 0 108 108" width="108" height="108" aria-hidden>
        {/* SVG filter, not CSS drop-shadow: WKWebView ignores CSS filters on SVG children. */}
        <filter id={glow} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <circle cx="54" cy="54" r={R} className="ring-track" />
        {arc && <circle {...arc} className={`ring-glow tone-${pace.tone}`} filter={`url(#${glow})`} />}
        {arc && <circle {...arc} className={`ring-arc tone-${pace.tone}`} />}
      </svg>
      <div className="ring-center">
        <span className={`ring-pct tone-${pace?.tone ?? "good"}`}>{pace ? `${Math.round(pct)}%` : "–"}</span>
        <span className="ring-label">{label}</span>
      </div>
      <div className="ring-reset">{w?.resetsAt ? fmtUntil(w.resetsAt, true) : "–"}</div>
    </div>
  );
}

// The thresholds last seen, and the rows showing them: a save on close or an Undo can land after
// the popover closed or reopened, and the open row should still show it.
let latestAlerts: LimitAlerts | null = null;
const alertRows = new Set<(v: LimitAlerts) => void>();
const showAlerts = (v: LimitAlerts) => {
  latestAlerts = v;
  alertRows.forEach((f) => f(v));
};

// Saves run one at a time, in order: the backend applies each after a usage read that can take a
// while, so two at once could finish in the wrong order. While any is on its way, `latestAlerts`
// already holds its values and is what a reopened row shows.
let saving = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Saves one threshold and toasts it with Undo, which saves the old value back. */
async function setThreshold(key: "fiveHour" | "sevenDay", v: number, isUndo = false) {
  const toast = useStore.getState().toast;
  const prev = latestAlerts;
  if (!prev || prev[key] === v) return;
  const next = { ...prev, [key]: v };
  latestAlerts = next; // so a second edit before this save returns builds on it
  const save = queue.then(() => api.setLimitThresholds(next.fiveHour, next.sevenDay));
  queue = save.catch(() => {});
  saving++;
  try {
    const saved = await save;
    if (--saving === 0) showAlerts(saved); // an earlier answer lacks the later edits
  } catch (e) {
    saving--;
    if (latestAlerts === next) latestAlerts = prev;
    toast(String(e), undefined, "error");
    return;
  }
  const name = key === "fiveHour" ? "5h" : "Weekly";
  if (!isUndo) toast(`${name} warning at ${v}%`, { label: `${name} Warning`, run: () => setThreshold(key, prev[key], true) });
}

/** The thresholds at which running sessions are told to save their work, and whether they can be told. */
function LimitAlertsRow() {
  const [la, setLa] = useState<LimitAlerts | null>(null);
  useEffect(() => {
    alertRows.add(setLa);
    // A save from the last close may still be on its way: the backend would answer with the old values.
    if (saving && latestAlerts) setLa(latestAlerts);
    else api.getLimitAlerts().then((v) => saving || showAlerts(v), () => {});
    return () => void alertRows.delete(setLa);
  }, []);
  if (!la) return null;
  return (
    <div className="up-alerts" title="At these levels Navarch asks every running session to save its work and schedule its resume for after the reset.">
      <div className="pace-label">Warn running sessions at</div>
      <div className="up-alerts-row">
        <ThresholdField label="5h" value={la.fiveHour} onCommit={(v) => setThreshold("fiveHour", v)} />
        <ThresholdField label="Weekly" value={la.sevenDay} onCommit={(v) => setThreshold("sevenDay", v)} />
      </div>
      {la.active && <p className="hint">Told: {la.active}</p>}
      {!la.live ? (
        <p className="hint">Dev build: its alerts go to a file of its own, so sessions aren’t told.</p>
      ) : (
        !la.hookInstalled && <p className="hint">The hook isn’t in ~/.claude/settings.json, so sessions aren’t told.</p>
      )}
    </div>
  );
}

/**
 * A percentage that commits on blur, Enter, and when it unmounts: closing the popover removes the
 * input without a blur (WKWebView), which used to drop the edit. Invalid input reverts.
 */
function ThresholdField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const draft = useRef<string | null>(null); // the edit not yet committed, if any
  const commit = () => {
    const text = draft.current;
    if (text === null) return;
    draft.current = null;
    const v = Number(text);
    if (text.trim() === "" || !(v >= 1 && v <= 100)) {
      if (input.current) input.current.value = String(value);
    } else if (v !== value) onCommit(v);
  };
  const flush = useRef(commit);
  flush.current = commit;
  useEffect(() => () => flush.current(), []);
  // Show a value that changed elsewhere (a save, an Undo) unless an edit is pending.
  useEffect(() => {
    if (draft.current === null && input.current) input.current.value = String(value);
  }, [value]);
  return (
    <label>
      {label}
      <input
        ref={input} type="number" className="field" min={1} max={100} defaultValue={value} aria-label={`${label} threshold`}
        onChange={(e) => (draft.current = e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        onBlur={commit}
      />
      %
    </label>
  );
}

function PaceBar({ label, pace, window: windowName }: { label: string; pace: Pace | null; window: string }) {
  const delta = pace?.delta;
  const title =
    pace && pace.expected != null && delta != null
      ? `${Math.round(pace.percent)}% used with ${Math.round(pace.expected)}% of the ${windowName} gone: ` +
        (delta === 0 ? "right on an even pace." : `${Math.abs(delta)} points ${delta < 0 ? "under" : "over"} an even pace.`)
      : undefined;
  return (
    <div className="pace" title={title}>
      <div className="pace-label">{label}</div>
      <div className="pace-row">
        <div className="pace-bar">
          {pace && Math.round(pace.percent) > 0 && <span className={`pace-fill tone-${pace.tone}`} style={{ width: `${pace.percent}%` }} />}
          {pace?.expected != null && <span className="pace-mark" style={{ left: `${pace.expected}%` }} />}
        </div>
        <span className={`pace-delta tone-${pace?.tone ?? "good"}`}>
          {delta == null ? "–" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)}%`}
        </span>
      </div>
    </div>
  );
}
