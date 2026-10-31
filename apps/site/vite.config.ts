import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Landing page (index.html) plus the real desktop UI on its in-memory mock (demo/index.html).
// base "./" keeps every URL relative, so the build works at / and under GitHub Pages' /navarch/.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // StatusBar compares this with the backend's checkout; the demo has neither.
  define: { __UI_CHECKOUT__: JSON.stringify("") },
  resolve: {
    alias: { "@desktop": here("../desktop/src") },
    // Desktop files resolve react from apps/desktop/node_modules; keep one copy.
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [here("../..")] } },
  build: {
    rolldownOptions: { input: { main: here("index.html"), demo: here("demo/index.html") } },
  },
});
