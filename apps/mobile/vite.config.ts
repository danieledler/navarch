import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The phone web app. Built into apps/mobile/dist, which the desktop app serves beside /api.
// In dev, /api goes to a running dev build's phone server (47821; NAVARCH_PHONE_PORT=47820 for the installed app).
const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const phonePort = process.env.NAVARCH_PHONE_PORT || "47821";

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  clearScreen: false,
  // The mock backend (?mock) reads this; the phone never shows it.
  define: { __UI_CHECKOUT__: JSON.stringify(repo) },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 1430,
    strictPort: true,
    // Shared code lives in the repo's src/ for now.
    fs: { allow: [repo] },
    proxy: { "/api": { target: `http://127.0.0.1:${phonePort}`, changeOrigin: true } },
  },
});
