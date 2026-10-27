import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { isOptionalModuleFailure } from "./optional-module";
import "./theme.css";
import "./sizing.css";
import "./canvas.css";

const App = lazy(() => import('./App').then(module => ({ default: module.App })));

// Assets are content-hashed, so a rebuild renames every lazy chunk and a tab
// opened before the deploy 404s on its next dynamic import (the server file
// explorer, and any other lazy view). Reload once to pick up the fresh index;
// the timestamp guard stops a reload loop when the failure is not deploy-related.
// Optional features handle their own import rejection and keep the current page.
window.addEventListener("vite:preloadError", (event) => {
  const error = (event as Event & { readonly payload?: unknown }).payload;
  // Allow Vite to reject the original import. Its local catch runs before the
  // next task, letting optional loaders claim only their own error object.
  window.setTimeout(() => {
    if (isOptionalModuleFailure(error)) return;
    const marker = "brain-chunk-reload";
    const now = Date.now();
    try {
      const last = Number(sessionStorage.getItem(marker) ?? 0);
      if (now - last < 30_000) return;
      sessionStorage.setItem(marker, String(now));
    } catch {
      // Without a durable guard, automatic reload could loop across page loads.
      // The view's error boundary still offers an explicit reload action.
      return;
    }
    window.location.reload();
  }, 0);
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<main role="status">Opening workspace…</main>}>
      <App />
    </Suspense>
  </StrictMode>,
);
