// The phone demo: the phone web app, rendered as apps/mobile/src/main.tsx does.
// __PHONE_DEMO__ (vite.config.ts) puts it on the desktop's in-memory mock, which it shares with the desktop demo.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@mobile/App";
import "@mobile/mobile.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
