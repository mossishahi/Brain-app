/**
 * @brainstorm-agentic/protocol
 *
 * The single API contract between apps/server and apps/web. Both sides depend
 * on this package; neither may invent shapes outside it. Pure types +
 * constants — no runtime dependencies.
 */

/* ------------------------------------------------------------------ stages */

/** Pipeline stage ids. These match the node ids in the shipped brainstorm workflow. */
export const STAGE_IDS = [
  "process-input",
  "decompose-experts",
  "select-panel",
  "confirm-panel",
  "first-pass",
  "review-members",
  "bridge-audit",
  "synthesize-proposal",
  "done",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type StageStatus =
  | "pending"
  | "active"
  | "suspended"
  | "credit_blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type StageActivityKind =
  | "status"
  | "model"
  | "tool_start"
  | "tool_progress"
  | "tool_end"
  | "retry"
  | "validation";

export interface StageActivityEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: StageActivityKind;
  readonly message: string;
  readonly toolName?: string;
  readonly turn?: number;
  readonly elapsedMs?: number;
}

export interface StageBase {
  readonly id: StageId;
  readonly status: StageStatus;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
  /** Sanitized operational events, oldest to newest (never chain-of-thought). */
  readonly activity?: readonly StageActivityEntry[];
}

/* --------------------------------------------------- per-stage artifact views */

export interface ProcessorOutputView {
  readonly type: string;
  readonly title: string;
  readonly question: string;
  readonly context: string;
  readonly attachments: readonly { readonly name: string; readonly note: string }[];
  readonly assumptions: readonly string[];
  readonly cotSteps: number;
}

/** One attached file with the processor's relation label ("NA" = useless). */
export interface AnnotatedFileView {
  readonly path: string;
  readonly label: string;
  readonly note: string;
}

/** The orchestrator's partition of the processor's file map. */
export interface FilePartitionView {
  /** The only file list later model calls receive. */
  readonly useful: readonly AnnotatedFileView[];
  /** NA-labeled files, kept as a separate audit artifact. */
  readonly ignored: readonly AnnotatedFileView[];
}

/**
 * One area of the tree. `count` is the measured support — distinct people in
 * the grounding pool who stated it — and is absent for trees produced before
 * the decomposer counted.
 */
export interface ExpertAreaView {
  readonly name: string;
  readonly count?: number;
}

export interface ExpertUmbrellaView {
  readonly name: string;
  readonly count?: number;
  readonly subfields: readonly ExpertAreaView[];
}

export interface ExpertDepartmentView {
  readonly name: string;
  /** The catalog group the department belongs to; absent on older trees. */
  readonly domain?: string;
  /** k — direct pool mentions of the department; absent on older trees. */
  readonly count?: number;
  readonly umbrellas: readonly ExpertUmbrellaView[];
}

/** Department → umbrella → subfields, ordered by descending support. */
export interface ExpertsTreeView {
  readonly departments: readonly ExpertDepartmentView[];
}

export interface PanelMemberView {
  readonly id: string;
  readonly department: string;
  readonly umbrella: string;
  readonly subfields: readonly string[];
}

export interface PaperView {
  readonly id?: string;
  readonly title: string;
  readonly authors?: readonly string[];
  readonly year?: number;
  readonly venue?: string;
  readonly url?: string;
  readonly relation?: string;
}

/** One enumerated author with their academic-profile-lookup outcome. */
export interface ScholarView {
  readonly name: string;
  /** Affiliation from the resolved profile; empty when unknown. */
  readonly affiliation: string;
  /** Resolved profile URL; empty when none. */
  readonly url: string;
  readonly profile: "ok" | "ambiguous" | "no_profile";
  /** Verbatim research interests; empty unless profile is "ok". */
  readonly interests: readonly string[];
}

/** The literature the decomposer's search surfaced: papers, authors, interests. */
export interface GroundingView {
  readonly papers: readonly PaperView[];
  readonly scholars: readonly ScholarView[];
}

/* ------------------------------------------- per-shape developed-output views */

/**
 * The eight structural output shapes (mirrors the content package's
 * OUTPUT_SHAPES). Which submission TYPES exist — and what they are called —
 * is bundle data (catalog/input-types.json), so views carry the type as a
 * free-form label alongside the closed shape id the body was validated as.
 */
export const OUTPUT_SHAPES = [
  "paper",
  "resolution",
  "verification",
  "feasibility",
  "critique",
  "interpretation",
  "survey",
  "explanation",
] as const;
export type OutputShape = (typeof OUTPUT_SHAPES)[number];

/** paper — the five-section research paper. */
export interface IdeaOutputView {
  readonly abstract: string;
  readonly introduction: string;
  readonly method: string;
  readonly discussion: string;
  readonly conclusion: string;
}

export interface ConfidenceView {
  readonly level: "high" | "medium" | "low";
  readonly rationale: string;
}

export interface KnownResultView {
  readonly result: string;
  readonly sourceType: string;
  readonly relation: string;
}

/** resolution — a proof/construction attempt with an explicit status. */
export interface ResolveOutputView {
  readonly problemStatement: string;
  readonly knownResults: readonly KnownResultView[];
  readonly approach: string;
  readonly derivation: readonly string[];
  /** Self-check of the derivation; absent when the member had none. */
  readonly verification?: EvidenceView;
  readonly status: "resolved" | "partial" | "refuted" | "still-open";
  readonly remainingGaps: readonly string[];
  readonly significance: string;
}

/** verification — one claim adjudicated with evidence. */
export interface VerifyOutputView {
  readonly claim: string;
  readonly claimSource: string;
  readonly verdict: "confirmed" | "refuted" | "partially-correct" | "indeterminate";
  /** Absent only for indeterminate verdicts. */
  readonly evidence?: EvidenceView;
  readonly reasoning: string;
  readonly confidence: ConfidenceView;
}

export interface SoundnessAspectView {
  readonly aspect: string;
  readonly assessment: "sound" | "concern" | "flaw";
  readonly note: string;
}

/** feasibility — a Registered-Reports-style soundness review. */
export interface AssessFeasibilityOutputView {
  readonly designSummary: string;
  readonly importance: string;
  readonly hypothesisLogic: string;
  readonly methodologySoundness: readonly SoundnessAspectView[];
  readonly replicability: string;
  readonly feasibilityVerdict: "feasible-as-is" | "feasible-with-changes" | "not-feasible";
  readonly requiredChanges: readonly string[];
  readonly alternativeDesigns: readonly string[];
}

export interface CritiqueIssueView {
  readonly description: string;
  readonly severity: "minor" | "major" | "critical";
  readonly evidence?: EvidenceView;
  readonly suggestion?: string;
}

/** critique — an itemized review of a finished artifact. */
export interface CritiqueOutputView {
  readonly artifactSummary: string;
  readonly strengths: readonly string[];
  readonly issues: readonly CritiqueIssueView[];
  readonly missingConsiderations: readonly string[];
  readonly recommendation: "sound" | "sound-with-revisions" | "not-sound";
  readonly prioritizedNextSteps: readonly { readonly priority: number; readonly action: string }[];
}

export interface InterpretationCandidateView {
  readonly interpretation: string;
  readonly supportingEvidence?: string;
  readonly contradictingEvidence?: string;
  readonly plausibility: "high" | "medium" | "low";
}

/** interpretation — ranked readings of the submitter's own finding. */
export interface InterpretOutputView {
  readonly observationSummary: string;
  readonly candidateInterpretations: readonly InterpretationCandidateView[];
  readonly mostLikelyInterpretation: string;
  readonly confidence: ConfidenceView;
  readonly threatsToValidity: readonly string[];
  readonly implications?: string;
}

export interface LandscapeGroupView {
  readonly name: string;
  readonly works: readonly PaperView[];
  readonly characterization: string;
}

export interface ComparisonRowView {
  readonly dimension: string;
  readonly comparison: string;
}

/** survey — the landscape map plus optional comparison and recommendation. */
export interface SurveyOutputView {
  readonly landscapeMap: readonly LandscapeGroupView[];
  readonly comparisonTable: readonly ComparisonRowView[];
  readonly consensusAndFrontier: string;
  readonly openGaps: readonly string[];
  readonly recommendation?: string;
}

export interface MisconceptionView {
  readonly misconception: string;
  readonly correction: string;
}

/** explanation — pedagogical exposition from intuition to rigor. */
export interface ExplainOutputView {
  readonly motivatingQuestion: string;
  readonly coreIntuition: string;
  readonly formalTreatment: string;
  readonly workedExample: string;
  readonly commonMisconceptions: readonly MisconceptionView[];
  readonly connections: readonly string[];
}

/**
 * One member's finished first-pass output. `type` is the submission's catalog
 * label (free-form — the catalog is bundle data); `shape` is the closed
 * structural id, and exactly the matching body field is present. `novelty`
 * exists only for shapes positioned against a literature map (paper,
 * resolution, survey).
 */
export interface BrainIdeaView {
  readonly type: string;
  readonly shape: OutputShape;
  readonly paper?: IdeaOutputView;
  readonly resolution?: ResolveOutputView;
  readonly verification?: VerifyOutputView;
  readonly feasibility?: AssessFeasibilityOutputView;
  readonly critique?: CritiqueOutputView;
  readonly interpretation?: InterpretOutputView;
  readonly survey?: SurveyOutputView;
  readonly explanation?: ExplainOutputView;
  readonly cot: readonly string[];
  readonly novelty?: string;
  readonly literature?: readonly PaperView[];
}

export type Verdict = "Pass" | "Build" | "Interrupt";

export type EvidenceView =
  | { readonly kind: "script"; readonly code: string; readonly result?: string }
  | { readonly kind: "math"; readonly derivation: string }
  | { readonly kind: "reference"; readonly citation: string; readonly locator: string; readonly shows: string };

export interface CommentView {
  readonly commentorId: string;
  readonly commentorLabel: string;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly suggestion?: string;
  readonly evidence?: EvidenceView;
}

export interface JudgeDecisionView {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly suggestion?: string;
  readonly evidence?: EvidenceView;
  /** commentor id -> verified | authority */
  readonly assessment: Readonly<Record<string, "verified" | "authority">>;
}

export interface ReviewRoundView {
  /** 1-based round on the current step. Round 1 is the initial review. */
  readonly round: number;
  readonly comments: readonly CommentView[];
  readonly decision?: JudgeDecisionView;
  /** Present when this round ended in a redevelopment. */
  readonly revision?: { readonly fromStep: number; readonly revisedStepCount: number };
}

export type ReviewStepOutcome = "pending" | "under-review" | "passed" | "force-passed";

export interface ReviewStepView {
  /** 1-based chain-of-thought step index. */
  readonly index: number;
  readonly outcome: ReviewStepOutcome;
  readonly rounds: readonly ReviewRoundView[];
}

export interface ReviewMemberView {
  readonly memberId: string;
  readonly label: string;
  readonly steps: readonly ReviewStepView[];
}

export interface ReviewCursorView {
  /** 1-based member position and total. */
  readonly member: number;
  readonly memberCount: number;
  /** 1-based chain step and total. */
  readonly step: number;
  readonly stepCount: number;
  /** 1-based review round on the current step. */
  readonly round: number;
  readonly maxRounds: number;
}

/** One member's novelty claim, audited across fields after review. */
export interface NoveltyAuditView {
  readonly memberId: string;
  readonly claim: string;
  readonly status: "clear" | "challenged";
  readonly note: string;
  /** The overlapping prior work; present only when challenged. */
  readonly evidence?: EvidenceView;
}

/** Two or more members whose outputs make claims that cannot both hold. */
export interface ContradictionView {
  readonly members: readonly string[];
  readonly description: string;
}

/** A gap between the seats: an interface no member covered. */
export interface SeamView {
  readonly between: readonly string[];
  readonly gap: string;
  readonly opportunity: string;
}

/** The integrator's post-review audit, advisory input to the chair. */
export interface BridgeReportView {
  readonly noveltyAudit: readonly NoveltyAuditView[];
  readonly contradictions: readonly ContradictionView[];
  readonly seams: readonly SeamView[];
}

export interface ActionItemView {
  readonly priority: number;
  readonly action: string;
  readonly rationale: string;
}

export interface ProposalView {
  readonly title: string;
  readonly framing: string;
  readonly consensus: readonly string[];
  readonly tensions: readonly string[];
  readonly novelDirections: readonly string[];
  readonly actionItems: readonly ActionItemView[];
  readonly applications: readonly string[];
}

export interface StageDurationView {
  readonly stage: StageId;
  readonly durationMs: number;
}

export interface RunSummaryView {
  readonly totalDurationMs?: number;
  readonly stageDurations: readonly StageDurationView[];
  readonly agentTaskCount: number;
}

/* --------------------------------------------------------------- stage views */

export interface ProcessInputStage extends StageBase {
  readonly id: "process-input";
  readonly output?: ProcessorOutputView;
  /** Present once the file map has been partitioned (jobs with attachments). */
  readonly files?: FilePartitionView;
}

export interface DecomposeStage extends StageBase {
  readonly id: "decompose-experts";
  readonly experts?: ExpertsTreeView;
  readonly counts?: { readonly departments: number; readonly umbrellas: number; readonly subfields: number };
  /** Papers/authors/research-interests the literature search surfaced. */
  readonly grounding?: GroundingView;
}

export interface SelectPanelStage extends StageBase {
  readonly id: "select-panel";
  readonly panel?: readonly PanelMemberView[];
  /** Umbrella leaves available in the experts tree before trimming. */
  readonly leavesAvailable?: number;
}

export type GateState = "not-reached" | "pending" | "approved" | "shrunk" | "auto-approved";

export interface ConfirmPanelStage extends StageBase {
  readonly id: "confirm-panel";
  readonly gate: {
    readonly state: GateState;
    readonly removedMemberIds?: readonly string[];
    readonly decidedAt?: number;
  };
}

export interface FirstPassMemberView {
  readonly memberId: string;
  readonly label: string;
  readonly department: string;
  readonly umbrella: string;
  readonly subfields: readonly string[];
  /** "paused": the task was mid-flight when the run credit-blocked. */
  readonly status: "pending" | "thinking" | "paused" | "completed" | "failed";
  readonly idea?: BrainIdeaView;
}

export interface FirstPassStage extends StageBase {
  readonly id: "first-pass";
  readonly members: readonly FirstPassMemberView[];
}

export interface ReviewStage extends StageBase {
  readonly id: "review-members";
  readonly cursor?: ReviewCursorView;
  readonly members: readonly ReviewMemberView[];
}

export interface BridgeAuditStage extends StageBase {
  readonly id: "bridge-audit";
  readonly bridge?: BridgeReportView;
}

export interface ChairStage extends StageBase {
  readonly id: "synthesize-proposal";
  readonly proposal?: ProposalView;
}

export interface DoneStage extends StageBase {
  readonly id: "done";
  readonly summary?: RunSummaryView;
}

export type StageView =
  | ProcessInputStage
  | DecomposeStage
  | SelectPanelStage
  | ConfirmPanelStage
  | FirstPassStage
  | ReviewStage
  | BridgeAuditStage
  | ChairStage
  | DoneStage;

/* ---------------------------------------------------------------------- jobs */

export type JobStatus =
  | "queued"
  | "running"
  | "suspended"
  | "credit-blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export type RunnerKind = "slurm" | "local";

export interface JobSummary {
  readonly jobId: string;
  readonly topic: string;
  readonly status: JobStatus;
  readonly runner: RunnerKind;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly slurmJobId?: string;
  /** Present once the job has been moved to the view-only trash. */
  readonly trashedAt?: number;
  /** Compact progress for the landing-page job card. */
  readonly progress?: {
    readonly activeStage?: StageId;
    readonly completedStages: number;
    readonly totalStages: number;
    readonly reviewCursor?: ReviewCursorView;
  };
  readonly error?: string;
  readonly creditBlock?: {
    readonly retryAt: number;
    readonly providerMessage: string;
    readonly source: "deterministic" | "openrouter";
  };
}

export interface PendingGateView {
  readonly gateKey: string;
  readonly title?: string;
  readonly prompt?: string;
  /** Panel shown for the confirm-panel gate. */
  readonly members?: readonly PanelMemberView[];
}

export interface JobDetail extends JobSummary {
  readonly stages: readonly StageView[];
  readonly pendingGate?: PendingGateView;
}

/* ------------------------------------------------------------------ settings */

/** The tag the user's SLURM template must contain; replaced by the orchestration command. */
export const SLURM_COMMAND_TAG = "{{BRAIN_COMMAND}}";

export type ClaudeAgentEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ClaudeAgentSettings {
  /** Maximum tool/API round-trips per pipeline agent task. */
  readonly maxTurns: number;
  /** Optional USD ceiling per pipeline agent task. */
  readonly maxBudgetUsd?: number;
  /** Reasoning effort passed to the Agent SDK. */
  readonly effort: ClaudeAgentEffort;
  /** Adaptive reasoning or no extended thinking. */
  readonly thinking: "adaptive" | "disabled";
  /** Optional model used when the primary model is overloaded/unavailable. */
  readonly fallbackModel?: string;
}

export interface LlmSettings {
  /**
   * "anthropic": developer Messages API + API key.
   * "claude-agent": Claude Agent SDK + token from `claude setup-token`.
   * "offline": deterministic executor (no network, for testing).
   */
  readonly provider: "anthropic" | "claude-agent" | "offline";
  /** Required for developer API; optional Agent SDK alias/full model id. */
  readonly model?: string;
  /** Optional developer-API endpoint override (not used by Claude Agent SDK). */
  readonly baseUrl?: string;
  readonly modelsByRoute?: Readonly<Record<string, string>>;
  /** Agent SDK execution controls; used only by the claude-agent backend. */
  readonly agentSdk?: ClaudeAgentSettings;
  /** Public status only. The API key itself is never returned by the server. */
  readonly apiKeyConfigured?: boolean;
  /** Public status only. The setup token itself is never returned by the server. */
  readonly setupTokenConfigured?: boolean;
}

export interface ServerSettings {
  readonly slurmTemplate: string;
  readonly runner: RunnerKind;
  readonly llm: LlmSettings;
  /** "manual": jobs pause at the panel gate for dashboard confirmation. */
  readonly panelConfirmation: "manual" | "auto";
  readonly contentRegistry: {
    readonly url: string;
    readonly bundle: string;
    /** Omit to resolve latest once per new run. */
    readonly version?: string;
    /**
     * "auto" (default): new runs silently take the latest published version.
     * "notify": run behavior is unchanged, but the dashboard surfaces newer
     * published versions with their release notes. Purely a UI policy.
     */
    readonly updatePolicy?: "auto" | "notify";
  };
  /** App self-update surfacing: "notify" (default) shows available updates. */
  readonly updateCheck?: "off" | "notify";
  readonly creditRecovery: {
    readonly autoResume: boolean;
    readonly safetyBufferSeconds: number;
    readonly openRouterModel: string;
    readonly openRouterKeyConfigured?: boolean;
  };
  /**
   * Host tools the user has explicitly enabled/disabled.
   * Tool IDs not listed here use their manifest default.
   */
  readonly hostTools?: {
    readonly enabledToolIds: readonly string[];
  };
}

/* --------------------------------------------------- task types and models */

/** One selectable model of a provider's catalog. */
export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

/** Per-provider dictionary of models offered by the per-task-type picker. */
export type ProviderModelCatalog = Readonly<
  Record<string, readonly ModelOption[]>
>;

/**
 * Built-in per-provider model dictionary. A deployment can extend or replace
 * entries by placing a `model-catalog.json` file with the same shape in the
 * workspace root; the server merges that file over these defaults.
 */
export const DEFAULT_MODEL_CATALOG: ProviderModelCatalog = {
  anthropic: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  "claude-agent": [
    { id: "opus", label: "Opus (alias)" },
    { id: "sonnet", label: "Sonnet (alias)" },
    { id: "haiku", label: "Haiku (alias)" },
  ],
  offline: [],
};

/** One task type (logical route) declared by the pinned content bundle. */
export interface TaskTypeOption {
  readonly id: string;
  readonly description: string;
}

/** GET /api/model-options: everything the per-task-type model picker needs. */
export interface ModelOptionsResponse {
  readonly provider: LlmSettings["provider"];
  /** Task types from the pinned bundle's route catalog, in declared order. */
  readonly taskTypes: readonly TaskTypeOption[];
  /** Selectable models for the active provider. */
  readonly models: readonly ModelOption[];
  /** Current per-task-type selection; a missing type uses defaultModel. */
  readonly modelsByRoute: Readonly<Record<string, string>>;
  readonly defaultModel?: string;
}

/**
 * PUT /api/settings/models-by-route request body. Entries with an empty
 * model string mean "use the default model" and are dropped. Unlike
 * PUT /api/settings this endpoint never touches credentials and performs no
 * connection re-verification.
 */
export interface ModelsByRouteUpdate {
  readonly modelsByRoute: Readonly<Record<string, string>>;
}

/* ---------------------------------------------------------------- api shapes */

/**
 * Settings accepted by PUT /api/settings. `llm.apiKey` and `llm.setupToken`
 * are write-only:
 * - omitted/blank: retain the corresponding configured secret;
 * - non-empty: verify through the selected backend, then replace that secret;
 * - clear flags: remove the corresponding secret when its provider is not selected.
 *
 * The response is always ServerSettings and therefore never contains the key.
 */
export interface ServerSettingsUpdate {
  readonly slurmTemplate: string;
  readonly runner: RunnerKind;
  readonly panelConfirmation: "manual" | "auto";
  readonly contentRegistry: {
    readonly url: string;
    readonly bundle: string;
    readonly version?: string;
    readonly updatePolicy?: "auto" | "notify";
  };
  readonly updateCheck?: "off" | "notify";
  readonly creditRecovery: {
    readonly autoResume: boolean;
    readonly safetyBufferSeconds: number;
    readonly openRouterModel: string;
    readonly openRouterApiKey?: string;
    readonly clearOpenRouterApiKey?: boolean;
  };
  readonly llm: {
    readonly provider: "anthropic" | "claude-agent" | "offline";
    readonly model?: string;
    readonly baseUrl?: string;
    readonly modelsByRoute?: Readonly<Record<string, string>>;
    readonly agentSdk?: ClaudeAgentSettings;
    readonly apiKey?: string;
    readonly clearApiKey?: boolean;
    readonly setupToken?: string;
    readonly clearSetupToken?: boolean;
  };
  /** Host tools the user wants enabled. Absent = keep current. */
  readonly hostTools?: {
    readonly enabledToolIds: readonly string[];
  };
}

export interface SubmitJobRequest {
  readonly topic: string;
  /**
   * Prevalidated paths on the orchestration server (folders, zip archives,
   * PDFs, images, videos, arbitrary files) and http(s) URLs. The server
   * revalidates and snapshots each one into the job's attachment store at
   * submission time.
   */
  readonly attachments?: readonly string[];
}

/** Logical server-side attachment type selected in the webapp. */
export type AttachmentSelectionKind =
  | "file"
  | "folder"
  | "zip"
  | "image"
  | "video"
  | "pdf"
  | "web";

/** Shared validation and snapshot ceilings. */
export const ATTACHMENT_LIMITS = {
  maxReferences: 20,
  maxFiles: 400,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
} as const;

export interface ServerAttachmentRoot {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface ServerAttachmentRootsResponse {
  readonly roots: readonly ServerAttachmentRoot[];
}

export interface ServerFileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly bytes?: number;
  readonly modifiedAt: number;
  /** Whether this entry matches the attachment type currently being picked. */
  readonly selectable: boolean;
  readonly reason?: string;
}

export interface BrowseServerFilesResponse {
  readonly roots: readonly ServerAttachmentRoot[];
  readonly rootId: string;
  readonly currentPath: string;
  readonly parentPath?: string;
  readonly entries: readonly ServerFileEntry[];
}

export interface SearchServerFilesResponse {
  readonly rootId: string;
  readonly basePath: string;
  readonly query: string;
  readonly entries: readonly ServerFileEntry[];
  readonly truncated: boolean;
}

export interface ValidateAttachmentsRequest {
  readonly kind: AttachmentSelectionKind;
  readonly paths: readonly string[];
}

export interface ValidatedAttachment {
  readonly path: string;
  readonly name: string;
  readonly kind: AttachmentSelectionKind;
  readonly valid: boolean;
  readonly readable: boolean;
  readonly files?: number;
  readonly bytes?: number;
  readonly reason?: string;
}

export interface ValidateAttachmentsResponse {
  readonly attachments: readonly ValidatedAttachment[];
}

export interface SubmitJobResponse {
  readonly jobId: string;
}

export interface GateAnswerRequest {
  readonly gateKey: string;
  readonly action: "approve" | "shrink";
  /** For shrink: member ids to KEEP, in their existing order. */
  readonly members?: readonly string[];
}

export interface CancelJobResponse {
  readonly jobId: string;
  readonly status: JobStatus;
}

export interface TrashJobResponse {
  readonly jobId: string;
  readonly trashedAt: number;
}

export interface ContentRegistryStatus {
  readonly running: boolean;
  readonly url?: string;
  readonly skills?: number;
  readonly workflows?: number;
  /** Newest published bundle version the registry index lists. */
  readonly latest?: string;
  /** Release notes of `latest` (the publisher's tag annotation). */
  readonly latestNotes?: string;
  /** The explicit version pin from settings, when one is set. */
  readonly pinnedVersion?: string;
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly workspace: string;
  readonly contentRegistry: ContentRegistryStatus;
  /** A newer app release tag exists (checked against the git remote). */
  readonly appUpdate?: {
    readonly version: string;
    readonly notes?: string;
  };
}

/** Server-sent events. `jobs` streams on /api/stream; `job` on /api/jobs/:id/stream. */
export type ServerEvent =
  | { readonly type: "jobs"; readonly jobs: readonly JobSummary[] }
  | { readonly type: "job"; readonly job: JobDetail }
  | { readonly type: "error"; readonly message: string };

/**
 * REST surface (all JSON):
 *   GET  /api/health                          -> HealthResponse
 *   GET  /api/settings                        -> ServerSettings
 *   PUT  /api/settings                        -> ServerSettings (body: ServerSettingsUpdate; Anthropic credentials are connection-tested before any save)
 *   GET  /api/model-options                   -> ModelOptionsResponse (task types from the pinned bundle + provider model catalog)
 *   PUT  /api/settings/models-by-route        -> ServerSettings (body: ModelsByRouteUpdate; no credential re-verification)
 *   GET  /api/jobs                            -> JobSummary[]
 *   GET  /api/attachments/roots               -> ServerAttachmentRootsResponse
 *   GET  /api/attachments/browse              -> BrowseServerFilesResponse
 *   GET  /api/attachments/search              -> SearchServerFilesResponse
 *   POST /api/attachments/validate            -> ValidateAttachmentsResponse
 *   POST /api/jobs                            -> SubmitJobResponse   (body: SubmitJobRequest with validated server paths/URLs)
 *   GET  /api/jobs/trash                      -> JobSummary[]       (view-only trash, newest first)
 *   GET  /api/jobs/:jobId                     -> JobDetail
 *   POST /api/jobs/:jobId/cancel              -> CancelJobResponse
 *   POST /api/jobs/:jobId/trash               -> TrashJobResponse   (409 while the job is still live)
 *   POST /api/jobs/:jobId/gate                -> JobDetail           (body: GateAnswerRequest; submits a resume job)
 *   GET  /api/stream                          -> SSE of ServerEvent{type:"jobs"}
 *   GET  /api/jobs/:jobId/stream              -> SSE of ServerEvent{type:"job"}
 * Static: everything else serves the webapp build (SPA fallback to index.html).
 */
export const API_BASE = "/api";
