# Navarch

A desktop planner for steering many projects toward 3–6 month goals, with Claude Code (desktop app, Code tab) doing the work.

Website and live demo: https://danieledler.github.io/navarch/

- **Spaces → projects (folders) → task trees.** Star tasks as OKR goals; pin them to the week; Navarch adds what you worked on, finished or have due.
- **Sessions.** Every Claude Code session shows up under its project with status, your last message, processes/CPU, time and tokens. Start a session from a task and it links automatically; time and tokens roll up to parent tasks, projects and spaces.
- **Badges** show sessions that need your input or have a reply you haven't read.
- **Status bar.** CPU load and your Claude plan limits: `2% 4h10 · 41% 1d21h` = 5-hour window used / resets in, weekly used / resets in.

```bash
pnpm install
pnpm tauri dev
```

See `CLAUDE.md` for architecture and data sources.
