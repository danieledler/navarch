// The live demo: the desktop app's own UI, rendered as apps/desktop/src/main.tsx does.
// Outside Tauri its api falls back to the in-memory mock with the fictional demo dataset.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@desktop/App";
import "@desktop/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
