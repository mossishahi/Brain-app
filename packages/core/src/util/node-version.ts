import { atLeastVersion } from "./semver.js";

/**
 * The one Node.js floor of the whole app, enforced at runtime.
 *
 * The floor is set by the most demanding dependency — the Cursor SDK
 * (`@cursor/sdk` declares `node >= 22.13`) — and matches the exact version
 * the deploy scripts install (`v22.13.0`). Everything else (server, worker,
 * the other providers) runs on it too, so ONE floor is declared everywhere:
 * the `engines` field plus `engine-strict` npmrc entries make installs fail
 * on the wrong Node, and this guard makes a LAUNCH on the wrong Node fail
 * with one clear sentence instead of a cryptic dependency crash later —
 * which matters most on clusters, where the compute node running a worker
 * can carry a different Node than the login node that installed the app.
 */
export const MINIMUM_NODE_VERSION = "22.13.0";

/** True when `version` (e.g. process.versions.node) is at/above the floor. */
export function isSupportedNodeVersion(
  version: string,
  minimum: string = MINIMUM_NODE_VERSION,
): boolean {
  return atLeastVersion(version, minimum);
}

/**
 * Fails fast (clear message, no stack of unrelated errors) when this process
 * runs on a Node older than the app's floor. Call it first thing in every
 * process entry point.
 */
export function assertSupportedNodeVersion(
  running: string = process.versions.node,
): void {
  if (isSupportedNodeVersion(running)) return;
  throw new Error(
    `This app needs Node.js ${MINIMUM_NODE_VERSION} or newer (the Cursor SDK's floor); ` +
      `this process is running Node ${running}. Install a newer Node — the deploy scripts ` +
      `under app/deploy/ set up v${MINIMUM_NODE_VERSION} in ~/opt — and relaunch.`,
  );
}
