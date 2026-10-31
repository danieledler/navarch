// Usage: node apps/desktop/scripts/ux-drive.mjs [step|all] [dark|light]  (needs `pnpm dev` running;
// NAVARCH_URL overrides the default http://localhost:1420)
// Drives the Navarch web UI (mock backend) through a test user's flows; saves screenshots, prints compact JSON.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = (process.env.NAVARCH_URL ?? "http://localhost:1420").replace(/\/$/, "");
const OUT = new URL("./shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const only = process.argv[2]; // optional: run steps whose name includes this
const scheme = process.argv[3] ?? "dark";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-first-run"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
page.on("dialog", (d) => d.accept());

const report = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  await sleep(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: `${OUT}${name}-${scheme}.png` });
  report.push({ name, overflow, errors: errors.splice(0) });
}
async function clickText(sel, text) {
  const ok = await page.evaluate(
    (sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text));
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    sel,
    text,
  );
  if (!ok) report.push({ missing: `${sel} "${text}"` });
  await sleep(150);
}
const type = async (s) => {
  await page.keyboard.type(s, { delay: 5 });
};
const key = async (k, mod) => {
  if (mod) await page.keyboard.down(mod);
  await page.keyboard.press(k);
  if (mod) await page.keyboard.up(mod);
  await sleep(150);
};

const steps = {
  async dashboard() {
    await page.goto(`${BASE}/?reset`, { waitUntil: "networkidle0" });
    await page.evaluate(() => localStorage.removeItem("navarch-ui"));
    await page.goto(`${BASE}/?reset`, { waitUntil: "networkidle0" });
    await shot("01-dashboard");
  },
  async space() {
    await page.click('button[aria-label="Work"]');
    await shot("02-space");
  },
  async detail() {
    await clickText(".task-title", "Launch team availability view");
    await shot("03-detail");
  },
  async outline() {
    await clickText(".add-task", "Add task");
    await type("Ship availability view to beta");
    await key("Enter");
    await type("Enable for three pilot teams");
    await key("Tab");
    await shot("04-outline-editing");
    await key("Escape");
    await shot("05-outline-done");
  },
  async done() {
    await clickText(".task-row", "Audit useMemo usage");
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".task-row")].find((r) => r.textContent.includes("Audit useMemo usage"));
      row.querySelector(".check").click();
    });
    await shot("06-done-toast");
  },
  async discover() {
    await page.click('button[aria-label="Overview of all spaces"]');
    await clickText(".group-head", "dotfiles");
    await clickText(".group-head .btn", "Import");
    await shot("07-discover-import");
    await clickText(".menu-item", "Import into Personal");
    await shot("08-imported");
  },
  async personal() {
    await page.click('button[aria-label="Personal"]');
    await shot("09-personal");
  },
  async usage() {
    for (const mode of ["normal", "hot", "zero", "error"]) {
      await page.goto(`${BASE}/?usage=${mode}`, { waitUntil: "networkidle0" });
      await page.click(".statusbar .usage");
      await shot(`11-usage-${mode}`);
      const box = await page.evaluate(() => {
        const r = document.querySelector(".usage-pop")?.getBoundingClientRect();
        const b = document.querySelector(".statusbar .usage").getBoundingClientRect();
        return r && { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), barTop: Math.round(b.top), vw: innerWidth };
      });
      report.push({ usage: mode, box });
      await page.click(".statusbar .usage"); // toggles closed
      report.push({ closedOnSecondClick: !(await page.$(".usage-pop")) });
    }
    // Error -> data while open: the popover must grow upward and stay above the status bar.
    await page.goto(`${BASE}/?usage=error`, { waitUntil: "networkidle0" });
    await page.click(".statusbar .usage");
    await page.evaluate(() => history.replaceState(null, "", "/?usage=normal"));
    await page.click(".usage-pop .icon-btn");
    await sleep(400);
    report.push({
      afterRefresh: await page.evaluate(() => {
        const r = document.querySelector(".usage-pop").getBoundingClientRect();
        const b = document.querySelector(".statusbar .usage").getBoundingClientRect();
        return { bottom: Math.round(r.bottom), barTop: Math.round(b.top), height: Math.round(r.height), hasRings: !!document.querySelector(".usage-pop .ring") };
      }),
    });
    await shot("11-usage-after-refresh");
  },
  async cpu() {
    // Opening the CPU popover closes the usage one; it sits above the bar with 10 min of history and every core.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.click(".statusbar .usage");
    await page.click(".statusbar .cpu");
    await sleep(300);
    report.push({
      cpu: await page.evaluate(() => {
        const r = document.querySelector(".cpu-pop")?.getBoundingClientRect();
        const b = document.querySelector(".statusbar .cpu").getBoundingClientRect();
        return r && {
          top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), barTop: Math.round(b.top), vw: innerWidth,
          cores: document.querySelectorAll(".cpu-pop .core").length,
          points: (document.querySelector(".cpu-pop .spark-line")?.getAttribute("d")?.match(/[ML]/g) ?? []).length,
          usageClosed: !document.querySelector(".usage-pop"),
        };
      }),
    });
    await shot("12-cpu");
    const bb = await (await page.$(".cpu-pop .spark svg")).boundingBox();
    await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height / 2);
    await sleep(150);
    report.push({ hoverReadout: await page.$eval(".cpu-pop .spark-val", (e) => e.textContent) });
    await shot("12-cpu-hover");
    await page.click(".statusbar .cpu");
    report.push({ cpuClosedOnSecondClick: !(await page.$(".cpu-pop")) });
  },
  async period() {
    // The period editor is anchored to the whole section header: clicking that header must close it.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.click('.focus button[aria-label="Period actions"]');
    await clickText(".menu-item", "Edit period");
    const opened = !!(await page.$(".period-editor"));
    await page.mouse.click(...(await page.evaluate(() => {
      const r = document.querySelector(".focus .sec-label").getBoundingClientRect();
      return [r.left + 30, r.top + r.height / 2];
    })));
    await sleep(150);
    report.push({ periodEditorOpened: opened, closedByHeaderClick: !(await page.$(".period-editor")) });
  },
  async narrow() {
    await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
    await page.click('button[aria-label="Work"]');
    await shot("10-narrow");
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  },
};

for (const [name, fn] of Object.entries(steps)) {
  if (only && only !== "all" && !name.includes(only) && name !== "dashboard") continue;
  try {
    await fn();
  } catch (e) {
    report.push({ step: name, fail: String(e).slice(0, 200) });
  }
}
console.log(JSON.stringify(report));
await browser.close();
