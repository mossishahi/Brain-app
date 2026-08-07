/**
 * The app's one update surface, mounted once in the shell so it is visible on
 * every view (landing, dashboard, trash) — a stack of cards in the lower-left
 * corner:
 *
 * - a newer APP release: actionable. "Update now" hands the server to its
 *   detached updater (POST /api/update); this component then covers the page,
 *   polls /api/health through the restart, and reloads the SAME tab the
 *   moment a server with the new version answers. No git, no npm, no manual
 *   restart. "Later" snoozes for this page load only, so the prompt greets
 *   the next launch again.
 * - a newer SKILLS bundle: informational. New runs pick it up automatically;
 *   "Got it" acknowledges the version so the card stays quiet until the next
 *   release.
 * - a newer bundle behind a deployment pin: informational (developers pin).
 *
 * Update checks are pull-based on the server (git release tags, half-hourly;
 * registry index, per health request); this component only polls /api/health.
 */
import { useEffect, useRef, useState } from "react";
import type { HealthResponse } from "@brainstorm-agentic/protocol";
import { errorMessage, getHealth, postUpdateApp, postUpdateCheck } from "../api";

/** Last bundle version this browser has acknowledged as "seen". */
const BUNDLE_ACK_KEY = "brain-acked-bundle-version";

function ackedBundleVersion(): string | null {
  try {
    return localStorage.getItem(BUNDLE_ACK_KEY);
  } catch {
    return null;
  }
}

function ackBundleVersion(version: string): void {
  try {
    localStorage.setItem(BUNDLE_ACK_KEY, version);
  } catch {
    // Storage unavailable; the notice simply reappears next visit.
  }
}

type UpdatePhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "updating";
      readonly from: string;
      readonly to: string;
      readonly logFile?: string;
    }
  | {
      readonly kind: "failed";
      readonly to: string;
      readonly message: string;
      readonly logFile?: string;
    };

/**
 * How long the restart may take before the overlay reports failure. Generous
 * because `npm ci` + build on cluster filesystems (NFS/Lustre home dirs) can
 * take a long while, and under SLURM the launch wrapper rebuilds after the
 * updater's checkout.
 */
const UPDATE_DEADLINE_MS = 15 * 60_000;

/**
 * Written just before the tab reloads itself into the new version; the
 * reloaded page reads it back (sessionStorage: per-tab, survives exactly the
 * one reload) and confirms the finished update with a check mark until the
 * user clicks anywhere on the page.
 */
const UPDATE_SUCCESS_KEY = "brain-update-success";

function takeUpdateSuccess(): { readonly to?: string } | null {
  try {
    const raw = sessionStorage.getItem(UPDATE_SUCCESS_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(UPDATE_SUCCESS_KEY);
    return JSON.parse(raw) as { readonly to?: string };
  } catch {
    return null;
  }
}

function markUpdateSuccess(to: string): void {
  try {
    sessionStorage.setItem(UPDATE_SUCCESS_KEY, JSON.stringify({ to }));
  } catch {
    // Storage unavailable: the update still lands, only the confirmation
    // card is skipped.
  }
}

export function UpdateToast() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ackedVersion, setAckedVersion] = useState<string | null>(
    ackedBundleVersion,
  );
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  /** "Later" pressed for this app version — this page load only. */
  const [snoozedAppVersion, setSnoozedAppVersion] = useState<string | null>(
    null,
  );
  /** Just landed from a self-update reload: confirm it until any click. */
  const [updateSuccess, setUpdateSuccess] = useState<{
    readonly to?: string;
  } | null>(takeUpdateSuccess);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // "Click on the main page and it disappears": any click anywhere dismisses
  // the success confirmation.
  useEffect(() => {
    if (updateSuccess === null) return;
    const dismiss = (): void => setUpdateSuccess(null);
    document.addEventListener("click", dismiss);
    return () => document.removeEventListener("click", dismiss);
  }, [updateSuccess]);

  useEffect(() => {
    let live = true;
    const poll = () => {
      if (phaseRef.current.kind === "updating") return;
      getHealth()
        .then((response) => {
          if (live) setHealth(response);
        })
        .catch(() => undefined);
    };
    // Opening the dashboard is the beginning of a pipeline session: ask the
    // server for a FRESH release check first (throttled server-side), then
    // fall into the regular health polling that renders the result.
    postUpdateCheck()
      .catch(() => undefined)
      .finally(poll);
    const timer = window.setInterval(poll, 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // First visit establishes the baseline silently: "updated" only means
  // "newer than what this browser saw before", never "newer than nothing".
  useEffect(() => {
    const latest = health?.contentRegistry.latest;
    if (latest && ackedVersion === null) {
      ackBundleVersion(latest);
      setAckedVersion(latest);
    }
  }, [health, ackedVersion]);

  // Through the restart: poll fast; a server answering with a DIFFERENT
  // version means the update landed — reload this tab into it. The old
  // version answering after a observed downtime means the updater rolled
  // back; surface that with the log location instead of reloading.
  useEffect(() => {
    if (phase.kind !== "updating") return;
    const startedAt = Date.now();
    let sawDown = false;
    const timer = window.setInterval(() => {
      getHealth()
        .then((response) => {
          if (response.version !== phase.from) {
            markUpdateSuccess(response.version);
            window.location.reload();
            return;
          }
          if (sawDown) {
            setPhase({
              kind: "failed",
              to: phase.to,
              message:
                "the server came back on the previous version — the updater rolled back",
              ...(phase.logFile ? { logFile: phase.logFile } : {}),
            });
            return;
          }
          if (Date.now() - startedAt > UPDATE_DEADLINE_MS) {
            setPhase({
              kind: "failed",
              to: phase.to,
              message: "the server never restarted into the new version",
              ...(phase.logFile ? { logFile: phase.logFile } : {}),
            });
          }
        })
        .catch(() => {
          sawDown = true;
          if (Date.now() - startedAt > UPDATE_DEADLINE_MS) {
            setPhase({
              kind: "failed",
              to: phase.to,
              message: "the server did not come back",
              ...(phase.logFile ? { logFile: phase.logFile } : {}),
            });
          }
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const startUpdate = async (): Promise<void> => {
    if (!health?.appUpdate) return;
    const from = health.version;
    const to = health.appUpdate.version;
    try {
      const response = await postUpdateApp();
      setPhase({ kind: "updating", from, to, logFile: response.logFile });
    } catch (error) {
      setPhase({ kind: "failed", to, message: errorMessage(error) });
    }
  };

  if (phase.kind === "updating") {
    return (
      <div className="update-overlay" role="alert" aria-busy="true">
        <div className="update-overlay-card">
          <span className="update-spinner" aria-hidden="true" />
          <h3>Updating to v{phase.to}…</h3>
          <p>
            The app is reinstalling and restarting itself; this tab reloads
            automatically when it is back. Active runs keep going and are
            adopted by the new server.
          </p>
        </div>
      </div>
    );
  }

  const registry = health?.contentRegistry;
  const bundleBehind =
    registry !== undefined &&
    registry.latest !== undefined &&
    registry.pinnedVersion !== undefined &&
    registry.latest !== registry.pinnedVersion;
  const skillsUpdated =
    registry !== undefined &&
    registry.latest !== undefined &&
    registry.pinnedVersion === undefined &&
    ackedVersion !== null &&
    registry.latest !== ackedVersion;
  const appUpdate =
    health?.appUpdate !== undefined &&
    health.appUpdate.version !== snoozedAppVersion
      ? health.appUpdate
      : undefined;

  if (
    phase.kind === "idle" &&
    updateSuccess === null &&
    !appUpdate &&
    !skillsUpdated &&
    !bundleBehind
  ) {
    return null;
  }

  return (
    <div className="update-toast-stack" role="status">
      {updateSuccess !== null && (
        <div className="update-toast update-toast-success">
          <strong>
            <span className="update-success-check" aria-hidden="true">
              ✓
            </span>
            Update complete
          </strong>
          <p>
            Now running v{health?.version ?? updateSuccess.to ?? "the new version"}.
            Click anywhere to dismiss.
          </p>
        </div>
      )}
      {phase.kind === "failed" && (
        <div className="update-toast update-toast-error">
          <strong>Update to v{phase.to} failed</strong>
          <p>
            {phase.message}
            {phase.logFile ? (
              <>
                {" "}
                — details in <code>{phase.logFile}</code>
              </>
            ) : null}
          </p>
          <div className="update-toast-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setPhase({ kind: "idle" })}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {appUpdate && health && (
        <div className="update-toast update-toast-actionable">
          <strong>
            Brainstorm v{appUpdate.version} is available
          </strong>
          <p>
            {appUpdate.notes ? <>{appUpdate.notes} </> : null}
            You are running v{health.version}. Updating restarts the app and
            reloads this tab by itself; active runs keep going.
          </p>
          <div className="update-toast-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => void startUpdate()}
            >
              Update now
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setSnoozedAppVersion(appUpdate.version)}
            >
              Later
            </button>
          </div>
        </div>
      )}
      {skillsUpdated && registry && (
        <div className="update-toast">
          <strong>
            Brain skills updated: {registry.bundle ?? "brainstorm"} v
            {registry.latest}
          </strong>
          <p>
            {registry.latestNotes ? <>{registry.latestNotes} </> : null}
            New pipelines use it automatically; nothing to do.
          </p>
          <div className="update-toast-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                ackBundleVersion(registry.latest!);
                setAckedVersion(registry.latest!);
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
      {bundleBehind && registry && (
        <div className="update-toast">
          <strong>Bundle v{registry.latest} is published</strong>
          <p>
            Runs are pinned to v{registry.pinnedVersion} by the deployment.
            {registry.latestNotes ? <> {registry.latestNotes}</> : null}
          </p>
        </div>
      )}
    </div>
  );
}
