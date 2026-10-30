import { randomBytes } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export type StartupPhase = "loading" | "initializing" | "listening" | "ready" | "failed";
export type StartupReporter = (phase: StartupPhase) => void;

export interface StartupStatus {
  readonly schemaVersion: 1;
  readonly hostname: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly phase: StartupPhase;
  readonly updatedAt: number;
  readonly message: string;
}

const messages: Record<StartupPhase, string> = {
  loading: "Loading the research service",
  initializing: "Opening the research workspace",
  listening: "Research service is listening; finishing initialization",
  ready: "Research service is ready to connect",
  failed: "The research service could not start. Open the connection logs for details.",
};

/** Advisory desktop progress only; the authenticated handshake proves readiness. */
export function createStartupReporter(env: NodeJS.ProcessEnv = process.env): StartupReporter {
  const path = env.BRAINSTORM_STARTUP_STATUS_FILE;
  if (!path || !env.BRAINSTORM_API_TOKEN_FILE) return () => {};
  const identity = { schemaVersion: 1 as const, hostname: hostname(), pid: process.pid, startedAt: Date.now() };
  return (phase) => {
    let temporary: string | undefined;
    try {
      // Bootstrap creates the private directory. Diagnostics must not create
      // directories or follow a directory symlink supplied by another user.
      const directory = lstatSync(dirname(path));
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 ||
          (process.getuid && directory.uid !== process.getuid())) return;
      temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      const status: StartupStatus = { ...identity, phase, updatedAt: Date.now(), message: messages[phase] };
      writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch {
      // A missing or unwritable progress file must never prevent startup.
    } finally {
      if (temporary) {
        try { unlinkSync(temporary); } catch { /* renamed, or never created */ }
      }
    }
  };
}
