import { expect, test, type Page } from "@playwright/test";
import { spaces } from "./demo-data";

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()}: ${r.url()}`));
  return errors;
}

test("the landing page and its demo frame load without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("./");
  await page.locator("[data-frame]").scrollIntoViewIfNeeded();
  await expect(page.frameLocator("[data-frame]").getByRole("button", { name: spaces[0].name, exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});

test("the full-page demo loads without errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("demo/");
  await expect(page.getByRole("navigation").getByRole("button", { name: spaces[0].name, exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});
