import type {
  CustomSeatRequest,
  JobStatus,
  RunnerKind,
  ServerSettings,
} from "@brainstorm-agentic/protocol";

export interface JobRecord {
  readonly jobId: string;
  readonly topic: string;
  /** The user's original attachment paths/URLs, kept for audit. */
  readonly attachments?: readonly string[];
  status: JobStatus;
  readonly runner: RunnerKind;
  readonly createdAt: number;
  updatedAt: number;
  slurmJobId?: string;
  /**
   * The SLURM cluster the submission landed on, as reported by sbatch
   * ("Submitted batch job N on cluster X"). Multi-cluster sites (e.g. LRZ)
   * route submissions by script directives, but squeue/sacct/scancel then
   * need an explicit -M for the job to be visible at all.
   */
  slurmCluster?: string;
  pid?: number;
  warnings?: string[];
  error?: string;
  submissionCount?: number;
  autoResumePending?: {
    /** Absent when the resume was claimed manually (no reset time known). */
    readonly retryAt?: number;
    readonly submittedAt: number;
  };
  /**
   * Bookkeeping of interrupted-job (orphaned) resubmissions: when the last
   * one was submitted, how many were submitted without checkpoint progress,
   * and the checkpoint seq observed at that submission (progress marker).
   * Auto-resume pauses after repeated attempts without progress; a manual
   * resume always resets the counter.
   */
  /**
   * When the submitter paused the run. Its presence is not what stops the
   * automatic paths — the STATUS does that — but it dates the decision for the
   * dashboard and survives restarts with the record.
   */
  pausedAt?: number;
  interruptedResume?: {
    readonly submittedAt: number;
    readonly count: number;
    readonly checkpointSeq?: number;
  };
  /**
   * The pending human gate's auto-approve countdown: initialized when the
   * server first observes the suspended checkpoint, approved as seated when
   * `deadlineAt` passes, permanently paused once `heldAt` is set (a user
   * interacted with the confirmation card). Cleared when the gate resolves.
   */
  gateAutoApprove?: {
    readonly gateKey: string;
    readonly deadlineAt: number;
    readonly totalMs: number;
    readonly heldAt?: number;
  };
  /**
   * The answer the last gate was resumed with, written the moment its resume
   * submission lands. Between that moment and the resumed worker's first
   * checkpoint write, the checkpoint on disk still says "suspended with a
   * pending gate" — a window that can last minutes in a scheduler queue —
   * and the dashboard must show the DECISION during it, not the machinery:
   * the stage reads decided, the card never re-offers, and the transition to
   * the next stage looks like one continuous run. The journal's own recorded
   * response stays authoritative the moment it exists; this is only the
   * bridge across the queue. Never cleared — a stale entry is ignored,
   * because the journal wins and each entry names its gate.
   */
  gateAnswer?: {
    readonly gateKey: string;
    readonly action: "approve" | "shrink" | "revise";
    readonly members?: readonly string[];
    readonly addedMembers?: readonly CustomSeatRequest[];
    readonly type?: string;
    readonly requestedOutputs?: readonly { title: string; ask: string }[];
    readonly at: number;
  };
  /** Immutable remote content snapshot used by this job. */
  contentBundle?: {
    readonly id: string;
    readonly version: string;
    readonly manifestSha256: string;
  };
  /** Snapshot used so a suspended run resumes with the same execution policy. */
  executionSettings?: ServerSettings;
  /**
   * Panel seats the submitter dismissed mid-run, in dismissal order, with the
   * moment each was dismissed. Append-only and never cleared by any resume
   * path: the list rides every later submission's command, and dropping it
   * would put a dismissed seat back to work.
   */
  dismissedMembers?: string[];
  /** memberId -> when it was dismissed, for the dashboard's record. */
  dismissedAt?: Record<string, number>;
  /** Set when the job moves to the view-only trash; never cleared. */
  trashedAt?: number;
}

export interface ContentRegistryRuntimeStatus {
  running: boolean;
  url?: string;
  skills?: number;
  workflows?: number;
  /** Version of the registry server process, from its /health payload. */
  serverVersion?: string;
}
