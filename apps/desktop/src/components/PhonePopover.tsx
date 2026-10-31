import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { api, type MobileAccess, type PairingCode } from "../api";
import { useStore } from "../store";
import { relTime } from "../lib/format";
import { Popover } from "./ui";

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
  useEffect(() => {
    api.getMobileAccess().then((a) => {
      onChange(a);
      setUrl(a.publicUrl);
    }, () => {});
  }, []);
  // A second tick for the code's countdown; a slow one otherwise for "last seen".
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), code ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [code]);

  if (!access) return null;
  const a = access;

  const apply = async (enabled: boolean, publicUrl: string, done: (n: MobileAccess) => string) => {
    setBusy(true);
    try {
      const n = await api.setMobileAccess(enabled, publicUrl);
      onChange(n);
      setUrl(n.publicUrl);
      if (!n.enabled) setCode(null);
      if (n.enabled && n.error) toast(`Phone access: ${n.error}`, undefined, "error");
      else toast(done(n));
    } catch (e) {
      toast(String(e), undefined, "error");
      setUrl(a.publicUrl);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () =>
    apply(!a.enabled, url.trim(), (n) => (n.enabled ? `Phone access on: serving 127.0.0.1:${n.port}` : "Phone access off"));
  const saveUrl = () => {
    if (url.trim() !== a.publicUrl) apply(a.enabled, url.trim(), (n) => (n.publicUrl ? `Phone URL set to ${n.publicUrl}` : "Phone URL cleared"));
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

  return (
    <Popover anchor={anchor} anchorIsTrigger onClose={onClose} side="top" align="end" className="phone-pop">
      <div className="ph-head">
        <span className="pop-title">Phone access</span>
        <button
          type="button" role="switch" aria-checked={a.enabled} aria-label="Phone access" disabled={busy}
          className={`switch ${a.enabled ? "is-on" : ""}`} onClick={toggle}
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
      <p className="hint ph-setup">
        Expose it with <code>tailscale serve --bg {a.port}</code>, or point a Cloudflare tunnel at <code>http://localhost:{a.port}</code>
      </p>
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
