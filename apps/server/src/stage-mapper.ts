import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentResult,
  JournalEntry,
  JsonObject,
  RunEvent,
  WorkflowCheckpoint,
} from "@brainstorm-agentic/core";
import {
  OUTPUT_SHAPES,
  STAGE_IDS,
  type ActivityCapability,
  type ActivityDetailView,
  type AnnotatedFileView,
  type ExpertAreaView,
  type AssessFeasibilityOutputView,
  type BrainIdeaView,
  type BridgeReportView,
  type CommentView,
  type ContradictionView,
  type ConfidenceView,
  type ConfirmPanelStage,
  type CritiqueIssueView,
  type CritiqueOutputView,
  type EvidenceView,
  type ExpertsTreeView,
  type ExplainOutputView,
  type FilePartitionView,
  type FirstPassMemberView,
  type GroundingView,
  type IdeaOutputView,
  type InterpretationCandidateView,
  type InterpretOutputView,
  type JobDetail,
  type JobStatus,
  type JudgeDecisionView,
  type JudgeIssueView,
  type NoveltyAuditView,
  type PaperView,
  type ResolveOutputView,
  type SeamView,
  type SoundnessAspectView,
  type SurveyOutputView,
  type VerifyOutputView,
  type PanelMemberView,
  type PendingGateView,
  type ProcessorOutputView,
  type ProposalView,
  type ReviewCursorView,
  type ReviewMemberView,
  type ReviewRoundView,
  type ReviewStepView,
  type RunSummaryView,
  type ServerSettings,
  type StageActivityEntry,
  type StageBase,
  type StageId,
  type StageStatus,
  type DecomposeStepView,
  type StageView,
} from "@brainstorm-agentic/protocol";

import { readJsonFile } from "./files.js";
import type { JobRecord } from "./model.js";

interface ArtifactRefFile {
  readonly id: string;
  readonly metadata?: {
    readonly nodeId?: string;
    readonly schema?: string;
    readonly path?: string;
  };
}

interface ArtifactIndexFile {
  readonly refs?: readonly ArtifactRefFile[];
}

interface ArtifactValue {
  readonly ref: ArtifactRefFile;
  readonly value: unknown;
}

interface MapperInput {
  readonly record: JobRecord;
  readonly status: JobStatus;
  readonly sessionDir: string;
  readonly jobDir: string;
  readonly settings: ServerSettings;
}

interface StageTiming {
  startedAt?: number;
  finishedAt?: number;
  active: boolean;
  error?: string;
  activity: StageActivityEntry[];
}

interface Coordinates {
  member?: number;
  step?: number;
  round?: number;
  commentor?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function readCheckpoint(sessionDir: string): WorkflowCheckpoint | undefined {
  try {
    return readJsonFile<WorkflowCheckpoint>(join(sessionDir, "checkpoint.json"));
  } catch {
    return undefined;
  }
}

/**
 * The immutable content bundle the job pinned at launch. The pin outlives
 * the fetched content cache (which is deleted on terminal states), so this
 * stays the run's provenance record forever.
 */
function readContentBundle(
  jobDir: string,
): { readonly id: string; readonly version: string } | undefined {
  try {
    const pin = readJsonFile<{ bundle?: unknown; version?: unknown }>(
      join(jobDir, "content", "content-pin.json"),
    );
    if (typeof pin?.bundle === "string" && typeof pin.version === "string") {
      return { id: pin.bundle, version: pin.version };
    }
  } catch {
    // A malformed pin never hides the rest of the job.
  }
  return undefined;
}

function readEvents(jobDir: string): RunEvent[] {
  const path = join(jobDir, "events.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readArtifacts(sessionDir: string): ArtifactValue[] {
  const directory = join(sessionDir, "artifacts");
  let index: ArtifactIndexFile | undefined;
  try {
    index = readJsonFile<ArtifactIndexFile>(join(directory, "index.json"));
  } catch {
    return [];
  }
  const values: ArtifactValue[] = [];
  for (const ref of index?.refs ?? []) {
    try {
      values.push({
        ref,
        value: JSON.parse(readFileSync(join(directory, ref.id), "utf8")) as unknown,
      });
    } catch {
      // Atomic index/payload updates can briefly expose an incomplete snapshot.
    }
  }
  return values;
}

function artifact(
  values: readonly ArtifactValue[],
  schema: string,
  path?: string,
): unknown {
  return values.find(
    ({ ref }) =>
      ref.metadata?.schema === schema &&
      (path === undefined || ref.metadata.path === path),
  )?.value;
}

/**
 * Latest-wins variant of artifact(): used where the runtime re-writes the
 * same artifact path during the run (the useful-file map gains code
 * summaries after the code-annotation pass), so the dashboard shows the
 * version every later task actually read.
 */
function artifactLatest(
  values: readonly ArtifactValue[],
  schema: string,
  path?: string,
): unknown {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const { ref, value } = values[index]!;
    if (
      ref.metadata?.schema === schema &&
      (path === undefined || ref.metadata.path === path)
    ) {
      return value;
    }
  }
  return undefined;
}

function agentOutput(entry: JournalEntry): unknown {
  if (entry.kind !== "agent") return undefined;
  const value = object(entry.value);
  if (value?.status !== "ok") return undefined;
  return value.output;
}

function journalAgent(
  entries: readonly JournalEntry[],
  matcher: (key: string) => boolean,
): unknown {
  return entries.find((entry) => matcher(entry.key) && agentOutput(entry) !== undefined)
    ? agentOutput(entries.find((entry) => matcher(entry.key) && agentOutput(entry) !== undefined)!)
    : undefined;
}

function journalStateField(
  entries: readonly JournalEntry[],
  matcher: (key: string) => boolean,
  field: string,
): unknown {
  for (const entry of entries) {
    if (!matcher(entry.key)) continue;
    const state = object(entry.value);
    if (state && field in state) return state[field];
  }
  return undefined;
}

/**
 * The decomposer split's workflow nodes: they all surface on the dashboard's
 * single Decompose stage (their agent activity, timing, and sub-step views).
 */
const DECOMPOSE_SUBNODES = [
  "partition-files-code",
  "annotate-code",
  "merge-code-annotations",
  "build-pool",
  "match-taxonomy",
  "place-fields",
  "submit-decisions",
  "bridge-experts",
] as const;

export function stageForPath(path: string): StageId | undefined {
  const segments = path.split("/");
  const direct = STAGE_IDS.find((id) => segments.includes(id));
  if (direct) return direct;
  return DECOMPOSE_SUBNODES.some((node) => segments.includes(node))
    ? "decompose-experts"
    : undefined;
}

/**
 * Which semantic capability each logged tool resolves through, across both
 * execution backends (host tools, Claude Code built-ins, Anthropic server
 * tools). Tools that transport artifacts (StructuredOutput, submit_step)
 * are deliberately absent — their rows carry no capability icon.
 */
const TOOL_CAPABILITY: Readonly<Record<string, ActivityCapability>> = {
  attachment_list: "attachment-access",
  attachment_read: "attachment-access",
  Read: "attachment-access",
  Glob: "attachment-access",
  Grep: "attachment-access",
  Bash: "code-execution",
  code_execution: "code-execution",
  bash_code_execution: "code-execution",
  text_editor_code_execution: "code-execution",
  WebSearch: "web-search",
  web_search: "web-search",
  WebFetch: "web-search",
  web_fetch: "web-search",
  taxonomy_tree: "taxonomy-access",
  taxonomy_resolve: "taxonomy-access",
};

const DETAIL_KINDS = new Set(["code", "query", "url", "path", "text"]);

/** The executor-attached call detail, when present and well-formed. */
function activityDetail(progress: {
  readonly data?: JsonObject;
}): ActivityDetailView | undefined {
  const detail = object(progress.data)?.detail;
  const record = object(detail);
  if (!record) return undefined;
  const { kind, value } = record;
  if (typeof kind !== "string" || !DETAIL_KINDS.has(kind)) return undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return { kind: kind as ActivityDetailView["kind"], value };
}

function timings(events: readonly RunEvent[]): Map<StageId, StageTiming> {
  const result = new Map<StageId, StageTiming>(
    STAGE_IDS.map((id) => [id, { active: false, activity: [] }]),
  );
  for (const event of events) {
    if (
      event.type === "agent:progress" ||
      event.type === "agent:started" ||
      event.type === "agent:completed"
    ) {
      const stage = stageForPath(event.path);
      if (!stage) continue;
      const timing = result.get(stage)!;
      if (event.type === "agent:progress") {
        const capability = event.progress.toolName
          ? TOOL_CAPABILITY[event.progress.toolName]
          : undefined;
        const detail = activityDetail(event.progress);
        timing.activity.push({
          id: String(event.seq),
          at: event.at,
          kind: event.progress.kind,
          message: event.progress.message,
          ...(event.progress.toolName
            ? { toolName: event.progress.toolName }
            : {}),
          ...(event.progress.turn !== undefined
            ? { turn: event.progress.turn }
            : {}),
          ...(event.progress.elapsedMs !== undefined
            ? { elapsedMs: event.progress.elapsedMs }
            : {}),
          ...(capability ? { capability } : {}),
          ...(detail ? { detail } : {}),
        });
      } else {
        const role = event.taskKind.replace(/^brainstorm\./, "");
        timing.activity.push({
          id: String(event.seq),
          at: event.at,
          kind: "status",
          message:
            event.type === "agent:started"
              ? `${role} agent started`
              : `${role} agent ${event.status === "ok" ? "completed" : "failed"}`,
        });
      }
      if (timing.activity.length > 200) {
        timing.activity.splice(0, timing.activity.length - 200);
      }
      continue;
    }
    if (
      event.type !== "node:started" &&
      event.type !== "node:completed" &&
      event.type !== "node:failed"
    ) {
      continue;
    }
    const stage = stageForPath(event.path);
    const leaf = event.path.split("/").pop() ?? "";
    if (!stage || event.path !== `brainstorm-root/${leaf}`) continue;
    // A decompose sub-node finishing is stage progress, not stage completion:
    // only the last sub-node (bridge-experts) closes the stage. Failures
    // close it from any sub-node.
    if (
      event.type === "node:completed" &&
      stage === "decompose-experts" &&
      leaf !== stage &&
      leaf !== "bridge-experts"
    ) {
      continue;
    }
    const timing = result.get(stage)!;
    if (event.type === "node:started") {
      if (timing.finishedAt !== undefined || timing.error !== undefined) {
        // The stage terminated before and is starting again (credit-block
        // auto-resume, retry): the fresh attempt supersedes the old outcome.
        timing.startedAt = event.at;
        timing.finishedAt = undefined;
        timing.error = undefined;
      } else {
        timing.startedAt = timing.startedAt === undefined
          ? event.at
          : Math.min(timing.startedAt, event.at);
      }
      timing.active = true;
    } else {
      timing.finishedAt = event.at;
      timing.active = false;
      if (event.type === "node:failed") timing.error = event.error.message;
    }
  }
  return result;
}

function coordinates(path: string): Coordinates {
  const number = (pattern: RegExp): number | undefined => {
    const match = pattern.exec(path);
    return match ? Number(match[1]) : undefined;
  };
  return {
    member: number(/review-members\/member\[(\d+)\]/),
    step: number(/cotStep\[(\d+)\]/),
    round: number(/iter\[(\d+)\]/),
    commentor: number(/commentor\[(\d+)\]/),
  };
}

function panelMembers(value: unknown): PanelMemberView[] {
  const members = object(value)?.members;
  if (!Array.isArray(members)) return [];
  return members.flatMap((candidate) => {
    const member = object(candidate);
    if (
      typeof member?.id !== "string" ||
      typeof member.department !== "string" ||
      typeof member.umbrella !== "string" ||
      !Array.isArray(member.subfields) ||
      !member.subfields.every((entry) => typeof entry === "string")
    ) {
      return [];
    }
    return [
      {
        id: member.id,
        department: member.department,
        umbrella: member.umbrella,
        subfields: member.subfields,
      },
    ];
  });
}

function processor(value: unknown): ProcessorOutputView | undefined {
  const output = object(value);
  if (
    typeof output?.type !== "string" ||
    typeof output.title !== "string" ||
    typeof output.question !== "string" ||
    typeof output.context !== "string" ||
    !Array.isArray(output.attachments) ||
    !Array.isArray(output.assumptions) ||
    typeof output.cotSteps !== "number"
  ) {
    return undefined;
  }
  const requestedOutputs = Array.isArray(output.requestedOutputs)
    ? output.requestedOutputs.flatMap((candidate) => {
        const entry = object(candidate);
        return typeof entry?.title === "string" && typeof entry.ask === "string"
          ? [{ title: entry.title, ask: entry.ask }]
          : [];
      })
    : [];
  // The raw artifact may also carry the annotated file map; the view exposes
  // the clean structured input only (files surface via the partition view).
  return {
    type: output.type,
    title: output.title,
    question: output.question,
    context: output.context,
    attachments: output.attachments,
    assumptions: output.assumptions,
    cotSteps: output.cotSteps,
    ...(requestedOutputs.length > 0 ? { requestedOutputs } : {}),
  } as ProcessorOutputView;
}

function annotatedFiles(value: unknown): AnnotatedFileView[] {
  const files = object(value)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((candidate) => {
    const file = object(candidate);
    return typeof file?.path === "string" && typeof file.label === "string"
      ? [{
          path: file.path,
          label: file.label,
          note: typeof file.note === "string" ? file.note : "",
          ...(typeof file.codeSummary === "string"
            ? { codeSummary: file.codeSummary }
            : {}),
        }]
      : [];
  });
}

/**
 * One tree area. Counted areas arrive as `{name, count}`; trees produced
 * before the decomposer counted carry bare strings, which stay readable
 * without a count.
 */
function expertArea(value: unknown): ExpertAreaView | undefined {
  if (typeof value === "string") return value.length > 0 ? { name: value } : undefined;
  const area = object(value);
  if (typeof area?.name !== "string" || area.name.length === 0) return undefined;
  return {
    name: area.name,
    ...(typeof area.count === "number" ? { count: area.count } : {}),
  };
}

function experts(value: unknown): ExpertsTreeView | undefined {
  const tree = object(value);
  if (!tree) return undefined;
  if (Array.isArray(tree.departments)) {
    const departments = tree.departments.flatMap((department) => {
      const item = object(department);
      if (typeof item?.name !== "string" || !Array.isArray(item.umbrellas)) return [];
      const meta = {
        ...(typeof item.domain === "string" ? { domain: item.domain } : {}),
        ...(typeof item.count === "number" ? { count: item.count } : {}),
      };
      const umbrellas = item.umbrellas.flatMap((umbrella) => {
        const leaf = object(umbrella);
        if (typeof leaf?.name !== "string" || !Array.isArray(leaf.subfields)) return [];
        return [{
          name: leaf.name,
          ...(typeof leaf.count === "number" ? { count: leaf.count } : {}),
          subfields: leaf.subfields.flatMap((field) => {
            const area = expertArea(field);
            return area ? [area] : [];
          }),
        }];
      });
      // A pool-mentioned department legitimately holds no umbrella under the
      // count-based tree, so an empty list no longer disqualifies the entry.
      return [{ name: item.name, ...meta, umbrellas }];
    });
    // The artifact may also carry the literature grounding; the tree view is
    // just the departments (grounding is extracted separately).
    if (departments.length > 0) return { departments };
  }

  // Backward compatibility for jobs produced before the constrained-output
  // representation changed from dynamic object keys to ordered arrays.
  const departments = Object.entries(tree).flatMap(
    ([departmentName, umbrellaValue]) => {
      const umbrellaRecord = object(umbrellaValue);
      if (!umbrellaRecord) return [];
      const umbrellas = Object.entries(umbrellaRecord).flatMap(
        ([umbrellaName, subfields]) =>
          Array.isArray(subfields) &&
          subfields.every((field) => typeof field === "string")
            ? [{
                name: umbrellaName,
                subfields: subfields.map((field: string) => ({ name: field })),
              }]
            : [],
      );
      return umbrellas.length > 0
        ? [{ name: departmentName, umbrellas }]
        : [];
    },
  );
  return departments.length > 0 ? { departments } : undefined;
}

/** Papers/authors/interests recorded by the decomposer's literature search. */
function grounding(value: unknown): GroundingView | undefined {
  const raw = object(object(value)?.grounding);
  if (!raw) return undefined;
  const papers: GroundingView["papers"] = Array.isArray(raw.papers)
    ? raw.papers.flatMap((candidate) => {
        const paper = object(candidate);
        if (typeof paper?.title !== "string") return [];
        return [{
          title: paper.title,
          ...(Array.isArray(paper.authors) &&
          paper.authors.every((name) => typeof name === "string")
            ? { authors: paper.authors }
            : {}),
          ...(typeof paper.year === "number" ? { year: paper.year } : {}),
          ...(typeof paper.venue === "string" && paper.venue.length > 0
            ? { venue: paper.venue }
            : {}),
          ...(typeof paper.url === "string" && paper.url.length > 0
            ? { url: paper.url }
            : {}),
          ...(typeof paper.relation === "string" && paper.relation.length > 0
            ? { relation: paper.relation }
            : {}),
        }];
      })
    : [];
  const scholars: GroundingView["scholars"] = Array.isArray(raw.scholars)
    ? raw.scholars.flatMap((candidate) => {
        const scholar = object(candidate);
        if (typeof scholar?.name !== "string") return [];
        return [{
          name: scholar.name,
          affiliation:
            typeof scholar.affiliation === "string" ? scholar.affiliation : "",
          url: typeof scholar.url === "string" ? scholar.url : "",
          profile:
            scholar.profile === "ambiguous" || scholar.profile === "no_profile"
              ? scholar.profile
              : "ok",
          interests: Array.isArray(scholar.interests)
            ? scholar.interests.filter(
                (interest): interest is string => typeof interest === "string",
              )
            : [],
        }];
      })
    : [];
  return papers.length > 0 || scholars.length > 0
    ? { papers, scholars }
    : undefined;
}

/** A single text block: a plain string, or paragraph array joined with blank lines. */
function textBlock(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry; // pre-array jobs
  if (
    Array.isArray(entry) &&
    entry.length > 0 &&
    entry.every((paragraph) => typeof paragraph === "string")
  ) {
    return entry.join("\n\n");
  }
  return undefined;
}

function stringList(entry: unknown): string[] {
  return Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === "string")
    : [];
}

function paperView(candidate: unknown): PaperView | undefined {
  const paper = object(candidate);
  if (typeof paper?.title !== "string") return undefined;
  return {
    ...(typeof paper.id === "string" ? { id: paper.id } : {}),
    title: paper.title,
    ...(Array.isArray(paper.authors) &&
    paper.authors.every((name) => typeof name === "string")
      ? { authors: paper.authors }
      : {}),
    ...(typeof paper.year === "number" ? { year: paper.year } : {}),
    ...(typeof paper.venue === "string" && paper.venue.length > 0
      ? { venue: paper.venue }
      : {}),
    ...(typeof paper.url === "string" && paper.url.length > 0
      ? { url: paper.url }
      : {}),
    ...(typeof paper.relation === "string" && paper.relation.length > 0
      ? { relation: paper.relation }
      : {}),
  };
}

function paperViews(entry: unknown): PaperView[] {
  return Array.isArray(entry)
    ? entry.flatMap((candidate) => {
        const paper = paperView(candidate);
        return paper ? [paper] : [];
      })
    : [];
}

function confidenceView(entry: unknown): ConfidenceView | undefined {
  const raw = object(entry);
  if (
    (raw?.level !== "high" && raw?.level !== "medium" && raw?.level !== "low") ||
    typeof raw.rationale !== "string"
  ) {
    return undefined;
  }
  return { level: raw.level, rationale: raw.rationale };
}

function researchIdeaView(body: Record<string, unknown>): IdeaOutputView | undefined {
  const paper = {
    abstract: textBlock(body.abstract),
    introduction: textBlock(body.introduction),
    method: textBlock(body.method),
    discussion: textBlock(body.discussion),
    conclusion: textBlock(body.conclusion),
  };
  if (Object.values(paper).some((entry) => entry === undefined)) return undefined;
  return paper as IdeaOutputView;
}

function openProblemView(body: Record<string, unknown>): ResolveOutputView | undefined {
  const problemStatement = textBlock(body.problemStatement);
  const approach = textBlock(body.approach);
  const significance = textBlock(body.significance);
  const derivation = stringList(body.derivation);
  const status = body.status;
  if (
    problemStatement === undefined ||
    approach === undefined ||
    significance === undefined ||
    derivation.length === 0 ||
    (status !== "resolved" && status !== "partial" && status !== "refuted" && status !== "still-open")
  ) {
    return undefined;
  }
  const knownResults = Array.isArray(body.knownResults)
    ? body.knownResults.flatMap((candidate) => {
        const item = object(candidate);
        return typeof item?.result === "string" &&
          typeof item.sourceType === "string" &&
          typeof item.relation === "string"
          ? [{ result: item.result, sourceType: item.sourceType, relation: item.relation }]
          : [];
      })
    : [];
  const verification = evidence(body.verification);
  return {
    problemStatement,
    knownResults,
    approach,
    derivation,
    ...(verification ? { verification } : {}),
    status,
    remainingGaps: stringList(body.remainingGaps),
    significance,
  };
}

function unverifiedClaimView(body: Record<string, unknown>): VerifyOutputView | undefined {
  const reasoning = textBlock(body.reasoning);
  const confidence = confidenceView(body.confidence);
  const verdict = body.verdict;
  if (
    typeof body.claim !== "string" ||
    typeof body.claimSource !== "string" ||
    reasoning === undefined ||
    confidence === undefined ||
    (verdict !== "confirmed" &&
      verdict !== "refuted" &&
      verdict !== "partially-correct" &&
      verdict !== "indeterminate")
  ) {
    return undefined;
  }
  const found = evidence(body.evidence);
  return {
    claim: body.claim,
    claimSource: body.claimSource,
    verdict,
    ...(found ? { evidence: found } : {}),
    reasoning,
    confidence,
  };
}

function researchProposalView(body: Record<string, unknown>): AssessFeasibilityOutputView | undefined {
  const designSummary = textBlock(body.designSummary);
  const importance = textBlock(body.importance);
  const hypothesisLogic = textBlock(body.hypothesisLogic);
  const replicability = textBlock(body.replicability);
  const verdict = body.feasibilityVerdict;
  if (
    designSummary === undefined ||
    importance === undefined ||
    hypothesisLogic === undefined ||
    replicability === undefined ||
    (verdict !== "feasible-as-is" && verdict !== "feasible-with-changes" && verdict !== "not-feasible")
  ) {
    return undefined;
  }
  const methodologySoundness: SoundnessAspectView[] = Array.isArray(body.methodologySoundness)
    ? body.methodologySoundness.flatMap((candidate) => {
        const item = object(candidate);
        const assessment = item?.assessment;
        if (
          typeof item?.aspect !== "string" ||
          typeof item.note !== "string" ||
          (assessment !== "sound" && assessment !== "concern" && assessment !== "flaw")
        ) {
          return [];
        }
        return [{ aspect: item.aspect, assessment, note: item.note }];
      })
    : [];
  return {
    designSummary,
    importance,
    hypothesisLogic,
    methodologySoundness,
    replicability,
    feasibilityVerdict: verdict,
    requiredChanges: stringList(body.requiredChanges),
    alternativeDesigns: stringList(body.alternativeDesigns),
  };
}

function completedWorkView(body: Record<string, unknown>): CritiqueOutputView | undefined {
  const artifactSummary = textBlock(body.artifactSummary);
  const recommendation = body.recommendation;
  if (
    artifactSummary === undefined ||
    (recommendation !== "sound" && recommendation !== "sound-with-revisions" && recommendation !== "not-sound")
  ) {
    return undefined;
  }
  const issues: CritiqueIssueView[] = Array.isArray(body.issues)
    ? body.issues.flatMap((candidate) => {
        const item = object(candidate);
        const severity = item?.severity;
        if (
          typeof item?.description !== "string" ||
          (severity !== "minor" && severity !== "major" && severity !== "critical")
        ) {
          return [];
        }
        const found = evidence(item.evidence);
        return [{
          description: item.description,
          severity,
          ...(found ? { evidence: found } : {}),
          ...(typeof item.suggestion === "string" && item.suggestion.length > 0
            ? { suggestion: item.suggestion }
            : {}),
        }];
      })
    : [];
  const prioritizedNextSteps = Array.isArray(body.prioritizedNextSteps)
    ? body.prioritizedNextSteps.flatMap((candidate) => {
        const item = object(candidate);
        return typeof item?.priority === "number" && typeof item.action === "string"
          ? [{ priority: item.priority, action: item.action }]
          : [];
      })
    : [];
  return {
    artifactSummary,
    strengths: stringList(body.strengths),
    issues,
    missingConsiderations: stringList(body.missingConsiderations),
    recommendation,
    prioritizedNextSteps,
  };
}

function empiricalResultView(body: Record<string, unknown>): InterpretOutputView | undefined {
  const observationSummary = textBlock(body.observationSummary);
  const mostLikelyInterpretation = textBlock(body.mostLikelyInterpretation);
  const confidence = confidenceView(body.confidence);
  if (observationSummary === undefined || mostLikelyInterpretation === undefined || confidence === undefined) {
    return undefined;
  }
  const candidateInterpretations: InterpretationCandidateView[] = Array.isArray(body.candidateInterpretations)
    ? body.candidateInterpretations.flatMap((candidate) => {
        const item = object(candidate);
        const plausibility = item?.plausibility;
        if (
          typeof item?.interpretation !== "string" ||
          (plausibility !== "high" && plausibility !== "medium" && plausibility !== "low")
        ) {
          return [];
        }
        return [{
          interpretation: item.interpretation,
          ...(typeof item.supportingEvidence === "string" && item.supportingEvidence.length > 0
            ? { supportingEvidence: item.supportingEvidence }
            : {}),
          ...(typeof item.contradictingEvidence === "string" && item.contradictingEvidence.length > 0
            ? { contradictingEvidence: item.contradictingEvidence }
            : {}),
          plausibility,
        }];
      })
    : [];
  return {
    observationSummary,
    candidateInterpretations,
    mostLikelyInterpretation,
    confidence,
    threatsToValidity: stringList(body.threatsToValidity),
    ...(typeof body.implications === "string" && body.implications.length > 0
      ? { implications: body.implications }
      : {}),
  };
}

function researchAreaView(body: Record<string, unknown>): SurveyOutputView | undefined {
  const consensusAndFrontier = textBlock(body.consensusAndFrontier);
  if (consensusAndFrontier === undefined || !Array.isArray(body.landscapeMap)) return undefined;
  const landscapeMap = body.landscapeMap.flatMap((candidate) => {
    const item = object(candidate);
    return typeof item?.name === "string" && typeof item.characterization === "string"
      ? [{ name: item.name, works: paperViews(item.works), characterization: item.characterization }]
      : [];
  });
  if (landscapeMap.length === 0) return undefined;
  const comparisonTable = Array.isArray(body.comparisonTable)
    ? body.comparisonTable.flatMap((candidate) => {
        const item = object(candidate);
        return typeof item?.dimension === "string" && typeof item.comparison === "string"
          ? [{ dimension: item.dimension, comparison: item.comparison }]
          : [];
      })
    : [];
  return {
    landscapeMap,
    comparisonTable,
    consensusAndFrontier,
    openGaps: stringList(body.openGaps),
    ...(typeof body.recommendation === "string" && body.recommendation.length > 0
      ? { recommendation: body.recommendation }
      : {}),
  };
}

function establishedConceptView(body: Record<string, unknown>): ExplainOutputView | undefined {
  const motivatingQuestion = textBlock(body.motivatingQuestion);
  const coreIntuition = textBlock(body.coreIntuition);
  const formalTreatment = textBlock(body.formalTreatment);
  const workedExample = textBlock(body.workedExample);
  if (
    motivatingQuestion === undefined ||
    coreIntuition === undefined ||
    formalTreatment === undefined ||
    workedExample === undefined
  ) {
    return undefined;
  }
  const commonMisconceptions = Array.isArray(body.commonMisconceptions)
    ? body.commonMisconceptions.flatMap((candidate) => {
        const item = object(candidate);
        return typeof item?.misconception === "string" && typeof item.correction === "string"
          ? [{ misconception: item.misconception, correction: item.correction }]
          : [];
      })
    : [];
  return {
    motivatingQuestion,
    coreIntuition,
    formalTreatment,
    workedExample,
    commonMisconceptions,
    connections: stringList(body.connections),
  };
}

function brainIdea(value: unknown): BrainIdeaView | undefined {
  const idea = object(value);
  if (!idea || !Array.isArray(idea.cot)) return undefined;
  const envelope = object(idea.output);
  if (!envelope) return undefined;

  // The developed-output envelope nests the body under its SHAPE key
  // (`output.verification`, …) while `type` carries the free-form catalog
  // label. Artifacts from before the shape envelope carry the five paper
  // sections directly on `output` and are read as a legacy paper.
  const shape = OUTPUT_SHAPES.find((candidate) => object(envelope[candidate]) !== undefined);
  const body = shape ? object(envelope[shape])! : envelope;
  const label =
    typeof envelope.type === "string" && envelope.type.length > 0
      ? envelope.type
      : (shape ?? "paper");

  const shaped: {
    paper?: IdeaOutputView;
    resolution?: ResolveOutputView;
    verification?: VerifyOutputView;
    feasibility?: AssessFeasibilityOutputView;
    critique?: CritiqueOutputView;
    interpretation?: InterpretOutputView;
    survey?: SurveyOutputView;
    explanation?: ExplainOutputView;
  } = {};
  switch (shape ?? "paper") {
    case "paper": {
      const paper = researchIdeaView(body);
      if (!paper) return undefined;
      shaped.paper = paper;
      break;
    }
    case "resolution": {
      const resolution = openProblemView(body);
      if (!resolution) return undefined;
      shaped.resolution = resolution;
      break;
    }
    case "verification": {
      const verification = unverifiedClaimView(body);
      if (!verification) return undefined;
      shaped.verification = verification;
      break;
    }
    case "feasibility": {
      const feasibility = researchProposalView(body);
      if (!feasibility) return undefined;
      shaped.feasibility = feasibility;
      break;
    }
    case "critique": {
      const critique = completedWorkView(body);
      if (!critique) return undefined;
      shaped.critique = critique;
      break;
    }
    case "interpretation": {
      const interpretation = empiricalResultView(body);
      if (!interpretation) return undefined;
      shaped.interpretation = interpretation;
      break;
    }
    case "survey": {
      const survey = researchAreaView(body);
      if (!survey) return undefined;
      shaped.survey = survey;
      break;
    }
    case "explanation": {
      const explanation = establishedConceptView(body);
      if (!explanation) return undefined;
      shaped.explanation = explanation;
      break;
    }
  }

  // The member's responses to the submitter's explicitly requested outputs
  // sit on the envelope next to the shape body; paragraphs join for display.
  const requested = Array.isArray(envelope.requested)
    ? envelope.requested.flatMap((candidate) => {
        const section = object(candidate);
        if (typeof section?.title !== "string" || !Array.isArray(section.response)) return [];
        return [
          {
            title: section.title,
            response: section.response.filter((entry) => typeof entry === "string").join("\n\n"),
          },
        ];
      })
    : [];

  const literature = paperViews(idea.literature);
  return {
    type: label,
    shape: shape ?? "paper",
    ...shaped,
    ...(requested.length > 0 ? { requested } : {}),
    cot: idea.cot as string[],
    ...(typeof idea.novelty === "string" ? { novelty: idea.novelty } : {}),
    ...(literature.length > 0 ? { literature } : {}),
  };
}

function bridgeReport(value: unknown): BridgeReportView | undefined {
  const raw = object(value);
  if (
    !Array.isArray(raw?.noveltyAudit) ||
    !Array.isArray(raw.contradictions) ||
    !Array.isArray(raw.seams)
  ) {
    return undefined;
  }
  const noveltyAudit: NoveltyAuditView[] = raw.noveltyAudit.flatMap((candidate) => {
    const entry = object(candidate);
    if (
      typeof entry?.memberId !== "string" ||
      typeof entry.claim !== "string" ||
      (entry.status !== "clear" && entry.status !== "challenged") ||
      typeof entry.note !== "string"
    ) {
      return [];
    }
    const found = evidence(entry.evidence);
    return [{
      memberId: entry.memberId,
      claim: entry.claim,
      status: entry.status,
      note: entry.note,
      ...(found ? { evidence: found } : {}),
    }];
  });
  const contradictions: ContradictionView[] = raw.contradictions.flatMap((candidate) => {
    const entry = object(candidate);
    return Array.isArray(entry?.members) &&
      entry.members.every((member) => typeof member === "string") &&
      typeof entry.description === "string"
      ? [{ members: entry.members, description: entry.description }]
      : [];
  });
  const seams: SeamView[] = raw.seams.flatMap((candidate) => {
    const entry = object(candidate);
    return Array.isArray(entry?.between) &&
      entry.between.every((name) => typeof name === "string") &&
      typeof entry.gap === "string" &&
      typeof entry.opportunity === "string"
      ? [{ between: entry.between, gap: entry.gap, opportunity: entry.opportunity }]
      : [];
  });
  return { noveltyAudit, contradictions, seams };
}

function proposal(value: unknown): ProposalView | undefined {
  const raw = object(value);
  if (
    typeof raw?.title !== "string" ||
    typeof raw.framing !== "string" ||
    !Array.isArray(raw.consensus) ||
    !Array.isArray(raw.tensions) ||
    !Array.isArray(raw.novelDirections) ||
    !Array.isArray(raw.actionItems) ||
    !Array.isArray(raw.applications)
  ) {
    return undefined;
  }
  return {
    title: raw.title,
    framing: raw.framing,
    consensus: raw.consensus as string[],
    tensions: raw.tensions as string[],
    novelDirections: raw.novelDirections as string[],
    actionItems: raw.actionItems.flatMap((candidate) => {
      const item = object(candidate);
      return typeof item?.priority === "number" && typeof item.action === "string"
        ? [{
            priority: item.priority,
            action: item.action,
            rationale: typeof item.rationale === "string" ? item.rationale : "",
          }]
        : [];
    }),
    applications: raw.applications as string[],
  };
}

/**
 * Custom seats from the gate response, mirrored to the exact ids the runtime
 * assigns (`member-user-N`, in submission order) so the dashboard's panel
 * matches the one the run actually executed.
 */
function addedPanelMembers(raw: unknown): PanelMemberView[] {
  if (!Array.isArray(raw)) return [];
  const members: PanelMemberView[] = [];
  raw.forEach((entry, index) => {
    const seat = object(entry);
    if (
      typeof seat?.department !== "string" ||
      typeof seat.umbrella !== "string" ||
      !Array.isArray(seat.subfields)
    ) {
      return;
    }
    members.push({
      id: `member-user-${index + 1}`,
      department: seat.department,
      umbrella: seat.umbrella,
      subfields: seat.subfields.filter(
        (subfield): subfield is string => typeof subfield === "string",
      ),
    });
  });
  return members;
}

function gateDecision(entries: readonly JournalEntry[]): {
  action?: string;
  members?: string[];
  added: PanelMemberView[];
  automatic: boolean;
} {
  const auto = entries.find((entry) =>
    entry.key.includes("/confirm-panel/confirm-panel-auto::result")
  );
  const manual = entries.find(
    (entry) =>
      entry.kind === "gate" &&
      entry.key.includes("/confirm-panel") &&
      entry.key.endsWith("::response"),
  );
  const raw = manual?.value ?? auto?.value;
  if (typeof raw === "string") {
    return { action: raw, added: [], automatic: auto !== undefined };
  }
  const value = object(raw);
  return {
    added: addedPanelMembers(value?.addedMembers),
    action: typeof value?.action === "string" ? value.action : undefined,
    members: Array.isArray(value?.members)
      ? value.members.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    automatic: auto !== undefined,
  };
}

function evidence(value: unknown): EvidenceView | undefined {
  const raw = object(value);
  if (!raw || raw.kind === "none") return undefined;
  if (raw.kind === "script" && typeof raw.code === "string") {
    return {
      kind: "script",
      code: raw.code,
      ...(typeof raw.result === "string" ? { result: raw.result } : {}),
    };
  }
  if (raw.kind === "math" && typeof raw.derivation === "string") {
    return { kind: "math", derivation: raw.derivation };
  }
  if (
    raw.kind === "reference" &&
    typeof raw.citation === "string" &&
    typeof raw.locator === "string" &&
    typeof raw.shows === "string"
  ) {
    return {
      kind: "reference",
      citation: raw.citation,
      locator: raw.locator,
      shows: raw.shows,
    };
  }
  return undefined;
}

function comment(
  value: unknown,
  member: PanelMemberView,
  label: string,
): CommentView | undefined {
  const raw = object(value);
  if (
    (raw?.verdict !== "Pass" &&
      raw?.verdict !== "Build" &&
      raw?.verdict !== "Interrupt") ||
    typeof raw.reason !== "string"
  ) {
    return undefined;
  }
  return {
    commentorId: member.id,
    commentorLabel: label,
    verdict: raw.verdict,
    ...(typeof raw.step === "number" ? { step: raw.step } : {}),
    reason: raw.reason,
    ...(typeof raw.suggestion === "string" && raw.suggestion.length > 0
      ? { suggestion: raw.suggestion }
      : {}),
    ...(evidence(raw.evidence) ? { evidence: evidence(raw.evidence)! } : {}),
  };
}

/** The judge's issues[] repair signal, projected for the dashboard. */
function issueViews(value: unknown): JudgeIssueView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = object(candidate);
    if (
      typeof item?.step !== "number" ||
      typeof item.point !== "string" ||
      (item.basis !== "verified" && item.basis !== "authority")
    ) {
      return [];
    }
    return [
      {
        step: item.step,
        point: item.point,
        basis: item.basis,
        mustAddress: item.mustAddress === true,
        ...(typeof item.suggestion === "string" && item.suggestion.length > 0
          ? { suggestion: item.suggestion }
          : {}),
        ...(evidence(item.evidence) ? { evidence: evidence(item.evidence)! } : {}),
      },
    ];
  });
}

function decision(value: unknown): JudgeDecisionView | undefined {
  const raw = object(value);
  if (
    (raw?.verdict !== "Pass" &&
      raw?.verdict !== "Build" &&
      raw?.verdict !== "Interrupt") ||
    typeof raw.reason !== "string"
  ) {
    return undefined;
  }
  let assessment: JudgeDecisionView["assessment"];
  if (Array.isArray(raw.assessment)) {
    const entries = raw.assessment.flatMap((candidate) => {
      const item = object(candidate);
      return typeof item?.commentorId === "string" &&
        (item.basis === "verified" || item.basis === "authority")
        ? [[item.commentorId, item.basis] as const]
        : [];
    });
    if (entries.length !== raw.assessment.length || entries.length === 0) {
      return undefined;
    }
    assessment = Object.fromEntries(entries);
  } else if (isObject(raw.assessment)) {
    // Backward compatibility for pre-array jobs.
    assessment = raw.assessment as JudgeDecisionView["assessment"];
  } else {
    return undefined;
  }
  const issues = issueViews(raw.issues);
  return {
    verdict: raw.verdict,
    reason: raw.reason,
    ...(typeof raw.suggestion === "string" && raw.suggestion.length > 0
      ? { suggestion: raw.suggestion }
      : {}),
    ...(evidence(raw.evidence) ? { evidence: evidence(raw.evidence)! } : {}),
    ...(issues.length > 0 ? { issues } : {}),
    assessment,
  };
}

function activePaths(events: readonly RunEvent[]): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "node:started") active.add(event.path);
    if (event.type === "node:completed" || event.type === "node:failed") {
      active.delete(event.path);
    }
  }
  return active;
}

function buildReviews(
  panel: readonly PanelMemberView[],
  ideas: ReadonlyMap<string, BrainIdeaView>,
  rawIdeas: ReadonlyMap<string, unknown>,
  processorOutput: ProcessorOutputView | undefined,
  entries: readonly JournalEntry[],
  events: readonly RunEvent[],
  stageActive: boolean,
): { members: ReviewMemberView[]; cursor?: ReviewCursorView; complete: boolean } {
  const rounds = new Map<string, {
    cot?: string;
    comments: Map<number, CommentView>;
    decision?: JudgeDecisionView;
    revision?: { touchedSteps: number[] };
  }>();
  // Per-member revision replay: how many redevelopments landed, and the last
  // one's raw record — the source of the member's final output envelope.
  const memberRevisions = new Map<number, { count: number; last: Record<string, unknown> }>();
  const roundFor = (member: number, step: number, round: number) => {
    const key = `${member}:${step}:${round}`;
    let found = rounds.get(key);
    if (!found) {
      found = { comments: new Map() };
      rounds.set(key, found);
    }
    return found;
  };
  const seatLabel = (index: number): string => `Seat ${index + 1}`;

  // Working chain per member, replayed in journal order: it starts as the
  // first-pass chain and every redevelopment re-emits the complete chain, so
  // each round can snapshot the step text exactly as its reviewers saw it.
  const workingCot = new Map<number, string[]>();
  const cotFor = (memberIndex: number): string[] => {
    let chain = workingCot.get(memberIndex);
    if (!chain) {
      const member = panel[memberIndex];
      chain = [...(member ? ideas.get(member.id)?.cot ?? [] : [])];
      workingCot.set(memberIndex, chain);
    }
    return chain;
  };

  for (const entry of entries) {
    const output = agentOutput(entry);
    if (output === undefined || !entry.key.includes("/review-members/")) continue;
    const at = coordinates(entry.key);
    if (at.member === undefined || at.step === undefined || at.round === undefined) continue;
    const round = roundFor(at.member, at.step, at.round);
    if (round.cot === undefined) {
      const text = cotFor(at.member)[at.step];
      if (text !== undefined) round.cot = text;
    }
    if (
      /\/comment-step(?:\/comment-step-execute)?::result$/.test(entry.key) &&
      at.commentor !== undefined
    ) {
      const thinker = panel[at.member];
      const commentors = panel.filter((member) => member.id !== thinker?.id);
      const author = commentors[at.commentor];
      if (author) {
        const view = comment(output, author, seatLabel(panel.indexOf(author)));
        if (view) round.comments.set(at.commentor, view);
      }
    } else if (/\/judge-step(?:\/judge-step-execute)?::result$/.test(entry.key)) {
      round.decision = decision(output);
    } else if (
      /\/redevelop-idea(?:\/redevelop-idea-execute)?::result$/.test(entry.key)
    ) {
      const revision = object(output);
      if (Array.isArray(revision?.steps)) {
        const replacement = revision.steps.filter(
          (step): step is string => typeof step === "string",
        );
        // The change-set mirrors the runtime's own diff: exact per-step
        // comparison of the re-emitted chain against the working chain.
        const chain = cotFor(at.member);
        const touchedSteps = replacement
          .map((step, index) => (step === chain[index] ? 0 : index + 1))
          .filter((index) => index > 0);
        round.revision = { touchedSteps };
        chain.splice(0, chain.length, ...replacement);
        const state = memberRevisions.get(at.member);
        memberRevisions.set(at.member, {
          count: (state?.count ?? 0) + 1,
          last: revision,
        });
      }
    }
  }

  const members: ReviewMemberView[] = panel.map((member, memberIndex) => {
    const stepCount =
      ideas.get(member.id)?.cot.length ?? processorOutput?.cotSteps ?? 0;
    const steps: ReviewStepView[] = Array.from({ length: stepCount }, (_, stepIndex) => {
      const views: ReviewRoundView[] = [...rounds.entries()]
        .flatMap(([key, value]) => {
          const [m, s, r] = key.split(":").map(Number);
          if (m !== memberIndex || s !== stepIndex) return [];
          return [{
            round: r! + 1,
            ...(value.cot !== undefined ? { cot: value.cot } : {}),
            comments: [...value.comments.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, item]) => item),
            ...(value.decision ? { decision: value.decision } : {}),
            ...(value.revision ? { revision: value.revision } : {}),
          }];
        })
        .sort((a, b) => a.round - b.round);
      const passed = views.some((round) => round.decision?.verdict === "Pass");
      const forcePassed =
        !passed &&
        views.length >= 4 &&
        views[views.length - 1]?.decision !== undefined;
      return {
        index: stepIndex + 1,
        outcome: passed
          ? "passed"
          : forcePassed
            ? "force-passed"
            : views.length > 0
              ? "under-review"
              : "pending",
        rounds: views,
      };
    });
    // The member's output as the review leaves it: with no redevelopments it
    // IS the first pass; otherwise the last revision's envelope over the
    // fully replayed chain, with the first pass's literature record riding
    // along (revisions rework reasoning, never its grounding record). This
    // replay works for every run the journal reaches, old artifacts or new.
    const revisionState = memberRevisions.get(memberIndex);
    let finalIdea = ideas.get(member.id);
    if (revisionState) {
      const firstRaw = object(rawIdeas.get(member.id));
      const composed = brainIdea({
        output: revisionState.last.output,
        cot: cotFor(memberIndex),
        ...(revisionState.last.novelty !== undefined
          ? { novelty: revisionState.last.novelty }
          : {}),
        ...(firstRaw?.literature !== undefined
          ? { literature: firstRaw.literature }
          : {}),
      });
      if (composed) finalIdea = composed;
    }
    return {
      memberId: member.id,
      label: seatLabel(memberIndex),
      department: member.department,
      umbrella: member.umbrella,
      steps,
      ...(finalIdea ? { finalIdea } : {}),
      revisionCount: revisionState?.count ?? 0,
    };
  });

  let cursor: ReviewCursorView | undefined;
  const deepest = [...activePaths(events)]
    .filter((path) => path.includes("/review-members/"))
    .sort((a, b) => b.split("/").length - a.split("/").length)[0];
  if (deepest) {
    const at = coordinates(deepest);
    if (at.member !== undefined && at.step !== undefined) {
      cursor = {
        member: at.member + 1,
        memberCount: panel.length,
        step: at.step + 1,
        stepCount: members[at.member]?.steps.length ?? processorOutput?.cotSteps ?? 0,
        round: (at.round ?? members[at.member]?.steps[at.step]?.rounds.length ?? 0) + 1,
        maxRounds: 4,
      };
    }
  }
  if (!cursor && stageActive) {
    outer: for (const [memberIndex, member] of members.entries()) {
      for (const [stepIndex, step] of member.steps.entries()) {
        if (step.outcome === "pending" || step.outcome === "under-review") {
          cursor = {
            member: memberIndex + 1,
            memberCount: members.length,
            step: stepIndex + 1,
            stepCount: member.steps.length,
            round: Math.min(4, Math.max(1, step.rounds.length || 1)),
            maxRounds: 4,
          };
          break outer;
        }
      }
    }
  }
  const complete =
    members.length > 0 &&
    members.every((member) =>
      member.steps.length > 0 &&
      member.steps.every((step) =>
        step.outcome === "passed" || step.outcome === "force-passed"
      )
    );
  return { members, ...(cursor ? { cursor } : {}), complete };
}

function stageStatus(
  id: StageId,
  directComplete: boolean,
  timing: StageTiming,
  checkpoint: WorkflowCheckpoint | undefined,
  jobStatus: JobStatus,
  failedStage: StageId | undefined,
): StageStatus {
  if (checkpoint?.status === "completed") return "completed";
  if (failedStage === id || timing.error) return "failed";
  if (
    checkpoint?.status === "suspended" &&
    checkpoint.pendingGates.some((gate) => stageForPath(gate.path) === id)
  ) {
    return "suspended";
  }
  if (checkpoint?.status === "credit_blocked" && timing.active) {
    return "credit_blocked";
  }
  if (directComplete || timing.finishedAt !== undefined) return "completed";
  if (timing.active) {
    return jobStatus === "cancelled" ? "cancelled" : "active";
  }
  return "pending";
}

function base(
  id: StageId,
  status: StageStatus,
  timing: StageTiming,
): StageBase {
  return {
    id,
    status,
    ...(timing.startedAt !== undefined ? { startedAt: timing.startedAt } : {}),
    ...(timing.finishedAt !== undefined ? { finishedAt: timing.finishedAt } : {}),
    ...(timing.error ? { error: timing.error } : {}),
    ...(timing.activity.length > 0 ? { activity: timing.activity } : {}),
  };
}

function pendingGate(
  checkpoint: WorkflowCheckpoint | undefined,
  panel: readonly PanelMemberView[],
): PendingGateView | undefined {
  const gate = checkpoint?.pendingGates[0];
  if (!gate) return undefined;
  const metadata = object(gate.metadata);
  return {
    gateKey: gate.gateKey,
    ...(typeof metadata?.title === "string" ? { title: metadata.title } : {}),
    ...(gate.prompt ? { prompt: gate.prompt } : {}),
    ...(stageForPath(gate.path) === "confirm-panel" ? { members: panel } : {}),
  };
}

export function buildJobDetail(input: MapperInput): JobDetail {
  const checkpoint = readCheckpoint(input.sessionDir);
  const events = readEvents(input.jobDir);
  const artifacts = readArtifacts(input.sessionDir);
  const entries = checkpoint?.journal ?? [];
  const stageTimings = timings(events);

  const processorOutput =
    processor(artifact(artifacts, "processorOutput")) ??
    processor(journalAgent(entries, (key) =>
      key.includes("/process-input") &&
      /\/process-input(?:-execute)?::result$/.test(key)
    ));
  const usefulFilesView = annotatedFiles(
    artifactLatest(artifacts, "usefulFiles") ??
      journalStateField(
        entries,
        (key) => key.endsWith("/partition-files-useful::result"),
        "usefulFiles",
      ),
  );
  const ignoredFilesView = annotatedFiles(
    artifact(artifacts, "ignoredFiles") ??
      journalStateField(
        entries,
        (key) => key.endsWith("/partition-files-ignored::result"),
        "ignoredFiles",
      ),
  );
  const filePartition: FilePartitionView | undefined =
    usefulFilesView.length > 0 || ignoredFilesView.length > 0
      ? { useful: usefulFilesView, ignored: ignoredFilesView }
      : undefined;

  const expertsArtifact = artifact(artifacts, "experts");
  const expertsJournal = journalAgent(entries, (key) =>
    key.includes("/decompose-experts") &&
    /\/decompose-experts(?:-execute)?::result$/.test(key)
  );
  const expertsOutput = experts(expertsArtifact) ?? experts(expertsJournal);
  const groundingOutput =
    grounding(expertsArtifact) ?? grounding(expertsJournal);
  let selectedPanel = panelMembers(
    artifact(artifacts, "panel") ??
      journalStateField(
        entries,
        (key) => key.endsWith("/select-panel::result"),
        "panel",
      ),
  );
  if (selectedPanel.length === 0) {
    selectedPanel = panelMembers(
      entries.find((entry) => entry.key.endsWith("/select-panel::result"))?.value,
    );
  }
  const gate = gateDecision(entries);
  const retained = new Set(gate.members ?? selectedPanel.map((member) => member.id));
  const keptPanel =
    gate.action === "shrink"
      ? selectedPanel.filter((member) => retained.has(member.id))
      : selectedPanel;
  // The panel the run executed: kept seats plus the custom seats the user
  // added at confirmation (they exist only once the gate was answered).
  const finalPanel =
    gate.action !== undefined ? [...keptPanel, ...gate.added] : keptPanel;
  const removedMemberIds =
    gate.action === "shrink"
      ? selectedPanel.filter((member) => !retained.has(member.id)).map((member) => member.id)
      : [];
  const addedMemberIds = gate.added.map((member) => member.id);

  // First-pass ideas stay pinned to the FIRST artifact under each member's
  // idea path: the runtime appends a new version there after every
  // redevelopment, and those later versions belong to the review stage's
  // final view, never to the first-pass record. The raw values are kept
  // alongside the views so the review builder can compose finals from them.
  const ideas = new Map<string, BrainIdeaView>();
  const rawIdeas = new Map<string, unknown>();
  for (const member of finalPanel) {
    const raw =
      artifact(artifacts, "brainIdea", `ideas.${member.id}`) ??
      journalAgent(entries, (key) =>
        key.includes("/first-pass/") &&
        key.includes(`/member[${finalPanel.indexOf(member)}]/`) &&
        /\/develop-idea(?:\/develop-idea-execute)?::result$/.test(key)
      );
    const value = brainIdea(raw);
    if (value) {
      ideas.set(member.id, value);
      rawIdeas.set(member.id, raw);
    }
  }

  const firstPassActive = activePaths(events);
  // A task that was mid-flight when the run credit-blocked is paused, not
  // thinking: nothing is executing until the auto-resume fires.
  const creditBlocked =
    checkpoint?.status === "credit_blocked" || input.status === "credit-blocked";
  const firstPassMembers: FirstPassMemberView[] = finalPanel.map((member, index) => {
    const idea = ideas.get(member.id);
    // Only the LAST lifecycle event decides failure: a member whose task
    // failed and then started again (auto-resume) is running, not failed.
    const lastLifecycle = [...events].reverse().find(
      (event) =>
        (event.type === "node:started" ||
          event.type === "node:completed" ||
          event.type === "node:failed") &&
        event.path.includes("/first-pass/") &&
        event.path.includes(`/member[${index}]/`),
    );
    const failed = lastLifecycle?.type === "node:failed";
    const thinking = [...firstPassActive].some(
      (path) =>
        path.includes("/first-pass/") && path.includes(`/member[${index}]/`),
    );
    return {
      memberId: member.id,
      label: member.umbrella,
      department: member.department,
      umbrella: member.umbrella,
      subfields: member.subfields,
      status: failed
        ? "failed"
        : idea
          ? "completed"
          : thinking
            ? creditBlocked
              ? "paused"
              : "thinking"
            : "pending",
      ...(idea ? { idea } : {}),
    };
  });

  // The newest failure counts only while its node has not started again; a
  // restart (credit-block auto-resume, retry) supersedes the recorded failure.
  let failedStage: RunEvent | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== "node:failed") continue;
    const restarted = events.some(
      (candidate, j) =>
        j > i &&
        candidate.type === "node:started" &&
        candidate.path === event.path,
    );
    if (!restarted) failedStage = event;
    break;
  }
  let failedStageId =
    failedStage?.type === "node:failed" ? stageForPath(failedStage.path) : undefined;
  if (failedStage?.type === "node:failed" && failedStageId) {
    const failedTiming = stageTimings.get(failedStageId)!;
    failedTiming.error ??= failedStage.error.message;
    failedTiming.finishedAt ??= failedStage.at;
    failedTiming.active = false;
  }
  const reviewTiming = stageTimings.get("review-members")!;
  const reviewJournalPresent = entries.some((entry) =>
    entry.key.includes("/review-members")
  );
  const review = buildReviews(
    finalPanel,
    ideas,
    rawIdeas,
    processorOutput,
    entries,
    events,
    reviewTiming.active ||
      (checkpoint?.status === "running" && reviewJournalPresent),
  );
  const bridgeOutput =
    bridgeReport(artifact(artifacts, "bridgeReport")) ??
    bridgeReport(journalAgent(entries, (key) =>
      key.includes("/bridge-audit") &&
      /\/bridge-audit(?:\/bridge-audit-execute)?::result$/.test(key)
    ));
  const proposalOutput =
    proposal(artifact(artifacts, "finalProposal")) ??
    proposal(journalAgent(entries, (key) =>
      key.includes("/synthesize-proposal") &&
      /\/synthesize-proposal(?:-execute)?::result$/.test(key)
    ));

  const gateResolvedAt = [...events]
    .reverse()
    .find((event) => event.type === "gate:resolved")?.at;
  const confirmGate: ConfirmPanelStage["gate"] = checkpoint?.pendingGates.some(
    (candidate) => stageForPath(candidate.path) === "confirm-panel",
  )
    ? { state: "pending" }
    : gate.automatic || (
        input.settings.panelConfirmation === "auto" &&
        (gate.action !== undefined || firstPassMembers.some((member) => member.status !== "pending"))
      )
      ? {
          state: "auto-approved",
          ...(gateResolvedAt !== undefined ? { decidedAt: gateResolvedAt } : {}),
        }
      : gate.action === "shrink"
        ? {
            state: "shrunk",
            removedMemberIds,
            ...(addedMemberIds.length > 0 ? { addedMemberIds } : {}),
            ...(gateResolvedAt !== undefined
              ? { decidedAt: gateResolvedAt }
              : checkpoint ? { decidedAt: checkpoint.updatedAt } : {}),
          }
        : gate.action === "approve"
          ? {
              state: "approved",
              ...(addedMemberIds.length > 0 ? { addedMemberIds } : {}),
              ...(gateResolvedAt !== undefined
                ? { decidedAt: gateResolvedAt }
                : checkpoint ? { decidedAt: checkpoint.updatedAt } : {}),
            }
          : { state: "not-reached" };

  const direct = new Map<StageId, boolean>([
    ["process-input", processorOutput !== undefined],
    ["decompose-experts", expertsOutput !== undefined],
    ["select-panel", selectedPanel.length > 0],
    ["confirm-panel", confirmGate.state !== "not-reached" && confirmGate.state !== "pending"],
    [
      "first-pass",
      finalPanel.length > 0 &&
        firstPassMembers.every((member) => member.status === "completed"),
    ],
    ["review-members", review.complete],
    ["bridge-audit", bridgeOutput !== undefined],
    ["synthesize-proposal", proposalOutput !== undefined],
    ["done", checkpoint?.status === "completed"],
  ]);
  const journalNodesFor = (id: StageId): readonly string[] =>
    id === "decompose-experts" ? [id, ...DECOMPOSE_SUBNODES] : [id];
  const journalPresent = new Map<StageId, boolean>(
    STAGE_IDS.map((id) => [
      id,
      entries.some((entry) =>
        journalNodesFor(id).some((node) => entry.key.includes(`/${node}`)),
      ) ||
        (checkpoint?.pendingGates.some((gate) => stageForPath(gate.path) === id) ??
          false),
    ]),
  );
  if (checkpoint) {
    for (const id of STAGE_IDS) {
      const timing = stageTimings.get(id)!;
      if ((direct.get(id) || checkpoint.status === "completed") && timing.finishedAt === undefined) {
        timing.startedAt ??= checkpoint.updatedAt;
        timing.finishedAt = checkpoint.updatedAt;
      }
    }
    if (
      ![...stageTimings.values()].some((timing) => timing.active) &&
      (checkpoint.status === "running" ||
        checkpoint.status === "failed" ||
        checkpoint.status === "credit_blocked" ||
        checkpoint.status === "cancelled")
    ) {
      let reached = -1;
      for (const [index, id] of STAGE_IDS.entries()) {
        if (journalPresent.get(id) || direct.get(id)) reached = index;
      }
      const candidate =
        reached < 0
          ? 0
          : direct.get(STAGE_IDS[reached]!)
            ? Math.min(STAGE_IDS.length - 1, reached + 1)
            : reached;
      const id = STAGE_IDS[candidate]!;
      const timing = stageTimings.get(id)!;
      timing.active = true;
      timing.startedAt ??= checkpoint.updatedAt;
      if (checkpoint.status === "failed" && failedStageId === undefined) {
        failedStageId = id;
        if (checkpoint.error?.message) timing.error = checkpoint.error.message;
      }
    }
  }
  const statuses = new Map<StageId, StageStatus>(
    STAGE_IDS.map((id) => [
      id,
      stageStatus(
        id,
        direct.get(id) ?? false,
        stageTimings.get(id)!,
        checkpoint,
        input.status,
        failedStageId,
      ),
    ]),
  );

  if (input.status === "queued") {
    for (const id of STAGE_IDS) statuses.set(id, "pending");
  } else if (input.status === "cancelled" && checkpoint?.status !== "completed") {
    const active = STAGE_IDS.find((id) => statuses.get(id) === "active");
    if (active) statuses.set(active, "cancelled");
  }

  const processBase = base(
    "process-input",
    statuses.get("process-input")!,
    stageTimings.get("process-input")!,
  );
  const decomposeBase = base(
    "decompose-experts",
    statuses.get("decompose-experts")!,
    stageTimings.get("decompose-experts")!,
  );
  const panelBase = base(
    "select-panel",
    statuses.get("select-panel")!,
    stageTimings.get("select-panel")!,
  );
  const confirmBase = base(
    "confirm-panel",
    statuses.get("confirm-panel")!,
    stageTimings.get("confirm-panel")!,
  );
  const firstBase = base(
    "first-pass",
    statuses.get("first-pass")!,
    stageTimings.get("first-pass")!,
  );
  const reviewBase = base(
    "review-members",
    statuses.get("review-members")!,
    reviewTiming,
  );
  const bridgeBase = base(
    "bridge-audit",
    statuses.get("bridge-audit")!,
    stageTimings.get("bridge-audit")!,
  );
  const proposalBase = base(
    "synthesize-proposal",
    statuses.get("synthesize-proposal")!,
    stageTimings.get("synthesize-proposal")!,
  );
  const doneTiming = stageTimings.get("done")!;
  const terminalEvent = [...events].reverse().find((event) =>
    event.type === "run:completed" ||
    event.type === "run:failed" ||
    event.type === "run:cancelled"
  );
  if (doneTiming.finishedAt === undefined && terminalEvent) {
    doneTiming.finishedAt = terminalEvent.at;
  }
  const doneBase = base("done", statuses.get("done")!, doneTiming);

  const stageDurations = STAGE_IDS.flatMap((id) => {
    const timing = stageTimings.get(id)!;
    return timing.startedAt !== undefined && timing.finishedAt !== undefined
      ? [{ stage: id, durationMs: Math.max(0, timing.finishedAt - timing.startedAt) }]
      : [];
  });
  const runStarted = events.find((event) => event.type === "run:started")?.at;
  const summary: RunSummaryView | undefined =
    checkpoint?.status === "completed"
      ? {
          ...(runStarted !== undefined && terminalEvent
            ? { totalDurationMs: Math.max(0, terminalEvent.at - runStarted) }
            : {}),
          stageDurations,
          agentTaskCount:
            new Set(
              events.flatMap((event) =>
                event.type === "agent:started" ? [event.taskId] : []
              ),
            ).size || entries.filter((entry) => entry.kind === "agent").length,
        }
      : undefined;

  const expertCounts = expertsOutput
    ? {
        departments: expertsOutput.departments.length,
        umbrellas: expertsOutput.departments.reduce(
          (count, department) => count + department.umbrellas.length,
          0,
        ),
        subfields: expertsOutput.departments.reduce(
          (count, department) =>
            count +
            department.umbrellas.reduce(
              (nested, umbrella) => nested + umbrella.subfields.length,
              0,
            ),
          0,
        ),
      }
    : undefined;

  // The split decompose pipeline's sub-steps: completion is read from the
  // journal, one line of live progress from each step's artifact, and while
  // the stage is active the first incomplete step is the running one (the
  // sequence is strictly ordered). Absent on single-decomposer bundles.
  const nodeDone = (node: string): boolean =>
    entries.some(
      (entry) => entry.key.includes(`/${node}`) && entry.key.endsWith("::result"),
    );
  const poolValue = object(artifact(artifacts, "pool"));
  const poolMatchesValue = object(artifact(artifacts, "poolMatches"));
  const placementsValue = object(artifact(artifacts, "placements"));
  const receiptValue = object(artifact(artifacts, "suggestionReceipt"));
  const decomposeIsSplit =
    DECOMPOSE_SUBNODES.some((node) =>
      entries.some((entry) => entry.key.includes(`/${node}`)),
    ) ||
    events.some(
      (event) =>
        "path" in event &&
        typeof event.path === "string" &&
        DECOMPOSE_SUBNODES.some((node) => event.path.split("/").includes(node)),
    ) ||
    poolValue !== undefined;
  let decomposeSteps: DecomposeStepView[] | undefined;
  if (decomposeIsSplit) {
    const poolMembers = Array.isArray(poolValue?.members)
      ? poolValue.members.length
      : undefined;
    const poolPapers = Array.isArray(object(poolValue?.grounding)?.papers)
      ? (object(poolValue?.grounding)!.papers as unknown[]).length
      : undefined;
    const matchedCount = Array.isArray(poolMatchesValue?.members)
      ? poolMatchesValue.members.filter((member) => object(member)?.matched === true).length
      : undefined;
    const unmatchedCount = Array.isArray(poolMatchesValue?.unmatched)
      ? poolMatchesValue.unmatched.length
      : undefined;
    const decisionCount = Array.isArray(placementsValue?.decisions)
      ? placementsValue.decisions.length
      : undefined;
    const queuedCount =
      typeof receiptValue?.queued === "number" ? receiptValue.queued : undefined;
    const definitions: readonly {
      id: DecomposeStepView["id"];
      label: string;
      detail: string | undefined;
    }[] = [
      {
        id: "build-pool",
        label: "Build expertise pool",
        detail:
          poolMembers !== undefined
            ? `${poolMembers} member${poolMembers === 1 ? "" : "s"}${
                poolPapers !== undefined ? ` from ${poolPapers} paper${poolPapers === 1 ? "" : "s"}` : ""
              }`
            : undefined,
      },
      {
        id: "match-taxonomy",
        label: "Match shared taxonomy",
        detail:
          matchedCount !== undefined || unmatchedCount !== undefined
            ? `${matchedCount ?? 0} matched · ${unmatchedCount ?? 0} unmatched`
            : undefined,
      },
      {
        id: "place-fields",
        label: "Place unmatched fields",
        detail:
          decisionCount !== undefined
            ? `${decisionCount} decision${decisionCount === 1 ? "" : "s"}`
            : undefined,
      },
      {
        id: "submit-decisions",
        label: "Submit decisions to registry",
        detail: queuedCount !== undefined ? `${queuedCount} queued` : undefined,
      },
      {
        id: "bridge-experts",
        label: "Bridge experts tree",
        detail: expertCounts
          ? `${expertCounts.departments} departments · ${expertCounts.umbrellas} umbrellas`
          : undefined,
      },
    ];
    const decomposeActive = statuses.get("decompose-experts") === "active";
    let sawIncomplete = false;
    decomposeSteps = definitions.map((definition) => {
      const done = nodeDone(definition.id);
      const status: DecomposeStepView["status"] =
        done ? "completed" : decomposeActive && !sawIncomplete ? "active" : "pending";
      if (!done) sawIncomplete = true;
      return {
        id: definition.id,
        label: definition.label,
        status,
        ...(definition.detail !== undefined ? { detail: definition.detail } : {}),
      };
    });
  }

  const stages: StageView[] = [
    {
      ...processBase,
      id: "process-input",
      ...(processorOutput ? { output: processorOutput } : {}),
      ...(filePartition ? { files: filePartition } : {}),
    },
    {
      ...decomposeBase,
      id: "decompose-experts",
      ...(expertsOutput ? { experts: expertsOutput } : {}),
      ...(expertCounts ? { counts: expertCounts } : {}),
      ...(groundingOutput ? { grounding: groundingOutput } : {}),
      ...(decomposeSteps ? { steps: decomposeSteps } : {}),
    },
    {
      ...panelBase,
      id: "select-panel",
      ...(selectedPanel.length > 0 ? { panel: selectedPanel } : {}),
      ...(expertCounts ? { leavesAvailable: expertCounts.umbrellas } : {}),
    },
    { ...confirmBase, id: "confirm-panel", gate: confirmGate },
    { ...firstBase, id: "first-pass", members: firstPassMembers },
    {
      ...reviewBase,
      id: "review-members",
      members: review.members,
      ...(review.cursor ? { cursor: review.cursor } : {}),
    },
    {
      ...bridgeBase,
      id: "bridge-audit",
      ...(bridgeOutput ? { bridge: bridgeOutput } : {}),
    },
    {
      ...proposalBase,
      id: "synthesize-proposal",
      ...(proposalOutput ? { proposal: proposalOutput } : {}),
    },
    { ...doneBase, id: "done", ...(summary ? { summary } : {}) },
  ];

  const activeStage = stages.find(
    (stage) =>
      stage.status === "active" ||
      stage.status === "suspended" ||
      stage.status === "credit_blocked",
  )?.id;
  const contentBundle = readContentBundle(input.jobDir);
  // The pending gate view, enriched with the record's auto-approve countdown
  // so the dashboard can render the progress bar (and its held state).
  const pendingGateBase = pendingGate(checkpoint, selectedPanel);
  const autoApprove = input.record.gateAutoApprove;
  const pendingGateView: PendingGateView | undefined = pendingGateBase
    ? {
        ...pendingGateBase,
        ...(autoApprove !== undefined &&
        autoApprove.gateKey === pendingGateBase.gateKey
          ? {
              autoApprove: {
                deadlineAt: autoApprove.deadlineAt,
                totalMs: autoApprove.totalMs,
                held: autoApprove.heldAt !== undefined,
              },
            }
          : {}),
      }
    : undefined;
  return {
    jobId: input.record.jobId,
    topic: input.record.topic,
    status: input.status,
    runner: input.record.runner,
    createdAt: input.record.createdAt,
    updatedAt: Math.max(input.record.updatedAt, checkpoint?.updatedAt ?? 0),
    ...(input.record.slurmJobId ? { slurmJobId: input.record.slurmJobId } : {}),
    ...(contentBundle ? { contentBundle } : {}),
    ...(input.record.trashedAt !== undefined
      ? { trashedAt: input.record.trashedAt }
      : {}),
    progress: {
      ...(activeStage ? { activeStage } : {}),
      completedStages: stages.filter((stage) => stage.status === "completed").length,
      totalStages: STAGE_IDS.length,
      ...(review.cursor ? { reviewCursor: review.cursor } : {}),
    },
    ...(input.record.error ?? checkpoint?.error?.message
      ? { error: input.record.error ?? checkpoint?.error?.message }
      : {}),
    ...(checkpoint?.creditBlock
      ? {
          creditBlock: {
            ...(checkpoint.creditBlock.retryAt !== undefined
              ? { retryAt: checkpoint.creditBlock.retryAt }
              : {}),
            providerMessage: checkpoint.creditBlock.providerMessage,
            source: checkpoint.creditBlock.source,
          },
        }
      : {}),
    stages,
    ...(pendingGateView ? { pendingGate: pendingGateView } : {}),
  };
}

export function compactJobDetail(detail: JobDetail): Omit<JobDetail, "stages" | "pendingGate"> {
  const { stages: _stages, pendingGate: _pendingGate, ...summary } = detail;
  return summary;
}
