/** App shell: hand-rolled hash router, theme toggle, and the settings drawer. */
import { useCallback, useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { AmbientBackdrop } from "./components/AmbientBackdrop";
import { Dashboard } from "./components/Dashboard";
import { Landing } from "./components/Landing";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { TrashView } from "./components/TrashView";
import { GearIcon, MoonIcon, SunIcon } from "./components/Icons";

type Route =
  | { view: "landing" }
  | { view: "job"; jobId: string }
  | { view: "trash" };

function parseRoute(): Route {
  const hash = window.location.hash;
  if (/^#\/trash(?:[/?#]|$)/.test(hash)) return { view: "trash" };
  const match = /^#\/jobs\/([^/?#]+)/.exec(hash);
  if (match) return { view: "job", jobId: decodeURIComponent(match[1]) };
  return { view: "landing" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => {
    const onChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

type Theme = "light" | "dark";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("brain-theme", next);
      } catch {
        // storage unavailable; theme still applies for this session
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}

export function App() {
  const route = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <ConfigProvider
      theme={{
        algorithm:
          theme === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
      }}
    >
      <AmbientBackdrop theme={theme} />
      <div className="app-foreground">
        <div className="top-controls">
          <button
            type="button"
            className="ghost-btn"
            aria-label={theme === "dark" ? "switch to light theme" : "switch to dark theme"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="ghost-btn"
            aria-label="open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
          </button>
        </div>
        <div
          className="route-view"
          key={route.view === "job" ? `job:${route.jobId}` : route.view}
        >
          {route.view === "job" ? (
            <Dashboard jobId={route.jobId} />
          ) : route.view === "trash" ? (
            <TrashView />
          ) : (
            <Landing onOpenSettings={() => setSettingsOpen(true)} />
          )}
        </div>
        {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      </div>
    </ConfigProvider>
  );
}
