import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The status bar compares this with the backend's checkout to spot a UI served from another worktree.
  // This file sits in apps/desktop, so the checkout root is two folders up.
  define: { __UI_CHECKOUT__: JSON.stringify(decodeURIComponent(new URL("../..", import.meta.url).pathname).replace(/\/$/, "")) },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
