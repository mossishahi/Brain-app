/**
 * The telemetry wire format.
 *
 * Three rules govern every change here, because they are what decide whether a
 * question can still be answered a year from now:
 *
 * 1. RAW FACTS, NOT AVERAGES. Records carry counts, durations and distributions
 *    — never pre-computed means. An average can always be derived later; a mean
 *    can never be un-averaged back into the spread it hid.
 * 2. PROVENANCE ON EVERYTHING. Every record carries the versions it was
 *    produced under, so questions nobody has thought of yet ("did bundle 0.16
 *    reduce the force-pass rate versus 0.15?") stay answerable retroactively.
 * 3. ADDITIVE-ONLY CHANGES. Never repurpose a field. If `durationMs` ever meant
 *    seconds, every historical record silently becomes wrong and unmixable with
 *    new ones. Add a new field and bump `schemaVersion` instead.
 */

/** Bumped only for additive changes; a field's meaning never changes. */
export const TELEMETRY_SCHEMA_VERSION = "1.0.0";

/** How the run was executed, for slicing every metric by environment. */
export type TelemetryRunner = "local" | "slurm";

/**
 * Stamped on every record. `installId` is a random UUID minted once per
 * installation: it identifies nobody, but it is STABLE, which is the only way
 * to ask whether the same install's runs change over time. Without it every
 * record looks like it came from a stranger.
 */
export interface ProvenanceEnvelope {
  readonly schemaVersion: string;
  /** Unique per record, so a retried send is idempotent at the receiver. */
  readonly eventId: string;
  readonly installId: string;
  readonly at: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly runner: TelemetryRunner;
  readonly provider: string;
  /** The content pin this run executed, and the digest that proves it. */
  readonly bundle?: {
    readonly name: string;
    readonly version: string;
    readonly digest: string;
  };
  /** The shared-taxonomy revision the run resolved against. */
  readonly taxonomyRevision?: number;
  /** Logical route -> model id, so results can be compared across models. */
  readonly modelsByRoute?: Readonly<Record<string, string>>;
}

/** One pipeline stage's wall-clock outcome. */
export interface StageFact {
  readonly stageId: string;
  readonly status: "completed" | "failed" | "incomplete";
  readonly durationMs?: number;
  readonly agentTasks: number;
}

/**
 * Per-role cost and latency. Keyed by the task kind the runtime already stamps
 * on every agent event, so no new plumbing is needed to attribute work.
 */
export interface RoleFact {
  readonly role: string;
  readonly tasks: number;
  readonly failures: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

/**
 * How the submission was read, and — the useful part — whether the submitter
 * accepted that reading. The revise rate is a free, unbiased accuracy score for
 * the classifier that is otherwise impossible to obtain.
 */
export interface ClassificationFact {
  readonly type?: string;
  readonly cotSteps?: number;
  readonly requestedOutputs: number;
  readonly gateAction?: "approve" | "revise" | "auto" | "unanswered";
}

export interface PanelFact {
  readonly seats: number;
  readonly distinctFields: number;
  readonly hasInterdisciplinarySeat: boolean;
  /** Seats the submitter removed at the confirmation gate. */
  readonly removedSeats: number;
  /** Seats the submitter added themselves. */
  readonly customSeats: number;
}

/**
 * The review's outcome distribution. Deliberately raw: histograms rather than
 * means, and force-passes counted separately, because "how often does the round
 * cap absorb an unresolved objection" is the question that matters and an
 * average would erase it.
 */
export interface ReviewFact {
  readonly stepsPassed: number;
  readonly stepsForcePassed: number;
  /** rounds-to-outcome -> how many steps took that many rounds. */
  readonly roundsHistogram: Readonly<Record<string, number>>;
  /** verdict -> count, across every judged round. */
  readonly verdicts: Readonly<Record<string, number>>;
  readonly mustAddressIssues: number;
  readonly verifiedIssues: number;
  readonly authorityIssues: number;
  readonly redevelopments: number;
}

/**
 * Which parts of the shared taxonomy a run actually used. Node IDS, never the
 * submitter's terms: ids are the registry's own public vocabulary, so this
 * carries no submission-derived text while still showing which regions are hot
 * and where the tree fails to cover reality.
 */
export interface TaxonomyFact {
  readonly revision?: number;
  readonly resolvedNodeIds: readonly string[];
  readonly matchedOn: Readonly<Record<string, number>>;
  readonly unmatched: number;
  readonly suggested: number;
}

/** A failure, as its error CLASS only — never a message, which can carry text. */
export interface FailureFact {
  readonly stageId?: string;
  readonly nodePath?: string;
  readonly errorName: string;
}

export interface RunSummary {
  readonly status: string;
  readonly durationMs?: number;
  readonly resumed: boolean;
  readonly stages: readonly StageFact[];
  readonly roles: readonly RoleFact[];
  readonly classification?: ClassificationFact;
  readonly panel?: PanelFact;
  readonly review?: ReviewFact;
  readonly taxonomy?: TaxonomyFact;
  readonly failures: readonly FailureFact[];
}

/** One completed run, ~3KB. The workhorse record: most questions are one query over these. */
export interface RunSummaryEvent extends ProvenanceEnvelope {
  readonly type: "run.summary";
  readonly runId: string;
  readonly summary: RunSummary;
}

/**
 * Emitted periodically while a run is in flight. The ONLY way to answer "how
 * many are running right now" — an end-of-run record cannot, by construction.
 */
export interface HeartbeatEvent extends ProvenanceEnvelope {
  readonly type: "heartbeat";
  readonly runId: string;
  readonly stageId?: string;
  readonly elapsedMs: number;
}

/**
 * Tier 1 of failure reporting: automatic and strictly CONTENT-FREE — an error
 * class and where it happened. Safe to send without asking, because it carries
 * nothing the submitter wrote. The full diagnostic bundle is a separate,
 * explicitly user-initiated act.
 */
export interface FailureEvent extends ProvenanceEnvelope {
  readonly type: "run.failure";
  readonly runId: string;
  readonly failure: FailureFact;
  readonly retries: number;
}

export type TelemetryEvent = RunSummaryEvent | HeartbeatEvent | FailureEvent;
