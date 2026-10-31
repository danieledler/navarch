import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The phone web app. Built into apps/mobile/dist, which the desktop app serves beside /api.
// In dev, /api goes to a running dev build's phone server (47821; NAVARCH_PHONE_PORT=47820 for the installed app).
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const repo = here("../..").replace(/\/$/, "");
const phonePort = process.env.NAVARCH_PHONE_PORT || "47821";

export default defineConfig(({ command }) => ({
  base: "/",
  plugins: [react()],
  clearScreen: false,
  // The desktop mock (?mock, dev only) reads this; a build carries no checkout path.
  define: { __UI_CHECKOUT__: JSON.stringify(command === "serve" ? repo : "") },
  resolve: {
    // Shared code comes from the desktop app, as in apps/site.
    alias: { "@desktop": here("../desktop/src") },
    // Desktop files resolve react from apps/desktop/node_modules; keep one copy.
    dedupe: ["react", "react-dom", "zustand"],
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 1430,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: { "/api": { target: `http://127.0.0.1:${phonePort}`, changeOrigin: true } },
  },
}));
