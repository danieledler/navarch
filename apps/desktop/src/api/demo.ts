// The demo dataset: one fictional developer, Robin, with work, open-source and personal projects.
// Shared by the mock backend (`pnpm dev`), the landing page's live demo and the UI walkthrough/e2e tests.
// Everything here is invented; dates are relative to today so deadlines, the week log and the OKR period stay current.
import type { Id, Period, Session, SessionStatus, Snapshot, Task } from "./types";
import { addDays, dayStr, isoWeek, parseDay, today, weekStart } from "../lib/dates";

export const DEMO_HOME = "/Users/robin";
/** Default answer of the mock folder picker: a folder with sessions that isn't a project yet. */
export const DEMO_PICK_FOLDER = `${DEMO_HOME}/code/scratch/wasm-image-resize`;

export function demoSnapshot(): Snapshot & { nextId: number } {
  let id = 1;
  const now = Date.now();
  const t0 = today();
  const weekEnd = addDays(weekStart(t0), 6);
  const weekStartMs = parseDay(weekStart(t0)).getTime();
  /** A deadline this week, `n` days from today but never past Sunday. */
  const thisWeek = (n: number) => (addDays(t0, n) > weekEnd ? weekEnd : addDays(t0, n));
  /** A finish time earlier this week: `f` of the way from Monday 00:00 to now. */
  const doneThisWeek = (f: number) => Math.round(weekStartMs + f * (now - weekStartMs));
  const daysAgo = (d: number) => now - d * 864e5;

  const snap: Snapshot = {
    spaces: [
      { id: id++, name: "Work", color: "#3b82f6", sort: 1 },
      { id: id++, name: "Open source", color: "#a855f7", sort: 2 },
      { id: id++, name: "Personal", color: "#22c55e", sort: 3 },
    ],
    projects: [],
    tasks: [],
    periods: [],
    periodTasks: [],
    weekTasks: [],
  };
  const [work, oss, personal] = snap.spaces.map((s) => s.id);
  const proj = (spaceId: Id, rel: string, ageDays: number) => {
    const p = { id: id++, spaceId, name: rel.split("/").pop()!, path: `${DEMO_HOME}/${rel}`, sort: snap.projects.length + 1, createdAt: daysAgo(ageDays) };
    snap.projects.push(p);
    return p.id;
  };
  const task = (projectId: Id, parentId: Id | null, title: string, extra: Partial<Task> = {}) => {
    const t: Task = {
      id: id++, projectId, parentId, title, notes: "", status: "open", deadline: null,
      sort: snap.tasks.filter((x) => x.projectId === projectId && x.parentId === parentId).length + 1,
      createdAt: daysAgo(30), doneAt: null, ...extra,
    };
    snap.tasks.push(t);
    return t.id;
  };
  const done = (doneAt: number): Partial<Task> => ({ status: "done", doneAt });

  // ---- Work: Shiftwren, a shift-scheduling app for small teams ----
  const web = proj(work, "code/shiftwren-web", 140);
  const avail = task(web, null, "Launch team availability view", {
    deadline: addDays(t0, 12),
    notes: "Managers see who can work when, per week, before they build the rota.\n\n- Behind the `availability_v2` flag until the pilot teams sign off\n- Must work with keyboard only",
  });
  task(web, avail, "Design availability grid component", done(daysAgo(6)));
  const wire = task(web, avail, "Wire grid to /availability endpoint", {
    notes: "Use the `useAvailability(teamId, week)` hook; optimistic toggles, roll back on 409.",
  });
  const drag = task(web, avail, "Drag to select time ranges");
  task(web, drag, "Keyboard support for range selection");
  task(web, drag, "Snap ranges to 15-minute slots");
  task(web, avail, "Empty and loading states", done(doneThisWeek(0.35)));
  task(web, null, "Fix Safari login redirect loop", {
    deadline: addDays(t0, -1),
    notes: "Reported by two customers. Only Safari, only after SSO.",
  });
  const compiler = task(web, null, "Adopt the React compiler");
  task(web, compiler, "Audit useMemo usage");
  task(web, compiler, "Turn on the compiler for /settings");

  const api = proj(work, "code/shiftwren-api", 160);
  const pubApi = task(api, null, "Public REST API v1", {
    deadline: addDays(t0, 45),
    notes: "Read-only first: teams, shifts, availability. Write endpoints after the beta.",
  });
  task(api, pubApi, "Rate limiting per API key", { deadline: thisWeek(1) });
  task(api, pubApi, "OpenAPI spec and generated docs");
  task(api, pubApi, "Pagination cursors for /shifts", done(doneThisWeek(0.6)));
  const hooks = task(api, pubApi, "Webhook delivery");
  task(api, hooks, "Retry with exponential backoff");
  task(api, hooks, "Signing secret rotation");
  const pg = task(api, null, "Postgres 17 upgrade", { deadline: addDays(t0, 20) });
  task(api, pg, "Dry run on a staging snapshot", done(doneThisWeek(0.2)));
  task(api, pg, "Check pg_stat_statements for regressions");

  const ops = proj(work, "code/shiftwren-ops", 120);
  const bill = task(ops, null, "Cut the cloud bill by 20%", {
    notes: "Baseline is last quarter's average. Biggest items: staging cluster, log storage, CI runners.",
  });
  task(ops, bill, "Right-size the staging cluster", done(daysAgo(10)));
  task(ops, bill, "Move logs to cold storage after 14 days");
  const spot = task(ops, bill, "Spot instances for CI runners");
  task(ops, null, "On-call runbook for queue backlog", { deadline: thisWeek(2) });

  // ---- Open source ----
  const knot = proj(oss, "oss/knotfile", 400);
  const rel = task(knot, null, "Release knotfile 1.0", { deadline: addDays(t0, 30) });
  const watch = task(knot, rel, "Watch mode with debounced rebuilds", {
    notes: "`knot watch build` reruns a target when its inputs change.\n\n**Done when** a save in any editor triggers exactly one rebuild.",
  });
  task(knot, watch, "Ignore files listed in .gitignore");
  task(knot, watch, "Coalesce FSEvents bursts on macOS", done(doneThisWeek(0.5)));
  task(knot, rel, "Windows path handling");
  task(knot, rel, "Changelog and migration guide");
  task(knot, null, "Triage new issues");

  const talk = proj(oss, "writing/local-first-talk", 60);
  const give = task(talk, null, "Give the talk at Harborconf", {
    deadline: addDays(t0, 19),
    notes: "30 minutes + Q&A. Theme: what *actually* goes wrong when two people edit offline.",
  });
  task(talk, give, "Outline: three sync strategies", done(daysAgo(12)));
  const demoApp = task(talk, give, "Build the live demo app");
  task(talk, demoApp, "Shared text demo with a CRDT", done(doneThisWeek(0.75)));
  task(talk, demoApp, "Offline toggle in the demo UI");
  const slides = task(talk, give, "Slides", { deadline: addDays(t0, 10) });
  task(talk, give, "Dry run with the team", { deadline: addDays(t0, 16) });
  task(talk, null, "Blog post: what I cut from the talk");

  // ---- Personal ----
  const lab = proj(personal, "homelab", 300);
  const move = task(lab, null, "Move services to the new mini PC");
  task(lab, move, "Restic backups to the NAS", done(doneThisWeek(0.1)));
  task(lab, move, "Migrate the media server");
  task(lab, move, "VPN access rules for family devices");
  task(lab, null, "Renew the wildcard TLS certificate", { deadline: thisWeek(3) });

  const game = proj(personal, "games/pixel-orchard", 200);
  const jam = task(game, null, "Playable build for the winter game jam", { deadline: addDays(t0, 40) });
  task(game, jam, "Tree growth sprites", done(daysAgo(8)));
  task(game, jam, "Seasons cycle");
  task(game, jam, "Save and load");
  task(game, null, "Fix tile seams at 150% zoom");

  // ---- OKR period (this half-year), goals at different depths, and this week's pins ----
  const half = Number(t0.slice(5, 7)) >= 7 ? "H2" : "H1";
  const start = `${t0.slice(0, 4)}-${half === "H2" ? "07" : "01"}-01`;
  const period: Period = { id: id++, name: `${t0.slice(0, 4)} ${half}`, start, end: addDays(start, 183) };
  snap.periods.push(period);
  for (const taskId of [avail, pubApi, watch, give]) snap.periodTasks.push({ periodId: period.id, taskId });
  const week = isoWeek(t0);
  for (const taskId of [wire, spot, slides]) snap.weekTasks.push({ week, taskId });

  return { ...snap, nextId: id };
}

interface DemoSession {
  title: string;
  /** Folder relative to the home directory. */
  dir: string;
  status: SessionStatus;
  minsAgo: number;
  prompt: string;
  /** Claude's latest text since the prompt; null when it hasn't written anything yet. */
  reply: string | null;
  task: string | null;
  hours: number;
  tokens: number;
  archived?: boolean;
  /** Claude started it in a temporary folder; `dir` is the project it was launched for. */
  temp?: boolean;
}

const SESSIONS: DemoSession[] = [
  {
    title: "Availability grid data wiring", dir: "code/shiftwren-web", status: "working", minsAgo: 0,
    prompt: "Hook the availability grid up to the new /availability endpoint and keep the optimistic updates",
    reply: "Grid now reads from `useAvailability(teamId, week)`. Optimistic toggles roll back on a 409; writing a test for two managers editing the same slot…",
    task: "Wire grid to /availability endpoint", hours: 4.2, tokens: 3_100_000,
  },
  {
    title: "Per-key rate limiting", dir: "code/shiftwren-api", status: "needs_input", minsAgo: 3,
    prompt: "Add rate limiting to the public API",
    reply: "I have a token-bucket limiter in `middleware/ratelimit.go`, backed by Redis, with `X-RateLimit-*` headers.\n\n**Question:** should the limit apply per API key or per organization? Per org is fairer to teams with many keys; per key matches the current docs draft.",
    task: "Rate limiting per API key", hours: 1.6, tokens: 820_000,
  },
  {
    title: "knotfile watch mode", dir: "oss/knotfile", status: "working", minsAgo: 1,
    prompt: "Make watch mode trigger exactly one rebuild per save",
    reply: "Editors fire 3–4 FSEvents per save (temp file, rename, chmod). I'm coalescing them in a 50 ms window and benchmarking on the 2k-file fixture now.",
    task: "Watch mode with debounced rebuilds", hours: 5.3, tokens: 2_600_000,
  },
  {
    title: "Cold storage lifecycle rule", dir: "code/shiftwren-ops", status: "unread", minsAgo: 12, temp: true,
    prompt: "Write a lifecycle rule that moves logs older than 14 days to cold storage",
    reply: "Here's a rule that moves `logs/` to the archive tier after 14 days and deletes after 365. This session is in a temporary folder, so I can't edit `terraform/storage.tf` from here; move it to **shiftwren-ops** and I'll apply it.",
    task: "Move logs to cold storage after 14 days", hours: 0.4, tokens: 140_000,
  },
  {
    title: "Cursor pagination for /shifts", dir: "code/shiftwren-api", status: "unread", minsAgo: 38,
    prompt: "Replace offset pagination on /shifts with cursors",
    reply: "**Done.** `/shifts` returns an opaque `next_cursor` (base64 of `starts_at, id`). Offset params still work but log a deprecation warning. All 48 handler tests pass.",
    task: "Pagination cursors for /shifts", hours: 2.3, tokens: 1_150_000,
  },
  {
    title: "Offline toggle for the talk demo", dir: "writing/local-first-talk", status: "unread", minsAgo: 95,
    prompt: "Add an offline switch to the demo so I can show conflicting edits on stage",
    reply: "Added an **Offline** switch in the header that pauses the sync socket. Edits queue in IndexedDB and merge on reconnect; open two tabs side by side to show it.",
    task: "Offline toggle in the demo UI", hours: 1.2, tokens: 560_000,
  },
  {
    title: "Explain the auth middleware", dir: "code/shiftwren-web", status: "idle", minsAgo: 410,
    prompt: "Walk me through how the session cookie is refreshed",
    reply: "The edge middleware refreshes the cookie when less than 10 minutes remain, then forwards the request. `lib/session.ts` holds the logic; the SSO callback bypasses it.",
    task: null, hours: 0.3, tokens: 95_000,
  },
  {
    title: "Query regressions after the upgrade", dir: "code/shiftwren-api", status: "stopped", minsAgo: 640,
    prompt: "Diff pg_stat_statements between the Postgres 16 and 17 staging runs",
    reply: "Comparing the top 20 queries by mean time. So far the `shifts_by_team` query is 18% slower on 17; checking whether the plan changed…",
    task: "Check pg_stat_statements for regressions", hours: 0.9, tokens: 410_000,
  },
  {
    title: "Safari login redirect loop", dir: "code/shiftwren-web", status: "idle", minsAgo: 1320,
    prompt: "After SSO login Safari loops back to /login. Why?",
    reply: "Safari drops the session cookie on the cross-site redirect because it is `SameSite=Strict`. `Lax` fixes it locally; the SSO callback still needs a check on staging.",
    task: "Fix Safari login redirect loop", hours: 1.8, tokens: 730_000,
  },
  {
    title: "Talk slides outline", dir: "writing/local-first-talk", status: "idle", minsAgo: 1700,
    prompt: "Turn the outline into a slide-by-slide plan, about 25 slides",
    reply: "24 slides in `slides/plan.md`: intro (3), last-write-wins (5), operational transforms (5), CRDTs (7), live demo (2), takeaways (2).",
    task: "Slides", hours: 0.8, tokens: 260_000,
  },
  {
    title: "Restic backups to the NAS", dir: "homelab", status: "idle", minsAgo: 2900,
    prompt: "Set up nightly restic backups of the docker volumes to the NAS",
    reply: "Nightly at 03:00 via a systemd timer; keeps 7 daily, 4 weekly, 6 monthly. A test restore of the `photos` volume matched checksums.",
    task: "Restic backups to the NAS", hours: 1.5, tokens: 480_000,
  },
  {
    title: "Tile seams at 150% zoom", dir: "games/pixel-orchard", status: "idle", minsAgo: 4400,
    prompt: "There are thin lines between tiles when I zoom to 150%",
    reply: "Linear filtering samples the neighbouring tile in the atlas. I added 1 px edge extrusion to the atlas build and set the texture filter to nearest.",
    task: "Fix tile seams at 150% zoom", hours: 0.7, tokens: 230_000,
  },
  {
    title: "Staging cluster right-sizing", dir: "code/shiftwren-ops", status: "idle", minsAgo: 14_500,
    prompt: "Which staging node pools are over-provisioned?",
    reply: "The `general` pool averages 11% CPU. Dropping from 6 to 3 nodes and moving batch jobs to a scale-to-zero pool saves about **$1,900/month**.",
    task: "Right-size the staging cluster", hours: 2.1, tokens: 900_000,
  },
  {
    title: "Zsh startup time", dir: "dotfiles", status: "idle", minsAgo: 5800,
    prompt: "My shell takes almost a second to start. Find out why",
    reply: "Startup went from 640 ms to 90 ms: the Node version manager is now lazy-loaded and `compinit` only rebuilds its cache once a day.",
    task: null, hours: 0.6, tokens: 190_000,
  },
  {
    title: "Neovim LSP config cleanup", dir: "dotfiles", status: "idle", minsAgo: 12_000,
    prompt: "Consolidate my LSP setup into one file",
    reply: "Merged the five server configs into `lua/lsp.lua` with shared keymaps and on-attach logic.",
    task: null, hours: 0.5, tokens: 170_000,
  },
  {
    title: "Resize images in a Web Worker", dir: "code/scratch/wasm-image-resize", status: "idle", minsAgo: 8600,
    prompt: "Spike: resize photos client-side with a WASM build of an image library",
    reply: "Works in a worker: a 12 MP photo resizes to 1600 px in about 180 ms. The WASM bundle is 410 kB gzipped.",
    task: null, hours: 1.1, tokens: 380_000,
  },
  {
    title: "Spike: GraphQL gateway", dir: "code/shiftwren-api", status: "idle", minsAgo: 26_000, archived: true,
    prompt: "Would a GraphQL gateway in front of the REST API be worth it?",
    reply: "Probably not yet: the mobile app needs three endpoints, and a gateway adds a deploy and a schema to keep in sync.",
    task: null, hours: 0.9, tokens: 300_000,
  },
];

/** Day shares of a session's active time, from its last day backwards. */
const DAY_SPREAD = [
  [0, 0.4],
  [1, 0.25],
  [2, 0.15],
  [4, 0.12],
  [9, 0.08],
] as const;

/** The demo sessions; `links` holds links made in the UI (session id → task), which win over the seeded ones. */
export function demoSessions(snap: Pick<Snapshot, "tasks">, links: Record<string, Id>): Session[] {
  const now = Date.now();
  const taskId = (title: string) => snap.tasks.find((t) => t.title === title)?.id ?? null;
  return SESSIONS.map((d, i) => {
    const n = i + 1;
    const running = d.status === "working" || d.status === "needs_input";
    const last = now - d.minsAgo * 6e4;
    const days = DAY_SPREAD.map(([back, share]) => ({
      day: dayStr(new Date(last - back * 864e5)),
      activeMs: Math.round(d.hours * 36e5 * share),
      tokens: Math.round(d.tokens * share),
    }));
    const id = `local_demo-${n}`;
    const project = `${DEMO_HOME}/${d.dir}`;
    return {
      id, cliId: `cli-demo-${n}`, title: d.title,
      cwd: d.temp ? `${DEMO_HOME}/Library/Application Support/Claude/scratch-workspaces/7c1e/2b90/scratch-${n}` : project,
      model: "claude-opus-5-5",
      createdAt: last - (60 + d.hours * 90) * 6e4, lastActivityAt: last, archived: d.archived ?? false, status: d.status, running,
      procs: running ? 1 + (n % 4) : 0, cpu: d.status === "working" ? 24 + n * 9 : running ? 0.4 : 0,
      lastPrompt: d.prompt, lastReply: d.reply, tokens: d.tokens,
      tokenRate: d.status === "working" ? 11_000 + n * 3_700 : 0, cacheRead: d.tokens * 9, activeMs: d.hours * 36e5, days,
      taskId: links[id] ?? (d.task ? taskId(d.task) : null),
      tempFolder: !!d.temp, launchPath: d.temp ? project : null,
    };
  });
}
