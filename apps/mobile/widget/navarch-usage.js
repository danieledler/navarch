// Navarch usage: a Scriptable (https://scriptable.app) widget with your Claude plan limits as Navarch on your Mac reads them.
// Copy it from Navarch's phone app (the cog in its header), which fills in SERVER and TOKEN; paste it into a new
// Scriptable script, then add a Scriptable widget to the Home or Lock Screen and choose this script.
// TOKEN is the phone's pairing token. It only works through your tailnet; after pairing again, copy the script again.

const SERVER = "{{SERVER}}";
const TOKEN = "{{TOKEN}}";

const FIVE_HOURS = 5 * 3600_000;
const SEVEN_DAYS = 7 * 24 * 3600_000;

const C = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1d1e22")),
  text: Color.dynamic(new Color("#1c1d21"), new Color("#e7e7ea")),
  muted: Color.dynamic(new Color("#8a8c94"), new Color("#7f818a")),
  track: new Color("#8a8c94", 0.22),
  good: Color.dynamic(new Color("#2f9e5b"), new Color("#3fb873")),
  warn: Color.dynamic(new Color("#e08a00"), new Color("#f5a524")),
  hot: Color.dynamic(new Color("#e5484d"), new Color("#f2555a")),
};

// Keep in step with apps/desktop/src/lib/pace.ts.
function paceOf(w, windowMs, now) {
  const percent = Math.max(0, Math.min(100, w.percent));
  let expected = null;
  if (w.resetsAt) {
    const left = new Date(w.resetsAt).getTime() - now;
    expected = Math.max(0, Math.min(100, (100 * (windowMs - left)) / windowMs));
  }
  const delta = expected == null ? null : Math.round(percent - expected);
  const tone =
    percent >= 90 || (delta != null && delta > 15) ? "hot" : (delta != null && delta > 0) || (delta == null && percent >= 60) ? "warn" : "good";
  return { percent, expected, delta, tone };
}

function windows(u, now) {
  return [
    { title: "5-hour window", short: "5h", w: u.fiveHour, ms: FIVE_HOURS, weekly: false },
    { title: "Weekly", short: "Week", w: u.sevenDay, ms: SEVEN_DAYS, weekly: true },
  ].map((x) => ({
    ...x,
    pace: x.w ? paceOf(x.w, x.ms, now) : null,
    // The numbers are from before this reset (the Mac hasn't answered since), so they no longer hold.
    passed: !!(x.w && x.w.resetsAt && new Date(x.w.resetsAt).getTime() <= now),
  }));
}

/** The Mac's answer, saved so a sleeping Mac still leaves the last numbers on screen. */
async function load() {
  const fm = FileManager.local();
  const file = fm.joinPath(fm.documentsDirectory(), "navarch-usage.json");
  let usage = null;
  let problem = null;
  try {
    const req = new Request(`${SERVER}/api/get_usage`);
    req.method = "POST";
    req.headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
    req.body = "{}";
    req.timeoutInterval = 10;
    const body = await req.loadJSON();
    const status = req.response.statusCode;
    if (status === 401) problem = "unpaired";
    else if (status === 200 && body && "fetchedAt" in body) {
      usage = body;
      fm.writeString(file, JSON.stringify(usage));
    } else problem = (body && body.error) || `Request failed (${status})`;
  } catch {
    // Not JSON (tailscale's own error page) or no answer at all.
    problem = "offline";
  }
  if (!usage && problem !== "unpaired" && fm.fileExists(file)) {
    try {
      usage = JSON.parse(fm.readString(file));
    } catch {
      /* a broken cache is no cache */
    }
  }
  return { usage, problem };
}

function ago(ms, now) {
  const m = Math.floor((now - ms) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function until(iso, now) {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - now) / 6e4));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 === 0 ? `${h / 24}d` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function resetLabel(iso, weekly) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return weekly ? `${d.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
}

/** One line on how fresh the numbers are; `quiet` when there's nothing to worry about. */
function freshness(r, now) {
  const read = r.usage ? ` · ${ago(r.usage.fetchedAt, now)}` : "";
  if (r.problem === "unpaired") return { text: "Pair again", color: C.hot };
  if (r.problem === "offline") return { text: `Mac offline${read}`, color: C.warn };
  if (r.problem) return { text: r.problem, color: C.warn };
  if (r.usage.error) return { text: `Stale${read}`, color: C.warn };
  const old = now - r.usage.fetchedAt > 30 * 60_000;
  return { text: `Read ${ago(r.usage.fetchedAt, now)}`, color: old ? C.warn : C.muted, quiet: !old };
}

/** Widgets come in fixed sizes per screen and a bar needs a width, so this errs a little short. */
function widgetWidth(family) {
  const s = Device.screenSize();
  const w = Math.min(s.width, s.height);
  const [small, medium] = Device.isPad()
    ? [155, 329]
    : w >= 428
      ? [170, 364]
      : w >= 414
        ? [159, 348]
        : w >= 390
          ? [158, 338]
          : w >= 375
            ? [148, 321]
            : [141, 292];
  return family === "small" ? small : medium;
}

function text(parent, s, font, color) {
  const t = parent.addText(s);
  t.font = font;
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

/** A meter as stacks (images can't follow light/dark): the fill, and a tick where an even pace would be. */
function bar(parent, width, height, pace, fill, mark) {
  const track = parent.addStack();
  track.size = new Size(width, height);
  track.cornerRadius = height / 2;
  track.backgroundColor = C.track;
  track.layoutHorizontally();
  const used = (pace.percent / 100) * width;
  const segs = [];
  if (pace.expected == null || !mark) segs.push([used, fill]);
  else {
    const m = 2;
    const at = Math.min(width - m, Math.max(0, (pace.expected / 100) * width));
    if (used <= at) segs.push([used, fill], [at - used, null], [m, mark]);
    else segs.push([at, fill], [m, mark], [used - at - m, fill]);
  }
  for (const [w, color] of segs) {
    if (w < 0.5) continue;
    const s = track.addStack();
    s.size = new Size(w, height);
    if (color) s.backgroundColor = color;
  }
  track.addSpacer();
}

function paceText(p) {
  if (p.delta == null) return "Reset time unknown";
  if (p.delta === 0) return "On pace";
  return `${Math.abs(p.delta)} ${p.delta < 0 ? "under" : "over"} pace`;
}

/** Title and percent, the meter, then a caption: the block both Home Screen sizes stack twice. */
function windowBlock(parent, x, width, now, medium) {
  const block = parent.addStack();
  block.layoutVertically();
  block.spacing = 4;
  const top = block.addStack();
  top.size = new Size(width, 0);
  top.centerAlignContent();
  text(top, medium ? x.title : x.short, Font.semiboldSystemFont(13), C.text);
  top.addSpacer();
  const shown = x.pace && !x.passed;
  text(top, shown ? `${Math.round(x.pace.percent)}%` : "–", Font.boldSystemFont(medium ? 15 : 18), shown ? C[x.pace.tone] : C.muted);
  if (shown) bar(block, width, 8, x.pace, C[x.pace.tone], C.text);
  else bar(block, width, 8, { percent: 0, expected: null }, null, null);
  const cap = block.addStack();
  cap.size = new Size(width, 0);
  const small = Font.systemFont(11);
  const reset = x.w && x.w.resetsAt;
  if (x.passed) text(cap, `Reset at ${resetLabel(reset, x.weekly)}`, small, C.muted);
  else if (medium) {
    if (shown) text(cap, paceText(x.pace), small, C[x.pace.tone]);
    cap.addSpacer();
    if (reset) text(cap, `Resets in ${until(reset, now)} · ${resetLabel(reset, x.weekly)}`, small, C.muted);
  } else if (reset) text(cap, `Resets ${resetLabel(reset, x.weekly)}`, small, C.muted);
  // A sized stack centers what it holds; a spacer keeps a lone caption on the left.
  if (x.passed || !medium) cap.addSpacer();
}

function homeWidget(r, family, now) {
  const medium = family !== "small";
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  const padX = medium ? 16 : 14;
  w.setPadding(14, padX, 14, padX);
  const width = widgetWidth(family) - 2 * padX - 2;
  const f = freshness(r, now);
  if (medium || !f.quiet) {
    const head = w.addStack();
    head.size = new Size(width, 0);
    if (medium) {
      text(head, "CLAUDE PLAN", Font.semiboldSystemFont(11), C.muted);
      head.addSpacer();
    }
    text(head, f.text, Font.systemFont(11), f.color);
    if (!medium) head.addSpacer();
    w.addSpacer();
  }
  const [five, week] = windows(r.usage, now);
  windowBlock(w, five, width, now, medium);
  w.addSpacer();
  windowBlock(w, week, width, now, medium);
  return w;
}

/** A ring for the lock screen, drawn in white: the system tints it. */
function ring(fraction) {
  const n = 120;
  const lw = 10;
  const ctx = new DrawContext();
  ctx.size = new Size(n, n);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const c = n / 2;
  const r = c - lw / 2 - 1;
  ctx.setLineWidth(lw);
  ctx.setStrokeColor(new Color("#ffffff", 0.25));
  ctx.strokeEllipse(new Rect(c - r, c - r, 2 * r, 2 * r));
  if (fraction > 0) {
    const steps = Math.max(2, Math.ceil(120 * fraction));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (2 * Math.PI * fraction * i) / steps;
      pts.push(new Point(c + r * Math.cos(a), c + r * Math.sin(a)));
    }
    const p = new Path();
    p.addLines(pts);
    ctx.addPath(p);
    ctx.setStrokeColor(Color.white());
    ctx.strokePath();
  }
  return ctx.getImage();
}

function pct(x) {
  return x.pace && !x.passed ? `${Math.round(x.pace.percent)}%` : "–";
}

function lockWidget(r, family, now) {
  const w = new ListWidget();
  const white = Color.white();
  const [five, week] = windows(r.usage, now);
  const stale = !!r.problem || !!r.usage.error;
  if (family === "accessoryInline") {
    text(w, `${stale ? "⚠︎ " : ""}5h ${pct(five)} · Week ${pct(week)}`, Font.systemFont(12), white);
    return w;
  }
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    w.backgroundImage = ring(five.pace && !five.passed ? five.pace.percent / 100 : 0);
    const col = w.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    const row = (s, font) => {
      const line = col.addStack();
      line.addSpacer();
      text(line, s, font, white);
      line.addSpacer();
    };
    row(pct(five), Font.boldSystemFont(15));
    row(stale ? "⚠︎ 5h" : "5h", Font.systemFont(10));
    return w;
  }
  // accessoryRectangular
  w.spacing = 3;
  for (const x of [five, week]) {
    const line = w.addStack();
    line.centerAlignContent();
    line.spacing = 6;
    const label = line.addStack();
    label.size = new Size(34, 0);
    text(label, x.short, Font.semiboldSystemFont(12), white);
    label.addSpacer();
    bar(line, 64, 6, x.pace && !x.passed ? x.pace : { percent: 0, expected: null }, white, null);
    text(line, pct(x), Font.semiboldSystemFont(12), white);
  }
  const reset = five.w && five.w.resetsAt;
  const foot = r.problem ? freshness(r, now).text : reset && !five.passed ? `5h resets ${resetLabel(reset, false)}` : "";
  if (foot) text(w, foot, Font.systemFont(11), new Color("#ffffff", 0.7));
  return w;
}

function messageWidget(title, detail, family) {
  const w = new ListWidget();
  const lock = family.startsWith("accessory");
  if (!lock) {
    w.backgroundColor = C.bg;
    w.setPadding(14, 14, 14, 14);
  }
  text(w, title, Font.semiboldSystemFont(lock ? 12 : 14), lock ? Color.white() : C.text);
  if (detail && family !== "accessoryInline") {
    const d = w.addText(detail);
    d.font = Font.systemFont(lock ? 10 : 12);
    d.textColor = lock ? Color.white() : C.muted;
    d.minimumScaleFactor = 0.7;
  }
  return w;
}

async function build(family) {
  const now = Date.now();
  if (TOKEN.startsWith("{{"))
    return messageWidget("Set up in Navarch", "Copy this script from Navarch's phone app: the cog in its header.", family);
  const r = await load();
  if (r.problem === "unpaired")
    return messageWidget("Pair again", "Navarch refused the token. Copy the widget script again from the phone app.", family);
  if (!r.usage) return messageWidget(r.problem === "offline" ? "Mac offline" : "No usage yet", r.problem === "offline" ? "" : r.problem, family);
  if (!r.usage.fiveHour && !r.usage.sevenDay) return messageWidget("Usage unavailable", r.usage.error || "", family);
  return family.startsWith("accessory") ? lockWidget(r, family, now) : homeWidget(r, family, now);
}

const family = config.widgetFamily || "medium";
const widget = await build(family);
widget.refreshAfterDate = new Date(Date.now() + 5 * 60_000);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
