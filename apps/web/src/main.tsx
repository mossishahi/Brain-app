import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// Assets are content-hashed, so a rebuild renames every lazy chunk and a tab
// opened before the deploy 404s on its next dynamic import (lazy views, the
// Vanta backdrop, …). Reload once to pick up the fresh index; the timestamp
// guard stops a reload loop when the failure is not deploy-related.
window.addEventListener("vite:preloadError", (event) => {
  const marker = "brain-chunk-reload";
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(marker) ?? 0);
    sessionStorage.setItem(marker, String(Date.now()));
  } catch {
    // storage unavailable; reload once per page lifetime is still fine
  }
  if (Date.now() - last < 30_000) return;
  event.preventDefault();
  window.location.reload();
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
