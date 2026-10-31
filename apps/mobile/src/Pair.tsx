import { useState, type FormEvent } from "react";
import { Offline } from "./api";
import { useStore } from "./store";

const ALPHABET = /[^A-Z0-9]/g;

/** iOS Safari outside the Home Screen app: only iOS has navigator.standalone. */
const inSafari = (navigator as { standalone?: boolean }).standalone === false;

export function Pair() {
  const pair = useStore((s) => s.pair);
  const note = useStore((s) => s.pairNote);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pair(code);
    } catch (err) {
      setError(
        err instanceof Offline
          ? "Can't reach Navarch on your Mac. Is it awake, with Phone access on?"
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setBusy(false);
    }
  };

  return (
    <form className="pair" onSubmit={submit}>
      <h1>Pair this phone</h1>
      {note && <div className="note">{note}</div>}
      <p>
        In Navarch on your Mac, open <strong>Phone access</strong> and tap <strong>Pair a phone</strong>. Type the 6-character code it
        shows.
      </p>
      <input
        className="code-input"
        aria-label="Pairing code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase().replace(ALPHABET, "").slice(0, 6));
          setError(null);
        }}
        maxLength={6}
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="one-time-code"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="······"
        autoFocus
      />
      {error && <div className="error" role="alert">{error}</div>}
      <button type="submit" className="btn" disabled={code.length !== 6 || busy}>
        {busy ? "Pairing…" : "Pair"}
      </button>
      {inSafari && (
        <div className="note">
          Add Navarch to your Home Screen first (Share › Add to Home Screen) and pair from there: the Home Screen app keeps its own key,
          so a pairing made here doesn't carry over.
        </div>
      )}
      <p className="muted" style={{ fontSize: 14 }}>
        A code works once, for 10 minutes. The phone keeps its own key afterwards; you can unpair it any time in settings.
      </p>
    </form>
  );
}
