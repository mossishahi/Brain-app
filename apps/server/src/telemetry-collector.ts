import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  DiagnosticComponent,
  DiagnosticPreview,
  JobSummary,
} from "@brainstorm-agentic/protocol";
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetrySpool,
} from "@brainstorm-agentic/telemetry";

/** The parts of a record that describe the installation rather than the run. */
export interface CollectorIdentity {
  readonly installId: string;
  readonly appVersion: string;
  readonly provider: string;
  readonly runner: "local" | "slurm";
}

function envelope(identity: CollectorIdentity): Omit<TelemetryEvent, "type" | "runId"> {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: randomUUID(),
    installId: identity.installId,
    at: new Date().toISOString(),
    appVersion: identity.appVersion,
    platform: `${process.platform}-${process.arch}`,
    runner: identity.runner,
    provider: identity.provider,
  } as Omit<TelemetryEvent, "type" | "runId">;
}

/**
 * Emits the records only the server can produce.
 *
 * The worker writes one summary when a run ends, but two things are invisible
 * from inside a finished run: how many runs are alive RIGHT NOW (an end-of-run
 * record cannot answer it by construction), and the fact that a run failed at
 * all — a worker killed by a SLURM timeout or an OOM never reaches its own
 * emission point. Both are observed here, where job state is reconciled.
 */
export class TelemetryCollector {
  /** Jobs whose failure has already been reported, so a poll cannot duplicate it. */
  private readonly reportedFailures = new Set<string>();

  constructor(
    private readonly spool: TelemetrySpool,
    private readonly jobsDir: string,
    private readonly identity: () => CollectorIdentity,
  ) {}

  /**
   * One pass over current job state. Called on the same slow timer that flushes
   * the spool, so it costs nothing beyond the poll that already happens.
   */
  collect(jobs: readonly JobSummary[]): void {
    const identity = this.identity();
    for (const job of jobs) {
      if (job.status === "running") {
        const heartbeat = {
          ...envelope(identity),
          type: "heartbeat",
          runId: job.jobId,
          elapsedMs: Date.now() - job.createdAt,
        } as TelemetryEvent;
        this.spool.append(heartbeat);
        continue;
      }
      if (job.status === "failed" && !this.reportedFailures.has(job.jobId)) {
        this.reportedFailures.add(job.jobId);
        this.spool.append({
          ...envelope(identity),
          type: "run.failure",
          runId: job.jobId,
          failure: this.failureOf(job),
          retries: 0,
        } as TelemetryEvent);
      }
    }
  }

  /**
   * Tier 1 of failure reporting: strictly CONTENT-FREE. The error CLASS and
   * where it happened — never the message, which can quote the submission.
   * Safe to send without asking, which is what makes it useful in aggregate:
   * it answers "where does this break for real users" without ever carrying
   * anyone's material.
   */
  private failureOf(job: JobSummary): {
    readonly errorName: string;
    readonly stageId?: string;
    readonly nodePath?: string;
  } {
    const checkpoint = join(this.jobsDir, job.jobId, "session", "checkpoint.json");
    try {
      if (existsSync(checkpoint)) {
        const parsed = JSON.parse(readFileSync(checkpoint, "utf8")) as {
          error?: { name?: unknown };
        };
        const name = parsed.error?.name;
        if (typeof name === "string" && name.length > 0) return { errorName: name };
      }
    } catch {
      // An unreadable checkpoint is itself only worth a generic class.
    }
    return { errorName: "RunFailed" };
  }
}

/**
 * The preview shapes are owned by `protocol` (the browser contract) and
 * re-exported here so the collector and the dashboard cannot describe the same
 * report differently.
 */
export type { DiagnosticComponent, DiagnosticPreview };

/** Bytes of the last `limit` lines of a file, and the lines themselves. */
function tailLines(path: string, limit: number): string[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-limit);
}

const EVENT_TAIL_LINES = 400;

/**
 * Builds a diagnostic bundle for one job, and the preview that describes it.
 *
 * What is INCLUDED is chosen to root-cause a failure: which versions ran, what
 * the pipeline did, where it stopped, and the shape of the recorded state.
 *
 * What is EXCLUDED is the point. A checkpoint's journal values hold the
 * submission text, every model output and the developed paper — a researcher's
 * unpublished work. Sending that to debug a crash would be wildly
 * disproportionate, so the journal is reduced to its KEYS and kinds: enough to
 * see which tasks ran and where the run stopped, with none of their content.
 */
export function buildDiagnostic(
  jobsDir: string,
  job: JobSummary,
  /**
   * Whether an endpoint is configured. Passed in rather than read here so the
   * preview can warn before the button is used instead of failing after.
   */
  canSend: boolean,
): { readonly preview: DiagnosticPreview; readonly report: Record<string, unknown> } {
  const jobDir = join(jobsDir, job.jobId);
  const eventsPath = join(jobDir, "events.jsonl");
  const checkpointPath = join(jobDir, "session", "checkpoint.json");

  const events = tailLines(eventsPath, EVENT_TAIL_LINES);
  let checkpointShape: Record<string, unknown> | undefined;
  try {
    if (existsSync(checkpointPath)) {
      const parsed = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
        status?: unknown;
        seq?: unknown;
        error?: unknown;
        journal?: Array<{ key?: unknown; kind?: unknown }>;
      };
      checkpointShape = {
        status: parsed.status,
        seq: parsed.seq,
        error: parsed.error,
        // Keys and kinds only — never the recorded values.
        journal: (parsed.journal ?? []).map((entry) => ({
          key: entry.key,
          kind: entry.kind,
        })),
      };
    }
  } catch {
    checkpointShape = { unreadable: true };
  }

  const report: Record<string, unknown> = {
    kind: "diagnostic",
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    reportId: randomUUID(),
    at: new Date().toISOString(),
    job: {
      jobId: job.jobId,
      status: job.status,
      runner: job.runner,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.contentBundle ? { contentBundle: job.contentBundle } : {}),
    },
    platform: `${process.platform}-${process.arch}`,
    ...(checkpointShape ? { checkpoint: checkpointShape } : {}),
    events,
  };

  const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));
  const components: DiagnosticComponent[] = [
    {
      id: "job",
      description: "Job status, runner, timings, and the content version it pinned.",
      bytes: sizeOf(report.job),
      mayContainYourContent: false,
    },
    {
      id: "checkpoint",
      description:
        "Run status and the list of recorded step names — their results are NOT included.",
      bytes: sizeOf(checkpointShape),
      mayContainYourContent: false,
    },
    {
      id: "events",
      description:
        `The last ${events.length} activity log lines. These name files that were read, ` +
        "searches that were run, and URLs that were fetched.",
      bytes: sizeOf(events),
      mayContainYourContent: true,
    },
  ];

  return {
    preview: {
      jobId: job.jobId,
      status: job.status,
      components,
      totalBytes: sizeOf(report),
      excluded: [
        "Your submission text",
        "Everything the panel wrote — ideas, reviews, and the final proposal",
        "Your attachments",
        "API keys and credentials",
      ],
      canSend,
    },
    report,
  };
}
