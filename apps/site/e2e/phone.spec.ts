import { expect, test, type Page } from "@playwright/test";
import { needsInput, projectsOf, spaces } from "./demo-data";

// The landing scrolls smoothly, which can move a frame under a click mid-scroll.
test.use({ reducedMotion: "reduce" });

// Both frames load lazily; bring each into view first.
const frame = async (page: Page, sel: string) => {
  await page.locator(sel).scrollIntoViewIfNeeded();
  return page.frameLocator(sel);
};

test("the landing runs the phone app on the demo data", async ({ page }) => {
  await page.goto("./");
  const phone = await frame(page, "[data-phone-frame]");
  await expect(phone.getByRole("heading", { name: "Waiting" })).toBeVisible();
  await expect(phone.getByText(needsInput.title, { exact: true }).first()).toBeVisible();
});

test("a task added on the phone lands in the desktop demo", async ({ page }) => {
  const probe = "E2E phone probe";
  const project = projectsOf(spaces[0].id)[0];
  await page.goto("./");
  const desk = await frame(page, "[data-frame]");
  await desk.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true }).click();
  await expect(desk.getByRole("heading", { level: 1, name: project.name })).toBeVisible();

  const phone = await frame(page, "[data-phone-frame]");
  await phone.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "New task" }).click();
  const sheet = phone.getByRole("dialog", { name: "New task" });
  await sheet.getByRole("textbox", { name: "Title" }).fill(probe);
  await sheet.getByRole("combobox").selectOption({ label: project.name });
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet).toHaveCount(0);

  await expect(desk.getByRole("treeitem", { name: new RegExp(probe) })).toBeVisible();
});

test("the phone picks up the shared data's changes at once", async ({ page }) => {
  const probe = "E2E phone sync probe";
  await page.goto("./");
  const phone = await frame(page, "[data-phone-frame]");
  await phone.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "New task" }).click();
  await phone.getByRole("textbox", { name: "Title" }).fill(probe);
  await phone.getByRole("button", { name: "Add", exact: true }).click();
  await phone.getByRole("button", { name: "Week" }).click();
  await expect(phone.getByText(probe, { exact: true })).toBeVisible();

  // Another page (here the landing itself) saves the shared demo data, as the desktop demo does on an edit.
  await page.evaluate((title) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("navarch-mock"))!;
    const db = JSON.parse(localStorage.getItem(key)!);
    for (const t of db.tasks) if (t.title === title) t.title = `${title} renamed`;
    localStorage.setItem(key, JSON.stringify(db));
  }, probe);
  // Well before the phone's 15 s poll.
  await expect(phone.getByText(`${probe} renamed`, { exact: true })).toBeVisible({ timeout: 4000 });
});

test("Reset demo restores the phone's data too", async ({ page }) => {
  const probe = "E2E phone reset probe";
  await page.goto("./");
  const phone = await frame(page, "[data-phone-frame]");
  await phone.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "New task" }).click();
  await phone.getByRole("textbox", { name: "Title" }).fill(probe);
  await phone.getByRole("button", { name: "Add", exact: true }).click();
  await phone.getByRole("button", { name: "Week" }).click();
  await expect(phone.getByText(probe, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.locator("[data-phone-frame]")).toHaveAttribute("src", /reset=/);
  // Wait for the reloaded page itself, so the checks below can't pass on the old one or a blank one.
  await expect.poll(() => page.frame({ url: /\/phone\/\?reset=/ })?.url() ?? null).not.toBeNull();
  // The Reset button scrolled the page up; the phone's tab bar has to be on screen to tap.
  await page.locator("[data-phone-frame]").scrollIntoViewIfNeeded();
  await phone.getByRole("button", { name: "Week" }).click();
  await expect(phone.getByRole("heading", { name: "This week" })).toBeVisible();
  await expect(phone.locator(".task-title").first()).toBeVisible();
  await expect(phone.getByText(probe, { exact: true })).toHaveCount(0);
});

test.describe("the phone page on its own", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("runs the phone app full screen", async ({ page }) => {
    await page.goto("phone/");
    await expect(page.getByRole("heading", { name: "Waiting" })).toBeVisible();
    await expect(page.getByText(needsInput.title, { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Goals" }).click();
    await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toContainText("Demo data: no Mac involved.");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("the phone section fits the screen", async ({ page }) => {
    await page.goto("./");
    const phone = await frame(page, "[data-phone-frame]");
    await expect(phone.getByRole("heading", { name: "Waiting" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = (await page.locator("[data-phone]").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
});
