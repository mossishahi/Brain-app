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
    name: singleLine(answered(4, "facet name")).max(
      80,
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
      .max(600, {
        message: "facet statement is runaway output; keep it to 1-2 sentences",
      }),
    /** Centrality of this facet to the submission's core, 0-1. */
    relevance: z.number().min(0).max(1),
    /**
     * Optional (classifier v2): up to five other names of the same concept,
     * including the names other communities publish under. Each is a term of
     * art (3-80 characters, one line), distinct from the facet name and from
     * every other alias. Absent means "not provided".
     */
    aliases: z
      .array(
        singleLine(
          z
            .string()
            .min(3, "facet alias must be at least 3 characters")
            .max(80, "facet alias must stay a short term of art (at most 80 characters)"),
        ),
      )
      .max(5)
      .optional(),
    /** Optional (classifier v2): what kind of concept the facet names. */
    kind: z.enum(["method", "theory", "problem", "object", "application"]).optional(),
  })
  .strict()
  .superRefine((facet, ctx) => {
    if (facet.aliases === undefined) return;
    const name = facet.name.trim().toLowerCase();
    const seen = new Set<string>();
    facet.aliases.forEach((alias, index) => {
      const key = alias.trim().toLowerCase();
      if (key === name) {
        ctx.addIssue({
          code: "custom",
          path: ["aliases", index],
          message: `alias "${alias}" repeats the facet name — an alias must be another name`,
        });
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["aliases", index],
          message: `duplicate alias "${alias}"`,
        });
      }
      seen.add(key);
    });
  });

export type EmbeddingFacet = z.infer<typeof embeddingFacetSchema>;

/**
 * Optional (classifier v2): a field where an equivalent or closely analogous
 * problem is studied under another name, with the classifier's confidence
 * that the analogy holds.
 */
export const equivalentProblemSchema = z
  .object({
    /** The field that studies it (2-80 characters, one line). */
    field: singleLine(
      z
        .string()
        .min(2, "equivalent-problem field must be at least 2 characters")
        .max(80, "equivalent-problem field must stay at most 80 characters"),
    ),
    /** The problem's name in that field (3-120 characters, one line). */
    name: singleLine(
      z
        .string()
        .min(3, "equivalent-problem name must be at least 3 characters")
        .max(120, "equivalent-problem name must stay at most 120 characters"),
    ),
    /** One or two self-contained sentences stating the analogous problem. */
    statement: z
      .string()
      .min(40, "equivalent-problem statement must be at least 40 characters")
      .max(400, "equivalent-problem statement must stay at most 400 characters (1-2 sentences)")
      .refine((value) => paragraphs(1).safeParse(value).success, {
        message: "equivalent-problem statement must be a single paragraph",
      }),
    /** Confidence that the problem is equivalent or closely analogous, 0-1. */
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type EquivalentProblem = z.infer<typeof equivalentProblemSchema>;

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
    title: singleLine(answered(8, "embedding title")).max(
      200,
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
      .max(2500, {
        message: "embedding abstract is runaway output; keep it to 3-6 sentences",
      }),
    /** The submission's distinct concepts, most central first. */
    facets: z.array(embeddingFacetSchema).min(3).max(8),
    /**
     * Optional (classifier v2): one paragraph (150-1,500 characters)
     * restating the problem with every application word removed — what is
     * given, what is sought, which structure or constraints matter — in the
     * vocabulary of mathematics, statistics and computer science.
     */
    problemFormulation: answered(150, "problem formulation")
      .refine((value) => paragraphs(1).safeParse(value).success, {
        message: "problem formulation must be a single paragraph",
      })
      .max(1500, {
        message: "problem formulation is runaway output; keep it to at most 1,500 characters",
      })
      .optional(),
    /**
     * Optional (classifier v2): at most five fields where an equivalent or
     * closely analogous problem is studied under another name.
     */
    equivalentProblems: z.array(equivalentProblemSchema).max(5).optional(),
    /**
     * Optional (classifier v2): at most twelve phrases copied verbatim from
     * the submission (the submitter's own wording), 2-80 characters each.
     */
    keyTerms: z
      .array(
        singleLine(
          z
            .string()
            .min(2, "key term must be at least 2 characters")
            .max(80, "key term must stay at most 80 characters"),
        ),
      )
      .max(12)
      .optional(),
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

/**
 * A reconsideration of a member's chain after the fact table deleted a badge
 * it cites: the rewritten steps only (none when unchanged), each a complete
 * four-part replacement, plus the developed sections and novelty the change
 * moved. Steps travel inline; no stepwise submit_step contract applies.
 */
export const chainReconsiderationPartsSchema = z
  .object({
    decision: z.enum(["revised", "unchanged"]),
    reason: paragraphs(1),
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
      .max(9)
      .superRefine(requireAscendingSteps),
    outputPatch: redevelopmentOutputPatchSchema.optional(),
    novelty: paragraphs(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const changes = value.steps.length > 0 || value.outputPatch !== undefined || value.novelty !== undefined;
    if (value.decision === "unchanged" && changes) {
      ctx.addIssue({ code: "custom", path: ["decision"], message: "an unchanged decision carries no steps, outputPatch or novelty" });
    }
    if (value.decision === "revised" && !changes) {
      ctx.addIssue({ code: "custom", path: ["decision"], message: "a revised decision carries at least one step, an outputPatch or a novelty" });
    }
  });

export type ChainReconsiderationParts = z.infer<typeof chainReconsiderationPartsSchema>;

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

/** The game critic's entire report. Identity and scores are host metadata. */
export const gameCritiqueSchema = z
  .object({
    q: z.number().min(0).max(1),
    justification: nonEmpty,
  })
  .strict();

export type GameCritique = z.infer<typeof gameCritiqueSchema>;

const reconsiderationDecision = z.enum(["revised", "withdrawn", "unchanged"]);

/** A critic's reconsideration of its game report after a fact-table deletion. */
export const gameReportReconsiderationSchema = z
  .object({
    decision: reconsiderationDecision,
    reason: nonEmpty,
    report: gameCritiqueSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.decision === "revised") !== (value.report !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["report"], message: "a report is returned exactly when the decision is revised" });
    }
  });

export type GameReportReconsideration = z.infer<typeof gameReportReconsiderationSchema>;

/** A critic's reconsideration of its review comment after a fact-table deletion. */
export const commentReconsiderationSchema = z
  .object({
    decision: reconsiderationDecision,
    reason: nonEmpty,
    comment: commentPartsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.decision === "revised") !== (value.comment !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["comment"], message: "a comment is returned exactly when the decision is revised" });
    }
  });

export type CommentReconsideration = z.infer<typeof commentReconsiderationSchema>;

/** What one fact-update merge point merged and discarded, in notice order. */
export const factUpdateMergeSchema = z
  .object({
    merged: z.array(
      z
        .object({
          /** Subscriber key: chain:<seat>, game-report:<seat>:<step>:<round>:<critic> or comment:<seat>:<step>:<round>:<critic>. */
          key: nonEmpty,
          taskId: nonEmpty,
          notices: z.array(nonEmpty).min(1),
          /** The task's validated output: chainReconsiderationParts, gameReportReconsideration or commentReconsideration, by key. */
          output: z.record(z.string(), z.unknown()),
          /** Game reports only: the deletion epoch the revision was requested at. */
          epoch: z.number().int().min(0).optional(),
        })
        .strict(),
    ),
    discarded: z.array(
      z
        .object({
          key: nonEmpty,
          taskId: nonEmpty,
          notices: z.array(nonEmpty).min(1),
          reason: z.enum(["superseded", "report-changed", "seat-dismissed"]),
        })
        .strict(),
    ),
    /** Late merges only: true when a report or comment the chair or judge already had was revised or withdrawn. */
    reassess: z.boolean().optional(),
  })
  .strict();

export type FactUpdateMerge = z.infer<typeof factUpdateMergeSchema>;

/** Whether a submitted justification can contribute to the chair's consensus. */
export const gameReportAdmissionSchema = z
  .object({ admissible: z.boolean(), reason: nonEmpty })
  .strict();

/**
 * The chair's readable reason is the final decision artifact for this round.
 * A null label explicitly means no admissible report; it is never a clean pass.
 * Exact report IDs and issue positions require the round's inputs and are
 * checked by the runtime, in addition to these context-free invariants.
 */
export const gameChairDecisionSchema = z
  .object({
    reports: z.record(nonEmpty, gameReportAdmissionSchema),
    y: z.union([z.literal(0), z.literal(1), z.null()]),
    reason: nonEmpty,
    issues: z.array(judgeIssuePartsSchema).max(12),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const admitted = Object.values(decision.reports).some((report) => report.admissible);
    if ((decision.y === null) !== !admitted) {
      ctx.addIssue({
        code: "custom",
        path: ["y"],
        message: "y is null exactly when no report is admissible",
      });
    }
    if (decision.y !== 1 && decision.issues.length > 0) {
      ctx.addIssue({ code: "custom", path: ["issues"], message: "only y=1 carries repair issues" });
    }
    if (decision.y === 1 && !decision.issues.some((issue) => issue.mustAddress)) {
      ctx.addIssue({ code: "custom", path: ["issues"], message: "y=1 requires a must-address issue" });
    }
  });

export type GameChairDecision = z.infer<typeof gameChairDecisionSchema>;

/** Committee fact checks cite host-issued Supreme receipts in mediated bundles.
 * Legacy bundles still use exact fact conditions. Both paths check real standing
 * and complete citation coverage again during deterministic settlement. */
export const gameFactCheckSchema = z.object({
  factId: z.string().regex(/^F:[1-9][0-9]*$/),
  /** Required by the host for supreme-mediated bundles; optional for pinned legacy outputs. */
  approvalId: nonEmpty.optional(),
  /** Hash of the original cited badge, never the approved replacement target. */
  badgeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  /** Approved target badge. Supreme authorizes semantic support in mediated
   * bundles; legacy bundles require exact same-premise reconciliation. */
  verifiedFactId: z.string().regex(/^F:[1-9][0-9]*$/).optional(),
  conditions: nonEmpty,
  supportsConclusion: z.boolean(),
  reason: nonEmpty,
}).strict();

/** The chair's decisiveness label for one report's argument (scoring v3):
 * `decisive` holds and changes the requested solution's correctness,
 * `not-decisive` holds but changes nothing, `invalid` does not hold or does
 * not address the major-flaw event. The host decides y from it only under the
 * chair-decisive rule; an admitted report is scored whatever its label. */
export const gameReportLabelSchema = z.enum(["decisive", "not-decisive", "invalid"]);

export type GameReportLabel = z.infer<typeof gameReportLabelSchema>;

/** Run-level decision rule for committee settlement (workflow param gameDecisionRule). */
export const gameDecisionRuleSchema = z.enum(["committee-mean", "chair-decisive"]);

export type GameDecisionRule = z.infer<typeof gameDecisionRuleSchema>;

export const gameCommitteeReportSchema = z.object({
  admissible: z.boolean(),
  reason: nonEmpty,
  /** Required by the host for bundles that declare gameDecisionRule (the task
   * schema pins it); optional for pinned legacy outputs, which never carry it. */
  label: gameReportLabelSchema.optional(),
  factChecks: z.array(gameFactCheckSchema),
}).strict().superRefine((report, ctx) => {
  if (new Set(report.factChecks.map((check) => check.factId)).size !== report.factChecks.length) {
    ctx.addIssue({ code: "custom", path: ["factChecks"], message: "check each fact ID once" });
  }
  // Directly inspectable reasoning may need no table lookup. The chair's
  // reason explains admission; every badge that is cited must still support it.
  if (report.admissible && report.factChecks.some((check) => !check.supportsConclusion)) {
    ctx.addIssue({ code: "custom", path: ["factChecks"], message: "every checked fact must support an admitted conclusion" });
  }
});

/** The model admits arguments; the runtime alone computes the mean and label. */
export const gameCommitteeDecisionSchema = z.object({
  reports: z.record(nonEmpty, gameCommitteeReportSchema),
  reason: nonEmpty,
}).strict();

export type GameCommitteeDecision = z.infer<typeof gameCommitteeDecisionSchema>;

/** Supreme-only semantic consultation over a host-selected scoped table batch. */
export const factConsultationSchema = z.object({
  answer: nonEmpty,
  matches: z.array(z.object({
    factId: z.string().regex(/^F:[1-9][0-9]*$/),
    relation: z.enum(["equivalent", "supports", "conflicts", "related"]),
    reason: nonEmpty,
  }).strict()),
  approval: z.object({ approved: z.boolean(), targetFactId: z.string().regex(/^F:[1-9][0-9]*$/).optional(), reason: nonEmpty }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.matches.map((match) => match.factId)).size !== value.matches.length) {
    ctx.addIssue({ code: "custom", path: ["matches"], message: "each supplied fact is assessed at most once" });
  }
  if (value.approval?.approved === true && value.approval.targetFactId === undefined) {
    ctx.addIssue({ code: "custom", path: ["approval", "targetFactId"], message: "approval must name the fact that supports the requested use" });
  }
});

export type FactConsultation = z.infer<typeof factConsultationSchema>;

/** The floor of the committee scoring rule, 2 x (-75) - 25 = -175: the lowest
 * score one round can record (base S in [-75, 25], R = 2 S - the peer mean of S).
 * A v3 row penalised for an invented badge records exactly this score. */
export const GAME_SCORE_FLOOR = -175;

/** Host-computed observations; rejected reports carry nulls, except a v3 invented-badge penalty row (score GAME_SCORE_FLOOR). */
export const gameScoreRowSchema = z
  .object({
    criticId: nonEmpty,
    q: z.number().min(0).max(1),
    admissible: z.boolean(),
    reason: nonEmpty,
    brierLoss: z.number().min(0).max(1).nullable(),
    baseScore: z.number().min(-75).max(25).nullable(),
    peerMeanBaseScore: z.number().min(-75).max(25).nullable(),
    score: z.number().min(-175).max(125).nullable(),
  })
  .strict();

export type GameScoreRow = z.infer<typeof gameScoreRowSchema>;

/**
 * A deterministic score artifact plus the compatibility signal for the existing
 * patching loop. An unresolved round may use Interrupt only as a control signal;
 * its scientific label stays null and its issues stay empty.
 */
export const gameSettlementV1Schema = z
  .object({
    ruleVersion: z.literal("brier-peer/v1"),
    version: nonEmpty,
    y: z.union([z.literal(0), z.literal(1), z.null()]),
    status: z.enum(["settled", "no-valid-reports"]),
    admittedCount: z.number().int().min(0),
    rows: z.array(gameScoreRowSchema),
    decision: z.object({
      verdict: z.enum(["Pass", "Interrupt"]),
      reason: nonEmpty,
      suggestion: z.string(),
      evidence: evidenceSchema,
      issues: z.array(judgeIssuePartsSchema).max(12),
    }).strict(),
  })
  .strict()
  .superRefine((settlement, ctx) => {
    const admitted = settlement.rows.filter((row) => row.admissible);
    if (settlement.admittedCount !== admitted.length) {
      ctx.addIssue({ code: "custom", path: ["admittedCount"], message: "admittedCount must match the rows" });
    }
    if (new Set(settlement.rows.map((row) => row.criticId)).size !== settlement.rows.length) {
      ctx.addIssue({ code: "custom", path: ["rows"], message: "each critic has exactly one score row" });
    }
    const noReports = admitted.length === 0;
    if ((settlement.y === null) !== noReports || (settlement.status === "no-valid-reports") !== noReports) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "only a round with no admitted reports is unresolved" });
    }
    if (settlement.decision.verdict !== (settlement.y === 0 ? "Pass" : "Interrupt")) {
      ctx.addIssue({ code: "custom", path: ["decision", "verdict"], message: "the compatibility verdict must preserve the chair label" });
    }
    if (settlement.y !== 1 && settlement.decision.issues.length > 0) {
      ctx.addIssue({ code: "custom", path: ["decision", "issues"], message: "only y=1 carries repair issues" });
    }
    if (settlement.y === 1 && !settlement.decision.issues.some((issue) => issue.mustAddress)) {
      ctx.addIssue({ code: "custom", path: ["decision", "issues"], message: "y=1 requires a must-address issue" });
    }
    settlement.rows.forEach((row, index) => {
      const scored = row.admissible && settlement.y !== null;
      if ([row.brierLoss, row.baseScore, row.score].some((value) => (value !== null) !== scored)) {
        ctx.addIssue({ code: "custom", path: ["rows", index], message: "only admitted reports with a label receive scores" });
      }
      if ((row.peerMeanBaseScore !== null) !== (scored && admitted.length > 1)) {
        ctx.addIssue({ code: "custom", path: ["rows", index, "peerMeanBaseScore"], message: "a peer mean requires another admitted report" });
      }
    });
  });

export type GameSettlementV1 = z.infer<typeof gameSettlementV1Schema>;

export const gameScoreRowV2Schema = gameScoreRowSchema.extend({
  balanceBefore: z.number(),
  balanceAfter: z.number(),
  /** Latched removal from future critic assignments, never from thinking. */
  excluded: z.boolean(),
});

/** Centering preserves an identical probability exactly, including a threshold
 * tie; compensated addition limits cancellation for heterogeneous reports. */
export function stableGameMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const anchor = values[0]!;
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const delta = value - anchor - compensation;
    const next = sum + delta;
    compensation = (next - sum) - delta;
    sum = next;
  }
  return Math.min(1, Math.max(0, anchor + sum / values.length));
}

/** Committee settlement: the arithmetic decision and a durable private ledger.
 * Anonymous repair arguments contain only admitted reports at the threshold. */
export const gameSettlementV2Schema = z.object({
  ruleVersion: z.literal("brier-peer/v2"),
  version: nonEmpty,
  settlementId: nonEmpty,
  ledgerSequence: z.number().int().min(1),
  criticIds: z.array(nonEmpty),
  initialPoints: z.number().min(0),
  meanQ: z.number().min(0).max(1).nullable(),
  threshold: z.number().min(0).max(1),
  y: z.union([z.literal(0), z.literal(1), z.null()]),
  status: z.enum(["settled", "no-valid-reports"]),
  admittedCount: z.number().int().min(0),
  rows: z.array(gameScoreRowV2Schema),
  repairArguments: z.array(nonEmpty),
  decision: z.object({
    verdict: z.enum(["Pass", "Interrupt"]),
    reason: nonEmpty,
    suggestion: z.string(),
    evidence: evidenceSchema,
    issues: z.array(judgeIssuePartsSchema).max(12),
  }).strict(),
}).strict().superRefine((settlement, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  const admitted = settlement.rows.filter((row) => row.admissible);
  if (new Set(settlement.criticIds).size !== settlement.criticIds.length) fail(["criticIds"], "confirmed critic IDs must be unique");
  if (new Set(settlement.rows.map((row) => row.criticId)).size !== settlement.rows.length) fail(["rows"], "each critic has one score row");
  if (settlement.rows.some((row) => !settlement.criticIds.includes(row.criticId))) fail(["rows"], "score rows belong to the confirmed panel");
  if (settlement.admittedCount !== admitted.length) fail(["admittedCount"], "admittedCount must match the rows");
  const mean = stableGameMean(admitted.map((row) => row.q));
  const label = mean === null ? null : mean >= settlement.threshold ? 1 : 0;
  if ((mean === null) !== (settlement.meanQ === null) || (mean !== null && settlement.meanQ !== null && !close(mean, settlement.meanQ))) fail(["meanQ"], "meanQ is the arithmetic mean of admitted probabilities");
  if (settlement.y !== label) fail(["y"], "the threshold applied to the admitted mean determines y");
  if ((settlement.status === "no-valid-reports") !== (mean === null)) fail(["status"], "no admissible reports means unresolved");
  if (settlement.decision.verdict !== (label === 0 ? "Pass" : "Interrupt")) fail(["decision", "verdict"], "the repair signal must preserve the computed label");
  if (settlement.decision.issues.length !== 0) fail(["decision", "issues"], "committee repair uses anonymous arguments, not model-selected issues");
  if ((label !== 1 && settlement.repairArguments.length !== 0) || (label === 1 && settlement.repairArguments.length === 0)) fail(["repairArguments"], "only a blocked round carries repair arguments");
  settlement.rows.forEach((row, index) => {
    const path = ["rows", index];
    const scored = row.admissible && label !== null;
    if ([row.brierLoss, row.baseScore, row.score].some((value) => (value !== null) !== scored)) fail(path, "rejected reports receive no score");
    if ((row.peerMeanBaseScore !== null) !== (scored && admitted.length > 1)) fail([...path, "peerMeanBaseScore"], "a peer mean requires another admitted report");
    if (scored) {
      const loss = (row.q - label) ** 2;
      const base = 25 - 100 * loss;
      const peers = admitted.filter((other) => other.criticId !== row.criticId);
      const peerMean = peers.length ? peers.reduce((sum, other) => sum + 25 - 100 * (other.q - label) ** 2, 0) / peers.length : null;
      const score = peerMean === null ? base : 2 * base - peerMean;
      if (row.brierLoss !== null && !close(row.brierLoss, loss)) fail([...path, "brierLoss"], "incorrect Brier loss");
      if (row.baseScore !== null && !close(row.baseScore, base)) fail([...path, "baseScore"], "incorrect base score");
      if (row.peerMeanBaseScore !== null && peerMean !== null && !close(row.peerMeanBaseScore, peerMean)) fail([...path, "peerMeanBaseScore"], "incorrect peer mean");
      if (row.score !== null && !close(row.score, score)) fail([...path, "score"], "incorrect peer-adjusted score");
    }
    if (!close(row.balanceAfter, row.balanceBefore + (row.score ?? 0))) fail([...path, "balanceAfter"], "only a scored report changes the balance");
    if ((row.balanceBefore < 0 || row.balanceAfter < 0) && !row.excluded) fail([...path, "excluded"], "a negative balance disables future criticism");
  });
});

export type GameSettlementV2 = z.infer<typeof gameSettlementV2Schema>;

export const gameScoreRowV3Schema = gameScoreRowV2Schema.extend({
  /** The chair's label; null for a report the host did not admit or that carried none. */
  label: gameReportLabelSchema.nullable(),
  /** The label this report was scored against; null for an unscored report. */
  scoringLabel: z.union([z.literal(0), z.literal(1), z.null()]),
  /**
   * Present only on a penalised report: "invented-badge" when it cites a badge
   * never issued in the run's fact table, else "deleted-badge" when it cites,
   * as support, one deleted from the table before the report was requested.
   */
  penalty: z.enum(["invented-badge", "deleted-badge"]).optional(),
  /** The invented badge ids, unique and string-sorted (citedGameFactIds order). */
  inventedBadges: z.array(z.string().regex(/^F:[1-9][0-9]*$/)).min(1).optional(),
  /** The badge ids deleted before the report was requested that it cites as support, unique and string-sorted. */
  deletedBadges: z.array(z.string().regex(/^F:[1-9][0-9]*$/)).min(1).optional(),
});

export type GameScoreRowV3 = z.infer<typeof gameScoreRowV3Schema>;

/** Committee settlement under a recorded decision rule. `chair-decisive`: y is 1
 * exactly when an admitted report is labelled decisive, and every admitted
 * report is scored against y. `committee-mean`: y is the threshold applied to
 * the admitted mean; with leaveOneOut each report is scored against the label
 * the OTHER admitted reports produce, and a lone admitted report is unscored.
 * Base score, peer mean, peer-adjusted score and balances are the v2 arithmetic
 * over the scored rows. */
export const gameSettlementV3Schema = z.object({
  ruleVersion: z.literal("brier-peer/v3"),
  version: nonEmpty,
  settlementId: nonEmpty,
  ledgerSequence: z.number().int().min(1),
  criticIds: z.array(nonEmpty),
  initialPoints: z.number().min(0),
  decisionRule: gameDecisionRuleSchema,
  leaveOneOut: z.boolean(),
  /** Present exactly when the run enables the invented-badge penalty. */
  inventedBadgePenalty: z.literal(true).optional(),
  /** Present exactly when the run also fines badges deleted from its fact table before a report was requested. */
  deletedBadgePenalty: z.literal(true).optional(),
  meanQ: z.number().min(0).max(1).nullable(),
  threshold: z.number().min(0).max(1),
  y: z.union([z.literal(0), z.literal(1), z.null()]),
  status: z.enum(["settled", "no-valid-reports"]),
  admittedCount: z.number().int().min(0),
  rows: z.array(gameScoreRowV3Schema),
  repairArguments: z.array(nonEmpty),
  decision: z.object({
    verdict: z.enum(["Pass", "Interrupt"]),
    reason: nonEmpty,
    suggestion: z.string(),
    evidence: evidenceSchema,
    issues: z.array(judgeIssuePartsSchema).max(12),
  }).strict(),
}).strict().superRefine((settlement, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  const admitted = settlement.rows.filter((row) => row.admissible);
  if (new Set(settlement.criticIds).size !== settlement.criticIds.length) fail(["criticIds"], "confirmed critic IDs must be unique");
  if (new Set(settlement.rows.map((row) => row.criticId)).size !== settlement.rows.length) fail(["rows"], "each critic has one score row");
  if (settlement.rows.some((row) => !settlement.criticIds.includes(row.criticId))) fail(["rows"], "score rows belong to the confirmed panel");
  if (settlement.admittedCount !== admitted.length) fail(["admittedCount"], "admittedCount must match the rows");
  const mean = stableGameMean(admitted.map((row) => row.q));
  if ((mean === null) !== (settlement.meanQ === null) || (mean !== null && settlement.meanQ !== null && !close(mean, settlement.meanQ))) fail(["meanQ"], "meanQ is the arithmetic mean of admitted probabilities");
  const chairRule = settlement.decisionRule === "chair-decisive";
  const label = mean === null ? null : chairRule ? (admitted.some((row) => row.label === "decisive") ? 1 : 0) : mean >= settlement.threshold ? 1 : 0;
  if (settlement.y !== label) fail(["y"], chairRule ? "a decisive admitted report determines y under chair-decisive" : "the threshold applied to the admitted mean determines y");
  if ((settlement.status === "no-valid-reports") !== (mean === null)) fail(["status"], "no admissible reports means unresolved");
  if (settlement.decision.verdict !== (label === 0 ? "Pass" : "Interrupt")) fail(["decision", "verdict"], "the repair signal must preserve the computed label");
  if (settlement.decision.issues.length !== 0) fail(["decision", "issues"], "committee repair uses anonymous arguments, not model-selected issues");
  if ((label !== 1 && settlement.repairArguments.length !== 0) || (label === 1 && settlement.repairArguments.length === 0)) fail(["repairArguments"], "only a blocked round carries repair arguments");
  const leaveOneOut = !chairRule && settlement.leaveOneOut;
  const targetOf = (row: GameScoreRowV3): 0 | 1 | null => {
    if (!row.admissible || label === null) return null;
    if (!leaveOneOut) return label;
    const others = stableGameMean(admitted.filter((other) => other.criticId !== row.criticId).map((other) => other.q));
    return others === null ? null : others >= settlement.threshold ? 1 : 0;
  };
  const targets = new Map(settlement.rows.map((row) => [row.criticId, targetOf(row)] as const));
  const scoredRows = settlement.rows.filter((row) => targets.get(row.criticId) !== null);
  settlement.rows.forEach((row, index) => {
    const path = ["rows", index];
    const target = targets.get(row.criticId) ?? null;
    if (!row.admissible && row.label !== null) fail([...path, "label"], "a rejected report carries no chair label");
    if (chairRule && row.admissible && row.label === null) fail([...path, "label"], "chair-decisive scores admitted reports the chair labelled");
    if (row.scoringLabel !== target) fail([...path, "scoringLabel"], leaveOneOut ? "the scoring label is the threshold applied to the other admitted reports" : "the scoring label is y");
    const scored = target !== null;
    // A penalty row records GAME_SCORE_FLOOR as its score (checked below); its
    // other score fields stay null, as on any rejected report.
    const penalty = row.penalty !== undefined;
    if ([row.brierLoss, row.baseScore, ...(penalty ? [] : [row.score])].some((value) => (value !== null) !== scored)) fail(path, "only reports with a scoring label receive scores");
    if ((row.peerMeanBaseScore !== null) !== (scored && scoredRows.length > 1)) fail([...path, "peerMeanBaseScore"], "a peer mean requires another scored report");
    if (scored) {
      const loss = (row.q - target) ** 2;
      const base = 25 - 100 * loss;
      const peers = scoredRows.filter((other) => other.criticId !== row.criticId);
      const peerMean = peers.length ? peers.reduce((sum, other) => sum + 25 - 100 * (other.q - targets.get(other.criticId)!) ** 2, 0) / peers.length : null;
      const score = peerMean === null ? base : 2 * base - peerMean;
      if (row.brierLoss !== null && !close(row.brierLoss, loss)) fail([...path, "brierLoss"], "incorrect Brier loss");
      if (row.baseScore !== null && !close(row.baseScore, base)) fail([...path, "baseScore"], "incorrect base score");
      if (row.peerMeanBaseScore !== null && peerMean !== null && !close(row.peerMeanBaseScore, peerMean)) fail([...path, "peerMeanBaseScore"], "incorrect peer mean");
      if (row.score !== null && !close(row.score, score)) fail([...path, "score"], "incorrect peer-adjusted score");
    }
    const badges = row.inventedBadges;
    const invented = row.penalty === "invented-badge";
    if (invented !== (badges !== undefined)) fail([...path, "penalty"], "an invented-badge penalty and its invented badges are recorded together");
    if (badges !== undefined && badges.some((id, at) => at > 0 && !(badges[at - 1]! < id))) fail([...path, "inventedBadges"], "invented badges are unique and string-sorted");
    if (invented) {
      if (row.admissible || row.label !== null || row.scoringLabel !== null || row.brierLoss !== null || row.baseScore !== null || row.peerMeanBaseScore !== null) {
        fail(path, "an invented-badge penalty row is a rejected report without labels or base scores");
      }
      if (row.score !== GAME_SCORE_FLOOR) fail([...path, "score"], "an invented-badge penalty records exactly GAME_SCORE_FLOOR");
      if (settlement.inventedBadgePenalty !== true) fail([...path, "penalty"], "an invented-badge penalty requires a settlement that enables it");
    }
    // A deleted-badge penalty (fact updates): the same floor row, with the
    // deleted ids; a row fined for both offences is an invented-badge row that
    // also lists its deleted ids.
    const deleted = row.deletedBadges;
    if (row.penalty === "deleted-badge" && deleted === undefined) fail([...path, "deletedBadges"], "a deleted-badge penalty records its deleted badges");
    if (deleted !== undefined && !penalty) fail([...path, "deletedBadges"], "deleted badges are recorded only on a penalty row");
    if (deleted !== undefined && deleted.some((id, at) => at > 0 && !(deleted[at - 1]! < id))) fail([...path, "deletedBadges"], "deleted badges are unique and string-sorted");
    if (deleted !== undefined && settlement.deletedBadgePenalty !== true) fail([...path, "deletedBadges"], "a deleted-badge penalty requires a settlement that enables it");
    if (row.penalty === "deleted-badge") {
      if (row.admissible || row.label !== null || row.scoringLabel !== null || row.brierLoss !== null || row.baseScore !== null || row.peerMeanBaseScore !== null) {
        fail(path, "a deleted-badge penalty row is a rejected report without labels or base scores");
      }
      if (row.score !== GAME_SCORE_FLOOR) fail([...path, "score"], "a deleted-badge penalty records exactly GAME_SCORE_FLOOR");
    }
    if (!close(row.balanceAfter, row.balanceBefore + (row.score ?? 0))) fail([...path, "balanceAfter"], "only a scored report changes the balance");
    if ((row.balanceBefore < 0 || row.balanceAfter < 0) && !row.excluded) fail([...path, "excluded"], "a negative balance disables future criticism");
  });
});

export type GameSettlementV3 = z.infer<typeof gameSettlementV3Schema>;
export const gameSettlementSchema = z.union([gameSettlementV1Schema, gameSettlementV2Schema, gameSettlementV3Schema]);
export type GameSettlement = z.infer<typeof gameSettlementSchema>;

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
// paper-based panel composition (literature -> literatureScreen -> panelEvidence)
// ---------------------------------------------------------------------------

/** A number (artifact numbers are rounded to 6 decimals by the producer). */
const finite = z.number();
const count = z.number().int().min(0);

/** The search routes a literature query can come from (spec v2, Step 2). */
export const LITERATURE_ROUTES = [
  "title",
  "facet",
  "alias",
  "pair",
  "statement",
  "equivalent",
  "knn",
  "citation",
  "feedback",
  "keyterm",
] as const;

export type LiteratureRoute = (typeof LITERATURE_ROUTES)[number];

/** Why a merged paper is (not) part of the eligible evidence set. */
export const LITERATURE_DECISIONS = [
  "eligible",
  "excluded:no-abstract",
  "excluded:short-abstract",
  "excluded:cap",
  "excluded:type",
] as const;

/** One retrieval need: the core, a facet, the formulation or an equivalent problem. */
export const literatureNeedSchema = z
  .object({
    id: count,
    kind: z.enum(["core", "facet", "formulation", "equivalent"]),
    name: z.string(),
    text: z.string(),
    /** w_f; 0 means the need only feeds retrieval. */
    weight: finite.min(0),
    /** Encoder mode the need text is embedded in. */
    mode: z.enum(["doc", "query"]),
  })
  .strict();

export const literaturePaperSchema = z
  .object({
    /** Run-local id (P0001...), assigned in fused-rank order. */
    pid: nonEmpty,
    /** Canonical id: doi:..., arxiv:..., s2:..., oa:..., core:..., or title:... */
    cid: nonEmpty,
    title: z.string(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    ids: z
      .object({
        doi: z.string().optional(),
        arxivId: z.string().optional(),
        pmid: z.string().optional(),
        s2Id: z.string().optional(),
        oaId: z.string().optional(),
        coreId: z.string().optional(),
      })
      .strict(),
    sources: z.array(z.string()),
    routes: z.array(z.string()),
    rounds: z.array(z.number().int().min(1)),
    /** One (best) rank per (query, source). */
    hits: z.array(
      z
        .object({
          source: z.string(),
          query: z.string(),
          rank: z.number().int().min(1),
        })
        .strict(),
    ),
    rrf: finite,
    abstract: z.string().optional(),
    abstractChars: count,
    decision: z.enum(LITERATURE_DECISIONS),
    /** The m most similar topics with their margin weights pi(d,t). */
    placement: z
      .array(z.object({ topic: nonEmpty, sim: finite, pi: finite }).strict())
      .optional(),
    /** c(d, t_(m+1)): the similarity of the first topic outside the placement. */
    nextSim: finite.optional(),
    /** s(d,f) for every need, in need order. */
    needSims: z.array(finite).optional(),
    /** Best placement similarity in the run's lowest weakPlacementQuantile. */
    weak: z.boolean().optional(),
  })
  .strict();

export type LiteraturePaper = z.infer<typeof literaturePaperSchema>;

/**
 * The literature record of one run (literature.retrieve, spec v2 Steps 1-5):
 * needs, query plan, every call, the merged papers with their placement into
 * the taxonomy and their similarity to every need, and the run's flags.
 */
export const literatureSchema = z
  .object({
    version: z.literal(1),
    needs: z.array(literatureNeedSchema),
    W: finite,
    encoder: z
      .object({
        id: nonEmpty,
        dim: z.number().int().min(0),
        models: z.record(z.string(), z.string()),
        nodeVectorsSha256: z.string(),
        nodeTextsSha256: z.string(),
        taxonomyRevision: z.number().int(),
      })
      .strict(),
    sources: z.array(
      z
        .object({
          id: nonEmpty,
          state: z.enum(["available", "needs-key", "unavailable", "disabled"]),
          detail: z.string().optional(),
        })
        .strict(),
    ),
    queries: z.array(
      z
        .object({
          id: nonEmpty,
          text: z.string(),
          route: z.enum(LITERATURE_ROUTES),
          round: z.number().int().min(1),
          own: z.number().int().min(0).nullable(),
          sources: z.array(z.string()),
        })
        .strict(),
    ),
    calls: z.array(
      z
        .object({
          source: z.string(),
          query: z.string(),
          ok: z.boolean(),
          outcome: z.enum(["ok", "cached", "error"]),
          n: count,
          nAbstract: count,
          error: z.string().optional(),
        })
        .strict(),
    ),
    rounds: z.array(
      z
        .object({
          round: z.number().int().min(1),
          calls: count,
          newPapers: count,
          newEligible: count,
        })
        .strict(),
    ),
    papers: z.array(literaturePaperSchema),
    /** Eligible papers, abstract cut to 600 characters, for the relevance screen. */
    screenItems: z.array(
      z.object({ pid: nonEmpty, title: z.string(), abstract: z.string() }).strict(),
    ),
    flags: z
      .object({
        weakCut: finite.optional(),
        hubs: z.array(z.object({ topic: nonEmpty, share: finite }).strict()),
        budgetExhausted: z.boolean(),
        notes: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type Literature = z.infer<typeof literatureSchema>;

/** The optional relevance screen's verdicts (literature-screener, or literature.noScreen). */
export const literatureScreenSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          pid: nonEmpty,
          onTopic: z.boolean(),
          reason: z.string().max(200),
        })
        .strict(),
    ),
    /** Why no screen ran (e.g. "relevance screen off"). */
    skipped: z.string().optional(),
  })
  .strict();

export type LiteratureScreen = z.infer<typeof literatureScreenSchema>;

/**
 * The evidence record of panel.compose (spec v2 Steps 6-11): evidence per
 * need, the candidates with their affinities, the greedy order with its
 * curve, every seat in greedy order, the flags and the determinism hash.
 */
export const panelEvidenceSchema = z
  .object({
    version: z.literal(1),
    params: z.record(z.string(), z.unknown()),
    evidence: z.array(
      z
        .object({
          need: count,
          ownShare: finite,
          thin: z.boolean(),
          sK1: finite.nullable(),
          papers: z.array(z.object({ pid: nonEmpty, sim: finite, omega: finite }).strict()),
          topTopics: z.array(z.object({ topic: nonEmpty, P: finite }).strict()),
        })
        .strict(),
    ),
    candidates: z.array(
      z
        .object({
          cand: nonEmpty,
          kind: z.enum(["topic", "anchor"]),
          name: z.string(),
          subfield: z.string(),
          field: z.string(),
          support: count,
          a: z.array(finite),
          P: z.array(finite),
          M: finite,
          anchorNeed: count.optional(),
        })
        .strict(),
    ),
    greedy: z
      .object({
        trace: z.array(
          z
            .object({
              k: z.number().int().min(1),
              cand: nonEmpty,
              gain: finite,
              F: finite,
              Fnorm: finite,
              coverage: z.array(finite),
              runnerUp: z.string().optional(),
              runnerUpGain: finite.optional(),
              contrib: z.record(z.string(), finite),
            })
            .strict(),
        ),
        droppedByCap: z.array(
          z
            .object({
              cand: nonEmpty,
              why: z.enum(["subfield cap", "field cap"]),
              atK: z.number().int().min(1),
              gain: finite,
            })
            .strict(),
        ),
        rescued: z.array(z.string()),
        kStar: count,
        kCov: count.nullable(),
        epsW: finite,
      })
      .strict(),
    seats: z.array(
      z
        .object({
          id: nonEmpty,
          department: nonEmpty,
          umbrella: nonEmpty,
          subfields: z.array(nonEmpty),
          kind: z.enum(["topic", "anchor"]),
          cand: nonEmpty,
          covers: z.array(z.string()),
          exemplars: z.array(z.object({ pid: nonEmpty, score: finite }).strict()),
          inKStar: z.boolean(),
        })
        .strict(),
    ),
    flags: z
      .object({
        sourceShare: z.record(z.string(), finite),
        sourceAlarm: z.array(z.string()),
        thinNeeds: z.array(z.string()),
        anchoredSeats: z.array(z.string()),
        failedSources: z.array(z.string()),
        screenedOut: count,
        weakPlacements: count,
        /** What the record could not do as specified (label-only fallback, unknown topics, fill-up). */
        notes: z.array(z.string()).optional(),
      })
      .strict(),
    determinismSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type PanelEvidence = z.infer<typeof panelEvidenceSchema>;

// ---------------------------------------------------------------------------
// fact table (the supreme judge's ruling on one submission)
// ---------------------------------------------------------------------------

/**
 * The fact table's closed vocabularies: core's FACT_CASES, FACT_METHODS,
 * FACT_RESOLUTIONS, FACT_KINDS and FACT_INTEGRITY (core/src/facts.ts),
 * restated because content does not depend on core. A brainstorm-runtime
 * test asserts that both copies agree; the names differ from core's so a
 * module importing both packages sees no clash.
 * - cases: the answer one submission receives;
 * - methods: how the supreme judge checked a claim ("none" only when nothing
 *   could be checked);
 * - resolutions: what a ruling does to an entry the submission contradicts;
 * - kinds: what a submitted fact is about;
 * - integrity: whether the submitted justification itself was honest.
 */
export const FACT_VERDICT_CASES = [
  "justified",
  "justified-new",
  "narrowed",
  "conflict",
  "refuted",
  "unverified",
  "not-a-fact",
] as const;

export const FACT_VERDICT_METHODS = [
  "re-executed",
  "source-quoted",
  "record-match",
  "judgement-only",
  "none",
] as const;

export const FACT_VERDICT_RESOLUTIONS = [
  "incumbent-stands",
  "incumbent-revoked",
  "both-narrowed",
  "disputed",
] as const;

export const FACT_VERDICT_KINDS = ["code", "record", "result", "literature", "math", "background"] as const;

export const FACT_VERDICT_INTEGRITY = ["honest", "unsupported", "misrepresented", "fabricated"] as const;

/** The id of a table entry: "F:" and a positive integer. */
const factId = z.string().regex(/^F:[1-9][0-9]*$/, { message: 'an entry id is "F:" and a positive integer' });

/** One contradicted entry of the table, and what the ruling does to it. */
const factConflictSchema = z
  .object({
    id: factId,
    resolution: z.enum(FACT_VERDICT_RESOLUTIONS),
    /** For "both-narrowed": the conditions the entry holds under from now on. */
    conditions: z.string().min(1).max(1200).optional(),
    explanation: z.string().min(1).max(1200),
  })
  .strict();

/**
 * The supreme judge's ruling on one fact-table submission (core's
 * FactVerdict). The worker commits it to the run's table, so the case and the
 * rest of the ruling must agree:
 * - "justified" names, in `existing`, the entry that already covers the
 *   claim — and no other case names one — and it contradicts nothing;
 * - "conflict" contradicts at least one entry, each of which stands or is
 *   disputed;
 * - "justified-new" and "narrowed" issue a badge, so the claim was checked
 *   (a method other than "none", evidence that is not blank) and every entry
 *   it contradicts is revoked or narrowed;
 * - "refuted" carries the evidence that refutes the claim and contradicts
 *   nothing; "unverified" and "not-a-fact" contradict nothing;
 * - a "both-narrowed" entry states the conditions it keeps, and no entry is
 *   ruled on twice.
 * The rules say what a case MEANS, so they stay strict: a ruling that breaks
 * one would put a badge in the table that its own record contradicts.
 */
export const factVerdictSchema = z
  .object({
    case: z.enum(FACT_VERDICT_CASES),
    /** The claim as checked: for "narrowed", the narrowed claim. */
    claim: z.string().min(1).max(600),
    /** The conditions it holds under ("none" when unconditional). */
    conditions: z.string().min(1).max(1200),
    method: z.enum(FACT_VERDICT_METHODS),
    /** What the supreme judge did and found: the script and its output, the quote and its source, the file and line. */
    evidence: z.string().max(8000),
    /** Addressed to the requester: what was found and why the case follows. */
    explanation: z.string().min(1).max(2000),
    /** For "justified": the entry that already covers the claim. */
    existing: factId.optional(),
    /** The entries the claim contradicts, each with its ruling. */
    conflicts: z.array(factConflictSchema).max(8),
    /** Whether the submitted justification itself was honest; never shown to the requester. */
    integrity: z.enum(FACT_VERDICT_INTEGRITY),
  })
  .strict()
  .superRefine((verdict, ctx) => {
    if (verdict.case === "justified" && verdict.existing === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["existing"],
        message: "justified names the entry that already covers the claim",
      });
    }
    if (verdict.case !== "justified" && verdict.existing !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["existing"],
        message: `only a justified verdict names an existing entry, not ${verdict.case}`,
      });
    }
    if (
      (verdict.case === "justified" ||
        verdict.case === "refuted" ||
        verdict.case === "unverified" ||
        verdict.case === "not-a-fact") &&
      verdict.conflicts.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicts"],
        message: `${verdict.case} contradicts no entry, so it lists no conflicts`,
      });
    }
    if (verdict.case === "conflict") {
      if (verdict.conflicts.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["conflicts"],
          message: "conflict names at least one entry the claim contradicts",
        });
      }
      verdict.conflicts.forEach((conflict, index) => {
        if (conflict.resolution !== "incumbent-stands" && conflict.resolution !== "disputed") {
          ctx.addIssue({
            code: "custom",
            path: ["conflicts", index, "resolution"],
            message: `in a conflict every contradicted entry stands or is disputed, not ${conflict.resolution}`,
          });
        }
      });
    }
    if (verdict.case === "justified-new" || verdict.case === "narrowed") {
      verdict.conflicts.forEach((conflict, index) => {
        if (conflict.resolution !== "incumbent-revoked" && conflict.resolution !== "both-narrowed") {
          ctx.addIssue({
            code: "custom",
            path: ["conflicts", index, "resolution"],
            message: `${verdict.case} revokes or narrows every entry it contradicts, not ${conflict.resolution}`,
          });
        }
      });
      if (verdict.method === "none") {
        ctx.addIssue({
          code: "custom",
          path: ["method"],
          message: `${verdict.case} issues a badge, so the claim was checked: the method cannot be none`,
        });
      }
    }
    if (
      (verdict.case === "justified-new" || verdict.case === "narrowed" || verdict.case === "refuted") &&
      verdict.evidence.trim().length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `${verdict.case} carries the evidence the check produced`,
      });
    }
    const seen = new Set<string>();
    verdict.conflicts.forEach((conflict, index) => {
      if (conflict.resolution === "both-narrowed" && conflict.conditions === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["conflicts", index, "conditions"],
          message: "both-narrowed states the conditions the entry keeps",
        });
      }
      if (seen.has(conflict.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["conflicts", index, "id"],
          message: `entry "${conflict.id}" is ruled on more than once`,
        });
      }
      seen.add(conflict.id);
    });
  });

export type FactVerdictArtifact = z.infer<typeof factVerdictSchema>;

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
  gameCritique: gameCritiqueSchema,
  gameChairDecision: gameChairDecisionSchema,
  gameCommitteeDecision: gameCommitteeDecisionSchema,
  factConsultation: factConsultationSchema,
  gameSettlement: gameSettlementSchema,
  redevelopmentPatchParts: redevelopmentPatchPartsSchema,
  finalProposal: finalProposalSchema,
  bridgeReport: bridgeReportSchema,
  // Paper-based panel composition: retrieval record, screen, evidence record.
  literature: literatureSchema,
  literatureScreen: literatureScreenSchema,
  panelEvidence: panelEvidenceSchema,
  // The fact table's verifier: the supreme judge's ruling on one submission.
  factVerdict: factVerdictSchema,
  // Fact updates: the three reconsideration outputs and what a merge point merged.
  chainReconsiderationParts: chainReconsiderationPartsSchema,
  gameReportReconsideration: gameReportReconsiderationSchema,
  commentReconsideration: commentReconsiderationSchema,
  factUpdateMerge: factUpdateMergeSchema,
} as const;

export type ArtifactSchemaName = keyof typeof artifactSchemas;
