import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { TelemetryEvent } from "./types.js";

/**
 * The local outbox.
 *
 * The worker appends records here and returns; the server drains and sends
 * them. That split is deliberate: a worker may run on a cluster node with no
 * outbound network and must never block a run on a telemetry request, while the
 * server is long-lived and already does network work.
 *
 * Append-only newline JSON: a partially written trailing line is dropped on
 * read rather than corrupting the file, and a crash mid-append can lose at most
 * the record being written — which is the correct trade for data that must
 * never cost a run.
 */
export class TelemetrySpool {
  private readonly path: string;

  constructor(workspace: string) {
    this.path = join(workspace, "telemetry", "spool.jsonl");
  }

  /** Appends one record. Never throws: telemetry must not be able to fail a run. */
  append(event: TelemetryEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // A spool that cannot be written is not a reason to fail anything.
    }
  }

  /**
   * Takes everything currently spooled and clears the file in one step, so a
   * concurrent append cannot be lost between the read and the truncate. Records
   * are returned to the caller, which is responsible for sending them; on a
   * send failure it can put them back with `restore`.
   */
  drain(): readonly TelemetryEvent[] {
    if (!existsSync(this.path)) return [];
    const staged = `${this.path}.sending-${process.pid}-${randomUUID()}`;
    try {
      renameSync(this.path, staged);
    } catch {
      return [];
    }
    try {
      return readFileSync(staged, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TelemetryEvent];
          } catch {
            // A torn trailing line from a crash mid-append: drop it.
            return [];
          }
        });
    } catch {
      return [];
    } finally {
      rmSync(staged, { force: true });
    }
  }

  /** Returns undelivered records to the spool after a failed send. */
  restore(events: readonly TelemetryEvent[]): void {
    for (const event of events) this.append(event);
  }
}

/**
 * The installation's stable, anonymous id.
 *
 * A random UUID minted once and kept beside the workspace. It identifies no
 * person and carries no machine detail, but it is stable, which is the only
 * thing that makes longitudinal questions ("do this install's runs get faster?")
 * answerable at all. It cannot be reconstructed after the fact, which is why it
 * is created now rather than when telemetry is first switched on.
 */
export function installId(workspace: string): string {
  const path = join(workspace, "install-id");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    const minted = randomUUID();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${minted}\n`, "utf8");
    return minted;
  } catch {
    // Unwritable workspace: a per-process id still lets a run report, it just
    // cannot be correlated with the install's other runs.
    return randomUUID();
  }
}
