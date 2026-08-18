import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OUTPUT_SHAPES,
  loadContent,
  type ContentBundle,
  type WorkflowDefinition as ContentWorkflowDefinition,
} from "@brainstorm-agentic/content";
import {
  contentCacheBoundaries,
  systemPromptSegments,
  systemPromptText,
  textContent,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import type {
  HostToolManifest,
  TaxonomyAccess,
  TaxonomyNodePosition,
  TaxonomyResolveResult,
} from "@brainstorm-agentic/core";

import { planTaskCaches } from "../src/cache-plan.js";
import {
  BrainstormRuntime,
  StaticBrainstormRouteResolver,
  taxonomyActivities,
} from "../src/index.js";

/**
 * Deterministic stand-in for the registry's shared taxonomy. Terms of the
 * pool fixture resolve to fixed four-level positions; everything else is NA.
 * Engineered so the experts bridge produces a tree with a known seating
 * order: department Σcxr values Physics 4.2 > Computer Science 2.6 >
 * Biology 2.35, each seated through its best umbrella (Quantum Optics,
 * Machine Learning, Systems Biology), Condensed Matter and Biophysics
 * trailing.
 */
const STUB_PATHS: Readonly<Record<string, readonly string[]>> = {
  "photon counting": ["Natural Sciences", "Physics", "Quantum Optics", "photon counting"],
  "quantum optics": ["Natural Sciences", "Physics", "Quantum Optics"],
  "transport": ["Natural Sciences", "Physics", "Condensed Matter", "transport"],
  "condensed matter": ["Natural Sciences", "Physics", "Condensed Matter"],
  "network inference": ["Life Sciences", "Biology", "Systems Biology", "network inference"],
  "single-molecule methods": ["Life Sciences", "Biology", "Biophysics", "single-molecule methods"],
  "machine learning": ["Engineering", "Computer Science", "Machine Learning"],
  "representation learning": ["Engineering", "Computer Science", "Machine Learning", "representation learning"],
};

class StubTaxonomy implements TaxonomyAccess {
  async resolve(query: string): Promise<TaxonomyResolveResult> {
    const path = STUB_PATHS[query.trim().toLowerCase()];
    if (!path) {
      return {
        query,
        found: false,
        status: "NA",
        revision: 7,
        beta: query.toLowerCase().split(/\s+/),
        options: ["Machine Learning"],
        total: 1,
      };
    }
    const levels = ["domain", "field", "subfield", "topic"] as const;
    const position: TaxonomyNodePosition = {
      id: `S:${path[path.length - 1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: path[path.length - 1]!,
      level: levels[path.length - 1]!,
      path,
      domain: path[0]!,
      ...(path[1] ? { field: path[1] } : {}),
      ...(path[2] ? { subfield: path[2] } : {}),
      ...(path[3] ? { topic: path[3] } : {}),
      matchedOn: "name",
    };
    return { query, found: true, revision: 7, position };
  }

  async tree(): Promise<{ revision: number; nodeCount: number; outline: string }> {
    return {
      revision: 7,
      nodeCount: Object.keys(STUB_PATHS).length,
      outline: "Natural Sciences\n  Physics\n    Quantum Optics\n    Condensed Matter",
    };
  }

  async suggest(entries: readonly { term: string; kind: string }[]): Promise<{
    id: string;
    receivedAt: string;
    revision: number;
    queued: number;
  }> {
    return {
      id: "stub-receipt",
      receivedAt: new Date(0).toISOString(),
      revision: 7,
      queued: entries.length,
    };
  }
}

type JudgeMode = "pass" | "build-step-2" | "repeat-build" | "cap-step-1";

const brainRepoRoot = fileURLToPath(
  new URL("../../../../../brain/", import.meta.url),
);
let storeMaterialized = false;
function registryStoreRoot(): string {
  if (!storeMaterialized) {
    execFileSync(
      process.execPath,
      [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
      { stdio: "inherit" },
    );
    storeMaterialized = true;
  }
  return join(brainRepoRoot, ".registry-store");
}

/** The version the registry index publishes as latest, like a real submission. */
function latestPublishedBundleDir(): string {
  const root = registryStoreRoot();
  const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8")) as {
    readonly bundles: readonly { readonly id: string; readonly latest: string }[];
  };
  const entry = index.bundles.find((bundle) => bundle.id === "brainstorm");
  if (!entry) throw new Error("the registry index does not publish a brainstorm bundle");
  return `${join(root, "bundles", "brainstorm", entry.latest)}/`;
}

const registryContentDir =
  process.env.BRAIN_TEST_CONTENT_DIR ?? latestPublishedBundleDir();

function object(value: JsonValue | undefined, label: string): JsonObject {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is not an object`);
  return value as JsonObject;
}

/**
 * The verdicts a round permits, however the bound options carry them: content
 * that renders the verdict catalog into its instructions binds the NAMES
 * alone, earlier content binds them zipped with their descriptions.
 */
function allowedVerdicts(options: JsonValue | undefined): readonly string[] {
  if (Array.isArray(options)) {
    return options.filter((name): name is string => typeof name === "string");
  }
  return Object.keys(object(options, "verdict options"));
}

/**
 * The rounds of the CURRENT walk position, however the bound ledger carries
 * them: content published before the scoped record binds the flat array, and
 * the scoped record's `rounds` field is that same list. The suite runs against
 * whichever content tree is configured, so it reads both.
 */
function ledgerRounds(history: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(history)) return history;
  const record = object(history, "scoped review record");
  return Array.isArray(record.rounds) ? record.rounds : [];
}

function paperBody(label: string): JsonObject {
  return {
    abstract: [1, 2, 3].map((i) => `${label} abstract paragraph ${i}`),
    introduction: [1, 2, 3].map(
      (i) => `${label} introduction paragraph ${i}`,
    ),
    method: [1, 2, 3].map((i) => `${label} method paragraph ${i}`),
    discussion: [1, 2, 3].map(
      (i) => `${label} discussion paragraph ${i}`,
    ),
    conclusion: [`${label} conclusion`],
  };
}

function developedOutput(label: string): JsonObject {
  return { type: "research idea", paper: paperBody(label) };
}

function finalProposal(): JsonObject {
  return {
    title: "Integrated proposal",
    framing: "A precise framing",
    consensus: ["Shared direction"],
    tensions: ["Useful disagreement"],
    novelDirections: ["Cross-field direction"],
    actionItems: [{ priority: 1, action: "Run the experiment", rationale: "It is decisive" }],
    applications: ["A practical application"],
  };
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

interface SeenTask {
  readonly role: string;
  readonly agentId: string;
  readonly bindings: JsonObject;
  readonly task: AgentTask;
}

class FakeBrainstormExecutor implements AgentExecutor {
  readonly seen: SeenTask[] = [];
  readonly judgeOrder: string[] = [];
  readonly judgeRounds = new Map<string, number>();
  readonly revisionCalls = new Map<string, number>();

  constructor(private readonly mode: JudgeMode = "pass") {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const input = object(task.input, "task input");
    const bindings = object(input.bindings, "task bindings");
    const role = input.role as string;
    const agentId = task.agentId ?? role;
    this.seen.push({ role, agentId, bindings, task });

    let output: JsonValue;
    switch (role) {
      case "processor":
        output = {
          type: "research idea",
          // Deterministic but not degenerate: processorOutput refuses
          // placeholder values, because a probe reaching this artifact silently
          // replaces the submission for every later stage.
          title: "Distributional message passing over graphs",
          question: "Can the mechanism be tested against a held-out graph?",
          context: "A deterministic fixture standing in for a real submission.",
          attachments: [],
          assumptions: [],
          cotSteps: 3,
          files: [
            {
              path: "attachments/1-repo/src/model.py",
              label: "code",
              note: "Prototype the question refers to.",
            },
            {
              path: "attachments/1-repo/package-lock.json",
              label: "NA",
              note: "",
            },
          ],
        };
        break;
      case "classifier":
        // The split classification stage (workflow 0.14.0+): the primary
        // reading mirrors the processor fixture's type so the merged input
        // stays the one every other fixture is built around.
        output = {
          primary: {
            type: "research idea",
            reason: "The fixture submission sketches a mechanism to be developed into a full contribution.",
          },
          alternative: {
            type: "unverified claim",
            reason: "A reader could take the held-out-graph question as a single checkable claim instead.",
          },
          cotSteps: 3,
          requestedOutputs: [],
          embeddingInput: {
            title: "Distributional message passing over graphs",
            abstract:
              "This work studies message passing over graphs in which node states are full distributions rather than point estimates. " +
              "It develops the propagation mechanism, examines its behavior on held-out graphs, and relates it to established graph representation learning. " +
              "A successful outcome is a mechanism whose predictions transfer across graph structures.",
            facets: [
              {
                name: "graph representation learning",
                statement:
                  "Graph representation learning studies how to encode nodes and graphs into vector spaces that preserve structural relationships for prediction tasks.",
                relevance: 0.9,
              },
              {
                name: "message passing neural networks",
                statement:
                  "Message passing neural networks compute node representations by iteratively aggregating information from neighboring nodes along the graph structure.",
                relevance: 0.8,
              },
              {
                name: "probabilistic modeling",
                statement:
                  "Probabilistic modeling represents quantities as distributions rather than point estimates, propagating uncertainty through the computation.",
                relevance: 0.6,
              },
            ],
          },
        };
        break;
      case "code-annotator": {
        // One deterministic summary per bound code file, in the given order —
        // the runtime cross-checks completeness and order on write.
        const files = Array.isArray(bindings.files) ? bindings.files : [];
        output = {
          files: files.map((file) => ({
            path: object(file, "code file").path,
            summary: `Deterministic summary for ${String(object(file, "code file").path)}: prototype module relevant to the mechanism.`,
          })),
        };
        break;
      }
      case "pool-builder": {
        // The pool the deterministic taxonomy.match resolves through the stub
        // taxonomy. Seating queue (cxr): Physics Σ4.2 > QO 3.6 > CS Σ2.6 >
        // ML 2.6 > Biology Σ2.35 > SysBio 2.1 — so panelSize 3 seats
        // Physics/QO, CS/ML, Biology/SysBio in that order and panelSize 2
        // seats the first two. "chip morphology" is the one unmatched member
        // the placer decides.
        const origin = (stated: string) => [
          { name: "Test Author", paper: "Deterministic Test Paper", stated },
        ];
        output = {
          members: [
            { term: "photon counting", count: 3, relevance: 0.9, variants: ["photon counting"], origins: origin("photon counting") },
            { term: "network inference", count: 3, relevance: 0.7, variants: ["network inference"], origins: origin("network inference") },
            { term: "machine learning", count: 2, relevance: 0.6, variants: ["machine learning", "ML"], origins: origin("machine learning") },
            { term: "representation learning", count: 2, relevance: 0.65, variants: ["representation learning"], origins: origin("representation learning") },
            { term: "quantum optics", count: 1, relevance: 0.85, variants: ["quantum optics"], origins: origin("quantum optics") },
            { term: "transport", count: 1, relevance: 0.3, variants: ["transport"], origins: origin("transport") },
            { term: "single-molecule methods", count: 1, relevance: 0.25, variants: ["single-molecule methods"], origins: origin("single-molecule methods") },
            { term: "chip morphology", count: 1, relevance: 0.2, variants: ["chip morphology"], origins: origin("chip morphology") },
          ],
          // Literature grounding rides on the pool artifact; matching and
          // panel selection must ignore it.
          grounding: {
            papers: [
              {
                title: "Deterministic Test Paper",
                authors: ["Test Author"],
                year: 2024,
                relation: "Grounds the machine-learning pool members.",
              },
            ],
            scholars: [
              {
                name: "Test Author",
                affiliation: "Test University",
                url: "https://example.org/test-author",
                profile: "ok",
                interests: ["representation learning"],
              },
            ],
          },
        };
        break;
      }
      case "placer":
        output = {
          revision: 7,
          decisions: [
            {
              term: "chip morphology",
              outcome: "place",
              name: "Chip Morphology",
              parent: "Condensed Matter",
              aliases: ["chip morphologies"],
              reason: "Fixture: a fabrication-morphology area housed with condensed matter research.",
            },
          ],
        };
        break;
      case "brain":
        output = {
          output: developedOutput(agentId),
          cot: [1, 2, 3].map((step) => `COT:${agentId}:${step}`),
          novelty: `Novelty for ${agentId}`,
        };
        break;
      case "commentor":
      case "interdisciplinary-commentor":
        output = {
          verdict: "Pass",
          step: bindings.currentStep,
          reason: `Comment from ${agentId}: the step is sound as developed.`,
          suggestion: "",
          evidence: noEvidence,
        };
        break;
      case "judge":
        output = this.judge(agentId, bindings);
        break;
      case "redeveloper":
        output = this.redevelop(agentId, bindings, task.outputSchema?.name);
        break;
      case "integrator": {
        const ideas = object(bindings.ideas, "integrator ideas");
        output = {
          noveltyAudit: Object.entries(ideas).flatMap(([memberId, idea]) => {
            const record = object(idea, `idea for ${memberId}`);
            if (typeof record.novelty !== "string") return [];
            return [
              {
                memberId,
                claim: record.novelty,
                status: "clear",
                note: `Audited ${memberId}: no prior work already does this claim.`,
                evidence: noEvidence,
              },
            ];
          }),
          contradictions: [],
          seams: [
            {
              between: ["Quantum Optics", "Systems Biology"],
              gap: "No member connected the two seated framings.",
              opportunity: "A joint treatment of both framings remains open.",
            },
          ],
        };
        break;
      }
      case "chair":
        output = finalProposal();
        break;
      default:
        throw new Error(`unexpected role ${role}`);
    }
    return { taskId: task.taskId, status: "ok", output };
  }

  private judge(memberId: string, bindings: JsonObject): JsonValue {
    const step = bindings.currentStep as number;
    const key = `${memberId}:${step}`;
    const round = (this.judgeRounds.get(key) ?? 0) + 1;
    this.judgeRounds.set(key, round);
    this.judgeOrder.push(`${memberId}:${step}:${round}`);
    const comments = object(bindings.comments, "comments");
    const assessment = Object.keys(comments).map((commentorId) => ({
      commentorId,
      basis: "verified",
    }));

    if (
      (this.mode === "repeat-build" ||
        (this.mode === "build-step-2" && round === 1)) &&
      memberId === "member-1" &&
      step === 2
    ) {
      return {
        verdict: "Build",
        reason: "A necessary justification is missing from this step",
        suggestion: "Add the missing control",
        evidence: noEvidence,
        issues: [
          {
            step,
            point: "The step relies on an uncontrolled comparison it never justifies.",
            basis: "authority",
            evidence: noEvidence,
            suggestion: "Add the missing control",
            mustAddress: true,
          },
        ],
        assessment,
      };
    }
    if (this.mode === "cap-step-1" && memberId === "member-1" && step === 1) {
      const mathEvidence = {
        kind: "math",
        code: "",
        result: "",
        derivation: "Assume A; derive not-A.",
        citation: "",
        locator: "",
        shows: "",
      };
      return {
        verdict: "Interrupt",
        reason: "The premise needs repair before the chain can continue",
        suggestion: "",
        evidence: mathEvidence,
        issues: [
          {
            step,
            point: "The opening premise contradicts itself under expansion.",
            basis: "verified",
            evidence: mathEvidence,
            suggestion: "",
            mustAddress: true,
          },
        ],
        assessment,
      };
    }
    return {
      verdict: "Pass",
      reason: "The step is sound and no comment demonstrates a flaw in it",
      suggestion: "",
      evidence: noEvidence,
      issues: [],
      assessment,
    };
  }

  private redevelop(
    memberId: string,
    bindings: JsonObject,
    schema: string | undefined,
  ): JsonValue {
    const step = bindings.currentStep as number;
    const key = `${memberId}:${step}`;
    this.revisionCalls.set(key, (this.revisionCalls.get(key) ?? 0) + 1);
    if (schema === "redevelopmentPatch") {
      // Patch delivery: only the rewritten step and only the section the
      // repair moved. Everything else is the host's to carry.
      return {
        steps: [{ index: step, text: `REVISED:${memberId}:${step}` }],
        outputPatch: {
          paper: { method: [1, 2, 3].map((i) => `${memberId} revised method paragraph ${i}`) },
        },
        novelty: `Revised novelty for ${memberId}`,
      };
    }
    // Full-chain re-emission with minimal edits: rewrite the issue's step,
    // copy every other step verbatim from the bound complete chain.
    const chain = Array.isArray(bindings.chain) ? bindings.chain : [];
    return {
      output: developedOutput(`${memberId} revised at ${step}`),
      steps: chain.map((text, index) =>
        index + 1 === step ? `REVISED:${memberId}:${index + 1}` : text,
      ),
      novelty: `Revised novelty for ${memberId}`,
    };
  }

  tasks(role: string): readonly SeenTask[] {
    return this.seen.filter((entry) => entry.role === role);
  }
}

let publishedBundle: ContentBundle | undefined;

function payloadVars(role: string): readonly string[] {
  publishedBundle ??= loadContent(registryContentDir);
  return publishedBundle.skills[role]?.meta.payload ?? [];
}

/** A role's effective capabilities: its own plus its techniques', in declared order. */
function roleCapabilities(role: string): readonly string[] {
  publishedBundle ??= loadContent(registryContentDir);
  const skill = publishedBundle.skills[role];
  if (!skill) return [];
  const capabilities = [...skill.meta.capabilities];
  for (const technique of skill.meta.techniques) {
    for (const capability of publishedBundle.skills[technique]?.meta.capabilities ?? []) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
  }
  return capabilities;
}

/**
 * The taxonomy read tools of a correctly configured deployment, as the
 * capability broker sees them. Without these the placer's REQUIRED
 * taxonomy-access capability resolves unavailable and the run fails loud
 * (REQUIRED_CAPABILITY_UNAVAILABLE) — exactly the toolless-placer guard.
 */
const TEST_HOST_TOOLS: readonly HostToolManifest[] = [
  {
    toolId: "taxonomy_tree",
    displayName: "Taxonomy Tree",
    operations: ["taxonomy.tree"],
    risk: "low",
    defaultEnabled: true,
    definition: {
      name: "taxonomy_tree",
      description: "Fetch the shared taxonomy outline.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    toolId: "taxonomy_resolve",
    displayName: "Taxonomy Resolve",
    operations: ["taxonomy.resolve"],
    risk: "low",
    defaultEnabled: true,
    definition: {
      name: "taxonomy_resolve",
      description: "Resolve one name against the shared taxonomy.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

function runtime(
  executor: AgentExecutor,
  humanGateMode: "manual" | "autoApproveSkippable" = "autoApproveSkippable",
  stores?: Pick<BrainstormRuntime, "checkpoints" | "artifacts">,
  journalFormat?: 1 | 2,
  workflow?: ContentWorkflowDefinition,
) {
  return new BrainstormRuntime({
    bundle: loadContent(registryContentDir),
    agentExecutor: executor,
    humanGateMode,
    ...(workflow !== undefined ? { workflow } : {}),
    activities: taxonomyActivities(new StubTaxonomy()),
    routeResolver: new StaticBrainstormRouteResolver({
      reasoning: { modelId: "configured-reasoner", providerId: "fake" },
      writing: { modelId: "configured-writer", providerId: "fake" },
      balanced: { modelId: "configured-balanced", providerId: "fake" },
    }),
    hostTools: TEST_HOST_TOOLS,
    enabledHostToolIds: new Set(TEST_HOST_TOOLS.map((manifest) => manifest.toolId)),
    ...(stores ?? {}),
    ...(journalFormat !== undefined ? { journalFormat } : {}),
  });
}

test("Pass path walks every seat in step order (seats in parallel) and keeps C-O-T from chair", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor);
  const result = await app.run({
    runId: "pass-path",
    submission: { prompt: "Investigate the mechanism", attachments: [] },
    params: { panelSize: 3 },
  });

  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );
  assert.deepEqual(result.status === "completed" && result.output, finalProposal());
  assert.deepEqual(
    executor.tasks("brain").map((task) => [
      task.agentId,
      task.bindings.department,
      task.bindings.umbrella,
    ]),
    [
      // One cxr-sorted queue with look-ahead: departments and umbrellas
      // defer to children sitting within the remaining capacity, so Physics
      // surfaces through the photon-counting topic, Machine Learning seats
      // as an umbrella (its topic is outside the window), and Biology
      // surfaces through network inference — in queue order. The weave then
      // appends the interdisciplinary seat, a full member that develops too.
      ["member-1", "Physics", "Quantum Optics"],
      ["member-2", "Computer Science", "Machine Learning"],
      ["member-3", "Biology", "Systems Biology"],
      [
        "member-4",
        "Interdisciplinary Research",
        "the interdisciplinary space between Quantum Optics, Machine Learning and Systems Biology",
      ],
    ],
  );
  // Seats review in PARALLEL, so the cross-seat interleaving of judgements
  // is scheduling noise. What must hold: every seat's walk is judged at
  // every step exactly once, and WITHIN a seat the walk stays in chain
  // order (one round per step on the pass path).
  const judgedPerMember = new Map<string, string[]>();
  for (const entry of executor.judgeOrder) {
    const memberId = entry.split(":")[0]!;
    const walk = judgedPerMember.get(memberId) ?? [];
    walk.push(entry);
    judgedPerMember.set(memberId, walk);
  }
  assert.deepEqual(
    [...judgedPerMember.keys()].sort(),
    ["member-1", "member-2", "member-3", "member-4"],
    "every seat's walk is judged, the woven seat included",
  );
  for (const [memberId, walk] of judgedPerMember) {
    assert.deepEqual(
      walk,
      [1, 2, 3].map((step) => `${memberId}:${step}:1`),
      `${memberId}'s walk stays in step order with one round per step`,
    );
  }
  // The interdisciplinary seat comments through its own roster-aware skill;
  // disciplinary seats never receive the roster.
  const bridgeComments = executor.tasks("interdisciplinary-commentor");
  assert.ok(bridgeComments.length > 0, "the interdisciplinary seat commented");
  for (const task of bridgeComments) {
    assert.equal(task.agentId, "member-4");
    assert.ok(Array.isArray(task.bindings.roster), "the seat receives the roster");
  }
  for (const task of executor.tasks("commentor")) {
    assert.notEqual(task.agentId, "member-4", "the seat never uses the disciplinary skill");
    assert.equal(task.bindings.roster, undefined);
  }

  const chair = executor.tasks("chair")[0]!;
  const chairIdeas = object(chair.bindings.ideas, "chair ideas");
  assert.ok(!JSON.stringify(chairIdeas).includes("COT:"));
  for (const idea of Object.values(chairIdeas)) {
    assert.deepEqual(Object.keys(object(idea, "projected idea")).sort(), ["novelty", "output"]);
  }

  // The integration audit runs after review on finished outputs only, and its
  // report reaches the chair.
  const integrator = executor.tasks("integrator")[0]!;
  const auditedIdeas = object(integrator.bindings.ideas, "integrator ideas");
  assert.ok(!JSON.stringify(auditedIdeas).includes("COT:"), "the integrator never sees chains");
  for (const idea of Object.values(auditedIdeas)) {
    const keys = Object.keys(object(idea, "audited idea"));
    assert.ok(
      keys.every((key) => ["output", "novelty", "literature"].includes(key)),
      "the integrator sees only projected idea fields",
    );
  }
  const bridge = object(chair.bindings.bridge, "chair bridge report");
  assert.ok(
    Array.isArray(bridge.noveltyAudit) && bridge.noveltyAudit.length === 4,
    "the chair receives one audit entry per member, the woven seat included",
  );

  for (const task of executor.seen) {
    const expectedRoute =
      task.role === "chair"
        ? "writing"
        : task.role === "code-annotator"
          ? "balanced"
          : "reasoning";
    assert.equal(task.task.logicalRoute, expectedRoute);
    assert.equal(task.task.outputSchema?.name, (object(task.task.input, "input").outputSchema as JsonObject).name);
    assert.ok(task.task.modelRequest?.responseFormat?.type === "jsonSchema");
  }

  // The delivered response schemas narrow what the static artifact schemas
  // leave open: the processor may only pick a catalog type, and members'
  // output.type is pinned to this run's label with the shape body required —
  // a schema-constrained model cannot mislabel the envelope.
  const deliveredSchema = (role: string): JsonObject => {
    const request = executor.tasks(role)[0]!.task.modelRequest;
    const format = request?.responseFormat;
    if (format?.type !== "jsonSchema") throw new Error(`${role} has no jsonSchema format`);
    return format.schema;
  };
  const processorProperties = object(
    deliveredSchema("processor").properties,
    "processor properties",
  );
  if (executor.tasks("classifier").length > 0) {
    // Split-classification bundles (0.14.0+): the processor cannot emit the
    // classification fields at all — they are stripped from its task schema
    // — and the CLASSIFIER's two offered readings are enum-pinned instead.
    assert.equal(processorProperties.type, undefined, "processor schema drops `type`");
    assert.equal(processorProperties.cotSteps, undefined, "processor schema drops `cotSteps`");
    const classifierProperties = object(
      deliveredSchema("classifier").properties,
      "classifier properties",
    );
    for (const option of ["primary", "alternative"] as const) {
      const optionType = object(
        object(object(classifierProperties[option], option).properties, `${option} properties`).type,
        `${option} type property`,
      );
      assert.ok(Array.isArray(optionType.enum), `classifier ${option}.type is enum-narrowed`);
      assert.ok((optionType.enum as JsonValue[]).includes("research idea"));
    }
  } else {
    const processorType = object(processorProperties.type, "processor type property");
    assert.ok(Array.isArray(processorType.enum), "processor type is enum-narrowed");
    assert.ok((processorType.enum as JsonValue[]).includes("research idea"));
  }
  const memberEnvelope = object(
    object(deliveredSchema("brain").properties, "brain properties").output,
    "brain output property",
  );
  const memberType = object(object(memberEnvelope.properties, "envelope properties").type, "envelope type");
  assert.deepEqual(memberType.enum, ["research idea"], "member output.type pinned to the run's label");
  assert.ok(
    Array.isArray(memberEnvelope.required) && (memberEnvelope.required as JsonValue[]).includes("paper"),
    "the run's shape body is required in the delivered schema",
  );
  assert.ok((await app.artifacts.list()).length > 0);
  // Capabilities are declared by the content, so the expectation reads the
  // loaded bundle: each task carries exactly its role's declared set.
  assert.deepEqual(
    executor.tasks("processor")[0]!.task.allowedCapabilities,
    roleCapabilities("processor"),
  );
  assert.deepEqual(chair.task.allowedCapabilities, roleCapabilities("chair"));
  // task.tools follows the broker PLAN, not the declaration: this fixture
  // wires only the taxonomy host tools, so processor/chair capabilities all
  // resolve unavailable — the model gets the whenUnavailable prose and no
  // tools, never a tool the prompt just said it does not have.
  assert.deepEqual(executor.tasks("processor")[0]!.task.tools, []);
  assert.deepEqual(chair.task.tools, []);

  // The orchestrator partitions the processor's file map deterministically:
  // every later model call receives the useful files only, and the raw map is
  // withheld from the bound input.
  const usefulEntry = {
    path: "attachments/1-repo/src/model.py",
    label: "code",
    note: "Prototype the question refers to.",
  };
  // With the code-annotation pass (workflow 0.11.0+), the runtime folds the
  // annotator's one-line summary into the shared map, so every task after the
  // merge reads the annotated entry; the annotator itself sees the pre-merge
  // code projection.
  const annotationRan = executor.tasks("code-annotator").length > 0;
  const mergedEntry = annotationRan
    ? {
        ...usefulEntry,
        codeSummary: `Deterministic summary for ${usefulEntry.path}: prototype module relevant to the mechanism.`,
      }
    : usefulEntry;
  for (const task of executor.seen) {
    if (task.role === "processor") continue;
    if (task.role === "placer") {
      // The placer reads the shared taxonomy, not the attachments: it gets the
      // projected input plus the unmatched pool members only.
      assert.equal(task.bindings.files, undefined, "placer receives no file map");
      const unmatched = task.bindings.unmatched as readonly { term?: unknown }[];
      assert.deepEqual(
        unmatched.map((member) => member.term),
        ["chip morphology"],
        "placer receives exactly the unmatched pool members",
      );
    } else if (task.role === "classifier") {
      // The classifier runs BEFORE partitioning by design: the raw relation
      // map — NA labels included — is evidence of what the submitter brought.
      assert.deepEqual(
        task.bindings.files,
        [
          usefulEntry,
          { path: "attachments/1-repo/package-lock.json", label: "NA", note: "" },
        ],
        "the classifier receives the processor's full relation map",
      );
    } else if (task.role === "code-annotator") {
      assert.deepEqual(
        task.bindings.files,
        [usefulEntry],
        "the annotator receives the code projection before any summary exists",
      );
    } else {
      assert.deepEqual(
        task.bindings.files,
        [mergedEntry],
        `${task.role} must receive exactly the useful files`,
      );
    }
    const boundInput = object(task.bindings.input, `${task.role} input`);
    assert.equal(
      boundInput.files,
      undefined,
      `${task.role} must not see the unpartitioned file map`,
    );
  }
  if (annotationRan) {
    // The annotator's task schema is narrowed to the exact code files: entry
    // count pinned, path enum-limited — a constrained model cannot skip or
    // invent a file.
    const annotatorSchema = (() => {
      const format = executor.tasks("code-annotator")[0]!.task.modelRequest?.responseFormat;
      if (format?.type !== "jsonSchema") throw new Error("annotator has no jsonSchema format");
      return format.schema;
    })();
    const filesProperty = object(
      object(annotatorSchema.properties, "annotator properties").files,
      "annotator files property",
    );
    assert.equal(filesProperty.minItems, 1);
    assert.equal(filesProperty.maxItems, 1);
    const pathProperty = object(
      object(object(filesProperty.items, "files items").properties, "item properties").path,
      "item path property",
    );
    assert.deepEqual(pathProperty.enum, [usefulEntry.path]);
  }
  const artifacts = await app.artifacts.list();
  const schemas = artifacts.map((ref) => ref.metadata?.schema);
  assert.ok(schemas.includes("usefulFiles"), "useful-files artifact persisted");
  assert.ok(schemas.includes("ignoredFiles"), "ignored-files artifact persisted");

  // The bridged experts tree is sorted by the pool builder's input-topic
  // relevance at EVERY level (ties by count), and every node carries the
  // score: departments Physics 0.9 > Biology 0.7 > Computer Science 0.65,
  // Physics umbrellas Quantum Optics 0.9 > Condensed Matter 0.3, and inside
  // Condensed Matter the leaves transport 0.3 > placed Chip Morphology 0.2.
  const expertsRef = artifacts.find((ref) => ref.metadata?.schema === "experts");
  assert.ok(expertsRef, "experts artifact persisted");
  const experts = JSON.parse((await app.artifacts.get(expertsRef.id))!.data) as {
    departments: Array<{
      name: string;
      relevance?: number;
      umbrellas: Array<{ name: string; relevance?: number; subfields: Array<{ name: string }> }>;
    }>;
  };
  assert.deepEqual(
    experts.departments.map((department) => [department.name, department.relevance]),
    [["Physics", 0.9], ["Biology", 0.7], ["Computer Science", 0.65]],
  );
  const physics = experts.departments[0]!;
  assert.deepEqual(
    physics.umbrellas.map((umbrella) => umbrella.name),
    ["Quantum Optics", "Condensed Matter"],
  );
  assert.deepEqual(
    physics.umbrellas[1]!.subfields.map((leaf) => leaf.name),
    ["transport", "Chip Morphology"],
  );
});

test("instructions stay in a cacheable system prefix; submitted data rides the task turn", async () => {
  const executor = new FakeBrainstormExecutor();
  const topic = "Investigate the mechanism";
  const result = await runtime(executor).run({
    runId: "prompt-split",
    submission: { prompt: topic, attachments: [] },
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "completed");

  for (const seen of executor.seen) {
    const request = seen.task.modelRequest!;
    const segments = systemPromptSegments(request.system);
    assert.ok(segments.length > 0, `${seen.role} has system instructions`);
    assert.equal(
      segments[0]?.cacheable,
      true,
      `${seen.role} must open with a cacheable instruction segment`,
    );

    // Payload values are addressed by name in the instructions and carried in
    // the task turn, so nothing submission-derived sits at instruction privilege.
    const system = systemPromptText(request.system) ?? "";
    const turn = request.messages.map((message) => textContent(message.content)).join("\n");
    for (const name of payloadVars(seen.role)) {
      const value = seen.bindings[name];
      // Mirrors renderTaskMessage: string payloads (e.g. the placer's
      // taxonomy outline) ride raw; structures ride as JSON.
      const rendered =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      assert.ok(turn.includes(`## ${name}`), `${seen.role} task turn carries ${name}`);
      assert.ok(turn.includes(rendered), `${seen.role} task turn carries the ${name} value`);
      // A bare scalar such as a step index collides with ordinary prose, so
      // only structured payloads can be checked for absence this way.
      if (typeof value === "object" && value !== null) {
        assert.ok(
          !system.includes(rendered),
          `${seen.role} must not render ${name} into its instructions`,
        );
      }
    }
  }

  const processor = executor.tasks("processor")[0]!;
  assert.ok(!(systemPromptText(processor.task.modelRequest!.system) ?? "").includes(topic));

  // Technique bodies render with the role's bindings: the literature-review
  // vantage carries the seat's expertise into the instructions.
  const brainTask = executor.seen.find((seen) => seen.role === "brain")!;
  const brainSystem = systemPromptText(brainTask.task.modelRequest!.system) ?? "";
  assert.ok(
    brainSystem.includes(String(brainTask.bindings.umbrella)),
    "the literature-review technique renders the seat's umbrella into the instructions",
  );
});

/**
 * The published workflow with its four review binds moved from the flat
 * ledger to the scoped record — exactly the edit the next bundle version
 * makes, so the runtime side can be proven before any tag exists.
 */
function scopedLedgerWorkflow(): ContentWorkflowDefinition {
  publishedBundle ??= loadContent(registryContentDir);
  // Content published before the scoped record binds the flat ledger, so the
  // rebind happens here; a tree that already binds the record passes through.
  const rebound = JSON.stringify(publishedBundle.workflows.brainstorm!).replaceAll(
    '"reviews[member.id].history"',
    '"reviews[member.id].record"',
  );
  assert.ok(
    rebound.includes('"reviews[member.id].record"'),
    "the review binds must resolve to the scoped record",
  );
  return JSON.parse(rebound) as ContentWorkflowDefinition;
}

test("a bundle binding the scoped record gets closed business collapsed and open business whole", async () => {
  const executor = new FakeBrainstormExecutor("build-step-2");
  const result = await runtime(
    executor,
    "autoApproveSkippable",
    undefined,
    undefined,
    scopedLedgerWorkflow(),
  ).run({ submission: "Scoped ledger", params: { panelSize: 2 } });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );

  // member-1's walk: step 1 passed on sight, step 2 took a Build and a
  // revision before passing. At step 3 both are closed business.
  const atStepThree = executor
    .tasks("commentor")
    .find(
      (task) =>
        task.bindings.currentStep === 3 &&
        (task.bindings.chain as readonly string[]).includes("REVISED:member-1:2"),
    );
  assert.ok(atStepThree, "the walk reached step 3 of the revised chain");
  const record = object(atStepThree!.bindings.history, "scoped record");

  assert.deepEqual(record.clean, [1], "a position that passed on sight is one number");
  const settled = record.settled as JsonObject[];
  assert.deepEqual(settled.map((entry) => entry.step), [2]);
  assert.equal(settled[0]!.outcome, "passed");
  assert.deepEqual(settled[0]!.revised, [2], "the change-set survives the collapse");
  const collapsed = (settled[0]!.objections as JsonObject[])[0]!;
  assert.ok(
    String(collapsed.point).includes("uncontrolled comparison"),
    "the objection stays nameable, so nobody re-raises it",
  );
  assert.equal(collapsed.step, 2, "and it names the step it targets");
  assert.deepEqual(record.standing, [], "nothing was left unanswered on this path");
  assert.deepEqual(record.rounds, [], "step 3 has not been reviewed yet");
  assert.ok(
    !JSON.stringify(record).includes("commentorId"),
    "the projection carries no reviewer identity, like the ledger it replaces",
  );
});

test("objections left standing by a force-passed position ride on, whole", async () => {
  const executor = new FakeBrainstormExecutor("cap-step-1");
  const result = await runtime(
    executor,
    "autoApproveSkippable",
    undefined,
    undefined,
    scopedLedgerWorkflow(),
  ).run({ submission: "Capped ledger", params: { panelSize: 2 } });
  assert.equal(result.status, "completed");

  // member-1's step 1 exhausts the round budget while the judge still faults
  // it, so its last round's issues are unresolved by construction.
  const atStepTwo = executor
    .tasks("commentor")
    .find(
      (task) =>
        task.bindings.currentStep === 2 &&
        (task.bindings.chain as readonly string[])[0]?.startsWith("REVISED:member-1:1"),
    );
  assert.ok(atStepTwo, "the walk moved past the capped position");
  const record = object(atStepTwo!.bindings.history, "scoped record");

  const settled = record.settled as JsonObject[];
  assert.equal(settled[0]!.step, 1);
  assert.equal(settled[0]!.outcome, "force-passed", "a capped position never reads as passed");
  const standing = record.standing as JsonObject[];
  assert.equal(standing.length, 1, "the unanswered objection is carried forward");
  assert.equal(standing[0]!.step, 1);
  assert.equal(standing[0]!.mustAddress, true, "with the flags a reviewer needs to weigh it");
  assert.equal(standing[0]!.evidenceKind, "math", "and with its evidence kind intact");
});

test("verdict definitions ride the instructions, and only the round's names ride the turn", async () => {
  const executor = new FakeBrainstormExecutor();
  const result = await runtime(executor).run({
    submission: "Verdict placement",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "completed");
  publishedBundle ??= loadContent(registryContentDir);
  // Both placements render the catalog as JSON, and the definitions quote the
  // verdict names, so the text to look for is the escaped form.
  const passDefinition = JSON.stringify(
    publishedBundle.catalogs.verdicts.verdicts.Pass!.description,
  ).slice(1, -1);

  const reviewers = executor.seen.filter(
    (seen) => seen.role === "judge" || seen.role === "commentor",
  );
  assert.ok(reviewers.length > 0, "the run produced review tasks");
  for (const seen of reviewers) {
    const system = systemPromptText(seen.task.modelRequest!.system) ?? "";
    const turn = textContent(seen.task.modelRequest!.messages[0]!.content);
    if (seen.bindings.verdictCatalog === undefined) {
      // Content published before the move: the definitions ride the payload,
      // exactly as its skills describe them. A pinned run must not change.
      assert.ok(turn.includes(passDefinition), `${seen.role} carries the definitions in its turn`);
      continue;
    }
    // The definitions are bundle prose that never varies within a run, so
    // they belong in the instruction prefix that is written once and read
    // back by every later call — not re-sent as task data every round.
    assert.ok(
      system.includes(passDefinition),
      `${seen.role} carries the verdict definitions in its instructions`,
    );
    assert.ok(
      !turn.includes(passDefinition),
      `${seen.role} must not re-send the verdict definitions as task data`,
    );
    assert.ok(
      Array.isArray(seen.bindings.verdictOptions),
      `${seen.role} receives this round's verdicts as names`,
    );
    // The narrowed answer schema still comes from the round's permitted set.
    const verdictSchema = object(
      object(seen.task.outputSchema!.schema.properties, "task properties").verdict,
      "verdict property",
    );
    assert.deepEqual(
      verdictSchema.enum,
      seen.bindings.verdictOptions,
      `${seen.role}'s delivered schema pins exactly the round's verdicts`,
    );
  }
});

test("the cache plan proves stability from the workflow's structure, never from variable names", () => {
  publishedBundle ??= loadContent(registryContentDir);
  const plan = planTaskCaches(publishedBundle.workflows.brainstorm!);

  // A review task's run-level material is identical in every call of the run;
  // everything the walk moves — the chain, the round, the seat's ledger — is
  // not, and a bind that reads a loop variable can never be marked stable.
  for (const nodeId of ["comment-step", "comment-step-bridge", "judge-step", "redevelop-idea"]) {
    const stable = plan.get(nodeId);
    assert.ok(stable, `${nodeId} is planned`);
    for (const name of ["input", "files"]) {
      assert.ok(stable.has(name), `${nodeId} may cache its ${name} payload`);
    }
    for (const name of [
      "chain",
      "currentStep",
      "history",
      "verdictOptions",
      "comments",
      "feedback",
      "department",
      "umbrella",
      "subfields",
    ]) {
      assert.ok(!stable.has(name), `${nodeId} must never cache ${name}: it varies per call`);
    }
  }

  // The first pass is bound entirely to run-level material, so its whole turn
  // is stable; the deterministic activities have no task turn at all.
  const firstPass = plan.get("develop-idea")!;
  assert.ok(firstPass.has("input") && firstPass.has("files"));
  assert.ok(!firstPass.has("department"), "the seat identity varies per member");
  assert.equal(plan.get("match-taxonomy"), undefined, "activities are not agent tasks");
});

test("a bind the plan cannot parse is volatile, never stable", () => {
  // The rule is only safe in one direction: what cannot be PROVEN stable has
  // to fall to volatile, costing a cache read. A reference the parser rejects
  // used to land the other way — its stand-in root was simply absent from the
  // volatile set, which reads as stable — so an unparsable bind was declared
  // cacheable, the one outcome the module promises cannot happen.
  const plan = planTaskCaches({
    apiVersion: "brainstorm.workflow/v1",
    name: "probe",
    version: "0.0.0",
    description: "probe",
    params: {},
    root: {
      kind: "agent",
      id: "probe-task",
      skill: "brain",
      route: "reasoning",
      bind: { sound: "input", broken: "ideas[" },
      output: { key: "out", schema: "brainIdea" },
    },
  } as unknown as Parameters<typeof planTaskCaches>[0]);

  const stable = plan.get("probe-task")!;
  assert.ok(stable.has("sound"), "a parseable run-level bind still caches");
  assert.ok(!stable.has("broken"), "an unparsable bind is treated as volatile");
});

test("the task turn declares its stable prefixes without changing a byte the model reads", async () => {
  const executor = new FakeBrainstormExecutor();
  const result = await runtime(executor).run({
    runId: "task-cache",
    submission: { prompt: "Investigate the mechanism", attachments: [] },
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );

  const blocksOf = (seen: SeenTask) => seen.task.modelRequest!.messages[0]!.content;

  // 1. Splitting the turn into blocks is a billing change only: the blocks
  //    concatenate to exactly the single string they replaced.
  for (const seen of executor.seen) {
    const sections = payloadVars(seen.role).map((name) => {
      const value = seen.bindings[name];
      const rendered =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `## ${name}\n\n${rendered}`;
    });
    const legacy = [
      "# Task",
      `Execute the ${seen.role} role instructions from the system prompt against the data below. ` +
        `Return only one JSON value satisfying the "${seen.task.outputSchema!.name}" schema.`,
      ...(sections.length > 0 ? ["# Task data", ...sections] : []),
    ].join("\n\n");
    assert.equal(
      textContent(blocksOf(seen)),
      legacy,
      `${seen.role} reads exactly the text it read before the split`,
    );
  }

  // 2. A commentor turn declares two prefixes: the run-level payload, and the
  //    chain as delivered so far — the second closing on the last STEP, never
  //    on the closing bracket, which is the byte that moves as the walk grows.
  for (const seen of executor.seen.filter((entry) => entry.role === "commentor")) {
    const blocks = blocksOf(seen);
    const boundaries = contentCacheBoundaries(blocks);
    assert.equal(boundaries.length, 2, "a commentor turn declares two stable prefixes");
    const through = (index: number) => textContent(blocks.slice(0, index + 1));
    assert.ok(
      through(boundaries[0]!).endsWith(JSON.stringify(seen.bindings.files, null, 2)),
      "the first prefix closes after the run-level file map",
    );
    const chain = seen.bindings.chain as readonly string[];
    assert.ok(
      through(boundaries[1]!).endsWith(JSON.stringify(chain[chain.length - 1])),
      "the second prefix closes after the last delivered chain step",
    );
  }

  // 3. What the second prefix buys: one walk position's marked span is a byte
  //    prefix of the next position's whole turn, so the cache is readable
  //    instead of merely written.
  const walks = new Map<string, SeenTask[]>();
  for (const seen of executor.seen) {
    if (seen.role !== "commentor") continue;
    const chain = seen.bindings.chain as readonly string[];
    const key = `${seen.agentId}|${chain[0]}`;
    walks.set(key, [...(walks.get(key) ?? []), seen]);
  }
  let compared = 0;
  for (const tasks of walks.values()) {
    const ordered = [...tasks].sort(
      (a, b) =>
        (a.bindings.chain as readonly string[]).length -
        (b.bindings.chain as readonly string[]).length,
    );
    for (let i = 1; i < ordered.length; i += 1) {
      const shorter = ordered[i - 1]!;
      const longer = ordered[i]!;
      const before = shorter.bindings.chain as readonly string[];
      const after = longer.bindings.chain as readonly string[];
      if (before.length >= after.length) continue;
      if (!before.every((step, index) => step === after[index])) continue;
      const boundaries = contentCacheBoundaries(blocksOf(shorter));
      const cached = textContent(
        blocksOf(shorter).slice(0, boundaries[boundaries.length - 1]! + 1),
      );
      assert.ok(
        textContent(blocksOf(longer)).startsWith(cached),
        "the next step's turn re-reads the previous one's marked prefix byte for byte",
      );
      compared += 1;
    }
  }
  assert.ok(compared > 0, "the walk produced consecutive positions to compare");
});

test("Build redevelops minimally: change-set computed, ledger carried, no immediate repeat", async () => {
  const executor = new FakeBrainstormExecutor("build-step-2");
  const app = runtime(executor);
  const result = await app.run({
    submission: "Build-path test",
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );
  assert.equal(executor.revisionCalls.get("member-1:2"), 1);

  // The reviser receives the COMPLETE chain plus the judge's issues.
  const redevelopment = executor.tasks("redeveloper")[0]!;
  assert.deepEqual(redevelopment.bindings.chain, [
    "COT:member-1:1",
    "COT:member-1:2",
    "COT:member-1:3",
  ]);
  const feedback = object(redevelopment.bindings.feedback, "redeveloper feedback");
  const issues = feedback.issues as readonly JsonValue[];
  assert.ok(Array.isArray(issues) && issues.length === 1, "the issues[] repair signal rides the feedback");
  assert.equal(object(issues[0], "issue").step, 2);

  const secondRoundJudge = executor
    .tasks("judge")
    .find((task) => task.agentId === "member-1" && task.bindings.currentStep === 2 &&
      executor.tasks("judge").filter((candidate) =>
        candidate.agentId === "member-1" && candidate.bindings.currentStep === 2,
      ).indexOf(task) === 1)!;
  // The round's permitted verdicts, however the bundle carries them: names
  // alone (the descriptions live in the cached instructions) or names zipped
  // with their descriptions.
  const options = allowedVerdicts(secondRoundJudge.bindings.verdictOptions);
  assert.ok(!options.includes("Build"), "Build must be removed after a Build verdict");
  assert.ok(options.includes("Pass"));
  assert.ok(options.includes("Interrupt"));
  // The judge is grounded in the chain it rules on, revised text included.
  assert.deepEqual(secondRoundJudge.bindings.chain, [
    "COT:member-1:1",
    "REVISED:member-1:2",
  ]);

  const roundTwoComment = executor.tasks("commentor").find((task) => {
    if (task.bindings.currentStep !== 2) return false;
    const chain = task.bindings.chain;
    return Array.isArray(chain) && chain.some((step) => String(step).startsWith("REVISED:member-1:2"));
  });
  assert.ok(roundTwoComment, "the re-review must receive the revised chain");
  assert.deepEqual(roundTwoComment!.bindings.chain, [
    "COT:member-1:1",
    "REVISED:member-1:2",
  ]);
  // The anonymized ledger reaches the next round: the Build record carries
  // its issues (content only) and the runtime-computed change-set.
  const history = roundTwoComment!.bindings.history;
  const buildRecord = ledgerRounds(history)
    .map((entry) => object(entry, "ledger record"))
    .find((entry) => entry.verdict === "Build");
  assert.ok(buildRecord, "the ledger carries the Build round");
  assert.deepEqual(buildRecord!.touched, [2], "the change-set names exactly the rewritten step");
  assert.deepEqual(buildRecord!.untouched, [1, 3]);
  const ledgerIssues = buildRecord!.issues as readonly JsonValue[];
  assert.equal(object(ledgerIssues[0], "ledger issue").evidenceKind, "none");
  assert.ok(
    !JSON.stringify(history).includes("commentorId"),
    "the ledger never carries commentor identity",
  );

  const roundTwoSchema = roundTwoComment!.task.outputSchema!.schema;
  const verdictSchema = (roundTwoSchema.properties as JsonObject)
    .verdict as JsonObject;
  assert.deepEqual(verdictSchema.enum, ["Pass", "Interrupt"]);
  // Step targets are narrowed to the walk position in the delivered schema.
  const stepSchema = (roundTwoSchema.properties as JsonObject).step as JsonObject;
  assert.equal(stepSchema.maximum, 2, "comment step targets are capped at the reviewed step");

  // Every redevelopment appends a new version of the member's idea under the
  // member's own artifact path, so the LAST entry is the reviewed output the
  // integrator, the chair, the dashboard, and the session's final copies read.
  const artifacts = await app.artifacts.list();
  const versions = artifacts.filter(
    (ref) => ref.metadata?.schema === "brainIdea" && ref.metadata.path === "ideas.member-1",
  );
  assert.equal(versions.length, 2, "first pass plus one revision under ideas.member-1");
  const finalStored = await app.artifacts.get(versions[versions.length - 1]!.id);
  const finalIdea = JSON.parse(finalStored!.data) as {
    cot: readonly string[];
    novelty?: string;
  };
  assert.deepEqual(finalIdea.cot, [
    "COT:member-1:1",
    "REVISED:member-1:2",
    "COT:member-1:3",
  ]);
  assert.equal(finalIdea.novelty, "Revised novelty for member-1");
  const untouched = artifacts.filter(
    (ref) => ref.metadata?.schema === "brainIdea" && ref.metadata.path === "ideas.member-2",
  );
  assert.equal(untouched.length, 1, "an unrevised member keeps its single first-pass version");
});

test("member task schemas carry only the run's shape body — the other eight never ride the wire", async () => {
  // The build path exercises BOTH chain-producing schemas: brainIdea (first
  // pass) and redevelopment (revision). The fixture submission classifies as
  // "research idea", which the catalog maps to the paper shape.
  const executor = new FakeBrainstormExecutor("build-step-2");
  const result = await runtime(executor).run({
    submission: "Slim-schema test",
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );

  const memberTasks = [...executor.tasks("brain"), ...executor.tasks("redeveloper")];
  assert.ok(executor.tasks("brain").length > 0, "the run produced first-pass tasks");
  assert.ok(executor.tasks("redeveloper").length > 0, "the build path produced a redevelopment");
  for (const seen of memberTasks) {
    const format = seen.task.modelRequest?.responseFormat;
    if (format?.type !== "jsonSchema") throw new Error(`${seen.role} has no jsonSchema format`);
    const schemaProperties = object(format.schema.properties, `${seen.role} properties`);
    // A first pass declares the whole envelope under `output`; a revision
    // patch declares only the sections it may change, under `outputPatch`.
    // Both carry exactly one shape body — the run's.
    const patching = schemaProperties.output === undefined;
    const envelope = object(
      patching ? schemaProperties.outputPatch : schemaProperties.output,
      `${seen.role} output property`,
    );
    const properties = object(envelope.properties, `${seen.role} envelope properties`);
    object(properties.paper, "the run's shape body stays declared");
    assert.ok(
      patching ||
        (Array.isArray(envelope.required) &&
          (envelope.required as JsonValue[]).includes("paper")),
      "the run's shape body is required of a full delivery",
    );
    for (const shape of OUTPUT_SHAPES) {
      if (shape === "paper") continue;
      assert.equal(
        properties[shape],
        undefined,
        `the unused "${shape}" body must be removed from the delivered ${seen.role} schema`,
      );
    }
  }
});

test("a verdict targeting a step beyond the review position fails the run with a named error", async () => {
  const overshoots = new (class extends FakeBrainstormExecutor {
    override async execute(task: AgentTask): Promise<AgentResult> {
      const result = await super.execute(task);
      const input = object(task.input, "task input");
      if (input.role !== "commentor" || result.status !== "ok") return result;
      const output = object(result.output as JsonValue, "comment output");
      return { ...result, output: { ...output, step: 5 } };
    }
  })();
  const result = await runtime(overshoots).run({
    submission: "Overshooting step target",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.status === "failed" ? result.error.message : "",
    /targeted step 5.*only reached step/,
  );
});

test("round cap force-proceeds after four decisions and only three redevelopments", async () => {
  const executor = new FakeBrainstormExecutor("cap-step-1");
  const app = runtime(executor);
  const result = await app.run({
    submission: "Cap-path test",
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );
  assert.equal(executor.judgeRounds.get("member-1:1"), 4);
  assert.equal(executor.revisionCalls.get("member-1:1"), 3);
  assert.ok(
    executor.judgeOrder.includes("member-1:2:1"),
    "the next step must run after the capped step is force-proceeded",
  );
});

test("a model cannot issue Build twice consecutively even if it ignores the prompt", async () => {
  const executor = new FakeBrainstormExecutor("repeat-build");
  const result = await runtime(executor).run({
    submission: "Invalid repeated Build",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error.message : "", /not allowed this round/);
  assert.equal(executor.judgeRounds.get("member-1:2"), 2);
});

test("manual panel gate suspends and checkpoint resume does not repeat prior agents", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor, "manual");
  let state = await app.run({
    runId: "manual-resume",
    submission: "Checkpoint test",
    params: { panelSize: 2 },
  });
  assert.equal(state.status, "suspended");
  if (state.status !== "suspended") throw new Error("unreachable");

  // Split-classification bundles (0.14.0+) pause at the classification gate
  // first; approving it across a FRESH runtime instance is itself part of
  // the replay proof.
  if (state.pendingGates[0]?.gateKey === "confirm-classification") {
    const processorTasks = executor.tasks("processor").length;
    const intermediate = runtime(executor, "manual", {
      checkpoints: app.checkpoints,
      artifacts: app.artifacts,
    });
    state = await intermediate.resume("manual-resume", {
      responses: { "confirm-classification": { action: "approve" } },
    });
    assert.equal(state.status, "suspended");
    if (state.status !== "suspended") throw new Error("unreachable");
    assert.equal(executor.tasks("processor").length, processorTasks);
  }
  assert.equal(state.pendingGates[0]?.gateKey, "confirm-panel");
  assert.equal(executor.tasks("processor").length, 1);
  assert.equal(executor.tasks("pool-builder").length, 1);

  // A fresh runtime instance over the persisted stores proves checkpoint
  // replay does not rely on interpreter memory.
  const resumedApp = runtime(executor, "manual", {
    checkpoints: app.checkpoints,
    artifacts: app.artifacts,
  });
  const second = await resumedApp.resume("manual-resume", {
    responses: { "confirm-panel": { action: "approve" } },
  });
  assert.equal(second.status, "completed");
  assert.equal(executor.tasks("processor").length, 1);
  assert.equal(executor.tasks("pool-builder").length, 1);
});

test("format-2 journals carry outputs only — no run-state copies", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor);
  const result = await app.run({
    runId: "journal-shape",
    submission: "Journal shape",
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );
  const checkpoint = await app.checkpoints.load("journal-shape");
  assert.ok(checkpoint);
  assert.equal(checkpoint.journalFormat, 2);
  const stateShaped = checkpoint.journal.filter((entry) => {
    const value = entry.value;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "_runtime" in value
    );
  });
  assert.equal(
    stateShaped.length,
    0,
    `no journal entry may carry the run state; found: ${stateShaped
      .map((entry) => entry.key)
      .join(", ")}`,
  );
  const foldEntries = checkpoint.journal.filter((entry) =>
    /-(store|phase|snapshot|merge|prepare|finish|initialize|apply)::result$/.test(entry.key),
  );
  assert.equal(
    foldEntries.length,
    0,
    `fold nodes must never reach the journal; found: ${foldEntries
      .map((entry) => entry.key)
      .join(", ")}`,
  );
  // The bounded outputs themselves ARE recorded: agent results and the
  // content activities' handler outputs under their -run child nodes.
  assert.ok(checkpoint.journal.some((entry) => entry.kind === "agent"));
  assert.ok(
    checkpoint.journal.some((entry) =>
      entry.key.endsWith("/select-panel/select-panel-run::result"),
    ),
  );
});

test("a format-1 journal migrates on load and resumes without repeating completed agents", async () => {
  const executor = new FakeBrainstormExecutor();
  const legacyStores = () => ({
    checkpoints: legacy.checkpoints,
    artifacts: legacy.artifacts,
  });
  const legacy = runtime(executor, "manual", undefined, 1);
  let state = await legacy.run({
    runId: "migrate-resume",
    submission: "Migration test",
    params: { panelSize: 2 },
  });
  assert.equal(state.status, "suspended");
  if (state.status !== "suspended") throw new Error("unreachable");
  if (state.pendingGates[0]?.gateKey === "confirm-classification") {
    state = await runtime(executor, "manual", legacyStores(), 1).resume("migrate-resume", {
      responses: { "confirm-classification": { action: "approve" } },
    });
    assert.equal(state.status, "suspended");
    if (state.status !== "suspended") throw new Error("unreachable");
  }
  assert.equal(state.pendingGates[0]?.gateKey, "confirm-panel");

  // The legacy layout really is on disk: activity entries carrying the state.
  const before = await legacy.checkpoints.load("migrate-resume");
  assert.ok(before);
  assert.equal(before.journalFormat ?? 1, 1);
  assert.ok(
    before.journal.some((entry) => {
      const value = entry.value;
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "_runtime" in value
      );
    }),
    "the format-1 fixture carries state copies",
  );

  const processorTasks = executor.tasks("processor").length;
  const poolTasks = executor.tasks("pool-builder").length;
  // A CURRENT runtime over the same stores: the load migrates the journal in
  // memory, replay reuses every recorded output, and the folds recompute.
  const modern = runtime(executor, "manual", legacyStores());
  const second = await modern.resume("migrate-resume", {
    responses: { "confirm-panel": { action: "approve" } },
  });
  assert.equal(
    second.status,
    "completed",
    second.status === "failed" ? `${second.error.name}: ${second.error.message}` : undefined,
  );
  assert.equal(executor.tasks("processor").length, processorTasks, "no re-run after migration");
  assert.equal(executor.tasks("pool-builder").length, poolTasks);

  // The first save after the migrated resume persists format 2, state-free.
  const after = await legacy.checkpoints.load("migrate-resume");
  assert.equal(after?.journalFormat, 2);
  assert.ok(
    !(after?.journal ?? []).some((entry) => {
      const value = entry.value;
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "_runtime" in value
      );
    }),
    "the resumed run's journal no longer carries state copies",
  );

  // Replayed folds re-persist their artifacts; idempotent puts must not
  // have duplicated any (name, payload) pair.
  const refs = await legacy.artifacts.list();
  const identities = refs.map((ref) => `${ref.name}#${ref.sha256 ?? ""}`);
  assert.equal(
    new Set(identities).size,
    identities.length,
    "no artifact was duplicated by the replayed folds",
  );
});

test("checkpoint resume re-persists no duplicate artifacts", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor, "manual");
  let state = await app.run({
    runId: "artifact-dedupe",
    submission: "Artifact dedupe",
    params: { panelSize: 2 },
  });
  assert.equal(state.status, "suspended");
  if (state.status !== "suspended") throw new Error("unreachable");
  const stores = { checkpoints: app.checkpoints, artifacts: app.artifacts };
  if (state.pendingGates[0]?.gateKey === "confirm-classification") {
    state = await runtime(executor, "manual", stores).resume("artifact-dedupe", {
      responses: { "confirm-classification": { action: "approve" } },
    });
    if (state.status !== "suspended") throw new Error("unreachable");
  }
  const suspendedRefs = (await app.artifacts.list()).length;
  const second = await runtime(executor, "manual", stores).resume("artifact-dedupe", {
    responses: { "confirm-panel": { action: "approve" } },
  });
  assert.equal(second.status, "completed");
  const refs = await app.artifacts.list();
  assert.ok(refs.length > suspendedRefs, "the resumed run persisted its own new artifacts");
  const identities = refs.map((ref) => `${ref.name}#${ref.sha256 ?? ""}`);
  assert.equal(
    new Set(identities).size,
    identities.length,
    "replaying the pre-gate folds duplicated no artifact",
  );
});

test("invalid agent artifacts fail before downstream state updates", async () => {
  const invalid: AgentExecutor = {
    async execute(task) {
      return { taskId: task.taskId, status: "ok", output: {} };
    },
  };
  const result = await runtime(invalid).run({
    submission: "Invalid output",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.error.name, "ArtifactValidationError");
  assert.match(result.status === "failed" ? result.error.message : "", /processorOutput/);
});

test("explicitly requested outputs are pinned per task, answered by every member, and reach the chair", async () => {
  const asks = [
    { title: "Benchmarking protocol", ask: "Propose a benchmarking protocol for the mechanism." },
    { title: "Risk register", ask: "List the main failure risks of the mechanism with mitigations." },
  ];
  // A well-behaved panel: the run records the submitter's explicit asks
  // (the processor on pre-split bundles, the classifier on 0.14.0+ — the
  // merge writes its list into the input), and every member (first pass
  // and revision alike) echoes one response section per ask, in order,
  // titles verbatim.
  class AnsweringExecutor extends FakeBrainstormExecutor {
    override async execute(task: AgentTask): Promise<AgentResult> {
      const result = await super.execute(task);
      const input = object(task.input, "task input");
      if (result.status !== "ok") return result;
      if (input.role === "processor" || input.role === "classifier") {
        const output = object(result.output as JsonValue, `${String(input.role)} output`);
        return { ...result, output: { ...output, requestedOutputs: asks } };
      }
      if (input.role === "brain" || input.role === "redeveloper") {
        const artifact = object(result.output as JsonValue, "member artifact");
        const bindings = object(input.bindings, "task bindings");
        const boundInput = object(bindings.input, "bound input");
        const boundAsks = boundInput.requestedOutputs as readonly { title: string }[];
        const requested = boundAsks.map((entry) => ({
          title: entry.title,
          response: [`Direct response to "${entry.title}" from ${String(task.agentId)}.`],
        }));
        return {
          ...result,
          output: {
            ...artifact,
            output: { ...object(artifact.output, "envelope"), requested },
          },
        };
      }
      return result;
    }
  }

  const executor = new AnsweringExecutor();
  const result = await runtime(executor).run({
    runId: "requested-outputs",
    submission: { prompt: "Investigate the mechanism and also give me a benchmarking protocol and a risk register", attachments: [] },
    params: { panelSize: 2 },
  });
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );

  // Every member task's delivered schema pins the section list: required,
  // count fixed, titles enum-narrowed in the recorded order.
  for (const task of executor.tasks("brain")) {
    const format = task.task.modelRequest?.responseFormat;
    if (format?.type !== "jsonSchema") throw new Error("brain has no jsonSchema format");
    const envelope = object(
      object(format.schema.properties, "brain properties").output,
      "brain output property",
    );
    assert.ok(
      Array.isArray(envelope.required) && (envelope.required as JsonValue[]).includes("requested"),
      "the requested sections are required in the delivered schema",
    );
    const requestedProperty = object(
      object(envelope.properties, "envelope properties").requested,
      "requested property",
    );
    assert.equal(requestedProperty.minItems, asks.length);
    assert.equal(requestedProperty.maxItems, asks.length);
    const titleProperty = object(
      object(object(requestedProperty.items, "requested items").properties, "item properties").title,
      "title property",
    );
    assert.deepEqual(
      titleProperty.enum,
      asks.map((entry) => entry.title),
      "section titles are pinned in the recorded order",
    );
  }

  // The sections ride each member's output into the integrator and the chair.
  const chairIdeas = object(executor.tasks("chair")[0]!.bindings.ideas, "chair ideas");
  const auditIdeas = object(executor.tasks("integrator")[0]!.bindings.ideas, "integrator ideas");
  for (const ideas of [chairIdeas, auditIdeas]) {
    for (const [memberId, idea] of Object.entries(ideas)) {
      const envelope = object(object(idea, "projected idea").output, "projected envelope");
      const sections = envelope.requested as readonly JsonValue[];
      assert.ok(Array.isArray(sections), `${memberId} carries requested sections downstream`);
      assert.deepEqual(
        sections.map((section) => object(section, "section").title),
        asks.map((entry) => entry.title),
      );
    }
  }
});

test("a member that skips a requested output fails the run with a named error", async () => {
  const withAsks = new (class extends FakeBrainstormExecutor {
    override async execute(task: AgentTask): Promise<AgentResult> {
      const result = await super.execute(task);
      const input = object(task.input, "task input");
      if (
        (input.role !== "processor" && input.role !== "classifier") ||
        result.status !== "ok"
      ) {
        return result;
      }
      const output = object(result.output as JsonValue, `${String(input.role)} output`);
      return {
        ...result,
        output: {
          ...output,
          requestedOutputs: [
            { title: "Benchmarking protocol", ask: "Propose a benchmarking protocol for the mechanism." },
          ],
        },
      };
    }
  })();
  // The base executor's members never emit requested sections, so the first
  // member write must fail the REQUESTED_SECTION_MISMATCH cross-check.
  const result = await runtime(withAsks).run({
    submission: "Requested output skipped",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.status === "failed" ? result.error.message : "",
    /must answer exactly the 1 requested output/,
  );
});

test("requested sections without a recorded ask fail the run with a named error", async () => {
  const volunteers = new (class extends FakeBrainstormExecutor {
    override async execute(task: AgentTask): Promise<AgentResult> {
      const result = await super.execute(task);
      const input = object(task.input, "task input");
      if (input.role !== "brain" || result.status !== "ok") return result;
      const artifact = object(result.output as JsonValue, "member artifact");
      return {
        ...result,
        output: {
          ...artifact,
          output: {
            ...object(artifact.output, "envelope"),
            requested: [
              { title: "Volunteered extra", response: ["An unrequested section nobody asked for."] },
            ],
          },
        },
      };
    }
  })();
  const result = await runtime(volunteers).run({
    submission: "Unrequested sections",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.status === "failed" ? result.error.message : "",
    /recorded no requested outputs/,
  );
});

test("a classification outside the input-type catalog fails the run with a named error", async () => {
  // The submission types are data (catalog/input-types.json), so the schema
  // accepts any label; this is the runtime cross-check that pins the
  // processor's choice to the loaded catalog.
  const inventsType = new (class extends FakeBrainstormExecutor {
    override async execute(task: AgentTask): Promise<AgentResult> {
      const result = await super.execute(task);
      const input = object(task.input, "task input");
      if (input.role !== "processor" || result.status !== "ok") return result;
      const output = object(result.output as JsonValue, "processor output");
      return { ...result, output: { ...output, type: "brilliant brainstorm" } };
    }
  })();
  const result = await runtime(inventsType).run({
    submission: "Invented type",
    params: { panelSize: 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.status === "failed" ? result.error.message : "",
    /brilliant brainstorm.*not a type of the loaded input-type catalog/,
  );
});
