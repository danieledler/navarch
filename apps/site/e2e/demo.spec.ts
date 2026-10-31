import { expect, test } from "@playwright/test";
import { firstOpenTask, needsInput, projectOf, projectsOf, spaces, waitingIn } from "./demo-data";

test.beforeEach(async ({ page }) => {
  await page.goto("demo/");
});

test("opens a project, its task tree and a task's detail", async ({ page }) => {
  const [, project] = projectsOf(spaces[0].id);
  const task = firstOpenTask(project.id);
  await page.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true }).click();
  await page.getByRole("complementary").getByRole("button", { name: new RegExp(`^${project.name}\\b`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: project.name })).toBeVisible();

  const row = page.getByRole("treeitem", { name: new RegExp(task.title) }).first();
  await expect(row).toBeVisible();
  await row.getByText(task.title, { exact: true }).click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  const notes = page.getByRole("textbox", { name: /^Notes and context/ });
  await expect(notes).toBeVisible();
  await expect(notes).toHaveValue(task.notes);
});

test("shows a session that needs input, with its attention badges", async ({ page }) => {
  await expect(page.getByRole("heading", { name: /^Waiting for you/ })).toBeVisible();
  // Session rows have no role of their own.
  const row = page.locator(".session-row", { hasText: needsInput.title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Needs your input");

  const space = spaces.find((s) => s.id === projectOf(needsInput.cwd).spaceId)!;
  const n = waitingIn(space.id);
  await expect(page.getByRole("navigation").getByTitle(`${n} session${n === 1 ? "" : "s"} waiting for you`, { exact: true })).toBeVisible();

  await page.getByRole("navigation").getByRole("button", { name: space.name, exact: true }).click();
  const card = page.getByRole("complementary").getByRole("button", { name: new RegExp(`^${projectOf(needsInput.cwd).name}\\b`) });
  // The status dot carries its label as an accessible name, not text.
  await expect(card).toHaveAccessibleName(/Needs your input/);
});

test("says that Open hands off to Claude, which the demo can't launch", async ({ page }) => {
  const row = page.locator(".session-row", { hasText: needsInput.title });
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".toast.is-error")).toContainText("The demo can't launch Claude");
});
