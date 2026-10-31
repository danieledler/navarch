import { expect, test, type Page } from "@playwright/test";
import { projectsOf, spaces } from "./demo-data";

const demoFrame = async (page: Page) => {
  // The iframe loads lazily; bring it into view first.
  await page.locator("[data-frame]").scrollIntoViewIfNeeded();
  return page.frameLocator("[data-frame]");
};

test("landing shows the hero and runs the demo in its frame", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try the live demo" })).toHaveAttribute("href", "#demo");
  await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", /^https:\/\/github\.com\//);

  const app = await demoFrame(page);
  const rail = app.getByRole("navigation");
  for (const s of spaces) await expect(rail.getByRole("button", { name: s.name, exact: true })).toBeVisible();
  await rail.getByRole("button", { name: spaces[0].name, exact: true }).click();
  for (const p of projectsOf(spaces[0].id)) {
    await expect(app.getByRole("complementary").getByRole("button", { name: new RegExp(`^${p.name}\\b`) })).toBeVisible();
  }
});

test("Reset demo restores the demo data", async ({ page }) => {
  const probe = "E2E reset probe";
  await page.goto("./");
  const app = await demoFrame(page);
  await app.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true }).click();
  await app.getByRole("button", { name: "Add task" }).click();
  await page.keyboard.type(probe);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(app.getByRole("treeitem", { name: new RegExp(probe) })).toBeVisible();

  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.locator("[data-frame]")).toHaveAttribute("src", /reset=/);
  await app.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true }).click();
  await expect(app.getByRole("heading", { level: 1, name: projectsOf(spaces[0].id)[0].name })).toBeVisible();
  await expect(app.getByRole("treeitem", { name: new RegExp(probe) })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("fits the screen and links to the full-page demo", async ({ page }) => {
    await page.goto("./");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const open = page.getByRole("link", { name: "Open the live demo" });
    await open.scrollIntoViewIfNeeded();
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute("href", "./demo/");
    await open.click();
    await expect(page).toHaveURL(/\/demo\/$/);
    await expect(page.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true })).toBeVisible();
  });
});
