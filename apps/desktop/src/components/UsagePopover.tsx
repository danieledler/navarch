import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";
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
      {usage?.error ? (
        <p className="hint up-error">{usage.error}</p>
      ) : (
        <>
          <div className="up-rings">
            <Ring label="5h" pace={paces.fiveHour} window={usage?.fiveHour ?? null} />
            <Ring label="Weekly" pace={paces.sevenDay} window={usage?.sevenDay ?? null} />
          </div>
          <PaceBar label="Session pacing" pace={paces.fiveHour} window="5-hour window" />
          <PaceBar label="Weekly pacing" pace={paces.sevenDay} window="week" />
        </>
      )}
      <LimitAlertsRow />
      <div className="up-foot">{usage ? `Updated ${relTime(usage.fetchedAt)}` : "Loading…"}</div>
    </Popover>
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

/** The thresholds at which running sessions are told to save their work, and whether they can be told. */
function LimitAlertsRow() {
  const toast = useStore((s) => s.toast);
  const [la, setLa] = useState<LimitAlerts | null>(null);
  useEffect(() => {
    api.getLimitAlerts().then(setLa, () => {});
  }, []);
  if (!la) return null;
  const save = async (fiveHour: number, sevenDay: number) => {
    try {
      setLa(await api.setLimitThresholds(fiveHour, sevenDay));
    } catch (e) {
      toast(String(e), undefined, "error");
    }
  };
  const pct = (label: string, value: number, set: (v: number) => void) => (
    <label>
      {label}
      <input
        type="number" className="field" min={1} max={100} defaultValue={value} aria-label={`${label} threshold`}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (!(v >= 1 && v <= 100)) e.target.value = String(value);
          else if (v !== value) set(v);
        }}
      />
      %
    </label>
  );
  return (
    <div className="up-alerts" title="At these levels Navarch asks every running session to save its work and schedule its resume for after the reset.">
      <div className="pace-label">Warn running sessions at</div>
      <div className="up-alerts-row">
        {pct("5h", la.fiveHour, (v) => save(v, la.sevenDay))}
        {pct("Weekly", la.sevenDay, (v) => save(la.fiveHour, v))}
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
