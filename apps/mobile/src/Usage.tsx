import { useEffect, useState } from "react";
import { AlertTriangle, CloudOff, Gauge } from "lucide-react";
import type { LimitAlerts, UsageWindow } from "@desktop/api/types";
import { fmtUntil } from "@desktop/lib/format";
import { usagePaces, type Pace } from "@desktop/lib/pace";
import { api } from "./api";
import { useStore } from "./store";
import { ago, useNow } from "./time";

/** Claude plan limits as the Mac last saw them: the 5-hour and 7-day windows, their pace, and Navarch's limit alerts. Read-only. */
export function Usage() {
  const usage = useStore((s) => s.usage);
  const offline = useStore((s) => s.offline);
  const updatedAt = useStore((s) => s.updatedAt);
  const now = useNow(30_000);
  const alerts = useLimitAlerts(updatedAt);
  const paces = usagePaces(usage, now);

  if (!usage)
    return (
      <div className="empty">
        {offline ? <CloudOff size={36} /> : <Gauge size={36} />}
        <strong>{offline ? "Mac offline" : "No usage yet"}</strong>
        {offline ? "Plan usage shows up here once your Mac answers again." : "Navarch on your Mac hasn't read your plan limits yet."}
      </div>
    );

  return (
    <>
      {alerts?.active && (
        <div className="section">
          <div className="alert-card" role="status">
            <AlertTriangle size={20} />
            <div>
              <strong>Limit alert</strong>
              <div>{alerts.active}</div>
              <div className="muted small">Running sessions are told to save their work and resume after the reset.</div>
            </div>
          </div>
        </div>
      )}
      {usage.error && !usage.fiveHour && !usage.sevenDay ? (
        <div className="empty">
          <Gauge size={36} />
          <strong>Usage unavailable</strong>
          {usage.error}
        </div>
      ) : (
        <div className="section">
          <div className="section-label">Claude plan</div>
          <div className="group">
            <WindowRow title="5-hour window" name="5-hour window" w={usage.fiveHour} pace={paces.fiveHour} now={now} />
            <WindowRow title="Weekly" name="week" w={usage.sevenDay} pace={paces.sevenDay} now={now} weekly />
          </div>
          {/* Stale numbers say so in amber, with why: they still look like today's otherwise. */}
          <div className={`foot ${usage.error ? "is-stale" : "muted"}`}>
            {usage.error ? `Numbers from ${ago(usage.fetchedAt, now)}. ${usage.error}` : `Read ${ago(usage.fetchedAt, now)}`}
            {offline ? " · Mac offline" : ""}
          </div>
        </div>
      )}
      {alerts && (
        <div className="section">
          <div className="section-label">Limit alerts</div>
          <div className="group">
            <div className="row">
              <div className="row-main">
                <div className="row-title">5-hour window</div>
              </div>
              <span className="row-side">at {alerts.fiveHour}%</span>
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-title">Weekly</div>
              </div>
              <span className="row-side">at {alerts.sevenDay}%</span>
            </div>
          </div>
          <div className="foot muted">
            {!alerts.live
              ? "Dev build: its alerts go to a file of its own, so sessions aren't told."
              : !alerts.hookInstalled
                ? "The limit hook isn't in ~/.claude/settings.json, so sessions aren't told."
                : "At these levels Navarch asks every running session to save its work and schedule its resume."}{" "}
            Change them on your Mac.
          </div>
        </div>
      )}
    </>
  );
}

/** Fetched beside each poll (keyed on its time); a failure keeps what's on screen. */
function useLimitAlerts(updatedAt: number | null): LimitAlerts | null {
  const [alerts, setAlerts] = useState<LimitAlerts | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getLimitAlerts()
      .then((a) => live && setAlerts(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [updatedAt]);
  return alerts;
}

function resetLabel(iso: string, weekly: boolean) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return weekly ? `${d.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
}

function WindowRow(p: { title: string; name: string; w: UsageWindow | null; pace: Pace | null; now: number; weekly?: boolean }) {
  const { w, pace } = p;
  if (!w || !pace)
    return (
      <div className="usage-row">
        <div className="usage-top">
          <span className="usage-title">{p.title}</span>
          <span className="muted">–</span>
        </div>
      </div>
    );
  const delta = pace.delta;
  const paceText =
    delta == null ? "Reset time unknown" : delta === 0 ? "On an even pace" : `${Math.abs(delta)} points ${delta < 0 ? "under" : "over"} an even pace`;
  return (
    <div className="usage-row">
      <div className="usage-top">
        <span className="usage-title">{p.title}</span>
        <span className={`usage-pct tone-${pace.tone}`}>{Math.round(pace.percent)}%</span>
      </div>
      <div
        className={`meter meter-usage tone-${pace.tone}`}
        role="img"
        aria-label={`${Math.round(pace.percent)}% used${pace.expected != null ? `, ${Math.round(pace.expected)}% of the ${p.name} gone` : ""}`}
      >
        <span style={{ width: `${pace.percent}%` }} />
        {pace.expected != null && <i className="pace-mark" style={{ left: `${pace.expected}%` }} />}
      </div>
      <div className="usage-meta">
        <span className={`tone-${pace.tone}`}>{paceText}</span>
        {w.resetsAt && (
          <span className="muted">
            Resets in {fmtUntil(w.resetsAt, true)} · {resetLabel(w.resetsAt, !!p.weekly)}
          </span>
        )}
      </div>
    </div>
  );
}
