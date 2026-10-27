/** GPU onboarding is separate from general readiness: GPU use is optional. */
export type GpuSetupPhase = "unconfigured" | "discovering" | "draft" | "probing" | "ready" | "failed" | "unsupported";

export interface GpuQos {
  readonly name: string;
  readonly maxTimeMinutes?: number;
  readonly flags: readonly string[];
  readonly requiresReservation: boolean;
}

export interface GpuPartition {
  readonly name: string;
  readonly accounts: readonly string[];
  readonly qos: readonly string[];
  readonly gpuTypes: readonly string[];
  readonly maxTimeMinutes?: number;
  readonly interactive?: boolean;
  readonly warnings?: readonly string[];
  /** Allowed combinations, when associations expose finer permissions. */
  readonly accountQos?: Readonly<Record<string, readonly string[]>>;
}

export interface GpuDiscovery {
  readonly hostname: string;
  readonly architecture: string;
  readonly platform: string;
  readonly scheduler: "slurm" | "unsupported";
  readonly schedulerVersion?: string;
  readonly cluster?: string;
  readonly partitions: readonly GpuPartition[];
  readonly qos: readonly GpuQos[];
  readonly warnings: readonly string[];
  readonly evidence: readonly { command: string; stdout: string; stderr: string; exitCode: number }[];
  readonly discoveredAt: string;
}

export interface GpuSlurmParameters {
  readonly partition: string;
  readonly account: string;
  readonly qos: string;
  readonly gpuType?: string;
  readonly gpus: number;
  readonly cpus: number;
  readonly memoryGb: number;
  readonly timeLimitMinutes: number;
  readonly nice: number;
  readonly reservation?: string;
  readonly prelude: string;
}

export interface GpuSetupDraft {
  readonly id: string;
  readonly revision: number;
  readonly parameters: GpuSlurmParameters;
  readonly template: string;
  readonly probeScript: string;
  /** Digest binds approval to the exact displayed script and parameters. */
  readonly reviewToken: string;
  readonly notes: readonly string[];
}

export interface GpuProbeReport {
  readonly submissionToken?: string;
  readonly attemptDirectory?: string;
  readonly jobId?: string;
  readonly cluster?: string;
  readonly jobDir?: string;
  readonly state: string;
  readonly log?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface GpuSetupReport {
  readonly phase: GpuSetupPhase;
  /** A prior job could not be cancelled; no further submissions are allowed. */
  readonly cleanupRequired?: boolean;
  readonly progress: { readonly percent: number; readonly message: string };
  readonly discovery?: GpuDiscovery;
  readonly draft?: GpuSetupDraft;
  readonly probe?: GpuProbeReport;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface GpuDraftUpdate {
  readonly draftId: string;
  readonly revision: number;
  readonly parameters: GpuSlurmParameters;
}

export interface GpuProbeApproval {
  readonly draftId: string;
  readonly revision: number;
  readonly reviewToken: string;
  readonly approved: true;
}
