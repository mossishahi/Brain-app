import { z } from "zod";

/**
 * Artifact schemas: the structured objects every agent step of the brainstorm
 * workflow must return. Skills describe these shapes in prose; the runtime
 * validates agent output against the schema named on the workflow node.
 */

/** A non-empty text block containing exactly `n` paragraphs separated by blank lines. */
const paragraphs = (n: number) =>
  z.string().refine(
    (s) => s.trim().length > 0 && s.trim().split(/\n[ \t]*\n/).length === n,
    { message: `must contain exactly ${n} paragraph(s) separated by blank lines` },
  );

const paragraphArray = (n: number) =>
  z.array(paragraphs(1)).length(n);

const nonEmpty = z.string().min(1);

/**
 * The closed catalog of requested epistemic acts — what the submitter wants
 * the panel to DO, not the grammatical shape the request arrived in
 * (mirrored by catalog/input-types.json). `develop` is the residual/default
 * act; every other act is chosen only when its specific cue is present.
 */
export const INPUT_TYPES = [
  "develop",
  "resolve",
  "verify",
  "assess-feasibility",
  "critique",
  "interpret",
  "survey",
  "explain",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

/** Epistemic acts whose output is positioned against a literature map. */
const NOVELTY_ACTS = new Set<InputType>(["develop", "resolve", "survey"]);

/** The three review verdicts (mirrored by catalog/verdicts.json). */
export const VERDICTS = ["Pass", "Build", "Interrupt"] as const;
export type Verdict = (typeof VERDICTS)[number];

// ---------------------------------------------------------------------------
// processor
// ---------------------------------------------------------------------------

/**
 * The closed relation-label catalog for attached files. `NA` is the single
 * predefined "useless for this submission" label; the orchestrator strips
 * NA-labeled files before any later model call sees the file list.
 */
export const FILE_LABELS = [
  "code",
  "implementation",
  "data",
  "paper",
  "similar-method",
  "documentation",
  "media",
  "other",
  "NA",
] as const;

export type FileLabel = (typeof FILE_LABELS)[number];

/**
 * One attached file, annotated by the processor: the exact inventory path,
 * one closed relation label, and a one-line note on how the file relates to
 * the prompt (empty only for NA).
 */
export const annotatedFileSchema = z
  .object({
    /** Copied verbatim from the submission's attachment inventory. */
    path: nonEmpty,
    label: z.enum(FILE_LABELS),
    /** How this file relates to the prompt; empty only when label is NA. */
    note: z.string(),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (file.label !== "NA" && file.note.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: `a "${file.label}" file needs a note explaining its relation to the prompt`,
      });
    }
  });

export type AnnotatedFile = z.infer<typeof annotatedFileSchema>;

export const processorOutputSchema = z
  .object({
    /** Exactly one key of the input-type catalog, copied verbatim. */
    type: z.enum(INPUT_TYPES),
    title: nonEmpty,
    /** The core scientific question, stated precisely. */
    question: nonEmpty,
    /** Background needed to understand the question; empty string when none can be determined. */
    context: z.string(),
    /** One entry per submitted attachment; empty when there are none. */
    attachments: z.array(z.object({ name: nonEmpty, note: nonEmpty }).strict()),
    /** Implied-but-unstated assumptions; empty when there are none. */
    assumptions: z.array(nonEmpty),
    /** How many reasoning steps a panel member should produce when developing this input. */
    cotSteps: z.number().int().min(3).max(9),
    /**
     * One annotated entry per file of the attachment inventory (empty when
     * the submission has no attachments). Optional so pre-attachment
     * artifacts stay valid.
     */
    files: z.array(annotatedFileSchema).max(400).optional(),
  })
  .strict();

export type ProcessorOutput = z.infer<typeof processorOutputSchema>;

/**
 * The two orchestrator-derived partitions of the processor's file map. The
 * useful list is the only file list later model calls receive; the ignored
 * list is kept as a separate audit artifact.
 */
export const usefulFilesSchema = z
  .object({
    files: z.array(annotatedFileSchema).max(400),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.files.forEach((file, index) => {
      if (file.label === "NA") {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "label"],
          message: "the useful-file list must not contain NA entries",
        });
      }
    });
  });

export type UsefulFiles = z.infer<typeof usefulFilesSchema>;

export const ignoredFilesSchema = z
  .object({
    files: z.array(annotatedFileSchema).max(400),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.files.forEach((file, index) => {
      if (file.label !== "NA") {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "label"],
          message: "the ignored-file list may only contain NA entries",
        });
      }
    });
  });

export type IgnoredFiles = z.infer<typeof ignoredFilesSchema>;

// ---------------------------------------------------------------------------
// shared literature shapes
// ---------------------------------------------------------------------------

/**
 * One work surfaced by a literature search. Used by the decomposer's
 * grounding record and by each member's literature review (dashboard
 * artifacts).
 */
export const paperSchema = z
  .object({
    id: nonEmpty.optional(),
    title: nonEmpty,
    authors: z.array(nonEmpty).optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    url: z.string().optional(),
    /** One line: what this work does relative to the topic. */
    relation: z.string().optional(),
  })
  .strict();

export type Paper = z.infer<typeof paperSchema>;

// ---------------------------------------------------------------------------
// experts / panel
// ---------------------------------------------------------------------------

/**
 * Ordered three-level expertise tree in constrained-output-safe form.
 * Arrays preserve relevance order without arbitrary JSON object keys (dynamic
 * property names are not reliably supported by provider structured outputs).
 */
export const expertUmbrellaSchema = z
  .object({
    name: nonEmpty,
    subfields: z.array(nonEmpty).max(30),
  })
  .strict();

export const expertDepartmentSchema = z
  .object({
    name: nonEmpty,
    umbrellas: z.array(expertUmbrellaSchema).min(1).max(30),
  })
  .strict()
  .superRefine((department, ctx) => {
    const seen = new Set<string>();
    department.umbrellas.forEach((umbrella, index) => {
      if (seen.has(umbrella.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["umbrellas", index, "name"],
          message: `duplicate umbrella "${umbrella.name}"`,
        });
      }
      seen.add(umbrella.name);
    });
  });

/**
 * One author enumerated from a retrieved paper's byline, with the outcome of
 * the academic-profile-lookup technique. Fixed flat fields only
 * (constrained-output-safe); empty string / empty array mean "not found".
 */
export const scholarSchema = z
  .object({
    name: nonEmpty,
    /** Affiliation from the resolved profile; empty when unknown. */
    affiliation: z.string(),
    /** Resolved profile URL; empty when none. */
    url: z.string(),
    /** Outcome of academic-profile-lookup: ok | ambiguous | no_profile. */
    profile: z.enum(["ok", "ambiguous", "no_profile"]),
    /** Research interests copied verbatim from the resolved profile; empty otherwise. */
    interests: z.array(nonEmpty).max(30),
  })
  .strict()
  .superRefine((scholar, ctx) => {
    if (scholar.profile !== "ok" && scholar.interests.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["interests"],
        message: `a ${scholar.profile} lookup must not carry interests`,
      });
    }
  });

export type Scholar = z.infer<typeof scholarSchema>;

/**
 * The literature grounding behind the expertise tree: the papers the
 * decomposer retrieved and the authors whose verbatim research interests the
 * umbrella terms trace to (dashboard artifact; panel selection ignores it).
 */
export const expertsGroundingSchema = z
  .object({
    papers: z.array(paperSchema).min(1).max(15),
    scholars: z.array(scholarSchema).min(1).max(60),
  })
  .strict();

export type ExpertsGrounding = z.infer<typeof expertsGroundingSchema>;

export const expertsTreeSchema = z
  .object({
    departments: z.array(expertDepartmentSchema).min(1).max(12),
    /**
     * Required whenever the literature search ran (it always does when
     * web-search is available); optional so pre-grounding artifacts and runs
     * without retrieved papers stay valid.
     */
    grounding: expertsGroundingSchema.optional(),
  })
  .strict()
  .superRefine((tree, ctx) => {
    const seen = new Set<string>();
    tree.departments.forEach((department, index) => {
      if (seen.has(department.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["departments", index, "name"],
          message: `duplicate department "${department.name}"`,
        });
      }
      seen.add(department.name);
    });
  });

export type ExpertsTree = z.infer<typeof expertsTreeSchema>;

export const panelMemberSchema = z
  .object({
    id: nonEmpty,
    department: nonEmpty,
    umbrella: nonEmpty,
    subfields: z.array(nonEmpty),
  })
  .strict();

export type PanelMember = z.infer<typeof panelMemberSchema>;

/**
 * The seated panel produced by the deterministic panel-selection activity.
 * The experts tree remains a separate upstream artifact; panel members copy
 * their expertise from its (department, umbrella) leaves. At least two members
 * are required so that every review step has at least one commentor.
 */
export const panelSchema = z
  .object({
    members: z.array(panelMemberSchema).min(2),
  })
  .strict()
  .superRefine((panel, ctx) => {
    const ids = new Set<string>();
    const seats = new Set<string>();
    panel.members.forEach((m, i) => {
      if (ids.has(m.id)) {
        ctx.addIssue({ code: "custom", path: ["members", i, "id"], message: `duplicate member id "${m.id}"` });
      }
      ids.add(m.id);
      const seat = `${m.department}\u0000${m.umbrella}`;
      if (seats.has(seat)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", i],
          message: `duplicate seat for (${m.department}, ${m.umbrella}) — one member per leaf`,
        });
      }
      seats.add(seat);
    });
  });

export type Panel = z.infer<typeof panelSchema>;

// ---------------------------------------------------------------------------
// evidence (shared by verification-bearing fields across acts, and by review)
// ---------------------------------------------------------------------------

/**
 * The evidence that must back a truth- or validity-bearing claim: a runnable
 * script, a self-contained mathematical derivation, or a real citable
 * reference. Assertion alone never qualifies. Shared by the review loop's
 * Interrupt verdicts and by every developed-output body that renders its own
 * verdict (resolve's verification, verify's evidence, critique's issues).
 */
export const evidenceSchema = z
  .object({
    kind: z.enum(["none", "script", "math", "reference"]),
    code: z.string(),
    result: z.string(),
    derivation: z.string(),
    citation: z.string(),
    locator: z.string(),
    shows: z.string(),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const require = (field: keyof typeof evidence): void => {
      if (evidence[field] === "") {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${evidence.kind} evidence requires ${field}`,
        });
      }
    };
    const forbid = (field: keyof typeof evidence): void => {
      if (evidence[field] !== "") {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${evidence.kind} evidence must use an empty ${field}`,
        });
      }
    };
    if (evidence.kind === "none") {
      ["code", "result", "derivation", "citation", "locator", "shows"].forEach(
        (field) => forbid(field as keyof typeof evidence),
      );
    } else if (evidence.kind === "script") {
      require("code");
      ["derivation", "citation", "locator", "shows"].forEach((field) =>
        forbid(field as keyof typeof evidence),
      );
    } else if (evidence.kind === "math") {
      require("derivation");
      ["code", "result", "citation", "locator", "shows"].forEach((field) =>
        forbid(field as keyof typeof evidence),
      );
    } else {
      require("citation");
      require("locator");
      require("shows");
      ["code", "result", "derivation"].forEach((field) =>
        forbid(field as keyof typeof evidence),
      );
    }
  });

export type Evidence = z.infer<typeof evidenceSchema>;

/** A confidence rating with a one-line rationale; reused by verify and interpret. */
export const confidenceSchema = z
  .object({
    level: z.enum(["high", "medium", "low"]),
    rationale: nonEmpty,
  })
  .strict();

export type Confidence = z.infer<typeof confidenceSchema>;

// ---------------------------------------------------------------------------
// developed-output bodies: one shape per epistemic act
// ---------------------------------------------------------------------------

/** develop — build an under-specified idea into a full research contribution. */
export const developBodySchema = z
  .object({
    abstract: paragraphArray(3),
    introduction: paragraphArray(3),
    method: paragraphArray(3),
    discussion: paragraphArray(3),
    conclusion: paragraphArray(1),
  })
  .strict();

export type DevelopBody = z.infer<typeof developBodySchema>;

/** One prior result the resolve act's approach must be positioned against. */
export const knownResultSchema = z
  .object({
    result: nonEmpty,
    sourceType: z.enum(["theorem", "bound", "partial-result", "counterexample-attempt"]),
    relation: nonEmpty,
  })
  .strict();

/** resolve — attempt a formally posed problem: prove, disprove, construct, or bound it. */
export const resolveBodySchema = z
  .object({
    problemStatement: paragraphs(1),
    knownResults: z.array(knownResultSchema).max(30),
    approach: paragraphs(1),
    /** Proof or construction steps, one per paragraph. */
    derivation: z.array(paragraphs(1)).min(1).max(20),
    /** A self-check of the derivation: script, independent re-derivation, or none. */
    verification: evidenceSchema,
    status: z.enum(["resolved", "partial", "refuted", "still-open"]),
    remainingGaps: z.array(nonEmpty),
    significance: paragraphs(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.status === "resolved" && body.remainingGaps.length > 0) {
      ctx.addIssue({ code: "custom", path: ["remainingGaps"], message: "a resolved status leaves no remaining gaps" });
    }
    if (body.status !== "resolved" && body.remainingGaps.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["remainingGaps"],
        message: "a status other than resolved must name at least one remaining gap",
      });
    }
  });

export type ResolveBody = z.infer<typeof resolveBodySchema>;

/** verify — adjudicate one specific claim, proof step, or previously published finding. */
export const verifyBodySchema = z
  .object({
    claim: nonEmpty,
    /** Where the claim comes from: the submitter's own hypothesis, or a located attachment passage. */
    claimSource: nonEmpty,
    verdict: z.enum(["confirmed", "refuted", "partially-correct", "indeterminate"]),
    evidence: evidenceSchema,
    reasoning: paragraphs(1),
    confidence: confidenceSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.verdict !== "indeterminate" && body.evidence.kind === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "confirmed, refuted, and partially-correct verdicts require script, math, or reference evidence",
      });
    }
  });

export type VerifyBody = z.infer<typeof verifyBodySchema>;

/** One aspect of a design's methodology, judged on its own terms. */
export const soundnessAspectSchema = z
  .object({
    aspect: nonEmpty,
    assessment: z.enum(["sound", "concern", "flaw"]),
    note: nonEmpty,
  })
  .strict();

/** assess-feasibility — a Registered-Reports-style soundness review of a not-yet-run design. */
export const assessFeasibilityBodySchema = z
  .object({
    designSummary: paragraphs(1),
    importance: paragraphs(1),
    hypothesisLogic: paragraphs(1),
    methodologySoundness: z.array(soundnessAspectSchema).min(1).max(15),
    replicability: paragraphs(1),
    feasibilityVerdict: z.enum(["feasible-as-is", "feasible-with-changes", "not-feasible"]),
    requiredChanges: z.array(nonEmpty),
    alternativeDesigns: z.array(nonEmpty),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.feasibilityVerdict === "feasible-as-is" && body.requiredChanges.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["requiredChanges"],
        message: "feasible-as-is leaves no required changes",
      });
    }
    if (body.feasibilityVerdict !== "feasible-as-is" && body.requiredChanges.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["requiredChanges"],
        message: "a design that is not feasible-as-is must name at least one required change",
      });
    }
  });

export type AssessFeasibilityBody = z.infer<typeof assessFeasibilityBodySchema>;

/** One itemized finding in a critique, with severity and a fix suggestion. */
export const critiqueIssueSchema = z
  .object({
    description: nonEmpty,
    severity: z.enum(["minor", "major", "critical"]),
    evidence: evidenceSchema,
    suggestion: z.string(),
  })
  .strict();

/** critique — a holistic, itemized review of a finished artifact. */
export const critiqueBodySchema = z
  .object({
    artifactSummary: paragraphs(1),
    strengths: z.array(nonEmpty).min(1),
    issues: z.array(critiqueIssueSchema),
    missingConsiderations: z.array(nonEmpty),
    recommendation: z.enum(["sound", "sound-with-revisions", "not-sound"]),
    prioritizedNextSteps: z
      .array(z.object({ priority: z.number().int().min(1), action: nonEmpty }).strict())
      .min(1),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.recommendation === "sound" && body.issues.some((issue) => issue.severity === "critical")) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "a critical issue cannot coexist with a sound recommendation",
      });
    }
  });

export type CritiqueBody = z.infer<typeof critiqueBodySchema>;

/** One candidate reading of an observation, ranked against the others. */
export const interpretationCandidateSchema = z
  .object({
    interpretation: nonEmpty,
    supportingEvidence: z.string(),
    contradictingEvidence: z.string(),
    plausibility: z.enum(["high", "medium", "low"]),
  })
  .strict();

/** interpret — sense-making of the submitter's own specific result or observation. */
export const interpretBodySchema = z
  .object({
    observationSummary: paragraphs(1),
    candidateInterpretations: z.array(interpretationCandidateSchema).min(1).max(10),
    mostLikelyInterpretation: paragraphs(1),
    confidence: confidenceSchema,
    threatsToValidity: z.array(nonEmpty),
    implications: z.string(),
  })
  .strict();

export type InterpretBody = z.infer<typeof interpretBodySchema>;

/** One school of thought or family of approaches in a landscape map. */
export const landscapeGroupSchema = z
  .object({
    name: nonEmpty,
    works: z.array(paperSchema).max(15),
    characterization: nonEmpty,
  })
  .strict();

/** One dimension along which the surveyed approaches are compared. */
export const comparisonRowSchema = z
  .object({
    dimension: nonEmpty,
    comparison: nonEmpty,
  })
  .strict();

/** survey — map existing work and, if a decision was requested, compare and recommend. */
export const surveyBodySchema = z
  .object({
    landscapeMap: z.array(landscapeGroupSchema).min(1).max(12),
    /** Only populated when the submitter actually asked to compare or choose between options. */
    comparisonTable: z.array(comparisonRowSchema),
    consensusAndFrontier: paragraphs(1),
    openGaps: z.array(nonEmpty),
    /** Only populated when the submitter asked which option to use. */
    recommendation: z.string(),
  })
  .strict();

export type SurveyBody = z.infer<typeof surveyBodySchema>;

/** One misconception an explanation should preempt or correct. */
export const misconceptionSchema = z
  .object({
    misconception: nonEmpty,
    correction: nonEmpty,
  })
  .strict();

/** explain — pedagogical exposition of an established concept, method, or topic. */
export const explainBodySchema = z
  .object({
    motivatingQuestion: paragraphs(1),
    coreIntuition: paragraphs(1),
    formalTreatment: paragraphs(1),
    workedExample: paragraphs(1),
    commonMisconceptions: z.array(misconceptionSchema),
    connections: z.array(nonEmpty),
  })
  .strict();

export type ExplainBody = z.infer<typeof explainBodySchema>;

/**
 * The full developed-output envelope: exactly one body populated, matching
 * `type`, which mirrors the run's `input.type` (the runtime cross-checks the
 * two — see brainstorm-runtime's writeValidatedOutput). One flat schema kept
 * deliberately (never a `oneOf`/discriminated union): every field the model
 * could possibly need is always a plain declared property, exactly like
 * `evidenceSchema` already does for its four evidence kinds — only the
 * *conditional requiredness*, enforced below, changes per act.
 */
export const developedOutputSchema = z
  .object({
    type: z.enum(INPUT_TYPES),
    develop: developBodySchema.optional(),
    resolve: resolveBodySchema.optional(),
    verify: verifyBodySchema.optional(),
    "assess-feasibility": assessFeasibilityBodySchema.optional(),
    critique: critiqueBodySchema.optional(),
    interpret: interpretBodySchema.optional(),
    survey: surveyBodySchema.optional(),
    explain: explainBodySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bodies: Record<InputType, unknown> = {
      develop: value.develop,
      resolve: value.resolve,
      verify: value.verify,
      "assess-feasibility": value["assess-feasibility"],
      critique: value.critique,
      interpret: value.interpret,
      survey: value.survey,
      explain: value.explain,
    };
    for (const act of INPUT_TYPES) {
      const present = bodies[act] !== undefined && bodies[act] !== null;
      if (act === value.type && !present) {
        ctx.addIssue({ code: "custom", path: [act], message: `type "${value.type}" requires a populated "${act}" body` });
      }
      if (act !== value.type && present) {
        ctx.addIssue({ code: "custom", path: [act], message: `"${act}" must be absent when type is "${value.type}"` });
      }
    }
  });

export type DevelopedOutput = z.infer<typeof developedOutputSchema>;

// ---------------------------------------------------------------------------
// brain idea (first pass) and redevelopment (revision)
// ---------------------------------------------------------------------------

export const brainIdeaSchema = z
  .object({
    output: developedOutputSchema,
    /** The chain of thought: one paragraph per step, forward-only, in order. */
    cot: z.array(paragraphs(1)).min(3).max(9),
    /**
     * One paragraph naming the closest prior works and what this idea does
     * that none of them does. Required only for acts positioned against a
     * literature map (develop, resolve, survey); omitted otherwise.
     */
    novelty: paragraphs(1).optional(),
    /** The works the literature review surfaced; omit when none were found. */
    literature: z.array(paperSchema).max(30).optional(),
  })
  .strict()
  .superRefine((idea, ctx) => {
    const wantsNovelty = NOVELTY_ACTS.has(idea.output.type);
    if (wantsNovelty && idea.novelty === undefined) {
      ctx.addIssue({ code: "custom", path: ["novelty"], message: `type "${idea.output.type}" requires a novelty statement` });
    }
    if (!wantsNovelty && idea.novelty !== undefined) {
      ctx.addIssue({ code: "custom", path: ["novelty"], message: `type "${idea.output.type}" must omit novelty` });
    }
  });

export type BrainIdea = z.infer<typeof brainIdeaSchema>;

/**
 * A member's revision after a Build/Interrupt on one step: the runtime keeps
 * chain steps before `fromStep` frozen and replaces everything from `fromStep`
 * on with `revisedSteps`; `output` and `novelty` replace the previous ones.
 */
export const redevelopmentSchema = z
  .object({
    fromStep: z.number().int().min(1),
    output: developedOutputSchema,
    revisedSteps: z.array(paragraphs(1)).min(1),
    novelty: paragraphs(1).optional(),
  })
  .strict()
  .superRefine((revision, ctx) => {
    const wantsNovelty = NOVELTY_ACTS.has(revision.output.type);
    if (wantsNovelty && revision.novelty === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["novelty"],
        message: `type "${revision.output.type}" requires a novelty statement`,
      });
    }
    if (!wantsNovelty && revision.novelty !== undefined) {
      ctx.addIssue({ code: "custom", path: ["novelty"], message: `type "${revision.output.type}" must omit novelty` });
    }
  });

export type Redevelopment = z.infer<typeof redevelopmentSchema>;

// ---------------------------------------------------------------------------
// review: comment, judge decision
// ---------------------------------------------------------------------------

/**
 * A substantive free-text field: long enough that placeholder probes ("test",
 * "ok") can never satisfy the contract. minLength is representable in JSON
 * Schema, so providers with native structured output reject placeholders at
 * the tool boundary instead of after a full round-trip.
 */
const substantiveReason = z
  .string()
  .min(30, "reason must be a substantive explanation (at least 30 characters)");

/** Build suggestions must be actionable sentences, not stubs. */
const requireConcreteSuggestion = (
  suggestion: string,
  ctx: z.RefinementCtx,
): void => {
  if (suggestion.trim().length < 20) {
    ctx.addIssue({
      code: "custom",
      path: ["suggestion"],
      message:
        "Build requires a concrete suggestion (at least 20 characters)",
    });
  }
};

/**
 * One commentor's verdict on a single chain-of-thought step.
 *
 * Suggestion tolerance is deliberate: only Build REQUIRES a suggestion; a
 * suggestion accompanying Pass/Interrupt is accepted and simply carried as
 * extra context (models reliably attach fix hints to Interrupts, and failing
 * a whole task over that field is disproportionate). Evidence rules stay
 * strict — they carry the verdict semantics.
 */
export const commentSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    reason: substantiveReason,
    suggestion: z.string(),
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine((comment, ctx) => {
    if (comment.verdict === "Build") {
      requireConcreteSuggestion(comment.suggestion, ctx);
    }
    if (comment.verdict === "Interrupt" && comment.evidence.kind === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Interrupt requires script, math, or reference evidence",
      });
    }
    if (comment.verdict !== "Interrupt" && comment.evidence.kind !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${comment.verdict} must use {kind:"none"} evidence`,
      });
    }
  });

export type Comment = z.infer<typeof commentSchema>;

/**
 * Per-commentor classification in constrained-output-safe form. An ordered
 * array avoids arbitrary JSON object keys while retaining commentor identity.
 */
const assessmentSchema = z
  .array(
    z
      .object({
        commentorId: nonEmpty,
        basis: z.enum(["verified", "authority"]),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .refine(
    (items) =>
      new Set(items.map((item) => item.commentorId)).size === items.length,
    { message: "assessment must classify each commentor at most once" },
  );

/**
 * The judge's single decision for a step, aggregating the commentors'
 * verdicts. Same suggestion tolerance as commentSchema: required-and-concrete
 * for Build, otherwise accepted as extra context for the redeveloper.
 */
export const judgeDecisionSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    reason: substantiveReason,
    suggestion: z.string(),
    evidence: evidenceSchema,
    assessment: assessmentSchema,
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.verdict === "Build") {
      requireConcreteSuggestion(decision.suggestion, ctx);
    }
    if (
      decision.verdict === "Interrupt" &&
      decision.evidence.kind === "none"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Interrupt requires script, math, or reference evidence",
      });
    }
    if (
      decision.verdict !== "Interrupt" &&
      decision.evidence.kind !== "none"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${decision.verdict} must use {kind:"none"} evidence`,
      });
    }
  });

export type JudgeDecision = z.infer<typeof judgeDecisionSchema>;

// ---------------------------------------------------------------------------
// final proposal
// ---------------------------------------------------------------------------

export const finalProposalSchema = z
  .object({
    title: nonEmpty,
    /** The sharpened question and why it matters. */
    framing: nonEmpty,
    /** Directions multiple members' Outputs converge on. */
    consensus: z.array(nonEmpty),
    /** Substantive disagreements across members worth pursuing. */
    tensions: z.array(nonEmpty),
    /** Ideas that emerged from the cross-disciplinary panel. */
    novelDirections: z.array(nonEmpty),
    /** Concrete, prioritized next steps (priority 1 = most urgent). */
    actionItems: z
      .array(
        z
          .object({
            priority: z.number().int().min(1),
            action: nonEmpty,
            rationale: nonEmpty.optional(),
          })
          .strict(),
      )
      .min(1),
    /** What solving this unlocks elsewhere. */
    applications: z.array(nonEmpty),
  })
  .strict();

export type FinalProposal = z.infer<typeof finalProposalSchema>;

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Every schema an agent or activity node's `output.schema` may reference, by name. */
export const artifactSchemas = {
  processorOutput: processorOutputSchema,
  usefulFiles: usefulFilesSchema,
  ignoredFiles: ignoredFilesSchema,
  experts: expertsTreeSchema,
  panel: panelSchema,
  brainIdea: brainIdeaSchema,
  comment: commentSchema,
  judgeDecision: judgeDecisionSchema,
  redevelopment: redevelopmentSchema,
  finalProposal: finalProposalSchema,
} as const;

export type ArtifactSchemaName = keyof typeof artifactSchemas;
