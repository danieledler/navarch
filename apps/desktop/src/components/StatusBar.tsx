import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { fmtUntil, relTime } from "../lib/format";
import { usagePaces, type Pace } from "../lib/pace";
import { api, type BuildInfo, type MobileAccess, type UsageWindow } from "../api";
import { StatusDot } from "./ui";
import { UsagePopover } from "./UsagePopover";
import { CpuPopover, cpuTone } from "./CpuPopover";
import { PhoneIcon, PhonePopover, phoneTitle } from "./PhonePopover";

export function StatusBar() {
  const sys = useStore((s) => s.sys);
  const usage = useStore((s) => s.usage);
  const sessions = useStore((s) => s.sessions);
  const usageRef = useRef<HTMLButtonElement>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const cpuRef = useRef<HTMLButtonElement>(null);
  const [cpuOpen, setCpuOpen] = useState(false);
  const phoneRef = useRef<HTMLButtonElement>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState<MobileAccess | null>(null);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  useEffect(() => {
    api.getBuildInfo().then(setBuild, () => {});
    api.getMobileAccess().then(setPhone, () => {});
  }, []);
  const active = sessions.filter((s) => !s.archived);
  const count = (st: string) => active.filter((s) => s.status === st).length;
  const working = count("working");
  const waiting = count("needs_input");
  const unread = count("unread");
  const paces = usagePaces(usage);

  const win = (label: string, w: UsageWindow | null, pace: Pace | null) =>
    w ? (
      <span className={`usage-win tone-${pace?.tone ?? "good"}`}>
        <span className="uw-pct">{Math.round(w.percent)}%</span>
        <span className="uw-reset">{fmtUntil(w.resetsAt)}</span>
      </span>
    ) : (
      <span className="usage-win muted">{label} –</span>
    );

  // After a failed request the last good numbers stay, dimmed, with the error on hover.
  const stale = !!usage?.error && !!(usage.fiveHour || usage.sevenDay);
  const usageTitle = usage?.error && !stale
    ? `Claude usage unavailable: ${usage.error}`
    : usage
      ? [
          stale && `Numbers from ${relTime(usage.fetchedAt)}: ${usage.error}`,
          usage.fiveHour && `5-hour window: ${Math.round(usage.fiveHour.percent)}% used, resets in ${fmtUntil(usage.fiveHour.resetsAt, true)}`,
          usage.sevenDay && `Weekly: ${Math.round(usage.sevenDay.percent)}% used, resets in ${fmtUntil(usage.sevenDay.resetsAt, true)}`,
          "Click for pacing details",
        ]
          .filter(Boolean)
          .join("\n")
      : "Loading Claude usage…";

  return (
    <footer className="statusbar">
      {build && <BuildLabel b={build} />}
      <span className="sb-item">
        {working > 0 && <><StatusDot status="working" size={7} /> {working} working</>}
        {waiting > 0 && <><StatusDot status="needs_input" size={7} /> {waiting} need{waiting === 1 ? "s" : ""} you</>}
        {unread > 0 && <><StatusDot status="unread" size={7} /> {unread} new repl{unread === 1 ? "y" : "ies"}</>}
        {!working && !waiting && !unread && <span className="muted">All sessions quiet</span>}
      </span>
      <span className="sb-fill" />
      {sys && (
        <button
          ref={cpuRef}
          type="button"
          className={`sb-item sb-btn cpu ${cpuOpen ? "is-open" : ""}`}
          title={cpuOpen ? undefined : `CPU ${sys.cpu.toFixed(0)}% busy · load average ${sys.load1.toFixed(2)}\nClick for per-core detail and history`}
          aria-expanded={cpuOpen}
          onClick={() => setCpuOpen((o) => !o)}
        >
          <span className="cpu-meter"><span style={{ width: `${Math.min(100, sys.cpu)}%` }} className={cpuTone(sys.cpu)} /></span>
          CPU {sys.cpu.toFixed(0)}%
          <span className="muted">· load {sys.load1.toFixed(1)}</span>
        </button>
      )}
      {cpuOpen && <CpuPopover anchor={cpuRef} onClose={() => setCpuOpen(false)} />}
      <button
        ref={phoneRef}
        type="button"
        className={`sb-item sb-btn phone ${phoneOpen ? "is-open" : ""}`}
        title={phoneOpen ? undefined : phoneTitle(phone)}
        aria-label="Phone access"
        aria-expanded={phoneOpen}
        onClick={() => setPhoneOpen((o) => !o)}
      >
        <PhoneIcon access={phone} />
      </button>
      {phoneOpen && <PhonePopover anchor={phoneRef} onClose={() => setPhoneOpen(false)} access={phone} onChange={setPhone} />}
      <button
        ref={usageRef}
        type="button"
        className={`sb-item sb-btn usage ${usageOpen ? "is-open" : ""} ${stale ? "is-stale" : ""}`}
        title={usageOpen ? undefined : usageTitle}
        aria-expanded={usageOpen}
        onClick={() => setUsageOpen((o) => !o)}
      >
        <span className="muted">Claude</span>
        {usage?.error && !stale ? (
          <span className="muted">unavailable</span>
        ) : (
          <>
            {win("5h", usage?.fiveHour ?? null, paces.fiveHour)}
            {win("7d", usage?.sevenDay ?? null, paces.sevenDay)}
          </>
        )}
      </button>
      {usageOpen && <UsagePopover anchor={usageRef} onClose={() => setUsageOpen(false)} />}
    </footer>
  );
}

/** Which build is running: commit (+ uncommitted files), branch when not main, and where the UI comes from. */
function BuildLabel({ b }: { b: BuildInfo }) {
  const uiElsewhere = b.devUi && __UI_CHECKOUT__ !== b.checkout;
  const title = [
    `Navarch ${b.version}, built ${relTime(b.builtAt)}`,
    `${b.branch} at ${b.commit}` + (b.dirty ? ` plus ${b.dirty} uncommitted file${b.dirty === 1 ? "" : "s"}` : ""),
    `Built in ${b.checkout}`,
    b.devUi ? `UI live from the Vite dev server in ${__UI_CHECKOUT__}` : "UI built in",
    b.db === "navarch.db" ? "Data: the real database" : `Data: ${b.db} (a copy; delete it to copy afresh)`,
  ].join("\n");
  return (
    <span className={`sb-item sb-build ${b.devUi ? "is-dev" : ""}`} title={title}>
      <span>
        {b.commit}
        {b.dirty > 0 && <span className="sb-dirty">+{b.dirty}</span>}
      </span>
      {b.branch !== "main" && <span>{b.branch}</span>}
      {uiElsewhere ? <span className="sb-tag warn">UI from another checkout</span> : b.devUi && <span className="sb-tag">dev</span>}
    </span>
  );
}
