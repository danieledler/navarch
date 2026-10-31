// Expected values come from the demo dataset itself, so the tests follow it when it changes.
import { demoSessions, demoSnapshot } from "../../desktop/src/api/demo";

export const snap = demoSnapshot();
export const sessions = demoSessions(snap, {});

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

export const spaces = [...snap.spaces].sort((a, b) => a.sort - b.sort);
export const projectsOf = (spaceId: number) => snap.projects.filter((p) => p.spaceId === spaceId).sort((a, b) => a.sort - b.sort);

export const projectOf = (path: string) => snap.projects.find((p) => inside(path, p.path))!;
export const firstOpenTask = (projectId: number) =>
  snap.tasks.filter((t) => t.projectId === projectId && t.parentId === null && t.status === "open").sort((a, b) => a.sort - b.sort)[0];

export const needsInput = sessions.find((s) => s.status === "needs_input" && !s.archived)!;

/** Sessions waiting for you in a space: needs input or unread, in one of its project folders (temp-folder ones by launch path). */
export function waitingIn(spaceId: number) {
  const dirs = projectsOf(spaceId).map((p) => p.path);
  return sessions.filter(
    (s) => !s.archived && (s.status === "needs_input" || s.status === "unread") &&
      dirs.some((d) => inside(s.launchPath ?? s.cwd, d)),
  ).length;
}
