#!/usr/bin/env bash
# Usage: scripts/install-app.sh   (from any checkout of this repo)
# Builds committed `main` in its own clean worktree (.claude/worktrees/release) and installs it as
# /Applications/Navarch.app, the only build that opens the real database. Uncommitted work in other
# checkouts is never built. A running installed Navarch is restarted on the new build.
set -euo pipefail

repo=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")
wt="$repo/.claude/worktrees/release"
dest=/Applications/Navarch.app

if [ -d "$wt" ]; then
  git -C "$wt" checkout -q --detach main
else
  git -C "$repo" worktree add -q --detach "$wt" main
fi
git -C "$wt" reset -q --hard main
git -C "$wt" clean -qfd # untracked leftovers only; node_modules and target/ stay for fast rebuilds
commit=$(git -C "$wt" rev-parse --short HEAD)
echo "Building Navarch from main at $commit …"

cd "$wt"
pnpm install --frozen-lockfile --silent
pnpm tauri build --bundles app
built="$wt/apps/desktop/src-tauri/target/release/bundle/macos/Navarch.app"

running=$(pgrep -f "^$dest/Contents/MacOS/" || true)
if [ -n "$running" ]; then
  kill $running
  for _ in $(seq 50); do pgrep -f "^$dest/Contents/MacOS/" >/dev/null || break; sleep 0.1; done
fi
rm -rf "$dest"
ditto "$built" "$dest"
[ -n "$running" ] && open "$dest"
echo "Installed Navarch $commit at $dest${running:+ (restarted)}"
