export type LibrarySection = "history" | "trash";

/** The central workspace is independent of the library panel beside it. */
export type MainRoute =
  | { readonly view: "home" }
  | { readonly view: "job"; readonly jobId: string; readonly stage?: string };

export type Route = MainRoute & { readonly panel?: LibrarySection };

function panelValue(value: string | null): LibrarySection | undefined {
  return value === "history" || value === "trash" ? value : undefined;
}

function pathAndPanel(hash: string): { path: string; panel?: LibrarySection } {
  const query = hash.indexOf("?");
  if (query === -1) return { path: hash };
  const panel = panelValue(new URLSearchParams(hash.slice(query + 1)).get("panel"));
  return { path: hash.slice(0, query), ...(panel ? { panel } : {}) };
}

function legacyPanel(path: string): LibrarySection | undefined {
  if (/^#\/history\/?$/.test(path)) return "history";
  if (/^#\/trash\/?$/.test(path)) return "trash";
  return undefined;
}

function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 && !/[\u0000-\u001f\u007f]/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function encodeSegment(segment: string): string | undefined {
  try {
    const encoded = encodeURIComponent(segment);
    return decodeSegment(encoded) !== undefined ? encoded : undefined;
  } catch {
    // Corrupt UTF-16 must not throw through the shell while it renders a link.
    return undefined;
  }
}

/** Direct-load parser. Old library URLs open that panel beside the home view. */
export function parseRoute(hash: string): Route {
  const { path, panel } = pathAndPanel(hash);
  const legacy = legacyPanel(path);
  if (legacy) return { view: "home", panel: legacy };
  const match = /^#\/jobs\/([^/?#]+)(?:\/stage\/([^/?#]+))?\/?$/.exec(path);
  if (match) {
    const jobId = decodeSegment(match[1]!);
    const stage = match[2] === undefined ? undefined : decodeSegment(match[2]);
    if (jobId !== undefined && (match[2] === undefined || stage !== undefined)) {
      return {
        view: "job", jobId,
        ...(stage !== undefined ? { stage } : {}),
        ...(panel ? { panel } : {}),
      };
    }
  }
  return { view: "home", ...(panel ? { panel } : {}) };
}

/** Opening, replacing, or closing a panel never changes the central workspace. */
export function withPanel(route: Route, panel?: LibrarySection): Route {
  const { panel: _previousPanel, ...main } = route;
  return panel ? { ...main, panel } : main;
}

/** Legacy in-app links open a panel; canonical URLs remain complete snapshots. */
export function resolveRoute(hash: string, current?: Route): Route {
  const legacy = legacyPanel(pathAndPanel(hash).path);
  return legacy && current ? withPanel(current, legacy) : parseRoute(hash);
}

/** Stable canonical hash. Unrepresentable identifiers degrade to a safe home URL. */
export function routeHash(route: Route): string {
  let path = "#/";
  if (route.view === "job") {
    const jobId = encodeSegment(route.jobId);
    if (jobId !== undefined) {
      path = `#/jobs/${jobId}`;
      if (route.stage) {
        const stage = encodeSegment(route.stage);
        if (stage !== undefined) path += `/stage/${stage}`;
      }
    }
  }
  return route.panel ? `${path}?panel=${route.panel}` : path;
}

/** Selecting a run dismisses the floating library without carrying another run's stage. */
export function selectJob(route: Route, jobId: string): Route {
  if (route.view === "job" && route.jobId === jobId) return withPanel(route, undefined);
  return { view: "job", jobId };
}
