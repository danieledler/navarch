import { Copy } from "lucide-react";
import widgetScript from "../widget/navarch-usage.js?raw";
import { getToken } from "./api";
import { useStore } from "./store";

/** The Scriptable widget script (apps/mobile/widget), copied with this server and the phone's token filled in. A one-time setup, so it lives in the settings sheet. */
export function WidgetSetup() {
  const toast = useStore((s) => s.toast);
  const copy = () => {
    const script = widgetScript
      .replace('"{{SERVER}}"', JSON.stringify(location.origin))
      .replace('"{{TOKEN}}"', JSON.stringify(getToken() ?? ""));
    navigator.clipboard.writeText(script).then(
      () => toast("Widget script copied"),
      () => toast("Couldn't copy the widget script", undefined, "error"),
    );
  };
  return (
    <>
      <button type="button" className="btn-sheet" onClick={copy}>
        <Copy size={18} />
        Copy usage widget script
      </button>
      <div className="sheet-note">
        Your Claude plan's 5-hour and weekly windows on the Home or Lock Screen, through the free Scriptable app: in Scriptable, tap + and paste,
        then add a Scriptable widget and pick the script. The script carries this phone's token.
      </div>
    </>
  );
}
