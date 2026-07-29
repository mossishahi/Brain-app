/**
 * Deterministic offline AgentExecutor: produces schema-valid artifacts for
 * every brainstorm role without any network or provider SDK. Used by
 * `--offline` runs and by the worker's own tests, so the full nested pipeline
 * (panel selection, review rounds, chair) can be exercised end to end.
 */
import type { LoadedInputTypes } from "@brainstorm-agentic/content";
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

const noEvidence: JsonObject = {
  kind: "none",
  code: "",
  result: "",
  derivation: "",
  citation: "",
  locator: "",
  shows: "",
};

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

  constructor(options: OfflineExecutorOptions = {}) {
    this.cotSteps = options.cotSteps ?? 3;
    this.paperType = paperTypeOf(options.inputTypes);
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
          files,
        };
        break;
      }
      case "decomposer":
        output = {
          departments: [
            {
              name: "Computer Science",
              umbrellas: [
                {
                  name: "Graph Representation Learning",
                  count: 3,
                  subfields: [
                    { name: "graph learning", count: 2 },
                    { name: "representation learning", count: 1 },
                  ],
                },
                {
                  name: "Algorithms & Theory",
                  count: 1,
                  subfields: [{ name: "approximation algorithms", count: 1 }],
                },
              ],
            },
            {
              name: "Mathematics",
              umbrellas: [
                {
                  name: "Optimization",
                  count: 2,
                  subfields: [
                    { name: "optimal transport", count: 2 },
                    { name: "convex optimization", count: 1 },
                  ],
                },
              ],
            },
            {
              name: "Statistics",
              umbrellas: [
                {
                  name: "Statistical Learning Theory",
                  count: 1,
                  subfields: [{ name: "generalization bounds", count: 1 }],
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
      case "brain":
        output = {
          output: this.developedOutput(agentId),
          cot: Array.from({ length: this.cotSteps }, (_, i) => `${agentId} chain step ${i + 1} reasoning paragraph.`),
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
      case "commentor":
        output = {
          verdict: "Pass",
          reason: `${agentId} finds the step sound and complete for its position in the chain.`,
          suggestion: "",
          evidence: noEvidence,
        };
        break;
      case "judge": {
        const comments = asObject(bindings.comments as JsonValue);
        const assessment = Object.keys(comments).map((commentorId) => ({
          commentorId,
          basis: "authority",
        }));
        output = {
          verdict: "Pass",
          reason: "No comment raises a point that would materially improve the next steps.",
          suggestion: "",
          evidence: noEvidence,
          assessment,
        };
        break;
      }
      case "redeveloper": {
        const fromStep = typeof bindings.currentStep === "number" ? bindings.currentStep : 1;
        const total = this.cotSteps;
        output = {
          fromStep,
          output: this.developedOutput(`${agentId} revised`),
          revisedSteps: Array.from(
            { length: total - fromStep + 1 },
            (_, i) => `${agentId} revised step ${fromStep + i} paragraph.`,
          ),
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
