/**
 * @brainstorm-agentic/protocol
 *
 * The single API contract between apps/server and apps/web. Both sides depend
 * on this package; neither may invent shapes outside it. Pure types +
 * constants — no runtime dependencies.
 */

// Shared pure logic both sides must agree on, not just shapes: the output
// change tracker's diff and its text projection (see each module's header).
export * from "./diff-inline.js";
export * from "./output-sections.js";

/* ------------------------------------------------------------------ stages */

/**
 * Pipeline stage ids. Most match node ids in the shipped brainstorm workflow;
 * `decompose-experts` is the dashboard's umbrella for the split decompose
 * pipeline (partition-files-* → build-pool → … → bridge-experts), kept as one
 * stage id so pre-split runs and the split topology share a dashboard.
 */
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
  | "validation"
  /**
   * One hand-off of a prompt to the model layer. Purely additive: no event
   * written before this kind existed carries it, so old runs keep rendering
   * exactly as they did. Every row of this kind names a captured prompt file
   * through `promptId` — a row without a file behind it is a bug.
   */
  | "llm_call";

/**
 * Token spend of one agent task (or a sum of tasks), as the provider
 * reported it. Mirrors the runtime's TokenUsage shape field-for-field —
 * protocol keeps zero dependencies by design, so the shape is restated here.
 */
export interface TokenUsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** The capability a logged tool call resolved through (drives the row icon). */
export type ActivityCapability =
  | "attachment-access"
  | "code-execution"
  | "web-search"
  | "taxonomy-access";

/**
 * The operational detail of one logged tool call: the file path read, the
 * query searched, the URL fetched, or the script/command the agent ran.
 * Tool inputs only, by contract — never prompts, chain-of-thought, or tool
 * outputs.
 */
export interface ActivityDetailView {
  readonly kind: "code" | "query" | "url" | "path" | "text";
  readonly value: string;
}

export interface StageActivityEntry {
  readonly id: string;
  readonly at: number;
  readonly kind: StageActivityKind;
  readonly message: string;
  readonly toolName?: string;
  readonly turn?: number;
  readonly elapsedMs?: number;
  /**
   * How the operation this row describes ENDED. An operation is a paired
   * span — a tool call, an agent task — whose start and finish the mapper
   * folds into the start's single row: the finish stamps this field (and the
   * elapsed time, and for agents the spend) onto the row a reader is already
   * looking at, instead of appending a second "finished" line. Absent while
   * the operation still runs, and on rows that are not operations at all
   * (model turns, retries, validation notes).
   */
  readonly outcome?: "finished" | "failed";
  /** Present on tool events whose tool maps to a semantic capability. */
  readonly capability?: ActivityCapability;
  /** Present when the executor attached the call's operational detail. */
  readonly detail?: ActivityDetailView;
  /** Present on task-completion rows: what the finished task spent. */
  readonly usage?: TokenUsageView;
  /**
   * Present on "llm_call" rows only: how the row addresses the captured
   * record of what we sent, at GET /api/jobs/:jobId/prompt/:promptId. The id
   * travels here rather than the prompt itself — prompts are never carried by
   * the event stream, which is sanitized and reaches every connected browser.
   */
  readonly promptId?: string;
  /**
   * WHAT this agent is, as the panel's own vocabulary names it: "Thinker",
   * "Commenter", "Judge", "Redeveloper". Absent only when the event carries no
   * task kind at all.
   */
  readonly role?: string;
  /**
   * WHO is doing it, when the actor is a seat: "Seat 2". Absent for an agent
   * that is not seated — the judge, the integrator, the chair, and every
   * pre-panel stage — where the role alone says who is working.
   *
   * For a comment this is NOT the seat under review: a round's commentors are
   * the panel minus the thinker, in seat order, so the index in the path has to
   * be projected back over the roster to name the author.
   */
  readonly actor?: string;
  /**
   * WHERE in the run it is happening: whose chain, which step of it, which
   * review round. Step and round are 1-based, as they are everywhere a reader
   * sees them. Absent outside the review and the first pass, where the stage
   * itself is the whole answer.
   */
  readonly where?: {
    readonly seat?: string;
    readonly step?: number;
    readonly round?: number;
  };
}

/**
 * One located failure inside a stage. Parallel stages (first pass, review)
 * can fail in several places while the rest keep working, so a stage carries
 * every failure of the current attempt — never just the newest one.
 */
export interface StageErrorView {
  readonly at?: number;
  readonly message: string;
  /**
   * The human-readable place: which seat, chain step, review round, and
   * call failed — e.g. "Seat 3 (Manifold Learning) · step 2 · round 1 ·
   * judge task". Absent when the failure has no finer location than the
   * stage itself.
   */
  readonly where?: string;
  /** The failing workflow node path, verbatim (for bug reports). */
  readonly path?: string;
}

export interface StageBase {
  readonly id: StageId;
  readonly status: StageStatus;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
  /**
   * Every failure of the stage's CURRENT attempt, oldest first (a resumed
   * attempt supersedes the previous list, like `error`). `error` stays the
   * newest message for compatibility.
   */
  readonly errors?: readonly StageErrorView[];
  /**
   * Sanitized operational events, oldest to newest (never chain-of-thought).
   * A WINDOW, not the whole log: the newest rows, plus a handful of older
   * rows whose operation just ended (their line gains its outcome in place).
   * The full history is served page by page at
   * GET /api/jobs/:jobId/stages/:stageId/activity.
   */
  readonly activity?: readonly StageActivityEntry[];
  /** How many activity rows the stage has IN TOTAL, beyond the window. */
  readonly activityTotal?: number;
  /**
   * The row id from which `activity` is GAP-FREE to the end. Rows before it
   * (late edits of old operations) may have unsent neighbours, so a reader
   * paging backwards anchors joins here, not at the array's first element.
   */
  readonly activityFloor?: string;
  /** Total token spend of the stage's agent tasks (all fan-out branches). */
  readonly usage?: TokenUsageView;
}

/**
 * One page of a stage's full activity history, oldest to newest. `entries`
 * are the `limit` rows immediately before the `before` row id (exclusive),
 * or the newest rows when `before` is absent; `total` is the whole history's
 * length, which is how a reader knows there is more above.
 */
export interface StageActivityPage {
  readonly entries: readonly StageActivityEntry[];
  readonly total: number;
}

/* --------------------------------------------------- per-stage artifact views */

/** One output the submitter explicitly asked the panel to deliver. */
export interface RequestedOutputView {
  readonly title: string;
  readonly ask: string;
}

export interface ProcessorOutputView {
  /**
   * The decided submission type. Absent while the run is between
   * preprocessing and classification (workflow >= 0.14.0 splits them); the
   * classification merge writes it in.
   */
  readonly type?: string;
  readonly title: string;
  readonly question: string;
  readonly context: string;
  readonly attachments: readonly { readonly name: string; readonly note: string }[];
  readonly assumptions: readonly string[];
  /** Chain-step count; absent between preprocessing and classification. */
  readonly cotSteps?: number;
  /** Requested deliverables; absent when the submission names none. */
  readonly requestedOutputs?: readonly RequestedOutputView[];
}

/** One candidate reading of the submission offered by the classifier. */
export interface ClassificationOptionView {
  readonly type: string;
  readonly reason: string;
}

/**
 * The classification stage's record on the Process-input card: the two
 * offered readings, the suggested asks, and how the confirmation gate was
 * (or will be) resolved.
 */
export interface ClassificationStageView {
  readonly primary: ClassificationOptionView;
  readonly alternative: ClassificationOptionView;
  /** The classifier's suggested asks (before any gate edit). */
  readonly requestedOutputs: readonly RequestedOutputView[];
  readonly gate: {
    readonly state: GateState;
    readonly decidedAt?: number;
    /** The type the run proceeded with, once decided. */
    readonly chosenType?: string;
  };
}

/** One attached file with the processor's relation label ("NA" = useless). */
export interface AnnotatedFileView {
  readonly path: string;
  readonly label: string;
  readonly note: string;
  /** The code annotator's one-line content summary; code files only. */
  readonly codeSummary?: string;
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
  /** Set when the submitter dismissed this seat mid-run. */
  readonly dismissed?: DismissedSeatView;
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
 * The nine structural output shapes (mirrors the content package's
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
  "solution",
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

export interface ObstacleCauseView {
  readonly cause: string;
  readonly rationale: string;
}

export interface PriorAttemptView {
  readonly attempt: string;
  readonly outcome: string;
}

export interface CandidateSolutionView {
  readonly approach: string;
  readonly mechanism: string;
  readonly expectedEffect: string;
  readonly risk: string;
}

/** solution — a diagnosis-and-fix for a concrete research obstacle. */
export interface SolutionOutputView {
  readonly problemFraming: string;
  readonly diagnosis: readonly ObstacleCauseView[];
  readonly priorAttempts: readonly PriorAttemptView[];
  readonly candidateSolutions: readonly CandidateSolutionView[];
  readonly recommendation: string;
  readonly validationPlan: readonly string[];
  readonly residualRisks: readonly string[];
}

/**
 * One chain step written as four parts. The parts carry NO meaning: they are a
 * size discipline, not a reasoning schema, so the same rule serves all nine
 * output shapes. Four is a hard maximum forever — a redevelopment rewrites the
 * existing four and can never add a fifth.
 */
export interface CotStepPartsView {
  readonly part1: string;
  readonly part2: string;
  readonly part3: string;
  readonly part4: string;
}

/** The part keys of a four-part step, in the order they are read and rendered. */
export const COT_STEP_PARTS = ["part1", "part2", "part3", "part4"] as const;
export type CotStepPart = (typeof COT_STEP_PARTS)[number];

/**
 * One chain step as a reader receives it: one string, or four parts.
 *
 * Every run started before the parts schemas existed recorded a step as a
 * single string, and a job pins its bundle for life — so both shapes keep
 * arriving at every later version of the reader, forever. The union is what
 * lets one dashboard render both.
 */
export type CotStepView = string | CotStepPartsView;

/**
 * Is this step the four-part shape? Branch on the RECORDED shape, never on the
 * app or bundle version: the version that wrote a run says nothing about the
 * shape of a step inside it, because a resumed run keeps writing in the shape
 * its pinned bundle chose.
 */
export function isCotStepParts(step: CotStepView): step is CotStepPartsView {
  return typeof step === "object" && step !== null;
}

/** A member's direct response to one explicitly requested output. */
export interface RequestedSectionView {
  readonly title: string;
  /** The response paragraphs, joined with blank lines for display. */
  readonly response: string;
}

/**
 * One member's finished first-pass output. `type` is the submission's catalog
 * label (free-form — the catalog is bundle data); `shape` is the closed
 * structural id, and exactly the matching body field is present. `novelty`
 * exists only for shapes positioned against a literature map (paper,
 * resolution, survey). `requested` exists only when the submission
 * explicitly asked for deliverables — one response section per ask.
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
  readonly solution?: SolutionOutputView;
  readonly requested?: readonly RequestedSectionView[];
  /** The chain, one entry per step, in either recorded step shape. */
  readonly cot: readonly CotStepView[];
  readonly novelty?: string;
  readonly literature?: readonly PaperView[];
}

export type Verdict = "Pass" | "Build" | "Interrupt";

export type EvidenceView =
  | { readonly kind: "script"; readonly code: string; readonly result?: string }
  | { readonly kind: "math"; readonly derivation: string }
  | { readonly kind: "reference"; readonly citation: string; readonly locator: string; readonly shows: string };

/**
 * One step's flaws, keyed by the part of that step each flaw sits in. Shared by
 * a commentor and by the judge, because both review the same four parts.
 *
 * The reviewer fills in a draft with every part key present and empty; the
 * orchestrator strips the empties before the record is written. So an ABSENT
 * part key means the reviewer said nothing about that part — never that it said
 * something empty — and a reviewer that found nothing carries an empty list
 * rather than no list at all.
 *
 * `part<N>` is a LOCATOR, not a citation: the parts carry no meaning and a
 * rewrite can move their boundaries, so each flaw sentence stands alone.
 */
export interface FlawEntryView {
  /** The 1-based chain step these flaws sit in. */
  readonly step: number;
  readonly part1?: string;
  readonly part2?: string;
  readonly part3?: string;
  readonly part4?: string;
}

export interface CommentView {
  readonly commentorId: string;
  readonly commentorLabel: string;
  readonly verdict: Verdict;
  /** The 1-based chain step the verdict targets (current or earlier). */
  readonly step?: number;
  readonly reason: string;
  readonly suggestion?: string;
  readonly evidence?: EvidenceView;
  /**
   * The flaws of a part-aware review, one entry per step the commentor had
   * something to say about. Absent on a run whose review recorded the scalar
   * `step` instead — read the two together, never one as a fallback for the
   * other, because a part-aware comment carries no top-level step.
   */
  readonly flaws?: readonly FlawEntryView[];
  /** What this commentor's task spent producing the comment. */
  readonly usage?: TokenUsageView;
}

/** One confirmed problem in the judge's repair signal, pinned to a step. */
export interface JudgeIssueView {
  readonly step: number;
  /**
   * Which part of that step the issue sits in. Absent on runs recorded before
   * the chain had parts. A locator only — see FlawEntryView.
   */
  readonly part?: CotStepPart;
  readonly point: string;
  readonly basis: "verified" | "authority";
  readonly mustAddress: boolean;
  readonly suggestion?: string;
  readonly evidence?: EvidenceView;
}

export interface JudgeDecisionView {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly suggestion?: string;
  readonly evidence?: EvidenceView;
  /** The distinct confirmed problems of the round; empty on Pass. */
  readonly issues?: readonly JudgeIssueView[];
  /**
   * The judge's own per-part flaws, on the same terms as a commentor's. Absent
   * on a run recorded before the chain had parts; empty when the judge upheld
   * nothing. `issues` stays the repair signal the redeveloper works from.
   */
  readonly flaws?: readonly FlawEntryView[];
  /** commentor id -> verified | authority */
  readonly assessment: Readonly<Record<string, "verified" | "authority">>;
}

export interface ReviewRoundView {
  /** 1-based round on the current step. Round 1 is the initial review. */
  readonly round: number;
  /** The chain-of-thought step exactly as it stood under this round's review. */
  readonly cot?: CotStepView;
  readonly comments: readonly CommentView[];
  readonly decision?: JudgeDecisionView;
  /** Present when this round ended in a redevelopment: the runtime-computed change-set. */
  readonly revision?: {
    readonly touchedSteps: readonly number[];
    /**
     * The NEW step, in touchedSteps order, in the shape the run records steps:
     * a rewrite replaces a whole step, so a part-aware run carries all four
     * parts here even when only one of them changed.
     */
    readonly rewritten?: readonly {
      readonly index: number;
      readonly text: CotStepView;
      /**
       * Opaque handle to the recorded thinking behind THIS rewrite of THIS
       * step, fetched on demand at GET /api/jobs/:jobId/thoughts?ref=… — a
       * handle rather than the text, because thoughts are large and ride
       * every SSE snapshot otherwise. Absent when the task recorded none
       * (providers may withhold the channel; runs predate the capture).
       */
      readonly thoughts?: string;
    }[];
  };
}

export type ReviewStepOutcome = "pending" | "under-review" | "passed" | "force-passed";

export interface ReviewStepView {
  /** 1-based chain-of-thought step index. */
  readonly index: number;
  readonly outcome: ReviewStepOutcome;
  /** While this step is under review, what the seat is doing on it. */
  readonly phase?: ReviewPhase;
  readonly rounds: readonly ReviewRoundView[];
  /**
   * Opaque handle to the recorded thinking behind the step's ORIGINAL
   * (first-pass) text — the same words the live thread streamed while the
   * seat worked — fetched on demand at GET /api/jobs/:jobId/thoughts?ref=….
   * Absent when nothing was recorded. Later versions carry their own handle
   * on the rewrite that produced them (see revision.rewritten).
   */
  readonly thoughts?: string;
}

export interface ReviewMemberView {
  readonly memberId: string;
  /** Seat name in pick order ("Seat 1"); umbrella terms may repeat across seats. */
  readonly label: string;
  readonly department?: string;
  readonly umbrella?: string;
  readonly steps: readonly ReviewStepView[];
  /**
   * The member's output as the review left it: the first pass with every
   * redevelopment applied. Once every step has passed (or force-passed) this
   * IS the member's final version — the record the integrator, the chair,
   * and the session's `final/` copies work from; while the walk is still
   * running it is the current version under review.
   */
  readonly finalIdea?: BrainIdeaView;
  /** How many redevelopments the review applied to this member's chain. */
  readonly revisionCount?: number;
  /** Present while this seat is actively under review. */
  readonly progress?: ReviewSeatProgress;
  /**
   * Present when this seat's walk FAILED and has not been restarted: the
   * failure message. The other seats keep reviewing in parallel; a resume
   * re-executes exactly this seat's failed task — UNLESS the seat has since been
   * dismissed, in which case the resume skips it and this is the record of where
   * it stopped, not of something waiting to be retried. Read it beside
   * `dismissed`; a reader that trusts this field alone will describe a seat that
   * has left as pending work.
   */
  readonly error?: string;
  /**
   * The submitter dismissed this seat mid-run. Everything it had produced by
   * then is still here — the dismissal ends its future, not its record.
   */
  readonly dismissed?: DismissedSeatView;
}

/**
 * A seat the submitter dismissed while the run was in flight. From the
 * dismissal on, the seat develops nothing further, comments on nobody, and is
 * withheld from the integrator and the chair.
 */
export interface DismissedSeatView {
  readonly at: number;
}

/**
 * What a seat is doing at its current walk position. Mirrors REVIEW_PHASES in
 * the content package (protocol keeps zero dependencies by design); the runtime
 * — never the model — stamps it.
 */
export type ReviewPhase = "commenting" | "judging" | "redeveloping";

/**
 * One seat's live position in its OWN walk. Per-seat rather than one global
 * cursor, because seats may be reviewed concurrently — and because a per-seat
 * shape is what lets a view render each seat's status independently.
 */
/**
 * Compact review progress for list views. Stays correct when several seats are
 * reviewed at once: the single-seat position is filled in only when exactly one
 * seat is active, so a one-line status never invents a global cursor.
 */
export interface ReviewProgressSummary {
  /** Seats whose walk is finished, and the roster size. */
  readonly membersComplete: number;
  readonly memberCount: number;
  /** How many seats are under review right now. */
  readonly activeSeats: number;
  readonly maxRounds: number;
  /** The active seat's position — present only when exactly one seat is active. */
  readonly step?: number;
  readonly stepCount?: number;
  readonly round?: number;
}

export interface ReviewSeatProgress {
  /** 1-based chain step under review, and the chain length. */
  readonly step: number;
  readonly stepCount: number;
  /** 1-based review round on that step. */
  readonly round: number;
  /** What the seat is doing right now, while the round is in flight. */
  readonly phase?: ReviewPhase;
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
  /**
   * The classification record (workflow >= 0.14.0): the classifier's two
   * offered readings plus the confirmation gate's state. Absent on runs from
   * bundles whose processor still classifies inline.
   */
  readonly classification?: ClassificationStageView;
}

/** One sub-step of the split decompose pipeline, in execution order. */
export type DecomposeStepId =
  | "build-pool"
  | "match-taxonomy"
  | "place-fields"
  | "submit-decisions"
  | "bridge-experts";

export interface DecomposeStepView {
  readonly id: DecomposeStepId;
  readonly label: string;
  readonly status: "pending" | "active" | "completed";
  /** One line of live progress, e.g. "41 members from 10 papers". */
  readonly detail?: string;
}

export interface DecomposeStage extends StageBase {
  readonly id: "decompose-experts";
  readonly experts?: ExpertsTreeView;
  readonly counts?: { readonly departments: number; readonly umbrellas: number; readonly subfields: number };
  /** Papers/authors/research-interests the literature search surfaced. */
  readonly grounding?: GroundingView;
  /**
   * The split pipeline's sub-steps (pool -> match -> place -> suggest ->
   * bridge) with live status; absent on jobs from single-decomposer bundles.
   */
  readonly steps?: readonly DecomposeStepView[];
}

export interface SelectPanelStage extends StageBase {
  readonly id: "select-panel";
  readonly panel?: readonly PanelMemberView[];
  /** Umbrella leaves available in the experts tree before trimming. */
  readonly leavesAvailable?: number;
}

export type GateState =
  | "not-reached"
  | "pending"
  | "approved"
  | "shrunk"
  | "revised"
  | "auto-approved";

export interface ConfirmPanelStage extends StageBase {
  readonly id: "confirm-panel";
  readonly gate: {
    readonly state: GateState;
    readonly removedMemberIds?: readonly string[];
    /** Ids of the custom seats the user added at confirmation. */
    readonly addedMemberIds?: readonly string[];
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
  /** What this member's first-pass task(s) spent. */
  readonly usage?: TokenUsageView;
  /**
   * Handle for the thinking recorded while this seat wrote its FIRST
   * version — the whole develop task's trace, not one step's slice.
   * Preview at GET /api/jobs/:jobId/thoughts, full download at
   * GET /api/jobs/:jobId/thoughts.txt, both `?ref=` this value. Absent when
   * the run captured no thinking (offline runs, models without a reasoning
   * channel).
   */
  readonly thoughts?: string;
  /** Set when the submitter dismissed this seat mid-run. */
  readonly dismissed?: DismissedSeatView;
}

export interface FirstPassStage extends StageBase {
  readonly id: "first-pass";
  readonly members: readonly FirstPassMemberView[];
}

export interface ReviewStage extends StageBase {
  readonly id: "review-members";
  /**
   * The run's review round budget, read from the workflow param the run pinned
   * — never assumed by the client, so a run started under a different budget
   * still renders correctly.
   */
  readonly maxRounds: number;
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
  | "orphaned"
  /**
   * Stopped by the submitter, and waiting for them. Its worker is gone and its
   * checkpoint stands: nothing auto-resumes it — not the interrupted-job
   * poller, not the credit scheduler — until the submitter says so. That is the
   * whole difference from `orphaned`, which looks identical on disk and is
   * resumed automatically.
   */
  | "paused";

/**
 * Is this run executing right now?
 *
 * The one question behind every "something is happening" claim the UI makes —
 * a pulsing dot, a blinking cell, a ticking clock, a streamed thought. It has
 * to be asked of the RUN, because nothing else in a snapshot answers it: a
 * paused run's stages still read "active" and its steps still read "under
 * review", which is correct — that is where it resumes — and a stopped run's
 * do too. Only the status changes.
 *
 * Stated here rather than in the app so the server and the page cannot drift:
 * the server stops streaming live text on the same answer the page stops
 * animating on.
 */
export function jobIsExecuting(status: JobStatus): boolean {
  switch (status) {
    case "running":
      return true;
    // Queued is not executing: the scheduler holds the job and no worker
    // exists yet. Suspended and credit-blocked are waits, paused is the
    // submitter's own, orphaned is a worker that died, and the last three are
    // over.
    case "queued":
    case "paused":
    case "suspended":
    case "credit-blocked":
    case "orphaned":
    case "completed":
    case "failed":
    case "cancelled":
      return false;
  }
}

export type RunnerKind = "slurm" | "local";

export interface JobSummary {
  readonly jobId: string;
  readonly topic: string;
  /**
   * The run's NAME once it has one: the processor's title for the
   * submission, present only after the process stage completed. Until then
   * the run goes by its `topic` (the submitted text) — readers should show
   * `title ?? topic`. The topic itself never changes; it stays the record
   * of what was submitted.
   */
  readonly title?: string;
  /**
   * The submission's ORIGINAL attachment paths/URLs, exactly as submitted —
   * what the redo control replays into a fresh composer. Absent when the
   * run was submitted without attachments.
   */
  readonly attachments?: readonly string[];
  readonly status: JobStatus;
  readonly runner: RunnerKind;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly slurmJobId?: string;
  /**
   * The immutable content bundle this job pinned at launch (from its
   * content-pin.json) — the exact skill/workflow version the run used.
   */
  readonly contentBundle?: {
    readonly id: string;
    readonly version: string;
  };
  /** Present once the job has been moved to the view-only trash. */
  readonly trashedAt?: number;
  /** Compact progress for the landing-page job card. */
  readonly progress?: {
    readonly activeStage?: StageId;
    readonly completedStages: number;
    readonly totalStages: number;
    readonly review?: ReviewProgressSummary;
  };
  readonly error?: string;
  readonly creditBlock?: {
    /**
     * Epoch ms of the automatic resume; absent when the provider message
     * named no reset time (e.g. a top-up is needed) and the job waits for a
     * manual resume instead.
     */
    readonly retryAt?: number;
    readonly providerMessage: string;
    readonly source: "deterministic" | "openrouter" | "manual";
  };
}

export interface PendingGateView {
  readonly gateKey: string;
  readonly title?: string;
  readonly prompt?: string;
  /** Panel shown for the confirm-panel gate. */
  readonly members?: readonly PanelMemberView[];
  /** Choices shown for the confirm-classification gate. */
  readonly classification?: {
    readonly primary: ClassificationOptionView;
    readonly alternative: ClassificationOptionView;
    /** The classifier's suggested asks, editable at the gate. */
    readonly requestedOutputs: readonly RequestedOutputView[];
    /** Every type of the run's catalog, in disambiguation order. */
    readonly typeOptions: readonly string[];
  };
  /**
   * The server-side countdown to automatic approval: an unattended gate
   * approves itself as seated when `deadlineAt` passes. Any click inside the
   * confirmation card (or its pause control) holds it permanently via
   * POST /api/jobs/:id/gate-hold — `held` then flips true and the deadline
   * stops mattering.
   */
  readonly autoApprove?: {
    readonly deadlineAt: number;
    readonly totalMs: number;
    readonly held: boolean;
  };
}

export interface JobDetail extends JobSummary {
  readonly stages: readonly StageView[];
  readonly pendingGate?: PendingGateView;
  /**
   * Seats the submitter dismissed mid-run, in dismissal order. The run carries
   * the list forward through every later resume, so a dismissal is permanent.
   */
  readonly dismissedMembers?: readonly DismissedMemberView[];
}

/** One dismissal, as the dashboard renders it. */
export interface DismissedMemberView {
  readonly memberId: string;
  readonly label?: string;
  readonly at: number;
}

/** Body of POST /api/jobs/:id/dismiss-member. */
export interface DismissMemberRequest {
  readonly memberId: string;
}

/* ------------------------------------------------------------------ settings */

/** The tag the user's SLURM template must contain; replaced by the orchestration command. */
export const SLURM_COMMAND_TAG = "{{BRAIN_COMMAND}}";

/** The tag the user's GPU template must contain; replaced by the agent's script. */
export const GPU_COMMAND_TAG = "{{AGENT_COMMAND}}";

/** Starter shown (never stored) while the GPU template is still empty. */
export const GPU_TEMPLATE_EXAMPLE = `#!/usr/bin/env bash
#SBATCH --job-name=brain-gpu
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G

set -euo pipefail
# module load cuda  (site-specific setup goes here)
${GPU_COMMAND_TAG}
`;

/**
 * GPU run settings: the deployment-owner's submission template plus the
 * wall-clock ceiling one agent job may request. An EMPTY template means GPU
 * runs are not set up — the gpu_run host tool stays non-executable and the
 * gpu-execution capability resolves unavailable.
 */
export interface GpuRunSettings {
  /** SLURM submission template containing GPU_COMMAND_TAG, or "" (off). */
  readonly template: string;
  /** Ceiling in minutes for one job's runtime; agent requests are capped. */
  readonly timeLimitMinutes: number;
}

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

/**
 * The host-owned web layer's deployment settings. Web search and web fetch
 * run through the app's OWN unified pipeline on every backend — no model
 * provider's built-in search is ever offered — so this section is what
 * decides which upstream search providers the pipeline uses:
 *
 * - `provider` selects the ONE general/news search provider: Tavily, Brave,
 *   a self-hosted SearXNG you point at ("searxng"), or a SearXNG instance
 *   the app itself launches and supervises on this deployment's own machine
 *   ("searxng-local" — keyless, no query ever passes a third-party search
 *   API). "none" leaves general search unconfigured and general queries get
 *   an explicit configuration error.
 * - `scholarly` (default on) enables the keyless scholarly chain — OpenAlex,
 *   Crossref, arXiv, Semantic Scholar — which is what paper/citation
 *   searches route to. Keys for these only raise rate limits.
 * - `cacheEnabled` turns on the cross-run keyword cache (per-workspace,
 *   TTL-bounded); every cache hit is still logged in the run's search log.
 *
 * Provider API keys are write-only exactly like the LLM credentials; the
 * server returns only the `…Configured` flags.
 */
export interface WebSearchSettings {
  readonly provider: "none" | "tavily" | "brave" | "searxng" | "searxng-local";
  /** Base URL of the self-hosted SearXNG instance (provider = "searxng"). */
  readonly searxngBaseUrl?: string;
  /** The keyless scholarly chain (OpenAlex/Crossref/arXiv/Semantic Scholar). */
  readonly scholarly: boolean;
  /** Cross-run keyword cache. */
  readonly cacheEnabled: boolean;
  /** Cache TTL in hours (default 24). */
  readonly cacheTtlHours?: number;
  /** Polite-pool contact for OpenAlex/Crossref (recommended, not secret). */
  readonly contactEmail?: string;
  /** Public status only; the keys themselves are never returned. */
  readonly tavilyKeyConfigured?: boolean;
  readonly braveKeyConfigured?: boolean;
  readonly semanticScholarKeyConfigured?: boolean;
  readonly openAlexKeyConfigured?: boolean;
}

export interface LlmSettings {
  /**
   * "anthropic": developer Messages API + API key.
   * "claude-agent": Claude Agent SDK + token from `claude setup-token`.
   * "cursor-agent": Cursor SDK + API key from cursor.com/dashboard.
   * "offline": deterministic executor (no network, for testing).
   */
  readonly provider: "anthropic" | "claude-agent" | "cursor-agent" | "offline";
  /** Required for developer API; optional agent-SDK alias/full model id. */
  readonly model?: string;
  /** Optional developer-API endpoint override (not used by the agent SDKs). */
  readonly baseUrl?: string;
  readonly modelsByRoute?: Readonly<Record<string, string>>;
  /**
   * Agent SDK execution controls, shared VERBATIM by the claude-agent and
   * cursor-agent backends: both read the same maxTurns / effort / thinking /
   * budget / fallback settings, so switching SDKs never changes the knobs —
   * only the transport. Ignored by the other providers.
   */
  readonly agentSdk?: ClaudeAgentSettings;
  /** Public status only. The API key itself is never returned by the server. */
  readonly apiKeyConfigured?: boolean;
  /** Public status only. The setup token itself is never returned by the server. */
  readonly setupTokenConfigured?: boolean;
  /** Public status only. The Cursor API key itself is never returned by the server. */
  readonly cursorApiKeyConfigured?: boolean;
}

export interface ServerSettings {
  readonly slurmTemplate: string;
  /** GPU run setup; absent or an empty template keeps GPU runs off. */
  readonly gpu?: GpuRunSettings;
  readonly runner: RunnerKind;
  readonly llm: LlmSettings;
  /** "manual": jobs pause at the panel gate for dashboard confirmation. */
  readonly panelConfirmation: "manual" | "auto";
  /**
   * Whether an unanswered gate is approved for the submitter after a
   * countdown. `true` (default) keeps an unattended run moving: the server
   * counts down and then approves what the pipeline proposed. `false` means
   * every gate waits for a human, however long that takes.
   *
   * Read LIVE by the server's poller, never snapshotted per job: switching it
   * off stops the countdown for every run in flight, including a run that has
   * already passed one gate and has not yet reached the next.
   */
  readonly gateAutoApprove?: boolean;
  /**
   * Review-round budget for NEW runs: one chain step may take at most
   * `maxRounds` rounds (the first review plus revisions). Absent = the
   * pinned bundle's own default. The value is snapshotted into each job's
   * execution settings at submit time, so a resume replays the run's own
   * budget; the pinned bundle's declared bounds stay authoritative when
   * the run starts.
   */
  readonly review?: {
    readonly maxRounds?: number;
  };
  /**
   * Panel composition for NEW runs, snapshotted at submit time exactly like
   * `review`. `size` is the seat count the deterministic selection may
   * produce (absent = the pinned bundle's own default); the bundle's declared
   * bounds stay authoritative when the run starts. `interdisciplinarySeat`
   * turns the deterministically woven between-fields seat on or off
   * (absent = on); a run that already journaled its panel keeps it either
   * way, because the weave replays from the journal.
   */
  readonly panel?: {
    readonly size?: number;
    readonly interdisciplinarySeat?: boolean;
  };
  /**
   * DEPLOYMENT-OWNED, read-only for users. The registry endpoint is baked
   * into the app (DEFAULT_CONTENT_REGISTRY_URL in the server's settings
   * module; developers override with --content-registry-url or
   * BRAIN_CONTENT_REGISTRY_URL at launch). PUT /api/settings ignores this
   * field entirely; it is returned so the UI can display what is in effect.
   * `version` is absent in normal operation — every new run resolves the
   * latest published bundle automatically; a developer may pin one by
   * editing settings.json on the server.
   */
  readonly contentRegistry: {
    readonly url: string;
    readonly bundle: string;
    /** Developer pin; omit (normal) to resolve latest once per new run. */
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
   * Anonymous usage reporting. One compact record per finished run — timings,
   * counts and version stamps, never submission text — plus a heartbeat while a
   * run is in flight. Opt-out: switching it off produces no record at all,
   * rather than one written and then withheld.
   *
   * Diagnostics are NOT covered by this setting. A diagnostic bundle carries a
   * run's own logs and can include the submitter's material, so it is only ever
   * sent by an explicit per-report action after a preview.
   */
  readonly telemetry?: {
    readonly enabled: boolean;
    /** Where records are sent. Empty disables sending regardless of `enabled`. */
    readonly ingestUrl: string;
  };
  /**
   * Recovery of interrupted jobs (SLURM timeouts, node failures, power
   * cuts): the scheduler resubmits an orphaned job from its last checkpoint.
   * Defaults to enabled; auto-resume pauses after repeated attempts without
   * checkpoint progress and waits for a manual resume instead.
   */
  readonly interruptedRecovery?: {
    readonly autoResume: boolean;
  };
  /**
   * Host tools the user has explicitly enabled/disabled.
   * Tool IDs not listed here use their manifest default.
   */
  readonly hostTools?: {
    readonly enabledToolIds: readonly string[];
  };
  /** The host-owned web layer's provider configuration. */
  readonly webSearch?: WebSearchSettings;
  /**
   * Per-run capability overrides, snapshotted into the job's execution
   * settings at submit time. Keys are capability ids from the content
   * bundle's catalog (e.g. "web-search"); `false` disables the capability
   * for the run — both its host tools and any provider-native equivalent —
   * and the agent is told the user switched it off. Absent keys (and `true`)
   * keep the deployment default. Never set on the global settings document;
   * it exists here so the submit-time snapshot carries it through resumes.
   */
  readonly capabilityOverrides?: Readonly<Record<string, boolean>>;
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
  // Cursor serves many vendors' models under one API key; ids here mirror
  // the Anthropic ids where both providers offer the same model, so a
  // per-task-type selection stays comparable when the SDK is switched.
  "cursor-agent": [
    { id: "auto", label: "Auto (server picks)" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
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
 * Settings accepted by PUT /api/settings. `llm.apiKey`, `llm.setupToken`,
 * and `llm.cursorApiKey` are write-only:
 * - omitted/blank: retain the corresponding configured secret;
 * - non-empty: verify through the selected backend, then replace that secret;
 * - clear flags: remove the corresponding secret when its provider is not selected.
 *
 * The response is always ServerSettings and therefore never contains the key.
 */
/**
 * A settings update is a PATCH: every section is optional and an absent
 * section keeps whatever is stored. That is what lets each panel of the
 * settings drawer save on its own — one section's edit never re-submits (and
 * so never re-verifies) another's. A full object remains valid, so callers
 * that send everything keep working unchanged.
 *
 * The one place absence means something else is documented per field below
 * (`review: {}` clears the override, while absent keeps it).
 */
export interface ServerSettingsUpdate {
  readonly slurmTemplate?: string;
  /** Absent = keep the current GPU run setup. */
  readonly gpu?: GpuRunSettings;
  readonly runner?: RunnerKind;
  readonly panelConfirmation?: "manual" | "auto";
  /** Absent = keep the stored gate countdown policy. */
  readonly gateAutoApprove?: boolean;
  /**
   * Absent = keep the stored review policy. `{}` = follow the bundle's
   * default again. `{ maxRounds: n }` = override the budget for new runs.
   */
  readonly review?: {
    readonly maxRounds?: number;
  };
  /**
   * Absent = keep the stored panel policy. `{}` = bundle default size with
   * the interdisciplinary seat on.
   */
  readonly panel?: {
    readonly size?: number;
    readonly interdisciplinarySeat?: boolean;
  };
  /** Anonymous usage reporting; omitted leaves the stored value unchanged. */
  readonly telemetry?: {
    readonly enabled: boolean;
    readonly ingestUrl?: string;
  };
  /**
   * Deployment-owned: accepted for wire compatibility but IGNORED by the
   * server — the registry endpoint is not a user setting.
   */
  readonly contentRegistry?: {
    readonly url: string;
    readonly bundle: string;
    readonly version?: string;
    readonly updatePolicy?: "auto" | "notify";
  };
  readonly updateCheck?: "off" | "notify";
  /** Absent = keep the stored credit-recovery policy. */
  readonly creditRecovery?: {
    readonly autoResume: boolean;
    readonly safetyBufferSeconds: number;
    readonly openRouterModel: string;
    readonly openRouterApiKey?: string;
    readonly clearOpenRouterApiKey?: boolean;
  };
  /** Absent = keep the current interrupted-recovery policy. */
  readonly interruptedRecovery?: {
    readonly autoResume: boolean;
  };
  /**
   * Absent = keep the stored model connection untouched, which also means NO
   * provider verification runs. Present and materially changed (provider,
   * model, base URL, or a newly submitted secret) = the server verifies the
   * connection for real before it persists anything.
   */
  readonly llm?: {
    readonly provider: "anthropic" | "claude-agent" | "cursor-agent" | "offline";
    readonly model?: string;
    readonly baseUrl?: string;
    readonly modelsByRoute?: Readonly<Record<string, string>>;
    readonly agentSdk?: ClaudeAgentSettings;
    readonly apiKey?: string;
    readonly clearApiKey?: boolean;
    readonly setupToken?: string;
    readonly clearSetupToken?: boolean;
    readonly cursorApiKey?: string;
    readonly clearCursorApiKey?: boolean;
  };
  /** Host tools the user wants enabled. Absent = keep current. */
  readonly hostTools?: {
    readonly enabledToolIds: readonly string[];
  };
  /**
   * Absent = keep the stored web-search configuration untouched. Present =
   * replace it. Provider API keys are write-only, exactly like the LLM
   * credentials: a submitted key is verified with a real one-result search
   * through the selected provider before it is stored, an omitted/blank one
   * keeps the configured secret, and a clear flag removes it.
   */
  readonly webSearch?: {
    readonly provider: "none" | "tavily" | "brave" | "searxng" | "searxng-local";
    readonly searxngBaseUrl?: string;
    readonly scholarly?: boolean;
    readonly cacheEnabled?: boolean;
    readonly cacheTtlHours?: number;
    readonly contactEmail?: string;
    readonly tavilyApiKey?: string;
    readonly clearTavilyApiKey?: boolean;
    readonly braveApiKey?: string;
    readonly clearBraveApiKey?: boolean;
    readonly semanticScholarApiKey?: string;
    readonly clearSemanticScholarApiKey?: boolean;
    readonly openAlexApiKey?: string;
    readonly clearOpenAlexApiKey?: boolean;
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
  /**
   * Per-run capability toggles. Keys are capability ids from the content
   * bundle's catalog (see GET /api/capabilities); `false` disables the
   * capability for this run — its host tools AND any provider-native
   * equivalent (e.g. Anthropic's built-in web search) — and the agents are
   * told the user switched it off. Absent keys and `true` keep the
   * deployment default. The map is snapshotted into the job's execution
   * settings, so every resume replays the same policy.
   */
  readonly capabilityOverrides?: Readonly<Record<string, boolean>>;
}

/** One toggleable capability, as reported by GET /api/capabilities. */
export interface CapabilityOption {
  /** Catalog id, e.g. "web-search". */
  readonly id: string;
  /** Catalog description (what the agents can do with it). */
  readonly description: string;
  /** Operation ids behind the capability, e.g. ["web.search", "web.fetch"]. */
  readonly operations: readonly string[];
  /**
   * Non-overridable: runtime infrastructure the workflow hard-requires
   * (e.g. taxonomy-access). The UI renders these locked-on; submitted
   * overrides for them are ignored.
   */
  readonly locked: boolean;
}

export interface CapabilityOptionsResponse {
  /** Catalog version the options were read from. */
  readonly version: string;
  readonly capabilities: readonly CapabilityOption[];
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
  /**
   * Present (true) when the listing stopped early — the directory holds more
   * entries than the cap, or the storage did not answer within the request's
   * time budget. Partial listings are served rather than hanging the request:
   * every explorer call is time-budgeted so a slow shared filesystem can never
   * freeze the server (see the search response's `truncated` for the same rule).
   */
  readonly truncated?: boolean;
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

/**
 * A user-defined panel seat added at confirmation: the department, the field
 * (rendered as the member's umbrella term), and 1-3 research focuses.
 */
export interface CustomSeatRequest {
  readonly department: string;
  /** The seat's field — carried as the panel member's umbrella term. */
  readonly umbrella: string;
  /** Research focuses; at least 1, at most 3. */
  readonly subfields: readonly string[];
}

/** Ceilings for gate-time panel edits (mirrors the panel/experts bounds). */
export const PANEL_EDIT_LIMITS = {
  minMembers: 2,
  maxMembers: 12,
  minSubfields: 1,
  maxSubfields: 3,
} as const;

/**
 * Bounds for gate-time classification edits (mirrors the artifact schema:
 * at most 4 requested outputs, title >= 4 chars, ask >= 12 chars).
 */
export const CLASSIFICATION_EDIT_LIMITS = {
  maxRequestedOutputs: 4,
  minTitleChars: 4,
  minAskChars: 12,
} as const;

export interface GateAnswerRequest {
  readonly gateKey: string;
  /**
   * "approve"/"shrink" answer the panel gate; "revise" answers the
   * classification gate with a different type and/or edited asks.
   */
  readonly action: "approve" | "shrink" | "revise";
  /** For shrink: member ids to KEEP, in their existing order. */
  readonly members?: readonly string[];
  /**
   * Custom seats to ADD alongside the kept ones (valid with either panel
   * action). The confirmed panel — kept + added — must stay within
   * PANEL_EDIT_LIMITS.
   */
  readonly addedMembers?: readonly CustomSeatRequest[];
  /** For revise: the catalog type to proceed with (omit to keep the primary). */
  readonly type?: string;
  /**
   * For revise: the FULL replacement requested-output list (omit to keep the
   * classifier's list; empty array clears it). Within
   * CLASSIFICATION_EDIT_LIMITS.
   */
  readonly requestedOutputs?: readonly RequestedOutputView[];
}

/**
 * The panel gate's decision, derived from what the user has checked and added.
 *
 * Pure, and deliberately here rather than inside the gate card: it is the rule
 * that decides whether a run proceeds with the panel the classifier proposed or
 * a different one, and it was previously only expressible by rendering a React
 * component. The card renders this; it does not decide it.
 */
export function panelGateDecision(input: {
  /** The seats the classifier proposed, in order. */
  readonly proposed: readonly { readonly id: string }[];
  /** Ids the user still has checked. */
  readonly checked: ReadonlySet<string>;
  readonly added: readonly CustomSeatRequest[];
}): {
  readonly kept: readonly string[];
  readonly total: number;
  /** True when the user unchecked at least one proposed seat. */
  readonly shrinking: boolean;
  /** True when the panel is below the minimum. */
  readonly tooFew: boolean;
  /** True when no further seat may be ADDED (drives the add affordance only). */
  readonly full: boolean;
  /**
   * Whether the gate can be answered at all. Every rule the server enforces on
   * a gate answer is mirrored here, so the card cannot offer a button whose
   * request the server will reject. The two disagreeing is what produced a live
   * "Continue" that answered with a 400.
   */
  readonly submittable: boolean;
  /** Why not, when `submittable` is false. Shown to the user verbatim. */
  readonly blockedReason?: string;
  readonly label: string;
} {
  const kept = input.proposed.filter((seat) => input.checked.has(seat.id)).map((seat) => seat.id);
  const total = kept.length + input.added.length;
  // The checkboxes ARE the decision: unchecking a seat turns the single submit
  // action into a shrink. An always-enabled "approve" used to silently discard
  // the selection — seats stayed unchecked on screen but the full panel ran.
  const shrinking = input.proposed.length > 0 && kept.length < input.proposed.length;
  const tooFew = total < PANEL_EDIT_LIMITS.minMembers;
  // A shrink names the seats to KEEP, so it cannot name none — the server
  // rejects an empty keep-list outright. Unchecking every proposed seat and
  // adding custom ones is therefore not an answer the server accepts, even
  // though the resulting panel would be a legal size. That combination is
  // exactly what used to leave "Continue" enabled and then fail with a 400.
  const keptNone = shrinking && kept.length === 0;
  const blockedReason = tooFew
    ? `A panel needs at least ${PANEL_EDIT_LIMITS.minMembers} seats — re-check members or add custom ones.`
    : total > PANEL_EDIT_LIMITS.maxMembers
      ? `A panel may seat at most ${PANEL_EDIT_LIMITS.maxMembers} members — uncheck a seat or remove a custom one.`
      : keptNone
        ? "Keep at least one of the proposed seats — a panel cannot be replaced wholesale from here."
        : undefined;
  return {
    kept,
    total,
    shrinking,
    tooFew,
    full: total >= PANEL_EDIT_LIMITS.maxMembers,
    submittable: blockedReason === undefined,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
    label:
      (shrinking
        ? `Continue with ${kept.length} of ${input.proposed.length} seats`
        : "Approve panel") +
      (input.added.length > 0 ? ` + ${input.added.length} custom` : ""),
  };
}

/** The request that answers the panel gate for a given decision. */
export function panelGateRequest(
  gateKey: string,
  decision: { readonly kept: readonly string[]; readonly shrinking: boolean },
  added: readonly CustomSeatRequest[],
): GateAnswerRequest {
  return {
    gateKey,
    ...(decision.shrinking
      ? { action: "shrink" as const, members: decision.kept }
      : { action: "approve" as const }),
    ...(added.length > 0 ? { addedMembers: added } : {}),
  };
}

export interface CancelJobResponse {
  readonly jobId: string;
  readonly status: JobStatus;
}

/** Response of POST /api/jobs/:jobId/resume (credit-blocked jobs only). */
export interface ResumeJobResponse {
  readonly jobId: string;
  readonly status: JobStatus;
}

/**
 * Response of POST /api/jobs/:jobId/resume-interrupted: resubmits an
 * orphaned (interrupted) job so it continues from its last checkpoint.
 */
export interface ResumeInterruptedJobResponse {
  readonly jobId: string;
  readonly status: JobStatus;
}

/** One part of a diagnostic report, as the preview describes it. */
export interface DiagnosticComponent {
  readonly id: string;
  readonly description: string;
  readonly bytes: number;
  /**
   * Whether this part can contain material the submitter wrote or referenced.
   * Shown in the preview so the decision to send is informed rather than
   * implied.
   */
  readonly mayContainYourContent: boolean;
}

/**
 * Response of GET /api/jobs/:jobId/diagnostics: a description of what a report
 * WOULD contain. Reading it sends nothing.
 */
export interface DiagnosticPreview {
  readonly jobId: string;
  readonly status: string;
  readonly components: readonly DiagnosticComponent[];
  readonly totalBytes: number;
  /** Named so the preview is honest about what is deliberately held back. */
  readonly excluded: readonly string[];
  /**
   * Whether an endpoint is configured to receive the report. False means the
   * POST would fail, so the affordance can say that before it is used rather
   * than after.
   */
  readonly canSend: boolean;
}

/** Response of POST /api/jobs/:jobId/diagnostics. */
export interface SendDiagnosticsResponse {
  readonly sent: boolean;
  readonly bytes: number;
}

/**
 * Response of GET /api/jobs/:jobId/thoughts?ref=…: the recorded thinking
 * behind one version of one chain step, addressed by the opaque `thoughts`
 * handle a review view carries. The text is the runtime-captured per-step
 * slice of the author's native-thinking stream — the same thread the
 * dashboard streamed live while the task ran — and it is served on demand
 * because it is far too large to ride every job-detail snapshot. "" is a
 * legal answer for a step whose author recorded nothing.
 */
export interface ThoughtsResponse {
  readonly ref: string;
  readonly text: string;
}

export interface TrashJobResponse {
  readonly jobId: string;
  readonly trashedAt: number;
}

export interface ContentRegistryStatus {
  /**
   * STRICT live connection verdict, re-verified on a short TTL: the registry
   * answered its /health probe AND currently serves the configured bundle's
   * index. Deliberately never a stale launch-time snapshot and never a
   * fallback — a registry that cannot be verified right now reports false,
   * so the UI shows disconnected rather than an old or unknown version.
   */
  readonly running: boolean;
  readonly url?: string;
  readonly skills?: number;
  readonly workflows?: number;
  /** The bundle this deployment serves runs from (e.g. "brainstorm"). */
  readonly bundle?: string;
  /** Version of the registry server process itself (from its /health). */
  readonly serverVersion?: string;
  /** Newest published bundle version the registry index lists. */
  readonly latest?: string;
  /** Release notes of `latest` (the publisher's tag annotation). */
  readonly latestNotes?: string;
  /** The explicit version pin from settings, when one is set. */
  readonly pinnedVersion?: string;
  /** The bundle version a NEW run starts with right now (pin ?? latest). */
  readonly effectiveVersion?: string;
}

/* --------------------------------------------------------------- readiness */

/**
 * Environment readiness checks the server runs so a submission never starts
 * into a broken deployment (HPC hosts especially: missing sbatch, offline
 * compute nodes, unverified credentials). Each check maps to one status icon
 * in the webapp next to the Brain Registry indicator.
 */
export const READINESS_CHECK_IDS = [
  "registry",
  "llm",
  "capabilities",
  "internet",
  "code",
  "slurm",
] as const;
export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

export type ReadinessCheckState =
  | "unknown" // never evaluated (fresh workspace, before the first run)
  | "checking" // currently being evaluated (icon pulses)
  | "ok" // green
  | "failed" // red — submissions are held until it clears
  | "skipped"; // not required under current settings (icon hidden)

export interface ReadinessCheck {
  readonly id: ReadinessCheckId;
  readonly label: string;
  readonly state: ReadinessCheckState;
  /** Whether current settings make this check required before submissions. */
  readonly required: boolean;
  /** One-line outcome: what works, or what failed. */
  readonly message?: string;
  /** Technical failure detail (command, exit code, stderr excerpt). */
  readonly detail?: string;
  /** LLM-generated fix guidance (or a built-in hint when no LLM is usable). */
  readonly advice?: string;
  /** True while the LLM advisor is composing advice for this failure. */
  readonly advising?: boolean;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface ReadinessReport {
  readonly checks: readonly ReadinessCheck[];
  /** True when every required check is ok; submissions start immediately. */
  readonly ready: boolean;
  readonly updatedAt: number;
}

/** POST /api/readiness/check request body; omit `checks` to re-run all. */
export interface ReadinessCheckRequest {
  readonly checks?: readonly ReadinessCheckId[];
}

/** POST /api/readiness/diagnose request body. */
export interface ReadinessDiagnoseRequest {
  readonly check: ReadinessCheckId;
}

/**
 * Body of the 409 returned by POST /api/jobs while a required readiness
 * check is failing: the submission is held client-side until `ready`.
 */
export interface SubmissionBlockedResponse {
  readonly message: string;
  readonly readiness: ReadinessReport;
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

/**
 * Response of POST /api/update: the one-click self-update was handed to a
 * detached updater and this server is about to exit. The browser should keep
 * polling /api/health and reload the tab once a server with a different
 * version answers; `logFile` is where the updater records every step (and
 * any rollback) for diagnosis.
 */
export interface UpdateAppResponse {
  readonly updatingTo: string;
  readonly logFile: string;
}

/**
 * Response of POST /api/update-check: a fresh (server-side throttled) look at
 * the release tags. The dashboard calls it when it loads — the "beginning of
 * a pipeline session" — so a just-published release surfaces immediately
 * rather than on the next half-hourly background tick.
 */
export interface UpdateCheckResponse {
  /** The running app version. */
  readonly version: string;
  /**
   * Whether this deployment checks for updates at all. False when the
   * server was launched with --no-self-update: no probe ran, so the absence
   * of `appUpdate` means "nothing was checked", never "you are current" —
   * and the UI must say so instead of claiming the latest version.
   */
  readonly selfUpdateEnabled: boolean;
  /** A newer release, when one exists. */
  readonly appUpdate?: {
    readonly version: string;
    readonly notes?: string;
  };
}

/**
 * Server-sent events. `jobs` and `readiness` stream on /api/stream; `job` on
 * /api/jobs/:id/stream.
 */
export type ServerEvent =
  | { readonly type: "jobs"; readonly jobs: readonly JobSummary[] }
  | { readonly type: "job"; readonly job: JobDetail }
  | { readonly type: "readiness"; readonly readiness: ReadinessReport }
  | { readonly type: "error"; readonly message: string }
  | {
      /**
       * What the models are SAYING right now, for the places that would
       * otherwise show the word "thinking". Frames carry only what was written
       * since this connection's last one.
       *
       * Not a transcript: nothing is stored, nothing reads it back, and a
       * thread ends — is deleted — the moment its task's real output exists,
       * which is when the page has something true to show instead.
       */
      readonly type: "live";
      readonly jobId: string;
      readonly entries: readonly LiveTextEntry[];
    };

export interface LiveTextEntry {
  /** The task, named by its execution path as every other channel names it. */
  readonly id: string;
  /** Characters written since this connection's previous frame. */
  readonly append?: string;
  /** The whole thread: this connection's first frame for it, or a repair. */
  readonly text?: string;
  /** The task is over — drop the thread; its output is the truth now. */
  readonly ended?: true;
  /** Who is talking, on the same terms the activity feed names them. */
  readonly role?: string;
  readonly actor?: string;
  /**
   * The same two answers as member IDS, so a thread can be attached to a card
   * without parsing its label: `actorId` is the agent talking (absent when it is
   * not a seat), `seatId` the seat whose chain is being worked on.
   */
  readonly actorId?: string;
  readonly seatId?: string;
  readonly where?: {
    readonly seat?: string;
    readonly step?: number;
    readonly round?: number;
  };
}

/**
 * Aggregated capability/tool usage of one job, computed from the event log.
 * Counts are completed tool calls (host tools and provider-native server
 * tools alike); capabilityResolution counts, per normalized operation, how
 * many agent tasks resolved it to each source — surfacing at a glance when a
 * capability silently ran in "unavailable" honesty mode.
 */
export interface ToolUsageReport {
  /** tool name -> completed calls, across the whole job. */
  readonly totals: Readonly<Record<string, number>>;
  /**
   * tool name -> calls that FAILED: refused by a permission hook, or errored.
   * Counted separately because a call and a successful call are not the same
   * fact: a run whose every attachment read was denied used to report the same
   * totals as one that read them all, which read as evidence the files had been
   * seen. Absent keys mean no failures for that tool.
   */
  readonly failures: Readonly<Record<string, number>>;
  /** role (task kind minus the workflow prefix) -> tool name -> calls. */
  readonly byRole: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** dashboard stage id (or "other") -> tool name -> calls. */
  readonly byStage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** operation id -> source ("provider" | "host" | "unavailable") -> tasks. */
  readonly capabilityResolution: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
}

/**
 * REST surface (JSON unless a line says otherwise):
 *   GET  /api/health                          -> HealthResponse
 *   POST /api/update-check                    -> UpdateCheckResponse (re-probes release tags now, throttled; called by the dashboard on load and after run submission)
 *   POST /api/update                          -> UpdateAppResponse   (starts the detached self-updater and exits; 409 when no release is known, self-update is disabled, or the checkout is dirty)
 *   GET  /api/settings                        -> ServerSettings
 *   PUT  /api/settings                        -> ServerSettings (body: ServerSettingsUpdate — a PATCH: absent sections keep their stored value, and the provider connection is tested only when the model connection itself materially changed)
 *   GET  /api/model-options                   -> ModelOptionsResponse (task types from the pinned bundle + provider model catalog)
 *   GET  /api/capabilities                    -> CapabilityOptionsResponse (toggleable capabilities from the pinned bundle's catalog)
 *   PUT  /api/settings/models-by-route        -> ServerSettings (body: ModelsByRouteUpdate; no credential re-verification)
 *   GET  /api/jobs                            -> JobSummary[]
 *   GET  /api/attachments/roots               -> ServerAttachmentRootsResponse
 *   GET  /api/attachments/browse              -> BrowseServerFilesResponse
 *   GET  /api/attachments/search              -> SearchServerFilesResponse
 *   POST /api/attachments/validate            -> ValidateAttachmentsResponse
 *   POST /api/jobs                            -> SubmitJobResponse   (body: SubmitJobRequest; 409 SubmissionBlockedResponse while a required readiness check fails)
 *   GET  /api/readiness                       -> ReadinessReport
 *   POST /api/readiness/check                 -> ReadinessReport     (body: ReadinessCheckRequest; re-runs checks asynchronously)
 *   POST /api/readiness/diagnose              -> ReadinessReport     (body: ReadinessDiagnoseRequest; asks the LLM advisor about a failed check)
 *   GET  /api/jobs/trash                      -> JobSummary[]       (view-only trash, newest first)
 *   GET  /api/jobs/:jobId                     -> JobDetail
 *   POST /api/jobs/:jobId/cancel              -> CancelJobResponse
 *   POST /api/jobs/:jobId/pause               -> CancelJobResponse  (ends the worker and keeps the checkpoint; nothing automatic resumes a paused job; 409 when the job is not pausable)
 *   POST /api/jobs/:jobId/resume-paused       -> CancelJobResponse  (paused jobs only; 409 otherwise)
 *   POST /api/jobs/:jobId/resume              -> ResumeJobResponse  (credit-blocked jobs only; 409 otherwise)
 *   POST /api/jobs/:jobId/resume-interrupted  -> ResumeInterruptedJobResponse (orphaned jobs only; 409 otherwise)
 *   POST /api/jobs/:jobId/retry               -> ResumeInterruptedJobResponse (failed jobs only, from the last checkpoint; 409 otherwise, and when the run failed before its first checkpoint)
 *   POST /api/jobs/:jobId/trash               -> TrashJobResponse   (409 while the job is still live)
 *   GET  /api/jobs/:jobId/diagnostics         -> DiagnosticPreview  (describes what a report WOULD carry; reading it sends nothing)
 *   POST /api/jobs/:jobId/diagnostics         -> SendDiagnosticsResponse (sends the report; 409 when no diagnostics endpoint is configured)
 *   POST /api/jobs/:jobId/gate                -> JobDetail           (body: GateAnswerRequest; submits a resume job)
 *   POST /api/jobs/:jobId/gate-hold           -> JobDetail           (permanently pauses the gate's auto-approve countdown)
 *   POST /api/jobs/:jobId/dismiss-member      -> JobDetail           (body: DismissMemberRequest; stops one seat mid-run and resumes the rest from the last checkpoint)
 *   GET  /api/jobs/:jobId/tool-usage          -> ToolUsageReport     (aggregated from the job's event log)
 *   GET  /api/jobs/:jobId/trace.zip           -> application/zip     (the run's whole record — journal by stage/seat, thinking, event/search logs, final outputs — packaged to fit the attachment rules for re-submission; 409 before the first checkpoint)
 *   GET  /api/jobs/:jobId/prompt/:promptId    -> text/markdown       (the prompt behind one "llm_call" row, rendered for download; 404 when the run or the record is unknown)
 *   GET  /api/jobs/:jobId/thoughts?ref=...    -> ThoughtsResponse    (the recorded thinking behind one version of one chain step; 404 when the run or the handle is unknown)
 *   GET  /api/stream                          -> SSE of ServerEvent{type:"jobs"|"readiness"}
 *   GET  /api/jobs/:jobId/stream              -> SSE of ServerEvent{type:"job"}
 * Static: everything else serves the webapp build (SPA fallback to index.html).
 */
export const API_BASE = "/api";
