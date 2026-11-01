import { defineConfig, devices } from "@playwright/test";

// E2E_PORT moves it when another checkout's tests hold the default.
const PORT = Number(process.env.E2E_PORT) || 4318;

// Smoke tests of the built site: the landing page and the real UI on the demo data.
// CI runs them before every GitHub Pages deploy and uploads the dist/ this server built.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Always builds first, so on CI (no server reuse) the tests run against the dist/ that gets deployed.
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
