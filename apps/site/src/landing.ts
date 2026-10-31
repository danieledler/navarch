import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "./landing.css";

/** The demo renders at the app's default window size and is scaled down to fit. */
const DESIGN_WIDTH = 1440;
/** Below this frame width the scaled app is too small to click, so it becomes a picture with a link. */
const COMPACT_BELOW = 720;

const win = document.querySelector<HTMLElement>("[data-window]")!;
const stage = document.querySelector<HTMLElement>("[data-stage]")!;
const frame = document.querySelector<HTMLIFrameElement>("[data-frame]")!;

function fit() {
  const width = win.clientWidth;
  stage.style.transform = `scale(${width / DESIGN_WIDTH})`;
  const compact = width < COMPACT_BELOW;
  win.toggleAttribute("data-compact", compact);
  frame.tabIndex = compact ? -1 : 0;
  frame.toggleAttribute("inert", compact);
}

new ResizeObserver(fit).observe(win);
fit();

// The demo's mock reseeds its data whenever its URL mentions "reset".
document.querySelector("[data-reset]")!.addEventListener("click", () => {
  frame.src = `./demo/?reset=${Date.now()}`;
});
