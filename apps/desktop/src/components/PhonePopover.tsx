import { useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { api, type MobileAccess, type PairingCode, type TailscaleServe } from "../api";
import { useStore } from "../store";
import { relTime } from "../lib/format";
import { Popover } from "./ui";
import { QrCode } from "./QrCode";

/** The status-bar button's look: green while serving, red on an error, muted when off. */
export function PhoneIcon({ access }: { access: MobileAccess | null }) {
  const tone = !access?.enabled ? "off" : access.error || !access.running ? "error" : "on";
  return <Smartphone size={13} className={`phone-icon is-${tone}`} aria-hidden />;
}

export function phoneTitle(a: MobileAccess | null): string {
  if (!a) return "Phone access";
  if (!a.enabled) return "Phone access is off\nClick to set it up";
  if (a.error) return `Phone access: ${a.error}`;
  return `Phone access on 127.0.0.1:${a.port}` + (a.lastSeenAt ? `\nPhone last seen ${relTime(Date.parse(a.lastSeenAt))}` : "");
}

/** A URL's host, lowercased, as url_host in src-tauri/src/mobile.rs: any scheme or none, no user, port or path. */
function urlHost(url: string): string {
  return url.trim().replace(/^[^:/?#]*:\/\//, "").split(/[/?#]/)[0].replace(/^.*@/, "").replace(/:\d*$/, "").replace(/\.+$/, "").toLowerCase();
}

/** The address for the QR code: the public URL, with https:// if it was typed without a scheme. Never a token. */
function phoneUrl(url: string): string {
  const u = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
}

const noServe = (error: string | null): TailscaleServe => ({
  cli: false, running: false, dnsName: null, route: null, target: null, auto: false, loginUrl: null, changed: null, error,
});

/** Phone companion: serve the phone API on a local port that tailscale serve or a Cloudflare tunnel exposes, and pair phones. */
export function PhonePopover({
  anchor, onClose, access, onChange,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  access: MobileAccess | null;
  onChange: (a: MobileAccess) => void;
}) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(access?.publicUrl ?? "");
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(Date.now());
  // Tailscale Serve and this Mac's Tailscale name, asked once per opening (the CLI can take a moment).
  const tailscale = useRef<Promise<TailscaleServe>>(null);
  tailscale.current ??= api.tailscaleServeStatus().catch((e) => noServe(String(e)));
  const [serve, setServe] = useState<TailscaleServe | null>(null);
  const [serveBusy, setServeBusy] = useState(false);
  useEffect(() => {
    tailscale.current?.then(setServe);
  }, []);
  const ts = serve?.cli ? serve : null;
  // Read by the event listener below, which outlives a render.
  const shown = useRef({ code, pairedAt: access?.pairedAt ?? null });
  shown.current = { code, pairedAt: access?.pairedAt ?? null };
  useEffect(() => {
    api.getMobileAccess().then((a) => {
      onChange(a);
      setUrl(a.publicUrl);
    }, () => {});
    // The code on screen is dead once this fires: a phone used it, wrong tries locked it, or the server stopped.
    return api.onMobileChanged(async () => {
      const before = shown.current;
      const n = await api.getMobileAccess().catch(() => null);
      if (n) onChange(n);
      if (!before.code) return;
      setCode(null);
      if (n?.pairedAt && n.pairedAt !== before.pairedAt) toast("Phone paired");
      else if (n?.running) toast("Too many wrong tries ended the pairing code. Pair again for a new one.", undefined, "error");
    });
  }, []);
  // A second tick for the code's countdown; a slow one otherwise for "last seen".
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), code ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [code]);

  if (!access) return null;
  const a = access;

  // enabled null keeps it as the backend has it: only the switch turns access on or off, never a stale view.
  const apply = async (enabled: boolean | null, publicUrl: string, done: (n: MobileAccess) => string) => {
    setBusy(true);
    try {
      const n = await api.setMobileAccess(enabled, publicUrl);
      onChange(n);
      setUrl(n.publicUrl);
      if (!n.enabled) setCode(null);
      if (n.enabled && n.error) toast(`Phone access: ${n.error}`, undefined, "error");
      else toast(done(n));
      return n;
    } catch (e) {
      toast(String(e), undefined, "error");
      setUrl(a.publicUrl);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const runServe = async (on: boolean, replace: boolean) => {
    setServeBusy(true);
    try {
      const s = await api.tailscaleServe(on, replace);
      setServe(s);
      if (s.loginUrl) toast("Tailscale Serve needs HTTPS for your tailnet: Enable HTTPS in the phone popover, then try again", undefined, "error");
      else if (s.error) toast(`Tailscale: ${s.error}`, undefined, "error");
      else if (s.changed) toast(s.changed);
    } catch (e) {
      toast(String(e), undefined, "error");
    } finally {
      setServeBusy(false);
    }
  };
  const pointHere = async () => {
    if (serve?.route === "other" && !(await api.confirm(`Tailscale serves ${serve.target ?? "something else"} at https://${serve.dnsName ?? "this Mac"}/. Replace it with Navarch's phone server?`))) return;
    runServe(true, true);
  };
  const toggle = async () => {
    // Busy before the Tailscale wait, so a second click can't send a second enable.
    setBusy(true);
    // Turning on with no URL: use this Mac's Tailscale name, which `tailscale serve` answers on.
    const t = !a.enabled && !url.trim() ? await tailscale.current : null;
    const name = t?.dnsName;
    const publicUrl = name ? `https://${name}` : url.trim();
    if (name) setUrl(publicUrl);
    const n = await apply(!a.enabled, publicUrl, (n) =>
      !n.enabled
        ? "Phone access off"
        : `Phone access on: serving 127.0.0.1:${n.port}` +
          (name ? ` at https://${name}` + (t?.running ? "" : " (Tailscale isn't connected)") : ""),
    );
    // The installed app points Tailscale Serve at itself, and lets go of it when switched off (only if it's ours).
    const s = await tailscale.current;
    if (n && n.enabled !== a.enabled && s?.auto && s.running) await runServe(n.enabled, false);
  };
  const applyTailscale = (name: string) => {
    setUrl(`https://${name}`);
    apply(null, `https://${name}`, (n) => `Phone URL set to ${n.publicUrl}`);
  };
  const suggest = ts?.dnsName && urlHost(url) !== ts.dnsName ? ts.dnsName : null;
  const saveUrl = () => {
    if (url.trim() !== a.publicUrl) apply(null, url.trim(), (n) => (n.publicUrl ? `Phone URL set to ${n.publicUrl}` : "Phone URL cleared"));
  };
  const pair = async () => {
    try {
      setCode(await api.newPairingCode());
      setNow(Date.now());
    } catch (e) {
      toast(String(e), undefined, "error");
    }
  };
  const unpair = async () => {
    if (!(await api.confirm("Unpair every phone? Each one has to pair again with a new code."))) return;
    try {
      onChange(await api.resetMobileToken());
      setCode(null);
      toast("Unpaired all phones");
    } catch (e) {
      toast(String(e), undefined, "error");
    }
  };

  const left = code ? Math.max(0, Math.floor((Date.parse(code.expiresAt) - now) / 1000)) : 0;
  const status = !a.enabled ? (
    <span className="muted">Off: nothing is served.</span>
  ) : a.error ? (
    <span className="ph-error">{a.error}</span>
  ) : a.running ? (
    <>
      <span className="ph-on">Running on port {a.port}</span>
      <span className="muted"> · {a.lastSeenAt ? `phone seen ${relTime(Date.parse(a.lastSeenAt))}` : "no phone seen yet"}</span>
    </>
  ) : (
    <span className="muted">Starting…</span>
  );

  const name = serve?.dnsName ? `https://${serve.dnsName}` : "This Mac";
  const point = (label: string) => (
    <button type="button" className="link" disabled={serveBusy || busy} onClick={pointHere}>
      {serveBusy ? "Pointing Tailscale here…" : label}
    </button>
  );
  const tailscaleLine = !serve ? (
    <span className="muted">Checking…</span>
  ) : !serve.cli ? (
    <span className="muted">not installed</span>
  ) : !serve.running ? (
    <span className="muted">not connected</span>
  ) : serve.loginUrl ? (
    <>
      <button type="button" className="link" onClick={() => api.openTailscaleLogin(serve.loginUrl!).catch((e) => toast(String(e), undefined, "error"))}>
        Enable HTTPS for your tailnet
      </button>
      <span className="muted">, then </span>
      {point("try again")}
    </>
  ) : serve.error || !serve.route ? (
    <span className="ph-error">{serve.error ?? "Can't read tailscale serve status"}</span>
  ) : serve.route === "ours" ? (
    <span><span className="ph-on">{name}</span> → this Mac</span>
  ) : serve.route === "navarch" ? (
    <>
      <span>{name} → another Navarch build</span>
      {a.enabled && point("Point Tailscale here")}
    </>
  ) : serve.route === "other" ? (
    <>
      <span title={serve.target ?? undefined}>
        {serve.target?.endsWith("open to the internet") ? "is public through Tailscale Funnel" : "serves something else at /"}
      </span>
      {a.enabled && point("Replace")}
    </>
  ) : (
    <>
      <span className="muted">not set up</span>
      {a.enabled && point("Point Tailscale here")}
    </>
  );
  // Dev builds point Serve here only on request, and the installed app takes it back.
  const devNote = serve && !serve.auto && serve.running && serve.route && serve.route !== "other" && (a.enabled || serve.route === "ours");

  return (
    <Popover anchor={anchor} anchorIsTrigger onClose={onClose} side="top" align="end" className="phone-pop">
      <div className="ph-head">
        <span className="pop-title">Phone access</span>
        <button
          type="button" role="switch" aria-checked={a.enabled} aria-label="Phone access" disabled={busy}
          className={`switch ${a.enabled ? "is-on" : ""}`} onClick={toggle}
          // Keep focus in the URL field: its blur would save on its own and disable this switch before the click lands.
          // toggle saves the URL too.
          onMouseDown={(e) => e.preventDefault()}
        >
          <span />
        </button>
      </div>
      <div className="ph-status">{status}</div>
      <label className="ph-url">
        <span className="pace-label">Public URL</span>
        <input
          className="field" type="url" spellCheck={false} value={url} placeholder="https://<mac>.<tailnet>.ts.net"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setUrl(a.publicUrl);
          }}
          onBlur={saveUrl}
        />
      </label>
      {suggest && (
        <button
          type="button" className="link ph-use" disabled={busy} onClick={() => applyTailscale(suggest)}
          // As the switch: the URL field's blur would save first.
          onMouseDown={(e) => e.preventDefault()}
          title={ts?.running ? "This Mac's Tailscale name" : "This Mac's Tailscale name (Tailscale isn't connected right now)"}
        >
          Use {suggest}
        </button>
      )}
      <div className="ph-ts">
        <span className="pace-label">Tailscale</span> {tailscaleLine}
      </div>
      {devNote && (
        <p className="hint ph-setup">
          {a.port === 47821
            ? "This is a dev build: the installed app takes the address back when it next starts with Phone access on."
            : `This dev build uses port ${a.port}, which the installed app doesn't know as Navarch's: it takes the address back only with Replace.`}
        </p>
      )}
      {serve && !serve.cli ? (
        <p className="hint ph-setup">
          Expose it with <code>tailscale serve --bg {a.port}</code>, or point a Cloudflare tunnel at <code>http://localhost:{a.port}</code>
        </p>
      ) : (
        <p className="hint ph-setup">
          Or point a Cloudflare tunnel at <code>http://localhost:{a.port}</code>
        </p>
      )}
      {a.enabled && a.publicUrl && (
        <div className="ph-qr">
          <QrCode value={phoneUrl(a.publicUrl)} label={`QR code for ${phoneUrl(a.publicUrl)}`} />
          <p className="hint">Scan with your iPhone camera, then Share › Add to Home Screen</p>
        </div>
      )}
      {code && left > 0 ? (
        <div className="ph-code">
          <div className="ph-code-value" aria-label="Pairing code">{code.code}</div>
          <div className="hint">
            Enter it on the phone{a.publicUrl ? ` at ${a.publicUrl}` : ""} · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-small ph-pair" disabled={!a.enabled || !a.running || busy} onClick={pair}>
          {code ? "Code expired: pair again" : "Pair a phone"}
        </button>
      )}
      <div className="ph-foot">
        <span>{a.pairedAt ? `Last paired ${relTime(Date.parse(a.pairedAt))}` : "No phone paired"}</span>
        {a.pairedAt && (
          <button type="button" className="link ph-unpair" onClick={unpair}>
            Unpair all phones
          </button>
        )}
      </div>
    </Popover>
  );
}
