// The demo dataset: one fictional developer, Robin, with work, open-source and personal projects.
// Shared by the mock backend (`pnpm dev`), the landing page's live demo and the UI walkthrough/e2e tests.
// Everything here is invented; dates are relative to today so deadlines, the week log and the OKR period stay current.
import type { CheckState, Id, Issue, Label, Period, PullRequest, RepoOverview, RepoRef, Session, SessionStatus, Snapshot, Task, Worktree } from "./types";
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
  /** It works in the project's worktree `.claude/worktrees/<worktree>` (see demoRepoOverview). */
  worktree?: string;
}

const SESSIONS: DemoSession[] = [
  {
    title: "Availability grid data wiring", dir: "code/shiftwren-web", status: "working", minsAgo: 0,
    prompt: "Hook the availability grid up to the new /availability endpoint and keep the optimistic updates",
    reply: "Grid now reads from `useAvailability(teamId, week)`. Optimistic toggles roll back on a 409; writing a test for two managers editing the same slot…",
    task: "Wire grid to /availability endpoint", hours: 4.2, tokens: 3_100_000, worktree: "availability-grid",
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
    task: "Watch mode with debounced rebuilds", hours: 5.3, tokens: 2_600_000, worktree: "watch-debounce",
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
    task: "Fix Safari login redirect loop", hours: 1.8, tokens: 730_000, worktree: "safari-sso-cookie",
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
    const cwd = d.temp ? `${DEMO_HOME}/Library/Application Support/Claude/scratch-workspaces/7c1e/2b90/scratch-${n}` : project;
    return {
      id, cliId: `cli-demo-${n}`, title: d.title, cwd,
      cwds: d.worktree ? [cwd, `${project}/.claude/worktrees/${d.worktree}`] : [cwd],
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

// ---- Repo panel: worktrees, pull requests and issues of the demo projects ----

const ME = "robinvale";
const lbl = (name: string, color: string): Label => ({ name, color });
const L = {
  bug: lbl("bug", "#d73a4a"),
  feature: lbl("enhancement", "#a2eeef"),
  docs: lbl("documentation", "#0075ca"),
  gfi: lbl("good first issue", "#7057ff"),
  help: lbl("help wanted", "#008672"),
  deps: lbl("dependencies", "#0366d6"),
  a11y: lbl("accessibility", "#5319e7"),
  avail: lbl("area: availability", "#1d76db"),
  auth: lbl("area: auth", "#c2e0c6"),
  safari: lbl("safari", "#fbca04"),
  flaky: lbl("flaky test", "#e99695"),
  debt: lbl("tech debt", "#c5def5"),
  windows: lbl("platform: windows", "#bfd4f2"),
  watch: lbl("watch mode", "#0e8a16"),
  rust: lbl("rust", "#dea584"),
  repro: lbl("needs repro", "#fef2c0"),
};

const CHECK_ORDER = { failure: 0, pending: 1, success: 2, neutral: 3 } as const;

// The talk's folder isn't a repo itself: it holds three (the demo app, the slides, and notes with no GitHub remote).
const TALK = `${DEMO_HOME}/writing/local-first-talk`;
/** Demo repo roots: [root, GitHub slug or null, HEAD commit hours ago]. */
const DEMO_REPOS: [string, string | null, number][] = [
  [`${DEMO_HOME}/code/shiftwren-web`, "robin-lab/shiftwren-web", 0.4],
  [`${DEMO_HOME}/oss/knotfile`, "robin-lab/knotfile", 20],
  [`${DEMO_HOME}/games/pixel-orchard`, null, 48],
  [`${TALK}/demo-app`, "robin-lab/syncpad", 1.6],
  [`${TALK}/slides`, "robin-lab/local-first-talk", 26],
  [`${TALK}/notes`, null, 140],
];

/** The git repos of a demo project folder, as `find_repos` would report them. */
export function demoFindRepos(path: string): RepoRef[] {
  const p = path.replace(/\/+$/, "");
  const ref = ([root, github, hours]: [string, string | null, number], rel: string): RepoRef => ({
    root, rel, name: rel || root.split("/").pop()!, github, committedAt: Date.now() - hours * 36e5,
  });
  const inside = DEMO_REPOS.find(([r]) => p === r || p.startsWith(r + "/"));
  const below = DEMO_REPOS.filter(([r]) => r.startsWith(p + "/") && r.slice(p.length + 1).split("/").length <= 2)
    .map((x) => ref(x, x[0].slice(p.length + 1)))
    .sort((a, b) => b.committedAt - a.committedAt);
  return [...(inside ? [ref(inside, "")] : []), ...below].slice(0, 12);
}

/** The repo behind a demo project folder (or a folder inside it), as `get_repo_overview` would report it. */
export function demoRepoOverview(path: string): RepoOverview | null {
  const now = Date.now();
  const m = (n: number) => now - n * 6e4;
  const h = (n: number) => now - n * 36e5;
  const d = (n: number) => now - n * 864e5;
  const known = DEMO_REPOS.find(([r]) => path.replace(/\/+$/, "") === r || path.startsWith(r + "/"));
  if (!known) return null;
  const root = known[0];
  const name = root.split("/").pop()!;
  const slug = known[1] ?? `robin-lab/${name}`;
  const gh = `https://github.com/${slug}`;

  const checks = (spec: string) =>
    spec
      .split(",")
      .map((c) => {
        const [n, s] = c.trim().split(":");
        return { name: n, state: (s ?? "success") as CheckState };
      })
      .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const pr = (p: Partial<PullRequest> & Pick<PullRequest, "number" | "title" | "headRef">): PullRequest => {
    const cs = p.checks ?? [];
    const rolled = cs.length === 0 ? null : cs.some((c) => c.state === "failure") ? "failure" : cs.some((c) => c.state === "pending") ? "pending" : "success";
    return {
      url: `${gh}/pull/${p.number}`, author: ME, isDraft: false, state: "open", baseRef: "main",
      createdAt: d(3), updatedAt: h(2), review: "review_required", checksState: rolled, checks: cs,
      additions: 0, deletions: 0, changedFiles: 0, labels: [], body: "", mergeable: "mergeable", mergeState: "clean",
      reviewers: [], commits: 1, comments: 0, closingIssues: [], autoMerge: false, mergedAt: null, closedAt: null,
      ...p,
    };
  };
  const issue = (i: Partial<Issue> & Pick<Issue, "number" | "title">): Issue => ({
    url: `${gh}/issues/${i.number}`, author: ME, createdAt: d(20), updatedAt: d(2), labels: [], assignees: [],
    comments: 0, body: "", milestone: null, issueType: null, subIssues: null, linkedPulls: [], ...i,
  });
  const wt = (w: Partial<Worktree> & Pick<Worktree, "head" | "subject" | "committedAt">, folder: string): Worktree => ({
    path: `${root}/.claude/worktrees/${folder}`, branch: folder, ahead: 0, behind: 0, dirty: w.changes?.length ?? 0, changes: [],
    merged: false, locked: false, prunable: false, commitsAhead: [], upstream: `origin/${folder}`, unpushed: 0, procs: [], ...w,
  });

  if (name === "shiftwren-web") {
    const pulls = [
      pr({
        number: 214, title: "Wire the availability grid to /availability", headRef: "availability-grid",
        createdAt: h(26), updatedAt: m(18), additions: 342, deletions: 113, changedFiles: 8, commits: 3, comments: 2,
        labels: [L.avail], closingIssues: [198], mergeState: "blocked",
        checks: checks("build, lint, typecheck, e2e (chromium):pending, e2e (webkit):pending, preview deploy:pending"),
        reviewers: [{ login: "lena-voss", state: "commented" }, { login: "sam-okafor", state: "pending" }],
        body: "Reads availability through `useAvailability(teamId, week)` and toggles slots optimistically; a 409 rolls the slot back and shows who changed it.\n\n- Behind `availability_v2`\n- Fixes the time zone shift from #198\n\nStill to do: test for two managers editing the same slot.",
      }),
      pr({
        number: 212, title: "Keyboard range selection in the availability grid", headRef: "grid-keyboard", isDraft: true,
        createdAt: d(2), updatedAt: h(5), additions: 128, deletions: 14, changedFiles: 4, commits: 2, review: null,
        labels: [L.avail, L.a11y], mergeState: "draft", checks: checks("build, lint, typecheck, e2e (chromium)"),
        body: "Shift+arrows extend the selection, Space toggles it. Draft until the focus ring design lands.",
      }),
      pr({
        number: 211, title: "Upgrade Next.js to 15 and drop the legacy middleware", headRef: "next-15", author: "mika-tan",
        createdAt: d(6), updatedAt: h(9), additions: 611, deletions: 948, changedFiles: 37, commits: 9, comments: 11,
        labels: [L.debt, L.deps], mergeable: "conflicting", mergeState: "dirty", review: "changes_requested",
        checks: checks("build:failure, typecheck:failure, lint, e2e (chromium):neutral, e2e (webkit):neutral"),
        reviewers: [{ login: ME, state: "changes_requested" }, { login: "lena-voss", state: "approved" }],
        body: "Moves session refresh out of the edge middleware into route handlers. Conflicts with the SameSite change from #209; needs a rebase.",
      }),
      pr({
        number: 210, title: "Snap availability ranges to 15-minute slots", headRef: "snap-slots", author: "lena-voss",
        createdAt: d(4), updatedAt: h(3), additions: 86, deletions: 31, changedFiles: 3, commits: 4, comments: 3,
        labels: [L.avail], review: "approved", closingIssues: [203], autoMerge: true,
        checks: checks("build, lint, typecheck, e2e (chromium), e2e (webkit), preview deploy"),
        reviewers: [{ login: ME, state: "approved" }, { login: "sam-okafor", state: "approved" }],
        body: "Rounds drag ranges to the nearest quarter hour and shows the snapped range while dragging.",
      }),
    ];
    const recentPulls = [
      pr({
        number: 209, title: "Use SameSite=Lax for the session cookie", headRef: "safari-sso-cookie", state: "merged",
        createdAt: d(1.4), updatedAt: h(20), mergedAt: h(20), closedAt: h(20), additions: 24, deletions: 6, changedFiles: 2,
        commits: 2, comments: 1, labels: [L.auth, L.safari], review: "approved", reviewers: [{ login: "sam-okafor", state: "approved" }],
        checks: checks("build, lint, typecheck, e2e (chromium), e2e (webkit)"),
        body: "Safari dropped the `Strict` cookie on the SSO redirect back to us. Fixes the loop locally; staging still to check.",
      }),
      pr({
        number: 206, title: "Empty and loading states for the availability grid", headRef: "grid-empty-states", state: "merged",
        createdAt: d(5), updatedAt: d(3), mergedAt: d(3), closedAt: d(3), additions: 97, deletions: 12, changedFiles: 5, commits: 3,
        labels: [L.avail], review: "approved", reviewers: [{ login: "lena-voss", state: "approved" }], checks: checks("build, lint, typecheck"),
      }),
      pr({
        number: 205, title: "Experiment: server components for /settings", headRef: "rsc-settings", state: "closed",
        createdAt: d(12), updatedAt: d(7), closedAt: d(7), additions: 410, deletions: 220, changedFiles: 14, commits: 5, comments: 6,
        labels: [L.debt], review: null, checks: checks("build, typecheck:failure"),
        body: "Closing: the React compiler gets most of this for less churn.",
      }),
    ];
    const issues = [
      issue({
        number: 215, title: "Login still loops after SSO in Safari on staging", author: "sam-okafor", createdAt: h(18), updatedAt: h(4),
        labels: [L.bug, L.auth, L.safari], assignees: [ME], comments: 4, issueType: "Bug",
        body: "#209 fixed it locally, but on staging the SSO callback still redirects to /login in Safari 18. Two customers affected.",
      }),
      issue({
        number: 198, title: "Availability grid shows slots shifted by the team's UTC offset", author: "lena-voss", createdAt: d(9), updatedAt: m(18),
        labels: [L.bug, L.avail], assignees: [ME], comments: 3, milestone: "Availability v2", issueType: "Bug", linkedPulls: [214],
        body: "A team in Europe/Stockholm sees a 9:00 slot at 8:00. The grid builds dates in the browser's zone, not the team's.",
      }),
      issue({
        number: 203, title: "Snap selected ranges to 15-minute slots", createdAt: d(8), updatedAt: h(3),
        labels: [L.feature, L.avail], assignees: ["lena-voss"], comments: 2, milestone: "Availability v2", issueType: "Feature", linkedPulls: [210],
      }),
      issue({
        number: 190, title: "Team availability view", createdAt: d(40), updatedAt: d(1),
        labels: [L.avail], assignees: [ME, "lena-voss"], comments: 9, milestone: "Availability v2", issueType: "Epic",
        subIssues: { total: 7, completed: 3 },
        body: "Managers see who can work when, per week, before they build the rota. Pilot teams: Harbor Café, Northside Clinic.",
      }),
      issue({
        number: 188, title: "Adopt the React compiler", createdAt: d(30), updatedAt: d(4), labels: [L.debt], comments: 2, issueType: "Task",
        subIssues: { total: 2, completed: 0 },
      }),
      issue({
        number: 176, title: "Date picker isn't announced by VoiceOver", author: "jo-lindqvist", createdAt: d(25), updatedAt: d(6),
        labels: [L.a11y, L.gfi, L.help], comments: 1, issueType: "Bug",
      }),
      issue({
        number: 172, title: "Flaky e2e: dragging a shift fails on CI webkit", author: "mika-tan", createdAt: d(18), updatedAt: d(2),
        labels: [L.flaky], comments: 5,
      }),
    ];
    const worktrees: Worktree[] = [
      wt(
        {
          head: "a3f9c21", subject: "Roll back optimistic toggles on 409", committedAt: m(25), ahead: 3, behind: 1, unpushed: 1,
          changes: [" M src/features/availability/AvailabilityGrid.tsx", " M src/features/availability/useAvailability.ts", "?? src/features/availability/concurrentEdit.test.ts", " M src/api/availability.ts"],
          commitsAhead: [
            { hash: "a3f9c21", subject: "Roll back optimistic toggles on 409", at: m(25) },
            { hash: "5be0d47", subject: "Build grid dates in the team's time zone", at: h(5) },
            { hash: "e81c3a0", subject: "Read the grid from useAvailability", at: h(27) },
          ],
          procs: [
            { pid: 48211, name: "node", cmd: "node node_modules/.bin/vite --port 5173" },
            { pid: 48240, name: "node", cmd: "node node_modules/.bin/vitest --watch src/features/availability" },
          ],
        },
        "availability-grid",
      ),
      wt(
        {
          head: "7d2e9b4", subject: "Turn on the compiler for /settings", committedAt: d(3), ahead: 2, behind: 6, upstream: null, unpushed: null,
          changes: [" M babel.config.js"],
          commitsAhead: [
            { hash: "7d2e9b4", subject: "Turn on the compiler for /settings", at: d(3) },
            { hash: "c04f8e1", subject: "Add babel-plugin-react-compiler", at: d(3.1) },
          ],
        },
        "react-compiler",
      ),
      wt({ head: "19ab6f2", subject: "Use SameSite=Lax for the session cookie", committedAt: h(23), behind: 4, merged: true }, "safari-sso-cookie"),
      wt(
        {
          head: "0c7d551", subject: "Retry the drag test with a longer pointer delay", committedAt: d(9), ahead: 1, behind: 14, locked: true,
          commitsAhead: [{ hash: "0c7d551", subject: "Retry the drag test with a longer pointer delay", at: d(9) }],
        },
        "e2e-drag-flake",
      ),
    ];
    return {
      root, base: "main", branch: "main", worktrees, githubError: null,
      github: { repo: slug, url: gh, pulls, recentPulls, issues, fetchedAt: m(1) },
    };
  }

  if (name === "knotfile") {
    const pulls = [
      pr({
        number: 91, title: "watch: skip files ignored by .gitignore", headRef: "gitignore-watch", author: "ana-sousa",
        createdAt: d(3), updatedAt: h(6), additions: 214, deletions: 38, changedFiles: 6, commits: 5, comments: 4,
        labels: [L.watch, L.feature], closingIssues: [79], checks: checks("test (ubuntu), test (macos), test (windows), clippy, fmt"),
        reviewers: [{ login: ME, state: "pending" }],
        body: "Uses the `ignore` crate to honour .gitignore, .ignore and global excludes. Adds a fixture with nested ignore files.",
      }),
      pr({
        number: 88, title: "Normalize Windows paths in target inputs", headRef: "windows-paths",
        createdAt: d(8), updatedAt: d(1), additions: 156, deletions: 47, changedFiles: 9, commits: 6, comments: 7,
        labels: [L.windows, L.bug], closingIssues: [82], mergeable: "conflicting", mergeState: "dirty", review: "changes_requested",
        checks: checks("test (windows):failure, test (ubuntu), test (macos), clippy, fmt"),
        reviewers: [{ login: "tjhorvat", state: "changes_requested" }],
        body: "Globs are matched on `/`-separated paths everywhere; drive letters are lowercased. UNC paths still fail one test.",
      }),
      pr({
        number: 86, title: "docs: migration guide for 1.0", headRef: "docs-migration", isDraft: true, review: null,
        createdAt: d(5), updatedAt: d(2), additions: 302, deletions: 4, changedFiles: 3, commits: 2,
        labels: [L.docs], mergeState: "draft", checks: checks("docs build"),
      }),
      pr({
        number: 85, title: "Bump notify from 6.1.1 to 7.0.0", headRef: "dependabot/cargo/notify-7.0.0", author: "dependabot[bot]",
        createdAt: d(6), updatedAt: d(6), additions: 18, deletions: 22, changedFiles: 2, labels: [L.deps, L.rust],
        mergeState: "behind", checks: checks("test (ubuntu), test (macos), test (windows):pending, clippy, fmt"),
        body: "Bumps notify from 6.1.1 to 7.0.0. Release notes: debouncer moved to notify-debouncer-full.",
      }),
    ];
    const recentPulls = [
      pr({
        number: 84, title: "Coalesce FSEvents bursts on macOS", headRef: "fsevents-coalesce", state: "merged",
        createdAt: d(4), updatedAt: d(1.5), mergedAt: d(1.5), closedAt: d(1.5), additions: 133, deletions: 41, changedFiles: 4,
        commits: 4, comments: 3, labels: [L.watch], review: "approved", reviewers: [{ login: "ana-sousa", state: "approved" }],
        checks: checks("test (ubuntu), test (macos), test (windows), clippy, fmt"),
      }),
      pr({
        number: 81, title: "Add a --dry-run flag", headRef: "dry-run", author: "tjhorvat", state: "merged",
        createdAt: d(14), updatedAt: d(10), mergedAt: d(10), closedAt: d(10), additions: 77, deletions: 9, changedFiles: 3,
        review: "approved", checks: checks("test (ubuntu), test (macos), test (windows), clippy, fmt"),
      }),
    ];
    const issues = [
      issue({
        number: 80, title: "One save in VS Code triggers 3–4 rebuilds", author: "pkerr", createdAt: d(11), updatedAt: m(40),
        labels: [L.bug, L.watch], assignees: [ME], comments: 6, milestone: "1.0", issueType: "Bug",
        body: "VS Code writes a temp file, renames it and chmods it; `knot watch build` reruns for each event.",
      }),
      issue({
        number: 79, title: "watch rebuilds when ignored files change", author: "ana-sousa", createdAt: d(12), updatedAt: h(6),
        labels: [L.watch], assignees: ["ana-sousa"], comments: 2, milestone: "1.0", issueType: "Bug", linkedPulls: [91],
      }),
      issue({
        number: 82, title: "Windows: backslashes in input globs never match", author: "tjhorvat", createdAt: d(10), updatedAt: d(1),
        labels: [L.bug, L.windows], assignees: [ME], comments: 5, milestone: "1.0", issueType: "Bug", linkedPulls: [88],
      }),
      issue({
        number: 75, title: "Release 1.0", createdAt: d(35), updatedAt: d(1.5), assignees: [ME], comments: 3, milestone: "1.0", issueType: "Epic",
        subIssues: { total: 9, completed: 5 },
        body: "Stable file format, watch mode, Windows support, a migration guide from 0.x.",
      }),
      issue({
        number: 70, title: "`knot graph` to print the target graph as DOT", author: "lgarnier", createdAt: d(28), updatedAt: d(9),
        labels: [L.feature, L.gfi, L.help], comments: 4, issueType: "Feature",
      }),
      issue({
        number: 67, title: "Panic on a target whose inputs include a broken symlink", author: "pkerr", createdAt: d(31), updatedAt: d(15),
        labels: [L.bug, L.repro], comments: 1,
      }),
    ];
    const worktrees: Worktree[] = [
      wt(
        {
          head: "4be1d09", subject: "Coalesce events in a 50 ms window", committedAt: m(14), ahead: 3, behind: 0, upstream: null, unpushed: null,
          changes: [" M src/watch/debounce.rs", " M benches/watch.rs", "?? benches/fixtures/two_k_files/"],
          commitsAhead: [
            { hash: "4be1d09", subject: "Coalesce events in a 50 ms window", at: m(14) },
            { hash: "aa31c7e", subject: "Track pending rebuilds per target", at: h(3) },
            { hash: "93f0b12", subject: "Benchmark: 2k-file fixture", at: h(20) },
          ],
          procs: [{ pid: 51302, name: "cargo", cmd: "cargo bench --bench watch -- two_k_files" }],
        },
        "watch-debounce",
      ),
      wt(
        {
          head: "e6c2a90", subject: "Lowercase drive letters before matching", committedAt: d(1), ahead: 6, behind: 3,
          commitsAhead: [
            { hash: "e6c2a90", subject: "Lowercase drive letters before matching", at: d(1) },
            { hash: "b1d4f3c", subject: "Match globs on /-separated paths", at: d(2) },
            { hash: "77a0e5d", subject: "Windows path fixtures", at: d(7) },
          ],
        },
        "windows-paths",
      ),
      wt({ head: "c9e14b8", subject: "Coalesce FSEvents bursts on macOS", committedAt: d(1.6), behind: 2, merged: true }, "fsevents-coalesce"),
    ];
    return {
      root, base: "main", branch: "main", worktrees, githubError: null,
      github: { repo: slug, url: gh, pulls, recentPulls, issues, fetchedAt: m(3) },
    };
  }

  if (name === "demo-app") {
    const pulls = [
      pr({
        number: 14, title: "Offline toggle that pauses the sync socket", headRef: "offline-toggle",
        createdAt: h(20), updatedAt: m(95), additions: 118, deletions: 22, changedFiles: 4, commits: 3, review: null,
        checks: checks("build, test"), body: "A switch in the corner so the audience sees edits pile up while offline.",
      }),
      pr({
        number: 12, title: "Show each peer's cursor in its own colour", headRef: "peer-cursors", author: "ana-sousa", isDraft: true,
        createdAt: d(4), updatedAt: d(1), additions: 64, deletions: 9, changedFiles: 2, commits: 1, review: null, mergeState: "draft",
        checks: checks("build, test:pending"),
      }),
    ];
    const recentPulls = [
      pr({
        number: 11, title: "Shared text demo on Automerge", headRef: "crdt-text", state: "merged",
        createdAt: d(5), updatedAt: d(2), mergedAt: d(2), closedAt: d(2), additions: 402, deletions: 31, changedFiles: 9, commits: 6,
        review: "approved", reviewers: [{ login: "ana-sousa", state: "approved" }], checks: checks("build, test"),
      }),
    ];
    const issues = [
      issue({ number: 13, title: "Conflicting edits flash on reconnect", createdAt: d(3), updatedAt: h(7), labels: [L.bug], comments: 2 }),
      issue({ number: 9, title: "QR code so the audience can join the demo", createdAt: d(12), updatedAt: d(5), labels: [L.feature] }),
    ];
    return {
      root, base: "main", branch: "main", githubError: null,
      worktrees: [
        wt(
          {
            head: "5be71d2", subject: "Pause the socket while offline", committedAt: h(1.6), ahead: 3,
            changes: [" M src/Toolbar.tsx"],
            commitsAhead: [
              { hash: "5be71d2", subject: "Pause the socket while offline", at: h(1.6) },
              { hash: "0c93e4a", subject: "Queue local ops while offline", at: h(5) },
              { hash: "f2a18b7", subject: "Offline switch in the toolbar", at: h(19) },
            ],
          },
          "offline-toggle",
        ),
      ],
      github: { repo: slug, url: gh, pulls, recentPulls, issues, fetchedAt: m(2) },
    };
  }

  if (name === "slides") {
    return {
      root, base: "main", branch: "main", githubError: null, worktrees: [],
      github: {
        repo: slug, url: gh, pulls: [], recentPulls: [], fetchedAt: m(4),
        issues: [issue({ number: 3, title: "Diagram for the three sync strategies", createdAt: d(6), updatedAt: d(1), labels: [L.docs] })],
      },
    };
  }

  if (name === "notes") {
    return { root, base: "main", branch: "main", github: null, githubError: "No GitHub remote", worktrees: [] };
  }

  // pixel-orchard: a local repo with no GitHub remote.
  return {
    root, base: "main", branch: "main", github: null, githubError: "No GitHub remote",
    worktrees: [
      wt(
        {
          head: "2f8a6c3", subject: "Tint the orchard per season", committedAt: d(2), ahead: 2, upstream: null, unpushed: null,
          changes: [" M src/seasons.ts", " M assets/palette.json"],
          commitsAhead: [
            { hash: "2f8a6c3", subject: "Tint the orchard per season", at: d(2) },
            { hash: "8e0b7d1", subject: "Season clock with a 4-minute day", at: d(2.2) },
          ],
          procs: [{ pid: 39877, name: "node", cmd: "node node_modules/.bin/vite --port 5180" }],
        },
        "seasons-cycle",
      ),
      wt({ head: "d41c0e9", subject: "Extrude atlas tiles by 1 px", committedAt: d(3.2), merged: true, upstream: null, unpushed: null }, "atlas-extrude"),
    ],
  };
}
