import { useEffect, useState, type ReactNode } from "react";
import { ago, useNow } from "./time";
import { CalendarDays, CloudOff, Gauge, TriangleAlert, Inbox, Plus, RefreshCw, Settings, Target } from "lucide-react";
import { weekLabel, weekNumber } from "@desktop/lib/dates";
import { isMock } from "./api";
import { startPolling, useModel, useStore } from "./store";
import { Pair } from "./Pair";
import { Waiting } from "./Waiting";
import { Week } from "./Week";
import { Goals, periodLeft } from "./Goals";
import { Usage } from "./Usage";
import { QuickAdd } from "./QuickAdd";
import { Toasts } from "./Toasts";
import { WidgetSetup } from "./WidgetSetup";

type Tab = "waiting" | "week" | "goals" | "usage";
const TAB_KEY = "navarch-phone-tab";

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === "waiting" || t === "week" || t === "goals" || t === "usage") return t;
  } catch {
    /* ignore */
  }
  return "waiting";
}

export function App() {
  const token = useStore((s) => s.token);
  useEffect(() => {
    if (token) startPolling();
  }, [token]);
  return (
    <>
      {token ? <Shell /> : <Pair />}
      <Toasts />
    </>
  );
}

function Shell() {
  const m = useModel();
  const [tab, setTabState] = useState<Tab>(loadTab);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    window.scrollTo(0, 0);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const waiting = m?.attentionTotal ?? 0;
  const head: Record<Tab, { title: string; sub?: string }> = {
    waiting: { title: "Waiting", sub: m ? (waiting ? `${waiting} session${waiting === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you` : "Nothing needs you") : undefined },
    week: { title: "This week", sub: m ? `Week ${weekNumber(m.week)} · ${weekLabel(m.weekStart)}` : undefined },
    goals: { title: "Goals", sub: m?.period ? `${m.period.name} · ${periodLeft(m)}` : undefined },
    usage: { title: "Usage", sub: "Claude plan limits" },
  };

  return (
    <div className="app">
      <Header title={head[tab].title} sub={head[tab].sub} onSettings={() => setSettings(true)} onAdd={tab === "week" && m ? () => setAdding(true) : undefined} />
      <OfflineBanner />
      {!m ? (
        <Loading />
      ) : tab === "waiting" ? (
        <Waiting m={m} />
      ) : tab === "week" ? (
        <Week m={m} />
      ) : tab === "goals" ? (
        <Goals m={m} />
      ) : (
        <Usage />
      )}
      <nav className="tabbar" aria-label="Sections">
        <TabButton id="waiting" tab={tab} setTab={setTab} label="Waiting" icon={<Inbox size={24} />} badge={waiting} />
        <TabButton id="week" tab={tab} setTab={setTab} label="Week" icon={<CalendarDays size={24} />} />
        <button type="button" className="tab tab-add" aria-label="New task" disabled={!m} onClick={() => setAdding(true)}>
          <span className="tab-add-circle">
            <Plus size={22} strokeWidth={2.5} />
          </span>
        </button>
        <TabButton id="goals" tab={tab} setTab={setTab} label="Goals" icon={<Target size={24} />} />
        <TabButton id="usage" tab={tab} setTab={setTab} label="Usage" icon={<Gauge size={24} />} />
      </nav>
      {settings && <SettingsSheet close={() => setSettings(false)} />}
      {adding && m && <QuickAdd m={m} close={() => setAdding(false)} />}
    </div>
  );
}

function TabButton(p: { id: Tab; tab: Tab; setTab: (t: Tab) => void; label: string; icon: ReactNode; badge?: number }) {
  return (
    <button type="button" className="tab" aria-current={p.tab === p.id ? "page" : undefined} onClick={() => p.setTab(p.id)}>
      <span className="tab-icon">
        {p.icon}
        {!!p.badge && <span className="badge" aria-label={`${p.badge} waiting`}>{p.badge > 99 ? "99+" : p.badge}</span>}
      </span>
      {p.label}
    </button>
  );
}

function Header({ title, sub, onSettings, onAdd }: { title: string; sub?: string; onSettings: () => void; onAdd?: () => void }) {
  const loading = useStore((s) => s.loading);
  const refresh = useStore((s) => s.refresh);
  return (
    <header className="head">
      <div className="head-text">
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {onAdd && (
        <button type="button" className="icon-btn" aria-label="New task" onClick={onAdd}>
          <Plus size={23} />
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => refresh()}>
        <RefreshCw size={20} className={loading ? "spin" : undefined} />
      </button>
      <button type="button" className="icon-btn" aria-label="Settings" onClick={onSettings}>
        <Settings size={21} />
      </button>
    </header>
  );
}

/** Says when what's on screen isn't live: Mac offline, its error, or the launch cache while the first poll is slow. */
function OfflineBanner() {
  const offline = useStore((s) => s.offline);
  const pollError = useStore((s) => s.pollError);
  const fresh = useStore((s) => s.fresh);
  const updatedAt = useStore((s) => s.updatedAt);
  const now = useNow();
  // A quick first poll shouldn't flash the banner on every launch.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(t);
  }, []);
  const what = offline ? "Mac offline" : pollError ? pollError : !fresh && slow && updatedAt ? "Checking your Mac" : null;
  if (!what) return null;
  return (
    <div className="banner" role="status">
      {pollError && !offline ? <TriangleAlert size={18} /> : <CloudOff size={18} />}
      <span>
        {what}
        {updatedAt ? ` · updated ${ago(updatedAt, now)}` : ""}
      </span>
    </div>
  );
}

function Loading() {
  const offline = useStore((s) => s.offline);
  const pollError = useStore((s) => s.pollError);
  return (
    <div className="placeholder">
      {offline ? "Can't reach Navarch on your Mac. Is it awake, with Phone access on?" : (pollError ?? "Connecting to your Mac…")}
    </div>
  );
}

function SettingsSheet({ close }: { close: () => void }) {
  const unpair = useStore((s) => s.unpair);
  const updatedAt = useStore((s) => s.updatedAt);
  const now = useNow();
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="sheet" role="dialog" aria-label="Settings">
        <div className="sheet-grip" />
        <h2>Navarch on your phone</h2>
        <p>
          {isMock ? `${__PHONE_DEMO__ ? "Demo" : "Mock"} data: no Mac involved.` : `Paired with Navarch on your Mac${updatedAt ? `, last heard from ${ago(updatedAt, now)}` : ""}.`} To
          cut off every phone at once, reset the token under Phone access on the Mac.
        </p>
        {!__PHONE_DEMO__ && <WidgetSetup />}
        <button
          type="button"
          className="btn-danger"
          onClick={() => {
            close();
            unpair();
          }}
        >
          Unpair this phone
        </button>
        <button type="button" className="btn-plain" onClick={close}>
          Close
        </button>
      </div>
    </>
  );
}
