import type {
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
  pid?: number;
  warnings?: string[];
  error?: string;
  submissionCount?: number;
  autoResumePending?: {
    readonly retryAt: number;
    readonly submittedAt: number;
  };
  /** Immutable remote content snapshot used by this job. */
  contentBundle?: {
    readonly id: string;
    readonly version: string;
    readonly manifestSha256: string;
  };
  /** Snapshot used so a suspended run resumes with the same execution policy. */
  executionSettings?: ServerSettings;
  /** Set when the job moves to the view-only trash; never cleared. */
  trashedAt?: number;
}

export interface ContentRegistryRuntimeStatus {
  running: boolean;
  url?: string;
  skills?: number;
  workflows?: number;
}
