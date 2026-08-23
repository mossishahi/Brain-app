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
 * What a model submits while probing a failing tool instead of answering it.
 *
 * A structured-output transport that rejects a valid payload invites exactly
 * this: the model shrinks its submission until something is accepted. A bare
 * "test-title" satisfies a non-empty string, so the probe becomes the artifact,
 * and every later stage reads a placeholder as the research input — the
 * decomposer then searches the literature for "test" and seats a panel of
 * software-testing experts. Only a whole degenerate value matches; a real title
 * that merely begins with one of these words ("Test-time adaptation for graph
 * networks") does not.
 */
const PLACEHOLDER_VALUE =
  /^(?:test|tests|todo|tbd|placeholder|example|sample|dummy|lorem|ipsum|foo|bar|baz|qux|n\/?a|none|null|unknown|undefined|string|value|text|title|question|context|name|note|xxx+|\.+|-+)(?:[-_\s]?(?:title|question|context|value|name|note|text|string|here|\d+))?$/i;

/**
 * A field whose value must be an actual answer: long enough to carry one, and
 * not one of the probe values above. The floor stays low enough that a terse
 * but real answer passes; the pattern is what rejects a probe.
 */
function answered(minLength: number, label: string) {
  return z
    .string()
    .min(minLength, `${label} must be a real answer (at least ${minLength} characters)`)
    .refine((value) => !PLACEHOLDER_VALUE.test(value.trim()), {
      message: `${label} is a placeholder, not an answer derived from the submission`,
    });
}

/**
 * The closed catalog of output SHAPES — the structural forms a member's
 * finished output can take. Shapes are code: each one has a body schema
 * below, a dashboard view, and prompt mechanics. Which submission types
 * exist, what they are called, and which shape each one produces is NOT
 * code — it is data, declared per type in the bundle's
 * catalog/input-types.json and enforced against the loaded catalog at
 * runtime. Renaming, describing, or re-mapping types is a content edit;
 * only inventing a genuinely new structure touches this file.
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

/** File relation labels that mark an entry as source code to annotate. */
export const CODE_FILE_LABELS: readonly FileLabel[] = ["code", "implementation"];

/**
 * The code annotator's one-line account of a code file: what the file
 * contains plus how it bears on the input topic. Exactly one line, long
 * enough to carry an actual description, and never a placeholder probe.
 * There is deliberately no style-level length cap — "one line" is the whole
 * formatting contract; the generous ceiling below only stops runaway
 * generation from bloating the file map that every later task's payload
 * carries.
 */
const codeSummaryValue = z
  .string()
  .min(10, "codeSummary must be a real one-line description (at least 10 characters)")
  .max(2000, "codeSummary is runaway output; keep it to one descriptive line")
  .refine((value) => !/[\r\n]/.test(value), {
    message: "codeSummary must be exactly one line",
  })
  .refine((value) => !PLACEHOLDER_VALUE.test(value.trim()), {
    message: "codeSummary is a placeholder, not a description derived from the file",
  });

/**
 * One attached file, annotated by the processor: the exact inventory path,
 * one closed relation label, and a one-line note on how the file relates to
 * the prompt (empty only for NA). Code files additionally gain a
 * `codeSummary` when the code-annotation pass has run: the annotator's
 * one-line account of what the file contains, folded in deterministically by
 * the runtime (attachments.annotate) — never self-reported by a later model.
 */
export const annotatedFileSchema = z
  .object({
    /** Copied verbatim from the submission's attachment inventory. */
    path: nonEmpty,
    label: z.enum(FILE_LABELS),
    /** How this file relates to the prompt; empty only when label is NA. */
    note: z.string(),
    /** The code annotator's one-line content summary; code files only. */
    codeSummary: codeSummaryValue.optional(),
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

/**
 * One output the submitter EXPLICITLY asked the panel to deliver, beyond the
 * standard deliverable the submission's type already produces (e.g. "also
 * give me pseudocode for the algorithm", "provide a comparison table of A
 * and B"). Detected by the processor from explicit phrasing only — never
 * inferred from topic or tone. Every panel member's developed output must
 * answer every recorded entry with a dedicated `requested` section; the
 * runtime enforces that per task and on write.
 */
export const requestedOutputSchema = z
  .object({
    /** Short section label for the deliverable; unique across entries. */
    title: answered(4, "requested-output title"),
    /** Precisely what the submitter asked to receive, restated faithfully. */
    ask: answered(12, "requested-output ask"),
  })
  .strict();

export type RequestedOutput = z.infer<typeof requestedOutputSchema>;

export const processorOutputSchema = z
  .object({
    /**
     * Exactly one key of the loaded catalog/input-types.json, copied verbatim.
     * The catalog is data, so this cannot be a static enum — the task compiler
     * narrows it to the loaded catalog's keys per run, and the runtime
     * cross-checks membership on write (writeValidatedOutput) whenever the
     * field is present. OPTIONAL since workflow 0.14.0: classification is a
     * separate stage (the classifier agent), and the deterministic
     * classification.apply merge writes the decided type into the structured
     * input. Bundles up to 0.13.0 still emit it from the processor directly.
     */
    type: nonEmpty
      .describe(
        "One category name from the option set in the instructions, copied verbatim.",
      )
      .optional(),
    title: answered(4, "title"),
    /** The core scientific question, stated precisely. */
    question: answered(12, "question"),
    /**
     * Background needed to understand the question. Legitimately empty when the
     * submission carries none, so there is no length floor — but a placeholder
     * is still refused, since it means the field was invented rather than left
     * blank.
     */
    context: z.string().refine(
      (value) => value.trim() === "" || !PLACEHOLDER_VALUE.test(value.trim()),
      { message: "context is a placeholder; leave it empty instead of inventing one" },
    ),
    /** One entry per submitted attachment; empty when there are none. */
    attachments: z.array(z.object({ name: nonEmpty, note: nonEmpty }).strict()),
    /** Implied-but-unstated assumptions; empty when there are none. */
    assumptions: z.array(nonEmpty),
    /**
     * How many reasoning steps a panel member should produce when developing
     * this input. OPTIONAL since workflow 0.14.0 — decided by the classifier
     * and merged in by classification.apply (see `type`).
     */
    cotSteps: z.number().int().min(3).max(9).optional(),
    /**
     * The outputs the submitter EXPLICITLY asked for beyond the type's
     * standard deliverable; empty when the submission names none (the common
     * case). Optional so pre-feature artifacts stay valid. Every member's
     * developed output must answer each entry, in this order.
     */
    requestedOutputs: z.array(requestedOutputSchema).max(4).optional(),
    /**
     * One annotated entry per file of the attachment inventory (empty when
     * the submission has no attachments). Optional so pre-attachment
     * artifacts stay valid.
     */
    files: z.array(annotatedFileSchema).max(400).optional(),
  })
  .strict()
  .superRefine((output, ctx) => {
    const seen = new Set<string>();
    (output.requestedOutputs ?? []).forEach((entry, index) => {
      if (seen.has(entry.title)) {
        ctx.addIssue({
          code: "custom",
          path: ["requestedOutputs", index, "title"],
          message: `duplicate requested-output title "${entry.title}"`,
        });
      }
      seen.add(entry.title);
    });
  });

export type ProcessorOutput = z.infer<typeof processorOutputSchema>;

/**
 * One candidate reading of the submission: a catalog type plus the reason it
 * fits. The type is a key of the loaded catalog/input-types.json — data, so
 * the static schema cannot enumerate it; the task compiler narrows it to the
 * loaded catalog's keys per run and the runtime re-checks membership on
 * write.
 */
export const classificationOptionSchema = z
  .object({
    type: nonEmpty.describe(
      "One category name from the option set in the instructions, copied verbatim.",
    ),
    /** Why this reading fits (or would fit), grounded in the submission's ask. */
    reason: answered(12, "classification reason"),
  })
  .strict();

export type ClassificationOption = z.infer<typeof classificationOptionSchema>;

/** Exactly one line of plain text (no newlines). */
const singleLine = (schema: z.ZodString | ReturnType<typeof answered>) =>
  schema.refine((value: string) => !/[\r\n]/.test(value), {
    message: "must be exactly one line",
  });

/**
 * One retrieval facet of the submission: a single scientific concept,
 * phrased for a text-embedding model. Facet vectors are matched against the
 * embedded nodes of the shared research taxonomy (and against literature),
 * so the text must live in the vocabulary that taxonomy and paper titles
 * use — the term of art plus a self-contained definitional statement, never
 * submission-specific wording.
 */
export const embeddingFacetSchema = z
  .object({
    /**
     * The concept's term of art: the phrase a survey title or taxonomy node
     * would use (2-5 words, one concept — never two joined by "and").
     */
    name: singleLine(answered(4, "facet name")).refine(
      (value) => value.length <= 80,
      { message: "facet name must stay a short term of art (at most 80 characters)" },
    ),
    /**
     * One or two self-contained sentences defining the concept and what
     * about it matters here — readable with zero context, no references to
     * "the submission", "the attachment", or "we".
     */
    statement: answered(40, "facet statement")
      .refine((value) => paragraphs(1).safeParse(value).success, {
        message: "facet statement must be a single paragraph",
      })
      .refine((value) => value.length <= 600, {
        message: "facet statement is runaway output; keep it to 1-2 sentences",
      }),
    /** Centrality of this facet to the submission's core, 0-1. */
    relevance: z.number().min(0).max(1),
  })
  .strict();

export type EmbeddingFacet = z.infer<typeof embeddingFacetSchema>;

/**
 * The submission distilled into embedding-ready text: one title+abstract
 * document (the canonical whole-submission vector) plus 3-8 single-concept
 * facets (multi-facet retrieval against the taxonomy's node vectors). The
 * raw prompt is deliberately never embedded — it is long, multi-topic, and
 * full of submission-specific artifacts that poison the vector; this record
 * is the clean projection the embedding stage consumes.
 */
export const embeddingInputSchema = z
  .object({
    /** A paper-style title for the submission's scientific core; one line. */
    title: singleLine(answered(8, "embedding title")).refine(
      (value) => value.length <= 200,
      { message: "embedding title must stay title-length (at most 200 characters)" },
    ),
    /**
     * One paragraph, 3-6 sentences, written like a paper abstract of the
     * scientific core: problem, objects of study, methods/theory involved,
     * and what a successful outcome is. Self-contained plain prose.
     */
    abstract: answered(150, "embedding abstract")
      .refine((value) => paragraphs(1).safeParse(value).success, {
        message: "embedding abstract must be a single paragraph",
      })
      .refine((value) => value.length <= 2500, {
        message: "embedding abstract is runaway output; keep it to 3-6 sentences",
      }),
    /** The submission's distinct concepts, most central first. */
    facets: z.array(embeddingFacetSchema).min(3).max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.facets.forEach((facet, index) => {
      const key = facet.name.trim().toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["facets", index, "name"],
          message: `duplicate facet "${facet.name}" — facets must be distinct concepts`,
        });
      }
      seen.add(key);
    });
  });

export type EmbeddingInput = z.infer<typeof embeddingInputSchema>;

/**
 * The classifier's decision, produced by a dedicated reasoning stage AFTER
 * preprocessing (workflow 0.14.0): the primary reading of the submission,
 * the strongest alternative reading (always a different type — the two
 * options a human confirms between at the classification gate), the panel's
 * chain-of-thought step count, the requested outputs — the submitter's
 * explicit asks plus any ask the submission unmistakably implies — and the
 * embedding input: the submission projected into clean retrieval text for
 * the semantic panel-assembly stage. The deterministic classification.apply
 * merge folds the primary decision into the structured input; the
 * confirmation gate may override it with the alternative, another catalog
 * type, or edited requested outputs.
 */
export const taskClassificationSchema = z
  .object({
    primary: classificationOptionSchema,
    alternative: classificationOptionSchema,
    /** How many reasoning steps a panel member should produce for this input. */
    cotSteps: z.number().int().min(3).max(9),
    /**
     * The deliverables the panel must answer beyond the type's standard
     * output: every explicit ask, plus asks the submission unmistakably
     * implies. Empty when there are none.
     */
    requestedOutputs: z.array(requestedOutputSchema).max(4),
    /** The submission as embedding-ready retrieval text (see the schema). */
    embeddingInput: embeddingInputSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.primary.type === value.alternative.type) {
      ctx.addIssue({
        code: "custom",
        path: ["alternative", "type"],
        message: "the alternative must be a different type than the primary",
      });
    }
    const seen = new Set<string>();
    value.requestedOutputs.forEach((entry, index) => {
      if (seen.has(entry.title)) {
        ctx.addIssue({
          code: "custom",
          path: ["requestedOutputs", index, "title"],
          message: `duplicate requested-output title "${entry.title}"`,
        });
      }
      seen.add(entry.title);
    });
  });

export type TaskClassification = z.infer<typeof taskClassificationSchema>;

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

/**
 * The deterministic projection of the useful files to the code-labeled
 * entries (`code` / `implementation`), plus their count — the count is what
 * the workflow's condition node tests to decide whether the code-annotation
 * pass runs at all.
 */
export const codeFilesSchema = z
  .object({
    /** Number of code-labeled useful files; equals files.length. */
    count: z.number().int().min(0),
    files: z.array(annotatedFileSchema).max(400),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.count !== value.files.length) {
      ctx.addIssue({
        code: "custom",
        path: ["count"],
        message: "count must equal the number of projected files",
      });
    }
    value.files.forEach((file, index) => {
      if (!CODE_FILE_LABELS.includes(file.label)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "label"],
          message: "the code-file projection may only contain code or implementation entries",
        });
      }
    });
  });

export type CodeFiles = z.infer<typeof codeFilesSchema>;

/**
 * The code annotator's output: one entry per code file it was given, in the
 * given order, each carrying the file's verbatim path and a one-line summary
 * of what the file contains and how it bears on the input topic. The runtime
 * cross-checks the paths against the bound code-file list on write and folds
 * the summaries into the shared file map deterministically.
 */
export const codeAnnotationsSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            /** Copied verbatim from the code-file list this task received. */
            path: nonEmpty,
            summary: codeSummaryValue,
          })
          .strict(),
      )
      .min(1)
      .max(400),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.files.forEach((file, index) => {
      if (seen.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `duplicate annotation for "${file.path}"`,
        });
      }
      seen.add(file.path);
    });
  });

export type CodeAnnotations = z.infer<typeof codeAnnotationsSchema>;

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
// expertise pool -> taxonomy matching -> placement (the decomposer split)
// ---------------------------------------------------------------------------

/** One person's verbatim statement behind a pool member: the provenance unit. */
export const poolOriginSchema = z
  .object({
    /** The author, as enumerated from a retrieved paper's byline. */
    name: nonEmpty,
    /** The retrieved paper whose byline surfaced this person. */
    paper: nonEmpty,
    /** The interest exactly as the person's profile wrote it. */
    stated: nonEmpty,
  })
  .strict();

export type PoolOrigin = z.infer<typeof poolOriginSchema>;

/**
 * One unified expertise-pool member: the canonical term, its distinct-people
 * count, the surface variants unification absorbed, and every origin — so any
 * later decision can be audited back to a named person on a named paper.
 */
export const poolMemberSchema = z
  .object({
    term: nonEmpty,
    /** Distinct people who stated any variant of this term. */
    count: z.number().int().min(1),
    /**
     * How relevant this area is to the input topic, in [0,1]: how often
     * researchers who state this exact interest do research similar to the
     * submission. Judged and audited by the pool builder; a separate axis
     * from count and never altered by it. Sort key of the bridged tree.
     */
    relevance: z.number().min(0).max(1),
    /** Every collected spelling, the canonical term included. */
    variants: z.array(nonEmpty).min(1).max(12),
    origins: z.array(poolOriginSchema).min(1).max(60),
  })
  .strict();

export type PoolMember = z.infer<typeof poolMemberSchema>;

/** The pool-builder's output: the unified pool plus its literature grounding. */
export const poolSchema = z
  .object({
    members: z.array(poolMemberSchema).min(1).max(200),
    /** Same contract as the experts tree's grounding (dashboard record). */
    grounding: z.lazy(() => expertsGroundingSchema).optional(),
  })
  .strict()
  .superRefine((pool, ctx) => {
    const seen = new Set<string>();
    pool.members.forEach((member, index) => {
      if (seen.has(member.term)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", index, "term"],
          message: `duplicate pool term "${member.term}"`,
        });
      }
      seen.add(member.term);
    });
  });

export type Pool = z.infer<typeof poolSchema>;

/** A node position in the shared four-level taxonomy, as the registry reports it. */
export const taxonomyPositionSchema = z
  .object({
    id: nonEmpty,
    name: nonEmpty,
    level: z.enum(["domain", "field", "subfield", "topic"]),
    /** Ancestors then self, e.g. ["Physical Sciences","Computer Science","Artificial Intelligence"]. */
    path: z.array(nonEmpty).min(1).max(4),
    domain: nonEmpty.optional(),
    field: nonEmpty.optional(),
    subfield: nonEmpty.optional(),
    topic: nonEmpty.optional(),
    matchedOn: z.enum(["name", "alias", "embedding"]).optional(),
    matchedAlias: nonEmpty.optional(),
  })
  .strict();

export type TaxonomyPosition = z.infer<typeof taxonomyPositionSchema>;

/**
 * One scored nearest-node candidate of an unmatched member, produced by the
 * semantic matching lane: the node's name, level, full ancestor path, and
 * the raw cosine similarity. The placer referees among these; the same list
 * rides into the suggestion queue as the insert anchor's evidence.
 */
export const matchCandidateSchema = z
  .object({
    name: nonEmpty,
    level: z.enum(["domain", "field", "subfield", "topic"]),
    path: z.array(nonEmpty).min(1).max(4),
    score: z.number().min(-1).max(1),
  })
  .strict();

export type MatchCandidate = z.infer<typeof matchCandidateSchema>;

/** One pool member after the deterministic taxonomy round-trip. */
export const matchedPoolMemberSchema = poolMemberSchema
  .safeExtend({
    matched: z.boolean(),
    /** The exact node the term resolved to; present iff matched. */
    position: taxonomyPositionSchema.optional(),
    /** Candidate node NAMES from the server's revise_query; empty when matched. */
    options: z.array(nonEmpty).max(100),
    /** Raw cosine of an embedding auto-match (matchedOn "embedding" only). */
    matchScore: z.number().min(-1).max(1).optional(),
    /** Scored nearest nodes of an unmatched member (semantic lane on). */
    candidates: z.array(matchCandidateSchema).max(8).optional(),
    /** The original compound pool term this member was split from, when the
     *  deterministic matcher divided an "<A> for <B>" term into two halves so
     *  each concept gets its own taxonomy landing. Absent on ordinary members. */
    splitFrom: nonEmpty.optional(),
  })
  .superRefine((member, ctx) => {
    if (member.matched && member.position === undefined) {
      ctx.addIssue({ code: "custom", path: ["position"], message: "a matched member carries its position" });
    }
    if (!member.matched && member.position !== undefined) {
      ctx.addIssue({ code: "custom", path: ["position"], message: "an unmatched member carries no position" });
    }
    if (member.matched && member.options.length > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "a matched member carries no candidate options" });
    }
  });

export type MatchedPoolMember = z.infer<typeof matchedPoolMemberSchema>;

/**
 * The deterministic matching artifact: every member annotated, plus the
 * unmatched projection the placer receives, stamped with the live taxonomy
 * revision the answers were computed against.
 */
export const poolMatchesSchema = z
  .object({
    /** The shared taxonomy revision the round-trips were answered from. */
    revision: z.number().int().min(1),
    members: z.array(matchedPoolMemberSchema).max(400),
    /** The unmatched members, verbatim (term/count/variants/origins/options). */
    unmatched: z.array(matchedPoolMemberSchema).max(400),
    /**
     * The semantic lane's status for this run: enabled with the embedder id
     * it matched in, or disabled with the reason (no served index, or a
     * local embedder that failed the served conformance vectors). Absent on
     * artifacts from before the lane existed.
     */
    embedding: z
      .object({
        enabled: z.boolean(),
        embedderId: nonEmpty.optional(),
        reason: nonEmpty.optional(),
      })
      .strict()
      .optional(),
    /**
     * The pruned taxonomy outline the placer reads instead of the whole
     * tree: the full domain/field skeleton plus the branches around the
     * unmatched members' candidate landings, with every cut marked inline
     * ("(N subfields — not shown)"). Rendered deterministically from the
     * run's pinned taxonomy, so a resume rebuilds the identical text.
     * Absent on artifacts from before the outline existed (old runs keep
     * fetching the full tree through the taxonomy-access tools).
     */
    placerOutline: nonEmpty.max(120_000).optional(),
  })
  .strict()
  .superRefine((matches, ctx) => {
    matches.unmatched.forEach((member, index) => {
      if (member.matched) {
        ctx.addIssue({
          code: "custom",
          path: ["unmatched", index, "matched"],
          message: "the unmatched projection may only contain unmatched members",
        });
      }
    });
  });

export type PoolMatches = z.infer<typeof poolMatchesSchema>;

/**
 * One placement decision for a member the taxonomy did not carry. The three
 * outcomes are the whole honest space: inject a new node (`place`), resolve
 * to an existing node under another spelling (`already_present`), or state
 * that no defensible decision exists (`undecidable`) — the legal exit that
 * keeps a cornered model from fabricating a placement when its information
 * genuinely does not suffice. Text fields refuse placeholder probes: a
 * "placeholder" placement recorded into the shared tree pollutes every
 * user's runs.
 */
export const placementDecisionSchema = z
  .object({
    /** The pool member's term, exactly as given. */
    term: nonEmpty,
    outcome: z.enum(["place", "already_present", "undecidable"]),
    /** place: the canonical field name to inject. */
    name: answered(4, "placement name").optional(),
    /** place: an existing node's name at domain/field/subfield depth. */
    parent: answered(4, "placement parent").optional(),
    /** place: other spellings that should resolve to the new node. */
    aliases: z.array(nonEmpty).max(12).optional(),
    /** already_present: the existing node the member resolves to. */
    node: answered(4, "existing node name").optional(),
    reason: answered(12, "placement reason"),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.outcome === "place") {
      if (!decision.name) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "a place decision names the field" });
      }
      if (!decision.parent) {
        ctx.addIssue({ code: "custom", path: ["parent"], message: "a place decision names its parent node" });
      }
      if (decision.node) {
        ctx.addIssue({ code: "custom", path: ["node"], message: "a place decision carries no existing node" });
      }
    } else if (decision.outcome === "already_present") {
      if (!decision.node) {
        ctx.addIssue({ code: "custom", path: ["node"], message: "an already_present decision names the existing node" });
      }
      if (decision.name || decision.parent) {
        ctx.addIssue({
          code: "custom",
          path: ["name"],
          message: "an already_present decision carries no new name or parent",
        });
      }
    } else {
      // undecidable: the reason IS the deliverable; everything else absent.
      if (decision.name || decision.parent || decision.node || (decision.aliases?.length ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "an undecidable decision carries only the term and the reason",
        });
      }
    }
  });

export type PlacementDecision = z.infer<typeof placementDecisionSchema>;

/** The placer's output: one decision per unmatched member, revision-stamped. */
export const placementsSchema = z
  .object({
    /** The taxonomy revision the placer read before deciding. */
    revision: z.number().int().min(1),
    decisions: z.array(placementDecisionSchema).max(400),
  })
  .strict()
  .superRefine((placements, ctx) => {
    const seen = new Set<string>();
    placements.decisions.forEach((decision, index) => {
      if (seen.has(decision.term)) {
        ctx.addIssue({
          code: "custom",
          path: ["decisions", index, "term"],
          message: `duplicate decision for "${decision.term}"`,
        });
      }
      seen.add(decision.term);
    });
  });

export type Placements = z.infer<typeof placementsSchema>;

/** The registry's receipt for one run's queued decisions (never applied here). */
export const suggestionReceiptSchema = z
  .object({
    /** Queue record id assigned by the registry. */
    id: nonEmpty,
    receivedAt: nonEmpty,
    /** The taxonomy revision the decisions were recorded against. */
    revision: z.number().int().min(1),
    queued: z.number().int().min(0),
    /**
     * Echo of what was submitted: one entry per pool member. "insert" is a
     * place-anchored insertion candidate carrying its nearest-node evidence
     * — an unmatched term without a decision, or a placer-declared
     * undecidable, when the semantic lane produced candidates.
     */
    entries: z
      .array(
        z
          .object({
            term: nonEmpty,
            kind: z.enum(["matched", "place", "already_present", "insert", "undecided"]),
          })
          .strict(),
      )
      .max(400),
  })
  .strict();

export type SuggestionReceipt = z.infer<typeof suggestionReceiptSchema>;

// ---------------------------------------------------------------------------
// experts / panel
// ---------------------------------------------------------------------------

/**
 * One area of the expertise tree: its name plus the measured support behind
 * it — how many distinct people in the grounding pool stated it as a research
 * interest. The count is what orders the tree; the runtime sorts by it on
 * write, so a consumer can read the order as the ranking.
 */
export const expertAreaSchema = z
  .object({
    name: nonEmpty,
    /** Distinct people in the grounding pool who stated this area. */
    count: z.number().int().min(1),
    /** Input-topic relevance in [0,1] (max over landed pool members); sort key. */
    relevance: z.number().min(0).max(1).optional(),
  })
  .strict();

export type ExpertArea = z.infer<typeof expertAreaSchema>;

/**
 * Ordered three-level expertise tree in constrained-output-safe form.
 * Arrays preserve relevance order without arbitrary JSON object keys (dynamic
 * property names are not reliably supported by provider structured outputs).
 */
export const expertUmbrellaSchema = z
  .object({
    name: nonEmpty,
    /** Distinct people in the grounding pool who stated this umbrella. */
    count: z.number().int().min(1),
    /** Input-topic relevance in [0,1] (max under this umbrella); sort key. */
    relevance: z.number().min(0).max(1).optional(),
    subfields: z.array(expertAreaSchema).max(30),
  })
  .strict();

export const expertDepartmentSchema = z
  .object({
    name: nonEmpty,
    /** The catalog group this department belongs to (the tree's top level). */
    domain: nonEmpty.optional(),
    /**
     * k — how many distinct people stated this department itself as an
     * interest, or 1 when nobody did but an umbrella was housed here.
     * Departments whose count stayed zero are pruned before the tree is
     * returned, so every entry carries at least 1.
     */
    count: z.number().int().min(1),
    /** Input-topic relevance in [0,1] (max under this department); sort key. */
    relevance: z.number().min(0).max(1).optional(),
    /**
     * May be empty: a department mentioned in the pool keeps its count even
     * when no umbrella landed under it.
     */
    umbrellas: z.array(expertUmbrellaSchema).max(30),
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

/**
 * A seated member. Subfields are plain names here, not the tree's counted
 * areas: pool statistics decided who sits, and carry no meaning for a seat
 * that renders them into its own role instructions.
 *
 * `seat` marks the panel's one interdisciplinary member — the seat the
 * deterministic panel.weave activity appends after selection, whose
 * expertise is the space BETWEEN the seated fields. Disciplinary members
 * carry no marker; the workflow dispatches its commenting skill on it.
 */
export const panelMemberSchema = z
  .object({
    id: nonEmpty,
    department: nonEmpty,
    umbrella: nonEmpty,
    subfields: z.array(nonEmpty),
    seat: z.literal("interdisciplinary").optional(),
  })
  .strict();

export type PanelMember = z.infer<typeof panelMemberSchema>;

/**
 * The seated panel produced by the deterministic panel-selection activity.
 * The experts tree remains a separate upstream artifact; a member is either
 * one TOPIC (a single, specific research focus, when that topic's own
 * support won it a seat on its own merit) or one UMBRELLA/DEPARTMENT whose
 * `subfields` carries the winning branch's strongest live topic by its real
 * name (the walk-down claim in `panel.ts`'s selectPanel — never a list of
 * every topic name the branch happened to accumulate, and the generic
 * `BROAD_SEAT_FOCUS` phrase only as the fallback for a branch with no live
 * topic left to name). At least two members are required so that every
 * review step has at least one commentor.
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
      // Several members may share an umbrella (topic-level seats under the
      // same branch), but the exact same focus set is one seat, never two.
      const seat = `${m.department}\u0000${m.umbrella}\u0000${m.subfields.join("\u0001")}`;
      if (seats.has(seat)) {
        ctx.addIssue({
          code: "custom",
          path: ["members", i],
          message: `duplicate seat for (${m.department}, ${m.umbrella}, ${m.subfields.join(" and ")})`,
        });
      }
      seats.add(seat);
    });
  });

export type Panel = z.infer<typeof panelSchema>;

// ---------------------------------------------------------------------------
// evidence (shared by verification-bearing fields across shapes, and by review)
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
    // The six detail fields default to the empty string an omission MEANS.
    //
    // Which of them must be filled is decided by `kind` in the refinement
    // below, and for `kind: "none"` every one of them must be exactly "" — an
    // empty string carries no information, so requiring a model to type six of
    // them is ceremony that fails on shape rather than on substance. A judge
    // that wrote a second issue as `evidence: { kind: "none" }` spent all three
    // validation attempts on "issues.1.evidence.shows: expected string,
    // received undefined" and took the run down with it.
    //
    // Nothing is loosened by this. The generated JSON Schema is built with
    // `io: "output"`, so the model is still told every field is required (now
    // with its default alongside), and the refinement still rejects a `script`
    // evidence whose code or result is empty — which is a claim about substance
    // and reads as one. Only the runtime's own canonical value stops being
    // something the model has to spell out.
    code: z.string().default(""),
    result: z.string().default(""),
    derivation: z.string().default(""),
    citation: z.string().default(""),
    locator: z.string().default(""),
    shows: z.string().default(""),
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
// developed-output bodies: the nine structural shapes
// ---------------------------------------------------------------------------

/** paper — a five-section research paper developing an idea into a contribution. */
export const paperBodySchema = z
  .object({
    abstract: paragraphArray(3),
    introduction: paragraphArray(3),
    method: paragraphArray(3),
    discussion: paragraphArray(3),
    conclusion: paragraphArray(1),
  })
  .strict();

export type PaperBody = z.infer<typeof paperBodySchema>;

/** One prior result the open-problem attempt must be positioned against. */
export const knownResultSchema = z
  .object({
    result: nonEmpty,
    sourceType: z.enum(["theorem", "bound", "partial-result", "counterexample-attempt"]),
    relation: nonEmpty,
  })
  .strict();

/** resolution — an attempt on a formally posed target: prove, disprove, construct, or bound. */
/**
 * The sections alone, without the cross-field rule below. A revision patch
 * names only the sections it changes, so a rule relating two of them cannot
 * be judged on the patch — it is judged on the merged whole, which is
 * validated in full before anything is recorded.
 */
export const resolutionBodyFields = z
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
  .strict();

export const resolutionBodySchema = resolutionBodyFields
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

export type ResolutionBody = z.infer<typeof resolutionBodySchema>;

/** verification — one claim adjudicated with evidence and an explicit verdict. */
export const verificationBodyFields = z
  .object({
    claim: nonEmpty,
    /** Where the claim comes from: the submitter's own hypothesis, or a located attachment passage. */
    claimSource: nonEmpty,
    verdict: z.enum(["confirmed", "refuted", "partially-correct", "indeterminate"]),
    evidence: evidenceSchema,
    reasoning: paragraphs(1),
    confidence: confidenceSchema,
  })
  .strict();

export const verificationBodySchema = verificationBodyFields
  .superRefine((body, ctx) => {
    if (body.verdict !== "indeterminate" && body.evidence.kind === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "confirmed, refuted, and partially-correct verdicts require script, math, or reference evidence",
      });
    }
  });

export type VerificationBody = z.infer<typeof verificationBodySchema>;

/** One aspect of a proposed plan's methodology, judged on its own terms. */
export const soundnessAspectSchema = z
  .object({
    aspect: nonEmpty,
    assessment: z.enum(["sound", "concern", "flaw"]),
    note: nonEmpty,
  })
  .strict();

/** feasibility — a Registered-Reports-style soundness review of a not-yet-run plan. */
export const feasibilityBodyFields = z
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
  .strict();

export const feasibilityBodySchema = feasibilityBodyFields
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

export type FeasibilityBody = z.infer<typeof feasibilityBodySchema>;

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
export const critiqueBodyFields = z
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
  .strict();

export const critiqueBodySchema = critiqueBodyFields
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

/** interpretation — ranked candidate readings of a specific empirical finding. */
export const interpretationBodySchema = z
  .object({
    observationSummary: paragraphs(1),
    candidateInterpretations: z.array(interpretationCandidateSchema).min(1).max(10),
    mostLikelyInterpretation: paragraphs(1),
    confidence: confidenceSchema,
    threatsToValidity: z.array(nonEmpty),
    implications: z.string(),
  })
  .strict();

export type InterpretationBody = z.infer<typeof interpretationBodySchema>;

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

/** survey — a landscape map of existing work, with optional comparison and recommendation. */
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

/** explanation — pedagogical exposition from intuition to rigor. */
export const explanationBodySchema = z
  .object({
    motivatingQuestion: paragraphs(1),
    coreIntuition: paragraphs(1),
    formalTreatment: paragraphs(1),
    workedExample: paragraphs(1),
    commonMisconceptions: z.array(misconceptionSchema),
    connections: z.array(nonEmpty),
  })
  .strict();

export type ExplanationBody = z.infer<typeof explanationBodySchema>;

/** One diagnosed cause of a research obstacle, listed most-likely first. */
export const obstacleCauseSchema = z
  .object({
    cause: nonEmpty,
    /** Why this cause is implicated, grounded in the stated setup. */
    rationale: nonEmpty,
  })
  .strict();

/** One approach already tried against the obstacle, and how it fell short. */
export const priorAttemptSchema = z
  .object({
    attempt: nonEmpty,
    outcome: nonEmpty,
  })
  .strict();

/** One candidate way past the obstacle, weighed on its own terms. */
export const candidateSolutionSchema = z
  .object({
    approach: nonEmpty,
    /** How and why it addresses the diagnosed cause. */
    mechanism: paragraphs(1),
    expectedEffect: nonEmpty,
    /** The cost or risk of taking this route. */
    risk: nonEmpty,
  })
  .strict();

/**
 * solution — a diagnosis-and-fix for a concrete research obstacle (a method,
 * derivation, code, or architecture that is stuck). It frames the obstacle,
 * ranks the likely causes, records what has already been tried, lays out
 * candidate ways past it, recommends one, and gives a plan to validate the
 * fix. Deliberately NOT a novelty shape: a correct fix need not be novel.
 */
export const solutionBodySchema = z
  .object({
    problemFraming: paragraphs(1),
    diagnosis: z.array(obstacleCauseSchema).min(1).max(10),
    priorAttempts: z.array(priorAttemptSchema).max(20),
    candidateSolutions: z.array(candidateSolutionSchema).min(1).max(8),
    recommendation: paragraphs(1),
    validationPlan: z.array(nonEmpty).min(1).max(20),
    residualRisks: z.array(nonEmpty).max(20),
  })
  .strict();

export type SolutionBody = z.infer<typeof solutionBodySchema>;

/**
 * One member's direct response to an explicitly requested output: the run's
 * section `title` echoed verbatim plus the answer itself. Uniform across all
 * nine shapes — the sections sit on the envelope next to the shape body, so
 * every projection that carries a member's `output` (integrator, chair,
 * dashboard) carries the responses automatically. Presence is run data:
 * exactly when the processor recorded `requestedOutputs`, one section per
 * ask in the recorded order — enforced per task (schema narrowing) and on
 * write (writeValidatedOutput), since the static schema cannot know the run.
 */
export const requestedSectionSchema = z
  .object({
    /** The requested output's title, copied verbatim from the run's list. */
    title: nonEmpty,
    /** The answer: 1-6 entries, each exactly one paragraph. */
    response: z
      .array(
        paragraphs(1).refine(
          (value) => !PLACEHOLDER_VALUE.test(value.trim()),
          { message: "response is a placeholder, not an answer to the requested output" },
        ),
      )
      .min(1)
      .max(6),
  })
  .strict();

export type RequestedSection = z.infer<typeof requestedSectionSchema>;

/**
 * The full developed-output envelope: `type` carries the submission's catalog
 * label (data — any key of the loaded catalog/input-types.json), and exactly
 * one SHAPE-keyed body is populated. The body key is the shape id, not the
 * type name, so the schema needs no knowledge of what the types are called;
 * the runtime cross-checks that the populated shape is the one the catalog
 * maps `type` to (see brainstorm-runtime's writeValidatedOutput). One flat
 * schema kept deliberately (never a `oneOf`/discriminated union): every field
 * the model could possibly need is always a plain declared property, exactly
 * like `evidenceSchema` already does for its four evidence kinds — only the
 * *conditional requiredness*, enforced below, changes per shape.
 */
export const developedOutputSchema = z
  .object({
    type: nonEmpty.describe(
      "The submission's catalog type label, copied verbatim from the instructions — never the output shape id.",
    ),
    paper: paperBodySchema.optional(),
    resolution: resolutionBodySchema.optional(),
    verification: verificationBodySchema.optional(),
    feasibility: feasibilityBodySchema.optional(),
    critique: critiqueBodySchema.optional(),
    interpretation: interpretationBodySchema.optional(),
    survey: surveyBodySchema.optional(),
    explanation: explanationBodySchema.optional(),
    solution: solutionBodySchema.optional(),
    /**
     * The member's responses to the submitter's explicitly requested
     * outputs — present exactly when the run recorded any (run data,
     * cross-checked by the runtime; see requestedSectionSchema).
     */
    requested: z.array(requestedSectionSchema).min(1).max(4).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const populated = OUTPUT_SHAPES.filter(
      (shape) => value[shape] !== undefined && value[shape] !== null,
    );
    if (populated.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: populated.length === 0 ? ["type"] : [populated[1]!],
        message:
          populated.length === 0
            ? "exactly one shape body must be populated, got none"
            : `exactly one shape body must be populated, got ${populated.join(", ")}`,
      });
    }
    const seen = new Set<string>();
    (value.requested ?? []).forEach((section, index) => {
      if (seen.has(section.title)) {
        ctx.addIssue({
          code: "custom",
          path: ["requested", index, "title"],
          message: `duplicate requested-output section "${section.title}"`,
        });
      }
      seen.add(section.title);
    });
  });

export type DevelopedOutput = z.infer<typeof developedOutputSchema>;

/** The single populated shape body of a developed output. */
export function populatedShape(output: DevelopedOutput): OutputShape {
  const shape = OUTPUT_SHAPES.find(
    (candidate) => output[candidate] !== undefined && output[candidate] !== null,
  );
  if (!shape) throw new Error("developed output has no populated shape body");
  return shape;
}

/**
 * The field names each shape's body schema accepts, derived from the envelope
 * itself so they can never drift from it. Bundle validation compares every
 * type's editable outline (catalog/input-types.json) against its shape's
 * fields, so a hand-edited outline that invents or drops a section fails at
 * load time with a named issue instead of silently diverging.
 */
export const SHAPE_FIELDS: Readonly<Record<OutputShape, readonly string[]>> = (() => {
  const json = z.toJSONSchema(developedOutputSchema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }) as { properties?: Record<string, { properties?: Record<string, unknown> }> };
  const fields = Object.fromEntries(
    OUTPUT_SHAPES.map((shape) => [
      shape,
      Object.keys(json.properties?.[shape]?.properties ?? {}),
    ]),
  ) as unknown as Record<OutputShape, readonly string[]>;
  for (const shape of OUTPUT_SHAPES) {
    if (fields[shape].length === 0) {
      throw new Error(`shape "${shape}" has no derivable fields — envelope schema changed?`);
    }
  }
  return fields;
})();

// ---------------------------------------------------------------------------
// brain idea (first pass) and redevelopment (revision)
// ---------------------------------------------------------------------------

/**
 * The four part keys of a chain step, in order. Exported because the runtime
 * walks them by name (the empty-prune of a reviewer's flaw list) and the read
 * side renders them in this order; a second hand-written list somewhere else
 * would be the thing that drifts.
 */
export const CHAIN_PARTS = ["part1", "part2", "part3", "part4"] as const;

export type ChainPart = (typeof CHAIN_PARTS)[number];

/**
 * One chain step, divided into four parts. The parts carry NO meaning: they
 * are a size discipline, not a reasoning schema, so the same rule serves all
 * nine output shapes. Four is a hard maximum forever — a redevelopment
 * rewrites the existing four and can never add a fifth, which is what makes
 * the shape itself the ceiling on how far a step can grow.
 *
 * No length rule lives here on purpose. The per-part character target is
 * skill prose; a refinement would turn a soft limit into a failed run.
 */
export const cotStepPartsSchema = z
  .object({
    part1: z.string(),
    part2: z.string(),
    part3: z.string(),
    part4: z.string(),
  })
  .strict();

export type CotStepParts = z.infer<typeof cotStepPartsSchema>;

export const brainIdeaSchema = z
  .object({
    output: developedOutputSchema,
    /** The chain of thought: one paragraph per step, forward-only, in order. */
    cot: z.array(paragraphs(1)).min(3).max(9),
    /**
     * One paragraph naming the closest prior works and what this idea does
     * that none of them does. Always OPTIONAL: a member includes it when its
     * treatment genuinely positions against specific works, and omits it
     * otherwise — no shape requires or forbids the claim (enforcement was
     * removed deliberately; the review examines a claim wherever one is made).
     */
    novelty: paragraphs(1).optional(),
    /** The works the literature review surfaced; omit when none were found. */
    literature: z.array(paperSchema).max(30).optional(),
  })
  .strict();

export type BrainIdea = z.infer<typeof brainIdeaSchema>;

/**
 * The same first pass, with every chain step divided into four parts.
 *
 * A separate NAME rather than a changed `brainIdea`: a run pins its bundle
 * version forever, so mutating the old shape would break every pinned run on
 * its next resume. A workflow node picks the form through `output.schema`,
 * exactly as `redevelopment` and `redevelopmentPatch` already coexist.
 * Everything but the chain — the envelope, the novelty rule, the literature
 * list — is the identical contract.
 */
export const brainIdeaPartsSchema = z
  .object({
    output: developedOutputSchema,
    /** The chain of thought: one four-part step per position, in order. */
    cot: z.array(cotStepPartsSchema).min(3).max(9),
    novelty: paragraphs(1).optional(),
    literature: z.array(paperSchema).max(30).optional(),
  })
  .strict();

export type BrainIdeaParts = z.infer<typeof brainIdeaPartsSchema>;

/**
 * A member's revision after a Build/Interrupt: the COMPLETE revised chain,
 * re-emitted step by step. The reviser fixes the steps the confirmed issues
 * implicate (any step, including ones before the current review position)
 * and copies every unaffected step verbatim; the runtime — never the model —
 * computes which steps were touched by exact comparison against the previous
 * chain, and records that change-set in the review ledger. Chain LENGTH is
 * invariant: `steps` must carry exactly the run's fixed step count. `output`
 * and `novelty` replace the previous ones.
 */
export const redevelopmentSchema = z
  .object({
    output: developedOutputSchema,
    /** The complete revised chain, one paragraph per step, in order. */
    steps: z.array(paragraphs(1)).min(3).max(9),
    novelty: paragraphs(1).optional(),
  })
  .strict();

export type Redevelopment = z.infer<typeof redevelopmentSchema>;

/**
 * A member's revision expressed as a PATCH rather than a re-emission.
 *
 * The full-emission contract above asks the reviser to re-type the entire
 * chain and the entire developed body every round, even when one confirmed
 * issue moved one step: the untouched text is copied character for character
 * at output prices, and the body — which the reviser never even receives — is
 * regenerated from scratch, so paragraphs nobody faulted drift round after
 * round. A patch carries only what changed; the HOST fills the rest from the
 * previous version, which makes an untouched step byte-identical by
 * construction instead of by the model's diligence.
 *
 * Nothing downstream sees a patch: `mergeRedevelopment` reassembles the whole
 * chain and the whole envelope, and the merged result is validated against
 * the same schemas the full-emission path uses before anything is recorded.
 */
/**
 * The chain-order rule of a patch's step list: ascending, each index at most
 * once. Shared by the string-step patch and the four-part one below, because
 * "what a well-formed patch looks like" is one contract — only the payload
 * of a step differs between the two forms.
 */
const requireAscendingSteps = (
  steps: readonly { readonly index: number }[],
  ctx: z.RefinementCtx,
): void => {
  steps.forEach((step, position) => {
    const previous = steps[position - 1];
    if (previous !== undefined && step.index <= previous.index) {
      ctx.addIssue({
        code: "custom",
        path: [position, "index"],
        message: "steps must be listed in ascending order, each index once",
      });
    }
  });
};

/**
 * The developed body's changed sections only, under the same shape key the
 * previous output populated. Omitted when the repair left the body standing.
 * `requested` is all-or-nothing: omit it to carry the previous sections, or
 * give the complete ordered list.
 *
 * Defined once and shared by both patch forms: the body a revision patches is
 * the same body whichever way its chain is written, and `mergeOutputPatch`
 * below is the single merge that reads it.
 */
export const redevelopmentOutputPatchSchema = z
  .object({
    // Built from each shape's SECTIONS, without its cross-field rules: a
    // rule relating two sections cannot be judged on a patch that names
    // one of them. Every such rule is enforced on the merged whole.
    paper: paperBodySchema.partial().optional(),
    resolution: resolutionBodyFields.partial().optional(),
    verification: verificationBodyFields.partial().optional(),
    feasibility: feasibilityBodyFields.partial().optional(),
    critique: critiqueBodyFields.partial().optional(),
    interpretation: interpretationBodySchema.partial().optional(),
    survey: surveyBodySchema.partial().optional(),
    explanation: explanationBodySchema.partial().optional(),
    solution: solutionBodySchema.partial().optional(),
    requested: z.array(requestedSectionSchema).min(1).max(4).optional(),
  })
  .strict();

export type RedevelopmentOutputPatch = z.infer<typeof redevelopmentOutputPatchSchema>;

export const redevelopmentPatchSchema = z
  .object({
    /**
     * The rewritten steps only, each at its 1-based position in the chain.
     * Ascending, no repeats, at least one — a revision exists because the
     * board confirmed an issue, and every confirmed issue sits at a step.
     */
    steps: z
      .array(
        z
          .object({ index: z.number().int().min(1).max(9), text: paragraphs(1) })
          .strict(),
      )
      .min(1)
      .max(9)
      .superRefine(requireAscendingSteps),
    outputPatch: redevelopmentOutputPatchSchema.optional(),
    /** Only when the repair moved it; otherwise the previous one stands. */
    novelty: paragraphs(1).optional(),
  })
  .strict();

export type RedevelopmentPatch = z.infer<typeof redevelopmentPatchSchema>;

/**
 * The same patch against a four-part chain: a named step arrives as its
 * complete replacement four-part object, never as a patch of single parts.
 * Parts have no meaning and a rewrite may move their boundaries, so patching
 * one part while the other three stand would leave a step nobody wrote.
 */
export const redevelopmentPatchPartsSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            index: z.number().int().min(1).max(9),
            part1: z.string(),
            part2: z.string(),
            part3: z.string(),
            part4: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(9)
      .superRefine(requireAscendingSteps),
    outputPatch: redevelopmentOutputPatchSchema.optional(),
    novelty: paragraphs(1).optional(),
  })
  .strict();

export type RedevelopmentPatchParts = z.infer<typeof redevelopmentPatchPartsSchema>;

/** A patch that cannot be applied to the version it claims to revise. */
export class RedevelopmentMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedevelopmentMergeError";
  }
}

/** The version a patch is applied to: the member's idea as it currently stands. */
export interface RedevelopmentBase {
  readonly cot: readonly string[];
  readonly output: Readonly<Record<string, unknown>>;
  readonly novelty?: string;
}

/** The reassembled revision, in the shape the full-emission path produces. */
export interface MergedRedevelopment {
  readonly steps: readonly string[];
  readonly output: Record<string, unknown>;
  readonly novelty?: string;
}

/** The version a four-part patch is applied to (see RedevelopmentBase). */
export interface RedevelopmentPartsBase {
  readonly cot: readonly CotStepParts[];
  readonly output: Readonly<Record<string, unknown>>;
  readonly novelty?: string;
}

/** The reassembled four-part revision (see MergedRedevelopment). */
export interface MergedRedevelopmentParts {
  readonly steps: readonly CotStepParts[];
  readonly output: Record<string, unknown>;
  readonly novelty?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A patched step must name a position the chain already has. Chain LENGTH is
 * invariant across a revision, so an index past the end is a broken patch —
 * never a silent append that would grow the chain behind the run's back.
 */
function assertStepInChain(index: number, length: number): void {
  if (index > length) {
    throw new RedevelopmentMergeError(
      `the patch rewrites step ${index}, but the chain has ${length} steps`,
    );
  }
}

/**
 * Folds a patch's changed body sections into the previous envelope.
 *
 * The body a revision patches is identical whichever way the chain is
 * written, so both merges call this one implementation: a forked copy would
 * let a four-part run and a string run disagree about which sections
 * survived, and the dashboard replays these merges out of the checkpoint
 * journal long after the run itself is gone.
 */
function mergeOutputPatch(
  base: Readonly<Record<string, unknown>>,
  outputPatch: RedevelopmentOutputPatch | undefined,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  const populated = OUTPUT_SHAPES.find((shape) => isRecord(base[shape]));
  for (const [key, value] of Object.entries(outputPatch ?? {})) {
    if (value === undefined) continue;
    if (key === "requested") {
      output.requested = value;
      continue;
    }
    if (key !== populated) {
      throw new RedevelopmentMergeError(
        `the patch changes the "${key}" body, but this member's output is a "${populated ?? "none"}"`,
      );
    }
    // Section-wise: a patched section replaces its previous text entirely,
    // every other section of the body rides through untouched.
    output[key] = { ...(base[key] as Record<string, unknown>), ...(value as object) };
  }
  return output;
}

/**
 * Applies a patch to the version it revises, producing the complete chain and
 * the complete envelope.
 *
 * This is the ONE implementation on purpose: the runtime folds the merge into
 * run state, and the dashboard replays the same patches out of the checkpoint
 * journal. Two copies would drift, and the review inspector would start
 * showing a chain no reviewer ever read.
 */
export function mergeRedevelopment(
  base: RedevelopmentBase,
  patch: RedevelopmentPatch,
): MergedRedevelopment {
  const steps = [...base.cot];
  for (const step of patch.steps) {
    assertStepInChain(step.index, steps.length);
    steps[step.index - 1] = step.text;
  }

  const output = mergeOutputPatch(base.output, patch.outputPatch);
  const novelty = patch.novelty ?? base.novelty;
  return {
    steps,
    output,
    ...(novelty !== undefined ? { novelty } : {}),
  };
}

/**
 * The same merge for a four-part chain: a patched step REPLACES the whole
 * four-part object at its position, and every step the patch does not name
 * rides through byte-identical because the host carried it rather than the
 * model retyping it. Body and novelty handling are the shared ones above.
 */
export function mergeRedevelopmentParts(
  base: RedevelopmentPartsBase,
  patch: RedevelopmentPatchParts,
): MergedRedevelopmentParts {
  const steps = [...base.cot];
  for (const step of patch.steps) {
    assertStepInChain(step.index, steps.length);
    steps[step.index - 1] = {
      part1: step.part1,
      part2: step.part2,
      part3: step.part3,
      part4: step.part4,
    };
  }

  const output = mergeOutputPatch(base.output, patch.outputPatch);
  const novelty = patch.novelty ?? base.novelty;
  return {
    steps,
    output,
    ...(novelty !== undefined ? { novelty } : {}),
  };
}

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
 * The verdict/evidence contract shared by every review artifact: an Interrupt
 * stands on script, math, or reference evidence, and every softer verdict
 * stands on none. This is a CONTRACT about what a verdict MEANS, not a length
 * rule, so the part-carrying forms below keep it verbatim. One copy, because
 * a commentor and a judge disagreeing about what Interrupt requires would be
 * a review loop arguing with itself.
 */
const requireVerdictEvidence = (
  value: { readonly verdict: Verdict; readonly evidence: Evidence },
  ctx: z.RefinementCtx,
): void => {
  if (value.verdict === "Interrupt" && value.evidence.kind === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "Interrupt requires script, math, or reference evidence",
    });
  }
  if (value.verdict !== "Interrupt" && value.evidence.kind !== "none") {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: `${value.verdict} must use {kind:"none"} evidence`,
    });
  }
};

/**
 * One step's flaws, keyed by the part of that step the flaw sits in. The
 * reviewer receives this as a DRAFT — one entry per step it has been shown,
 * every part key present and empty — and fills in only what it has. The
 * orchestrator strips the empties before the judge reads them.
 *
 * `part<N>` is a LOCATOR, not a citation: parts carry no meaning and a
 * rewrite can move their boundaries, so the flaw sentence must stand alone.
 */
export const flawEntrySchema = z
  .object({
    step: z.number().int().min(1),
    part1: z.string(),
    part2: z.string(),
    part3: z.string(),
    part4: z.string(),
  })
  .strict();

export type FlawEntry = z.infer<typeof flawEntrySchema>;

/**
 * One commentor's verdict on the reviewed chain so far.
 *
 * `step` names the 1-based chain step the verdict targets. A commentor may
 * target the current step or any earlier one it can now fault (a flaw at
 * step 2 is often only visible from the vantage of step 5); for Pass the
 * field carries the current review position. The runtime rejects targets
 * beyond the step under review.
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
    /** The 1-based chain step this verdict targets (current position for Pass). */
    step: z.number().int().min(1),
    reason: substantiveReason,
    suggestion: z.string(),
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine((comment, ctx) => {
    if (comment.verdict === "Build") {
      requireConcreteSuggestion(comment.suggestion, ctx);
    }
    requireVerdictEvidence(comment, ctx);
  });

export type Comment = z.infer<typeof commentSchema>;

/**
 * The same commentor verdict against a four-part chain.
 *
 * There is no top-level `step` any more: a commentor faults as many steps as
 * it can see, and each flaw entry carries its own position. `reason` stays as
 * the short overall note, because a Pass carries no flaws at all and the
 * dashboard renders a reason for every reviewer.
 *
 * Every length rule is gone on purpose. `validateArtifact` throws on a Zod
 * failure and the adapter turns that into retries and then a dead task, so a
 * character floor here would convert a soft style target into a lost run. The
 * limits are prose, in the skill files. The evidence contract stays: it says
 * what a verdict means.
 */
export const commentPartsSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    /** The overall note; the one thing a Pass, which carries no flaws, says. */
    reason: z.string(),
    /** One entry per faulted step; empty when the reviewer found nothing. */
    flaws: z.array(flawEntrySchema).max(9),
    suggestion: z.string(),
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine(requireVerdictEvidence);

export type CommentParts = z.infer<typeof commentPartsSchema>;

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
 * One distinct problem the judge confirms in the reviewed chain: which step
 * it sits at, the point itself, whether it is backed by verification or
 * stands on authority, its evidence, and whether the redeveloper must
 * address it. Issues are deliberately authorless — the objection ledger and
 * the repair signal carry content, never commentor identity — so the
 * existing `assessment` field remains the only place commentors are named.
 */
/**
 * The issue fields alone. Split out from the schema below so the part-aware
 * form can extend the same shape instead of restating it; a refined schema
 * carries no `.safeExtend`, exactly as `resolutionBodyFields` already is.
 */
const judgeIssueFields = z
  .object({
    /** The 1-based chain step the issue sits at (never beyond the reviewed step). */
    step: z.number().int().min(1),
    /** The problem, stated substantively (at least 30 characters). */
    point: substantiveReason,
    /** "verified" = backed by the evidence object; "authority" = assertion only. */
    basis: z.enum(["verified", "authority"]),
    evidence: evidenceSchema,
    /** Concrete repair direction; may be empty when the evidence speaks for itself. */
    suggestion: z.string(),
    /** True when the revision cannot stand without resolving this issue. */
    mustAddress: z.boolean(),
  })
  .strict();

/**
 * The basis/evidence contract of an issue: "verified" means an evidence
 * object backs it, "authority" means the judge stands on its own reading.
 * Shared by both issue forms — the word "verified" cannot mean two things.
 */
const requireIssueEvidence = (
  issue: { readonly basis: "verified" | "authority"; readonly evidence: Evidence },
  ctx: z.RefinementCtx,
): void => {
  if (issue.basis === "verified" && issue.evidence.kind === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: 'a "verified" issue requires script, math, or reference evidence',
    });
  }
  if (issue.basis === "authority" && issue.evidence.kind !== "none") {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: 'an "authority" issue must use {kind:"none"} evidence',
    });
  }
};

export const judgeIssueSchema = judgeIssueFields.superRefine(requireIssueEvidence);

export type JudgeIssue = z.infer<typeof judgeIssueSchema>;

/**
 * The same confirmed problem against a four-part chain: it names the part of
 * the step it sits in, and its `point` carries no length floor (the two-
 * sentence target is skill prose, never a run-killing refinement).
 *
 * `part` is a LOCATOR only. Parts carry no meaning and a redevelopment may
 * move their boundaries, so the point itself must stand without it.
 */
export const judgeIssuePartsSchema = judgeIssueFields
  .safeExtend({
    /** The problem, stated in the reviewer's own words. */
    point: z.string(),
    /** Which part of the named step the problem sits in. */
    part: z.enum(CHAIN_PARTS),
  })
  .superRefine(requireIssueEvidence);

export type JudgeIssueParts = z.infer<typeof judgeIssuePartsSchema>;

/**
 * The judge's single decision for a review round, aggregating the
 * commentors' verdicts. `issues` is the de-duplicated repair signal: one
 * entry per distinct confirmed problem (several commentors making the same
 * point are one issue), each pinned to a step. Pass carries no issues;
 * Build/Interrupt carry at least one that must be addressed, and an
 * Interrupt requires at least one verified must-address issue. Same
 * suggestion tolerance as commentSchema: required-and-concrete for Build,
 * otherwise accepted as extra context for the redeveloper.
 */
const judgeDecisionFields = z
  .object({
    verdict: z.enum(VERDICTS),
    reason: substantiveReason,
    suggestion: z.string(),
    evidence: evidenceSchema,
    /** The distinct confirmed problems this round; empty exactly when Pass. */
    issues: z.array(judgeIssueSchema).max(12),
    assessment: assessmentSchema,
  })
  .strict();

/**
 * How a verdict and its issue list must agree: Pass means nothing is open,
 * anything else names at least one problem the revision must resolve, and an
 * Interrupt — which stops the chain — needs one of those backed by evidence
 * rather than by standing alone. Shared by both decision forms; the rule is
 * about the verdict, and the verdict is the same object in either.
 */
const requireVerdictIssues = (
  decision: {
    readonly verdict: Verdict;
    readonly issues: readonly {
      readonly mustAddress: boolean;
      readonly basis: "verified" | "authority";
    }[];
  },
  ctx: z.RefinementCtx,
): void => {
  if (decision.verdict === "Pass" && decision.issues.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["issues"],
      message: "Pass carries no issues; an open issue rules out Pass",
    });
  }
  if (decision.verdict !== "Pass") {
    if (!decision.issues.some((issue) => issue.mustAddress)) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: `${decision.verdict} requires at least one must-address issue`,
      });
    }
    if (
      decision.verdict === "Interrupt" &&
      !decision.issues.some(
        (issue) => issue.mustAddress && issue.basis === "verified",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: "Interrupt requires at least one verified must-address issue",
      });
    }
  }
};

export const judgeDecisionSchema = judgeDecisionFields.superRefine((decision, ctx) => {
  if (decision.verdict === "Build") {
    requireConcreteSuggestion(decision.suggestion, ctx);
  }
  requireVerdictEvidence(decision, ctx);
  requireVerdictIssues(decision, ctx);
});

export type JudgeDecision = z.infer<typeof judgeDecisionSchema>;

/**
 * The same decision against a four-part chain.
 *
 * It gains `flaws` — the judge's own reading of the chain, in the identical
 * per-step, per-part form the commentors submit, so the dashboard renders one
 * reviewer's marks the same way whoever made them. `issues` stays the
 * de-duplicated repair signal the redeveloper acts on; the two are not the
 * same list, and only `issues` drives a revision.
 *
 * `assessment` keeps its `.min(1)`: naming who was verified and who stood on
 * authority is the judge's core act, not a length target. What is gone is the
 * Build suggestion floor, which was a length rule and would have cost a run.
 */
export const judgeDecisionPartsSchema = judgeDecisionFields
  .safeExtend({
    reason: z.string(),
    /** The judge's own per-step marks; empty when it faulted nothing itself. */
    flaws: z.array(flawEntrySchema).max(9),
    issues: z.array(judgeIssuePartsSchema).max(12),
  })
  .superRefine((decision, ctx) => {
    requireVerdictEvidence(decision, ctx);
    requireVerdictIssues(decision, ctx);
  });

export type JudgeDecisionParts = z.infer<typeof judgeDecisionPartsSchema>;

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
// bridge report (post-review integration audit)
// ---------------------------------------------------------------------------

/**
 * One member's novelty claim, audited across fields. `challenged` requires a
 * real reference — the prior work that already does it; `clear` carries the
 * fixed empty evidence object. An audit never challenges on suspicion.
 */
export const noveltyAuditSchema = z
  .object({
    memberId: nonEmpty,
    /** The audited claim, restated precisely. */
    claim: nonEmpty,
    status: z.enum(["clear", "challenged"]),
    /** How the audit reached this status (at least 30 characters). */
    note: substantiveReason,
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine((audit, ctx) => {
    if (audit.status === "challenged" && audit.evidence.kind !== "reference") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "a challenged novelty claim requires reference evidence",
      });
    }
    if (audit.status === "clear" && audit.evidence.kind !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: 'a clear audit must use {kind:"none"} evidence',
      });
    }
  });

export type NoveltyAudit = z.infer<typeof noveltyAuditSchema>;

/** Two or more members whose outputs make claims that cannot both hold. */
export const contradictionSchema = z
  .object({
    members: z.array(nonEmpty).min(2).max(6),
    description: substantiveReason,
  })
  .strict();

/** A gap between the seats: an interface no member covered. */
export const seamSchema = z
  .object({
    /** The expertise or members the seam connects. */
    between: z.array(nonEmpty).min(1).max(3),
    /** What no member covered. */
    gap: nonEmpty,
    /** The concrete opening it leaves, grounded in the outputs. */
    opportunity: nonEmpty,
  })
  .strict();

/**
 * The integrator's post-review audit: novelty claims verified across fields,
 * contradictions between members, and the unexplored seams between their
 * expertise. Advisory input to the chair; empty lists are valid — the audit
 * never pads.
 */
export const bridgeReportSchema = z
  .object({
    noveltyAudit: z.array(noveltyAuditSchema).max(12),
    contradictions: z.array(contradictionSchema).max(12),
    seams: z.array(seamSchema).max(12),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<string>();
    report.noveltyAudit.forEach((audit, index) => {
      if (seen.has(audit.memberId)) {
        ctx.addIssue({
          code: "custom",
          path: ["noveltyAudit", index, "memberId"],
          message: `member "${audit.memberId}" is audited more than once`,
        });
      }
      seen.add(audit.memberId);
    });
  });

export type BridgeReport = z.infer<typeof bridgeReportSchema>;

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Every schema an agent or activity node's `output.schema` may reference, by name. */
export const artifactSchemas = {
  processorOutput: processorOutputSchema,
  taskClassification: taskClassificationSchema,
  usefulFiles: usefulFilesSchema,
  ignoredFiles: ignoredFilesSchema,
  codeFiles: codeFilesSchema,
  codeAnnotations: codeAnnotationsSchema,
  pool: poolSchema,
  poolMatches: poolMatchesSchema,
  placements: placementsSchema,
  suggestionReceipt: suggestionReceiptSchema,
  experts: expertsTreeSchema,
  panel: panelSchema,
  brainIdea: brainIdeaSchema,
  comment: commentSchema,
  judgeDecision: judgeDecisionSchema,
  redevelopment: redevelopmentSchema,
  redevelopmentPatch: redevelopmentPatchSchema,
  // The four-part chain forms. Separate names, never replacements: a run pins
  // its bundle version forever, so the old names must keep meaning what they
  // meant on the day that run started.
  brainIdeaParts: brainIdeaPartsSchema,
  commentParts: commentPartsSchema,
  judgeDecisionParts: judgeDecisionPartsSchema,
  redevelopmentPatchParts: redevelopmentPatchPartsSchema,
  finalProposal: finalProposalSchema,
  bridgeReport: bridgeReportSchema,
} as const;

export type ArtifactSchemaName = keyof typeof artifactSchemas;
