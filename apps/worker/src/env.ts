/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments, no expansion. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function loadDotEnv(dir: string): void {
  const file = join(dir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function defaultSessionRoot(): string {
  const configured = process.env.BRAINSTORM_AGENTIC_SESSION_ROOT;
  return expandHome(configured && configured.trim() !== "" ? configured : "~/.brainstorm-agentic/workspace/sessions");
}

/**
 * The workspace root that owns a session root — where the telemetry spool
 * (`<root>/telemetry/spool.jsonl`) and install id (`<root>/install-id`) live.
 *
 * The server lays runs out as `<workspace>/workspace/sessions` (JobManager)
 * and its telemetry sender drains `<workspace>/telemetry`, so a session root
 * following that convention resolves two levels up — anything less and the
 * worker spools run summaries into a directory the server never drains. A
 * bespoke session root (a hand-set BRAINSTORM_AGENTIC_SESSION_ROOT outside the
 * convention) keeps the one-level parent: no server drains those spools, but
 * the records stay local and inspectable next to the sessions.
 */
export function workspaceRootFromSessionRoot(sessionRoot: string): string {
  const parent = dirname(sessionRoot);
  if (basename(sessionRoot) === "sessions" && basename(parent) === "workspace") {
    return dirname(parent);
  }
  return parent;
}
