import { useEffect, useState } from "react";
import { api, type CpuSample } from "../api";
import { useStore } from "../store";
import { Popover } from "./ui";

export const cpuTone = (pct: number) => (pct >= 80 ? "hot" : pct >= 50 ? "warm" : "");

const SPAN = 10 * 60_000; // the backend keeps 10 min of 2 s samples
const W = 288; // popover content width
const H = 48;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** CPU in detail: load per core now, the last 10 minutes of total CPU and load average, and Claude's share. */
export function CpuPopover({ anchor, onClose }: { anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const sys = useStore((s) => s.sys);
  const sessions = useStore((s) => s.sessions);
  const [history, setHistory] = useState<CpuSample[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => api.getCpuHistory().then((h) => live && setHistory(h), () => {});
    load();
    const t = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!sys) return null;

  const n = sys.cores.length || 1;
  const claude = sessions.filter((s) => s.procs > 0);
  // Process CPU is % of one core; divide by the core count for a share of the whole machine.
  const claudeShare = claude.reduce((a, s) => a + s.cpu, 0) / n;
  const claudeProcs = claude.reduce((a, s) => a + s.procs, 0);
  const peakLoad = Math.max(0, ...history.map((h) => h.load1));

  return (
    <Popover anchor={anchor} anchorIsTrigger onClose={onClose} side="top" align="end" className="cpu-pop">
      <div className="up-head">
        <span className="pop-title">CPU</span>
        <span className="cp-chip">{sys.brand ? `${sys.brand} · ` : ""}{n} cores</span>
      </div>
      <div className="cp-now">
        <Stat value={`${Math.round(sys.cpu)}%`} label="busy" main />
        <Stat value={sys.load1.toFixed(2)} label="load 1 min" main />
        <Stat value={sys.load5.toFixed(2)} label="5 min" />
        <Stat value={sys.load15.toFixed(2)} label="15 min" />
      </div>
      <Spark title="CPU busy" samples={history.map((h) => ({ t: h.t, v: h.cpu }))} max={100} fmt={(v) => `${Math.round(v)}%`} />
      <Spark
        title="Load average, 1 min"
        samples={history.map((h) => ({ t: h.t, v: h.load1 }))}
        max={Math.max(n * 1.4, peakLoad * 1.15)}
        fmt={(v) => v.toFixed(2)}
        refLine={{ v: n, label: `${n} cores` }}
      />
      <div>
        <div className="spark-head">
          <span className="spark-title">Per core</span>
        </div>
        <div className="cp-cores">
          {sys.cores.map((c, i) => (
            <span key={i} className="core" title={`Core ${i + 1}: ${Math.round(c)}%`}>
              <span className={`core-fill ${cpuTone(c)}`} style={{ height: `${Math.min(100, c)}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="cp-claude">
        {claude.length ? (
          <>
            Claude Code uses <b>{claudeShare < 1 ? "<1" : Math.round(claudeShare)}%</b> · {claude.length} session
            {claude.length === 1 ? "" : "s"}, {claudeProcs} process{claudeProcs === 1 ? "" : "es"}
          </>
        ) : (
          <span className="muted">No Claude Code processes running</span>
        )}
      </div>
      <p className="cp-foot">
        <b>CPU</b> is how much of the last 2 s the cores were busy. <b>Load</b> counts threads running or waiting for a
        core, averaged over time; above {n} they queue.
      </p>
    </Popover>
  );
}

function Stat({ value, label, main = false }: { value: string; label: string; main?: boolean }) {
  return (
    <div className={`cp-stat ${main ? "main" : ""}`}>
      <span className="cp-val">{value}</span>
      <span className="cp-label">{label}</span>
    </div>
  );
}

/** A 10-minute line with a hover crosshair; the header shows the hovered value, else the latest. */
function Spark({ title, samples, max, fmt, refLine }: {
  title: string;
  samples: { t: number; v: number }[];
  max: number;
  fmt: (v: number) => string;
  refLine?: { v: number; label: string };
}) {
  const [cursor, setCursor] = useState<number | null>(null); // 0–1 across the chart; samples scroll under it
  const last = samples.at(-1);
  const end = last?.t ?? Date.now();
  const x = (t: number) => W - ((end - t) / SPAN) * W;
  const y = (v: number) => 1 + (1 - Math.min(v, max) / max) * (H - 2);
  const line = samples.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
  const area = samples.length > 1 ? `${line}L${x(end).toFixed(1)} ${H}L${x(samples[0].t).toFixed(1)} ${H}Z` : "";

  let hover: { t: number; v: number } | undefined;
  if (cursor != null) {
    const t = end - (1 - cursor) * SPAN;
    for (const p of samples) if (!hover || Math.abs(p.t - t) < Math.abs(hover.t - t)) hover = p;
  }
  const shown = hover ?? last;

  return (
    <div className="spark">
      <div className="spark-head">
        <span className="spark-title">{title}</span>
        <span className="spark-val">
          {shown ? fmt(shown.v) : "–"}
          {hover && <span className="muted"> at {clock(hover.t)}</span>}
        </span>
      </div>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}, last 10 minutes`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setCursor(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        }}
        onMouseLeave={() => setCursor(null)}
      >
        <line className="spark-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
        {refLine && refLine.v < max && (
          <>
            <line className="spark-ref" x1={0} x2={W} y1={y(refLine.v)} y2={y(refLine.v)} />
            <text className="spark-ref-label" x={W - 3} y={y(refLine.v) - 3} textAnchor="end">{refLine.label}</text>
          </>
        )}
        {area && <path className="spark-area" d={area} />}
        <path className="spark-line" d={line} />
        {hover && (
          <>
            <line className="spark-cross" x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={H} />
            <circle className="spark-dot" cx={x(hover.t)} cy={y(hover.v)} r={3.5} />
          </>
        )}
      </svg>
      <div className="spark-axis">
        <span>10 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
