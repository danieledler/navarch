# Navarch

macOS desktop planner (Tauri 2 + React) that keeps work across many folders pointed at 3–6 month OKR goals. Execution happens in the Claude desktop app's Code tab; Navarch reads its local session files and deep-links into it.

## Concepts

- **Space** (left rail, like Slack workspaces) → **Project** (= a folder, belongs to one space) → **Task tree** (any depth).
- **OKR period**: tasks at any level can be starred as goals for the current period (`period_tasks`).
- **Week**: tasks pinned to an ISO week (`week_tasks`) plus automatic ones (due that week, worked on, finished) — see `weekItems` in `apps/desktop/src/lib/model.ts`.
- **Session**: a Claude Code-tab session. It belongs to a project by folder (longest path prefix) and to a task by `session_links`. Time and tokens roll up session → task → parent tasks → project → space.
- Badges count sessions with status `needs_input` or `unread` in imported projects.

## Layout

- The repo is a pnpm workspace: `apps/desktop` (this app), `apps/site` (landing page with a live demo, for GitHub Pages), `apps/mobile` (phone web app, served by the desktop app). Root `pnpm dev` / `pnpm tauri` run in `apps/desktop`, `pnpm site` in `apps/site`, `pnpm mobile` in `apps/mobile`; `pnpm typecheck` / `pnpm build` run in every app.
- `apps/site/` — static Vite multi-page build for GitHub Pages (https://danieledler.github.io/navarch/): `index.html` + `src/landing.ts`/`landing.css` is the landing page; `demo/index.html` + `src/demo.tsx` renders the desktop `App` from `apps/desktop/src` (alias `@desktop`) on the in-memory mock and demo dataset (`apps/desktop/src/api/demo.ts`), shown on the landing page in a scaled iframe. Keep URLs relative (Vite `base: "./"`): it is served under `/navarch/`.
- `apps/desktop/src/api/types.ts` — the JSON contract with the backend. Change it together with `apps/desktop/src-tauri/src/db.rs`/`commands.rs`.
- `apps/desktop/src/api/index.ts` — `Api` interface; Tauri `invoke` in the app, `apps/desktop/src/api/mock.ts` (in-memory, localStorage) in a plain browser.
- `apps/desktop/src/store.ts` — zustand store, polling, toasts; `useModel()` returns the shared derived model.
- `apps/desktop/src/lib/model.ts` — trees, rollups, attention counts, week items, the session prompt with the `Navarch task #<id>` marker.
- `apps/desktop/src/components/` — `SpaceRail`, `ProjectList`, `ProjectView` + `TaskTree` (outliner keys) + `TaskDetail`, `FocusPanel`, `Dashboard` (waiting, week log, discover), `StatusBar`.
- `apps/desktop/src-tauri/src/` — `db.rs` (SQLite, migrations via `user_version`), `scanner.rs` (session files, incremental transcript parsing), `procs.rs` (process tree + CPU via sysinfo), `usage.rs` (plan limits), `limits.rs` (usage-limit alerts for running sessions), `commands.rs`, `lib.rs` (setup, 3 s scan loop emitting `sessions-updated`, 2 s CPU sampler feeding the CPU popover's 10-min history, 1-min limit watch emitting `limit-alert`).
- `apps/desktop/src-tauri/src/mobile.rs` + `http.rs` — phone API: an axum server on 127.0.0.1:47820 (installed app) / 47821 (any other build; `NAVARCH_PHONE_PORT` overrides), `POST /api/<cmd>` with bearer token, every other GET serves `apps/mobile/dist` (embedded with rust-embed in release builds, read from disk in debug builds). Settings keys `mobile` (`{enabled, publicUrl}`), `mobile_token`, `mobile_paired_at`; a dev DB copy drops them (`mobile::forget`). Emits `snapshot-changed` (a phone edited data) and `mobile-changed` (pairing/server state) to the desktop UI.
- `apps/mobile/` — the phone web app (Home Screen, no service worker), its own workspace package. Imports shared code from `apps/desktop/src` through the `@desktop` alias (Vite alias + tsconfig paths, like the site). Served by the Mac app; the phone reaches it via `tailscale serve --bg <port>`, so page and `/api` share one origin.

## Data sources (read-only — never write to them)

- Session metadata: `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` (`cwd`, `title`, `lastTurnEdgeAt`, `lastFocusedAt`, `isArchived`, …). Internal format; may change with app updates.
- Transcripts: `~/.claude/projects/*/<cliSessionId>.jsonl` (+ `<id>/subagents/*.jsonl`). Tokens = input + cache writes + output, counted once per `message.id`. Active time = gaps ≤ 5 min.
- Live process: the `claude` binary with `--resume=<cliSessionId>`, or, for a session started fresh and never resumed (no such flag), `CLAUDE_CODE_HOST_SESSION_ID=<local id>` in its environment (undocumented); its process tree gives procs/CPU. A `claude` nested under another one belongs to that one's tree.
- Plan limits: Keychain item `Claude Code-credentials` → `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`). Never log or return the token; never refresh it. Every Navarch process (installed app, dev windows) shares `usage-cache.json` beside the DB under a file lock, so they make one request per interval between them; after a 429 none asks again until the longer of Retry-After (up to 1 h) and a 5–30 min backoff is over.
- Usage-limit alerts: when a window passes its threshold (usage popover; default 5h 95%, weekly 99%), Navarch writes `limit-alert` beside its DB, and `limit-hook.sh`, which it rewrites at launch, hands it to each session and subagent once as hook context (save work, `CronCreate` a resume after the reset). The hook only runs if `~/.claude/settings.json` has it as a `PostToolUse` + `UserPromptSubmit` hook, and sessions act on it because Daniel's `~/.claude/CLAUDE.md` makes it a standing instruction. Dev builds write `limit-hook-dev-<checkout>.sh` / `limit-alert-dev-<checkout>`, which no hook reads: point a `claude -p --settings` hook at the dev script to test.
- Deep links: `claude://code/new?q=` (documented; the docs list only `ssh_host`/`ssh_port`/`ssh_folder` besides `q`), `claude://code/continue?session=<local_id>` (undocumented).
  We don't pass `folder=`: the app routes it through its external-link flow (`src=external`, trust dialog even for trusted folders), then starts the session in its own scratch folder anyway (`…/Claude/scratch-workspaces/…`, log line `source=presettle_failsafe`). So you pick the folder in Claude's composer. Every spawn is still recorded in `pending_spawns`: a session in that folder links to the task, and one left in a scratch folder is adopted for it (`session_folders`) and flagged "Temp folder".
- Navarch's own DB: `~/Library/Application Support/se.icelab.navarch/navarch.db`, opened only by the app installed in /Applications. Every other build (dev windows, `cargo build`, `--dump-sessions`, bundles left in `target/`) uses `navarch-dev-<checkout>.db` beside it, a copy made on first launch; delete it to copy afresh.

## Run & check

- UI against the mock: `pnpm dev`, open http://localhost:1420 (`?reset` reseeds mock data).
- Site: `pnpm site` (Vite dev server; landing at `/`, the demo alone at `/demo/`). `pnpm --filter site build` writes `apps/site/dist`; check it with `pnpm --filter site preview`. The demo compiles `apps/desktop/src` against the mock, so desktop UI changes show up there too; in a production build its status bar reads `demo` instead of the red dev label.
- Site e2e: `pnpm test:e2e` (Playwright, `apps/site/e2e/`) builds the site, previews it on port 4318 and smoke-tests the landing page and the demo, taking expected names from the demo dataset. First run `pnpm --filter site exec playwright install chromium`. CI (`.github/workflows/pages.yml`) runs typecheck and these tests on every push and PR to `main`, and deploys that build to GitHub Pages only when they pass (pushes to `main`, not PRs).
- Dev window: `pnpm tauri dev`, on this checkout's DB copy, with the UI hot-reloading from Vite. Its Dock icon (`apps/desktop/src-tauri/icons/icon-dev.png`, rendered from `icon-dev.svg` with `rsvg-convert -w 512 -h 512`) and its status-bar build label are dark red, so it can't pass for the installed app.
- Installed app: `scripts/install-app.sh` builds committed `main` and installs /Applications/Navarch.app. That is Daniel's everyday Navarch and the only build that opens the real DB.
- Types: `pnpm typecheck`. Backend: `cargo test` and `target/debug/navarch --dump-sessions` (one scan of this checkout's DB copy, JSON summary, no window) in `apps/desktop/src-tauri/`.
- Phone UI: `pnpm --filter mobile dev` (or `pnpm mobile`) on http://localhost:1430 (`?mock` for the desktop mock and demo data, dev only; otherwise `/api` proxies to a dev build's 47821). `pnpm --filter mobile build` writes `apps/mobile/dist`, which the app serves; `tauri build` runs it first (`beforeBuildCommand`), so release builds embed it.
- UX walkthrough: with `pnpm dev` running, `node apps/desktop/scripts/ux-drive.mjs all dark` drives the main flows in headless Chrome and saves screenshots to `apps/desktop/scripts/shots/` (`NAVARCH_URL` points it at another port).
- The status bar's left end shows which build is running: commit, `+N` uncommitted files, branch when not `main`, and `dev` when the UI is live from Vite (an amber tag if that Vite runs in another checkout). Hover for the checkout, build time and which DB it uses.
- A running app window keeps the backend it was started with, while its UI hot-reloads from Vite. After Rust changes, restart it (`pnpm tauri dev` does this for you), or the new UI talks to the old backend.

## Parallel sessions

Several Claude sessions often work on this repo at once. Daniel's everyday Navarch is the installed app, built from `main`, so work reaches him only through `main`:

- Do each task in its own worktree under `.claude/worktrees/<task>`, on its own branch. Never edit or build in the main checkout: it stays clean on `main` and only fast-forwards.
- To land a branch: rebase it onto `main` in its worktree and run `pnpm typecheck` and `cargo test` (in `apps/desktop/src-tauri`). Then open a dev window from the worktree (`pnpm tauri dev` in the background, or the port-1421 variant below if 1420 is taken) so Daniel can try the change before deciding, tell him what to look at, and ask him. Once he says OK, run `git -C <main checkout> merge --ff-only <branch>`, then `scripts/install-app.sh` to ship it.
- Clean up after yourself once the branch is on `main`: stop the dev servers, dev windows and background jobs you started, run `git worktree remove .claude/worktrees/<task>` and `git branch -d <branch>` (both refuse if anything is uncommitted or unmerged), and delete the worktree's DB copy `navarch-dev-<task>.db*`. Remove other sessions' worktrees only when asked, and only those that are clean, fully merged into `main`, and not in use by a running process.
- A new worktree needs `pnpm install`, and its first Rust build starts from scratch (a few minutes). `.claude/worktrees/release` belongs to the install script; leave it alone.
- Only one checkout can serve port 1420, and dev windows load their UI from it (the build label warns when it is another checkout). For a second dev window, run `pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:1421","beforeDevCommand":"pnpm dev --port 1421"}}'`.
- A branch's migrations run only on its checkout's DB copy until it is merged and installed. Cover schema changes with `cargo test`, and never edit a migration that has shipped; add the next version.

## Conventions

- Rust toolchain is Homebrew rustc. MSRV is `rust-version = "1.95"` in `apps/desktop/src-tauri/Cargo.toml` (set by `sysinfo` 0.40); resolver 3 only locks dependency versions compatible with it, so raise it before upgrading a crate that needs newer Rust.
- Patch conventions in `update_task`: `deadline: ""` clears, `parentId: 0` moves to top level. Deletes are soft (`deleted_at` stamp) so the UI can offer Undo.
- Every destructive or state-changing action gets a toast; done/delete/link toasts carry Undo (`{ label, run }`), which also puts them on the ⌘Z / Edit › Undo history, and the menu names the newest one (`undo` in `apps/desktop/src/store.ts`; the menu item is built in `apps/desktop/src-tauri/src/lib.rs`).
- Keep CPU overhead low: no per-frame work, cheap sysinfo refreshes, incremental transcript reads.
