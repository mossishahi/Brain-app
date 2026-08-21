/**
 * Deterministic offline AgentExecutor: produces schema-valid artifacts for
 * every brainstorm role without any network or provider SDK. Used by
 * `--offline` runs and by the worker's own tests, so the full nested pipeline
 * (panel selection, review rounds, chair) can be exercised end to end.
 */
import type { ChainPart, LoadedInputTypes } from "@brainstorm-agentic/content";
import type { AgentExecutor, AgentResult, AgentTask, JsonObject, JsonValue } from "@brainstorm-agentic/core";

function asObject(value: JsonValue | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function paragraphs(label: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${label} paragraph ${i + 1}.`);
}

function paperBody(label: string): JsonObject {
  return {
    abstract: paragraphs(`${label} abstract`, 3),
    introduction: paragraphs(`${label} introduction`, 3),
    method: paragraphs(`${label} method`, 3),
    discussion: paragraphs(`${label} discussion`, 3),
    conclusion: [`${label} conclusion paragraph.`],
  };
}

/**
 * The offline executor only stubs the `paper` output shape, so its processor
 * always classifies the run as the loaded catalog's paper-shaped type (the
 * residual default). The type NAME comes from the catalog, never from code,
 * so renaming types in catalog/input-types.json keeps offline runs working.
 */
function paperTypeOf(inputTypes: LoadedInputTypes | undefined): string {
  if (!inputTypes) return "research idea";
  for (const [name, shape] of Object.entries(inputTypes.shapes)) {
    if (shape === "paper") return name;
  }
  // Description-only bundles (pre-0.2.0) have no shape projections; their
  // residual default is the last listed type.
  const names = Object.keys(inputTypes.types);
  if (names.length === 0) throw new Error("offline executor: input-type catalog defines no types");
  return names[names.length - 1]!;
}

/**
 * One four-part chain step. The parts carry no assigned meaning — they are a
 * size discipline, not a reasoning schema — so the stand-in simply divides
 * one deterministic step across the four keys. All four are written even when
 * a part would be uninteresting: `cotStepPartsSchema` is strict and none of
 * the parts is optional, so an omitted key is a failed run, not an empty box.
 */
function cotParts(label: string, index: number): JsonObject {
  return {
    part1: `${label} chain step ${index} part 1: the claim this step puts forward.`,
    part2: `${label} chain step ${index} part 2: what the claim rests on.`,
    part3: `${label} chain step ${index} part 3: the check that would break it.`,
    part4: `${label} chain step ${index} part 4: what the next step leaves to settle.`,
  };
}

/**
 * The flaw list a part-aware reviewer submits: one entry per step it has been
 * shown, every part key present, and text only in the boxes it actually has
 * something for. This is the DRAFT the skills describe, emitted here rather
 * than a pre-pruned list on purpose — an offline fixture then drives the
 * runtime's empty-prune exactly as a live reviewer does, so the pruned list
 * that reaches the journal is produced by the prune and not by the stand-in.
 *
 * `mark` writes one note into one box. Every other box and every other entry
 * stays empty, which exercises BOTH halves of the prune: an empty part inside
 * a surviving entry, and an entry whose four parts are all empty.
 */
function flawDraft(
  reviewedThrough: number,
  mark?: { readonly step: number; readonly part: ChainPart; readonly text: string },
): JsonValue[] {
  // The schema caps the list at nine entries, the chain's own maximum; a
  // review position beyond that would make the fixture itself unwritable.
  const entries = Math.max(0, Math.min(reviewedThrough, 9));
  return Array.from({ length: entries }, (_, i) => {
    const step = i + 1;
    // The note overwrites its box in place — a spread keeps the key at its
    // first position — so the four parts stay in chain order in every entry.
    const note = mark !== undefined && mark.step === step ? { [mark.part]: mark.text } : {};
    return { step, part1: "", part2: "", part3: "", part4: "", ...note };
  });
}

const noEvidence: JsonObject = {
  kind: "none",
  code: "",
  result: "",
  derivation: "",
  citation: "",
  locator: "",
  shows: "",
};

/**
 * The requested-output section list a member's envelope must carry: one
 * response per entry of the structured input's `requestedOutputs`, in order,
 * titles echoed verbatim — the same contract the runtime enforces. Returns
 * undefined when the run recorded no requested outputs.
 */
function requestedSections(input: JsonValue | undefined, label: string): JsonValue[] | undefined {
  const requested = asObject(input).requestedOutputs;
  if (!Array.isArray(requested) || requested.length === 0) return undefined;
  return requested.flatMap((entry) => {
    const ask = asObject(entry as JsonValue);
    if (typeof ask.title !== "string") return [];
    return [
      {
        title: ask.title,
        response: [`${label} offline deterministic response answering the requested output.`],
      },
    ];
  });
}

export interface OfflineExecutorOptions {
  /** Chain-of-thought steps the offline processor requests. Default 3. */
  readonly cotSteps?: number;
  /** The loaded input-type catalog; the executor classifies runs as its paper-shaped type. */
  readonly inputTypes?: LoadedInputTypes;
}

export class OfflineBrainstormExecutor implements AgentExecutor {
  readonly executed: Array<{ role: string; agentId: string }> = [];
  private readonly cotSteps: number;
  private readonly paperType: string;
  private readonly alternativeType: string;

  constructor(options: OfflineExecutorOptions = {}) {
    this.cotSteps = options.cotSteps ?? 3;
    this.paperType = paperTypeOf(options.inputTypes);
    // The classifier's second option must be a different catalog type; any
    // deterministic pick works offline (first non-paper type in order).
    this.alternativeType =
      Object.keys(options.inputTypes?.types ?? {}).find(
        (name) => name !== this.paperType,
      ) ?? "unverified claim";
  }

  private developedOutput(label: string): JsonObject {
    return { type: this.paperType, paper: paperBody(label) };
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const input = asObject(task.input);
    const bindings = asObject(input.bindings as JsonValue);
    const role = String(input.role ?? task.kind ?? "");
    const agentId = task.agentId ?? role;
    this.executed.push({ role, agentId });
    // Which SHAPE a role writes is the TASK's choice, never the role's: the
    // same commentor writes a scalar-step comment under a 0.15..0.22 bundle
    // and a part-keyed flaw list under a newer one, and the artifact is
    // validated against the name the node declared. Reading the name off the
    // task is what keeps one offline executor valid for every bundle the
    // worker can still load. The names are listed literally, exactly as the
    // runtime lists them, so a pinned run takes the path its own bundle was
    // compiled against and an unknown name falls through to the legacy shape.
    const schemaName = task.outputSchema?.name ?? "";

    let output: JsonValue;
    switch (role) {
      case "processor": {
        const submission = asObject(bindings.submission as JsonValue);
        const prompt = typeof submission.prompt === "string" ? submission.prompt : "Untitled topic";
        const attachments = Array.isArray(submission.attachments)
          ? submission.attachments.map((entry) => asObject(entry as JsonValue))
          : [];
        const files = attachments.flatMap((attachment) => {
          const inventory = Array.isArray(attachment.files) ? attachment.files : [];
          return inventory.flatMap((candidate) => {
            const file = asObject(candidate as JsonValue);
            if (typeof file.path !== "string") return [];
            const base = file.path.split("/").pop()?.toLowerCase() ?? "";
            const useless =
              base.startsWith(".") || base.includes("lock") || base.endsWith(".log");
            return [
              useless
                ? { path: file.path, label: "NA", note: "" }
                : {
                    path: file.path,
                    label: "code",
                    note: `Offline deterministic relation for ${base}.`,
                  },
            ];
          });
        });
        output = {
          type: this.paperType,
          title: prompt.slice(0, 80),
          question: prompt,
          context: "Offline deterministic context.",
          attachments: attachments.flatMap((attachment) =>
            typeof attachment.name === "string"
              ? [{ name: attachment.name, note: "Offline deterministic attachment note." }]
              : [],
          ),
          assumptions: [],
          cotSteps: this.cotSteps,
          // One deterministic explicit ask, so every offline run exercises
          // the requested-output contract end to end (members must echo one
          // section per entry; the runtime enforces it on write).
          requestedOutputs: [
            {
              title: "Submitter takeaway",
              ask: "State, in direct address to the submitter, the single most decision-relevant takeaway of this treatment.",
            },
          ],
          files,
        };
        break;
      }
      case "classifier": {
        // Deterministic classification mirroring the offline processor's
        // paper-shaped reading, with the same single explicit ask so every
        // offline run exercises the requested-output contract end to end.
        output = {
          primary: {
            type: this.paperType,
            reason:
              "Offline deterministic classification: the residual paper-shaped reading of the submission.",
          },
          alternative: {
            type: this.alternativeType,
            reason:
              "Offline deterministic runner-up: the strongest other reading a careful reader could take.",
          },
          cotSteps: this.cotSteps,
          requestedOutputs: [
            {
              title: "Submitter takeaway",
              ask: "State, in direct address to the submitter, the single most decision-relevant takeaway of this treatment.",
            },
          ],
          embeddingInput: {
            title: "Offline deterministic study of graph-based representation learning",
            abstract:
              "This work studies how graph-based machine learning methods recover useful low-dimensional structure from high-dimensional observations. " +
              "It examines the construction of neighborhood graphs, the optimization objectives that align learned representations with the underlying data geometry, and the failure modes that arise when spurious connections contaminate the graph. " +
              "A successful outcome is a representation whose pairwise distances faithfully reflect the true relationships in the data.",
            facets: [
              {
                name: "graph representation learning",
                statement:
                  "Graph representation learning studies how to encode nodes, edges, and whole graphs into vector spaces that preserve structural and semantic relationships for downstream prediction tasks.",
                relevance: 0.9,
              },
              {
                name: "dimensionality reduction",
                statement:
                  "Dimensionality reduction maps high-dimensional data into low-dimensional spaces while preserving the relationships that matter, trading off local neighborhood fidelity against global structure.",
                relevance: 0.7,
              },
              {
                name: "mathematical optimization",
                statement:
                  "Mathematical optimization studies algorithms that minimize or maximize objective functions under constraints, including the convergence behavior of first-order methods on non-convex landscapes.",
                relevance: 0.5,
              },
            ],
          },
        };
        break;
      }
      case "code-annotator": {
        // One deterministic summary per bound code file, in the given order,
        // mirroring the completeness-and-order contract the runtime enforces.
        const files = Array.isArray(bindings.files) ? bindings.files : [];
        output = {
          files: files.flatMap((candidate) => {
            const file = asObject(candidate as JsonValue);
            if (typeof file.path !== "string") return [];
            const base = file.path.split("/").pop() ?? file.path;
            return [
              {
                path: file.path,
                summary: `Offline deterministic summary of ${base}: module contents related to the input topic.`,
              },
            ];
          }),
        };
        break;
      }
      case "pool-builder":
        // Terms chosen to resolve against the bundle's real taxonomy seed
        // (names or curated aliases), plus one unmatched member the placer
        // decides. Deterministic offline stand-in for the literature pool.
        output = {
          members: [
            {
              term: "Graph Neural Networks",
              count: 2,
              relevance: 0.95,
              variants: ["Graph Neural Networks", "GNNs"],
              origins: [
                { name: "Ada Lovelace", paper: "Offline Survey of Graph Representation Learning", stated: "Graph Neural Networks" },
                { name: "Norbert Wiener", paper: "Optimal Transport for Structured Prediction", stated: "GNNs" },
              ],
            },
            {
              term: "Deep Learning",
              count: 2,
              relevance: 0.8,
              variants: ["Deep Learning"],
              origins: [
                { name: "Ada Lovelace", paper: "Offline Survey of Graph Representation Learning", stated: "Deep Learning" },
                { name: "Norbert Wiener", paper: "Optimal Transport for Structured Prediction", stated: "Deep Learning" },
              ],
            },
            {
              term: "Mathematical Optimization",
              count: 2,
              relevance: 0.55,
              variants: ["Mathematical Optimization", "Optimization"],
              origins: [
                { name: "Norbert Wiener", paper: "Optimal Transport for Structured Prediction", stated: "Optimization" },
                { name: "Ada Lovelace", paper: "Offline Survey of Graph Representation Learning", stated: "Mathematical Optimization" },
              ],
            },
            {
              term: "Variational Autoencoders",
              count: 1,
              relevance: 0.75,
              variants: ["Variational Autoencoders", "VAEs"],
              origins: [
                { name: "Ada Lovelace", paper: "Offline Survey of Graph Representation Learning", stated: "VAEs" },
              ],
            },
            {
              term: "Statistics",
              count: 1,
              relevance: 0.45,
              variants: ["Statistics"],
              origins: [
                { name: "Norbert Wiener", paper: "Optimal Transport for Structured Prediction", stated: "Statistics" },
              ],
            },
            {
              term: "Offline Curiosity Studies",
              count: 1,
              relevance: 0.3,
              variants: ["Offline Curiosity Studies"],
              origins: [
                { name: "Ada Lovelace", paper: "Offline Survey of Graph Representation Learning", stated: "Offline Curiosity Studies" },
              ],
            },
          ],
          grounding: {
            papers: [
              {
                title: "Offline Survey of Graph Representation Learning",
                authors: ["Ada Lovelace", "Norbert Wiener"],
                year: 2024,
                venue: "Offline Proceedings",
                url: "https://example.org/grounding-paper-1",
                relation: "Surveys the fields the pool is drawn from.",
              },
              {
                title: "Optimal Transport for Structured Prediction",
                authors: ["Norbert Wiener", "Unlisted Author"],
                year: 2023,
                venue: "Offline Journal",
                relation: "Connects the optimization members to the topic.",
              },
            ],
            scholars: [
              {
                name: "Ada Lovelace",
                affiliation: "Offline Institute of Technology",
                url: "https://scholar.example.org/ada-lovelace",
                profile: "ok",
                interests: ["Graph Neural Networks", "Deep Learning", "Variational Autoencoders"],
              },
              {
                name: "Norbert Wiener",
                affiliation: "Offline State University",
                url: "https://scholar.example.org/norbert-wiener",
                profile: "ok",
                interests: ["Optimization", "Statistics", "Deep Learning"],
              },
              {
                name: "Unlisted Author",
                affiliation: "",
                url: "",
                profile: "no_profile",
                interests: [],
              },
            ],
          },
        };
        break;
      case "placer":
        output = {
          revision: 1,
          decisions: [
            {
              term: "Offline Curiosity Studies",
              outcome: "place",
              name: "Offline Curiosity Studies",
              parent: "Artificial Intelligence",
              aliases: [],
              reason: "Offline deterministic placement: a machine-learning research area housed with its peers.",
            },
          ],
        };
        break;
      case "decomposer":
        // Legacy fixture: kept so older published bundle versions (whose
        // workflow still carries the single decomposer) stay runnable offline.
        // Relevance is present because seating strictly requires it — real
        // pre-relevance history is unsupported and restarted instead.
        output = {
          departments: [
            {
              name: "Computer Science",
              domain: "engineering_and_applied_sciences",
              count: 3,
              relevance: 0.9,
              umbrellas: [
                {
                  name: "Graph Representation Learning",
                  count: 3,
                  relevance: 0.9,
                  subfields: [
                    { name: "graph learning", count: 2, relevance: 0.9 },
                    { name: "representation learning", count: 1, relevance: 0.7 },
                  ],
                },
                {
                  name: "Algorithms & Theory",
                  count: 1,
                  relevance: 0.4,
                  subfields: [{ name: "approximation algorithms", count: 1, relevance: 0.4 }],
                },
              ],
            },
            {
              name: "Mathematics",
              domain: "natural_sciences",
              count: 2,
              relevance: 0.6,
              umbrellas: [
                {
                  name: "Optimization",
                  count: 2,
                  relevance: 0.6,
                  subfields: [
                    { name: "optimal transport", count: 2, relevance: 0.6 },
                    { name: "convex optimization", count: 1, relevance: 0.5 },
                  ],
                },
              ],
            },
            {
              name: "Statistics",
              domain: "natural_sciences",
              count: 1,
              relevance: 0.45,
              umbrellas: [
                {
                  name: "Statistical Learning Theory",
                  count: 1,
                  relevance: 0.45,
                  subfields: [{ name: "generalization bounds", count: 1, relevance: 0.45 }],
                },
              ],
            },
          ],
          grounding: {
            papers: [
              {
                title: "Offline Survey of Graph Representation Learning",
                authors: ["Ada Lovelace", "Norbert Wiener"],
                year: 2024,
                venue: "Offline Proceedings",
                url: "https://example.org/grounding-paper-1",
                relation: "Surveys the umbrella fields the tree is built from.",
              },
              {
                title: "Optimal Transport for Structured Prediction",
                authors: ["Norbert Wiener", "Unlisted Author"],
                year: 2023,
                venue: "Offline Journal",
                relation: "Connects the optimization umbrella to the topic.",
              },
            ],
            scholars: [
              {
                name: "Ada Lovelace",
                affiliation: "Offline Institute of Technology",
                url: "https://scholar.example.org/ada-lovelace",
                profile: "ok",
                interests: ["representation learning", "graph learning"],
              },
              {
                name: "Norbert Wiener",
                affiliation: "Offline State University",
                url: "https://scholar.example.org/norbert-wiener",
                profile: "ok",
                interests: ["convex optimization", "optimal transport", "graph learning"],
              },
              {
                name: "Unlisted Author",
                affiliation: "",
                url: "",
                profile: "no_profile",
                interests: [],
              },
            ],
          },
        };
        break;
      case "brain": {
        const requested = requestedSections(bindings.input as JsonValue, agentId);
        output = {
          output: {
            ...this.developedOutput(agentId),
            ...(requested ? { requested } : {}),
          },
          cot: Array.from({ length: this.cotSteps }, (_, i) =>
            schemaName === "brainIdeaParts"
              ? cotParts(agentId, i + 1)
              : `${agentId} chain step ${i + 1} reasoning paragraph.`,
          ),
          novelty: `${agentId} novelty paragraph naming the two closest works and the precise gap.`,
          literature: [
            {
              title: `Closest prior work for ${agentId}`,
              authors: ["A. Author", "B. Author"],
              year: 2024,
              venue: "Offline Proceedings",
              url: "https://example.org/paper-1",
              relation: "Solves the local case; the global case remains open.",
            },
            {
              title: `Second related work for ${agentId}`,
              year: 2023,
              venue: "Offline Journal",
              relation: "Introduces the metric this idea extends.",
            },
          ],
        };
        break;
      }
      case "commentor": {
        const currentStep = typeof bindings.currentStep === "number" ? bindings.currentStep : 1;
        output =
          schemaName === "commentParts"
            ? {
                // No top-level `step`: the part-aware form is strict and each
                // flaw entry carries its own position instead.
                verdict: "Pass",
                reason: `${agentId} finds no demonstrable flaw standing in the reviewed steps.`,
                flaws: flawDraft(currentStep, {
                  step: currentStep,
                  part: "part2",
                  text: `${agentId} notes the support here is thin, though not yet faultable.`,
                }),
                suggestion: "",
                evidence: noEvidence,
              }
            : {
                verdict: "Pass",
                step: currentStep,
                reason: `${agentId} finds no demonstrable flaw standing in the reviewed steps.`,
                suggestion: "",
                evidence: noEvidence,
              };
        break;
      }
      case "interdisciplinary-commentor": {
        // The panel's interdisciplinary seat comments through its own skill;
        // offline it passes like every other commentor, with a seam-flavored
        // reason so the two comment paths stay distinguishable in fixtures.
        const currentStep = typeof bindings.currentStep === "number" ? bindings.currentStep : 1;
        output =
          schemaName === "commentParts"
            ? {
                verdict: "Pass",
                reason: `${agentId} finds every cross-field crossing of the reviewed steps carried by its own support.`,
                flaws: flawDraft(currentStep, {
                  step: currentStep,
                  part: "part3",
                  text: `${agentId} notes the crossing here is stated rather than shown.`,
                }),
                suggestion: "",
                evidence: noEvidence,
              }
            : {
                verdict: "Pass",
                step: currentStep,
                reason: `${agentId} finds every cross-field crossing of the reviewed steps carried by its own support.`,
                suggestion: "",
                evidence: noEvidence,
              };
        break;
      }
      case "judge": {
        const comments = asObject(bindings.comments as JsonValue);
        const currentStep = typeof bindings.currentStep === "number" ? bindings.currentStep : 1;
        const assessment = Object.keys(comments).map((commentorId) => ({
          commentorId,
          basis: "authority",
        }));
        output = {
          verdict: "Pass",
          reason: "No comment demonstrates a flaw or a necessary gap in the reviewed steps.",
          suggestion: "",
          evidence: noEvidence,
          issues: [],
          assessment,
          // The judge's own marks, in the same draft form the commentors
          // submit. A Pass confirmed nothing, so every box stays empty and the
          // prune reduces the whole draft to `flaws: []` — the recorded value
          // for a reviewer that was shown the parts and faulted none of them.
          // Spread conditionally: the legacy decision is strict and has no
          // such field, so an unconditional key would fail every old bundle.
          ...(schemaName === "judgeDecisionParts" ? { flaws: flawDraft(currentStep) } : {}),
        };
        break;
      }
      case "redeveloper": {
        // Full-chain re-emission: the offline reviser rewrites the current
        // step and copies the rest of the previous chain verbatim, mirroring
        // the minimal-edit contract the runtime diffs against.
        const currentStep = typeof bindings.currentStep === "number" ? bindings.currentStep : 1;
        if (schemaName === "redevelopmentPatch" || schemaName === "redevelopmentPatchParts") {
          // A patch names ONLY what changed and carries no `output` envelope
          // at all — the host fills every step and every section the patch
          // leaves unnamed, which is what makes an untouched step
          // byte-identical by construction rather than by diligence. So the
          // offline reviser names one step, the one under review, and patches
          // the single body section a repair at that step would move.
          output = {
            steps: [
              schemaName === "redevelopmentPatchParts"
                ? { index: currentStep, ...cotParts(`${agentId} revised`, currentStep) }
                : { index: currentStep, text: `${agentId} revised step ${currentStep} paragraph.` },
            ],
            outputPatch: {
              paper: { conclusion: [`${agentId} revised conclusion paragraph.`] },
            },
            novelty: `${agentId} revised novelty paragraph.`,
          };
          break;
        }
        const previous = Array.isArray(bindings.chain) ? bindings.chain : [];
        const requested = requestedSections(bindings.input as JsonValue, `${agentId} revised`);
        output = {
          output: {
            ...this.developedOutput(`${agentId} revised`),
            ...(requested ? { requested } : {}),
          },
          steps: Array.from({ length: this.cotSteps }, (_, i) => {
            const carried = previous[i];
            return i + 1 === currentStep || typeof carried !== "string"
              ? `${agentId} revised step ${i + 1} paragraph.`
              : carried;
          }),
          novelty: `${agentId} revised novelty paragraph.`,
        };
        break;
      }
      case "integrator": {
        const ideas = asObject(bindings.ideas as JsonValue);
        const roster = Array.isArray(bindings.roster) ? bindings.roster : [];
        const umbrellas = roster.flatMap((member) => {
          const umbrella = asObject(member as JsonValue).umbrella;
          return typeof umbrella === "string" ? [umbrella] : [];
        });
        output = {
          noveltyAudit: Object.entries(ideas).flatMap(([memberId, idea]) => {
            const novelty = asObject(idea as JsonValue).novelty;
            if (typeof novelty !== "string") return [];
            return [
              {
                memberId,
                claim: novelty,
                status: "clear",
                note: "Offline deterministic audit: no prior work surfaced against this claim.",
                evidence: noEvidence,
              },
            ];
          }),
          contradictions: [],
          seams: [
            {
              between: [umbrellas[0] ?? "Field A", umbrellas[1] ?? "Field B"],
              gap: "No member connected the two seated framings of the submission.",
              opportunity: "A joint treatment of both framings remains open, per the outputs.",
            },
          ],
        };
        break;
      }
      case "chair":
        output = {
          title: "Synthesized research proposal",
          framing: "The sharpened question and why it matters.",
          consensus: ["Direction multiple members converged on."],
          tensions: ["A substantive disagreement worth pursuing."],
          novelDirections: ["A cross-disciplinary direction that emerged."],
          actionItems: [{ priority: 1, action: "Design the first experiment", rationale: "It is decisive." }],
          applications: ["What solving this unlocks elsewhere."],
        };
        break;
      default:
        return {
          taskId: task.taskId,
          status: "error",
          error: { name: "OfflineExecutorError", message: `unknown role "${role}"` },
        };
    }
    return { taskId: task.taskId, status: "ok", output };
  }
}
