import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent } from "@brainstorm-agentic/content";
import type {
  AgentExecutor,
  AgentResult,
  AgentTask,
  HostToolManifest,
  JsonObject,
  JsonValue,
  RunResult,
  TaxonomyAccess,
  TaxonomyNodePosition,
  TaxonomyResolveResult,
} from "@brainstorm-agentic/core";

import {
  BrainstormRuntime,
  StaticBrainstormRouteResolver,
  taxonomyActivities,
} from "../src/index.js";

/**
 * Mid-run panel-seat dismissal, driven through the whole pipeline.
 *
 * The unit-level policy (dismissal.ts) only answers questions; what has to be
 * proven is that the compiled guards actually stop the MODEL CALLS a dismissed
 * seat would otherwise buy, and that a run with nothing dismissed is the run
 * that existed before the feature. Both are only visible end to end, so this
 * file drives real runs and reads the executor's record of what it was asked
 * to do.
 *
 * The harness below is the e2e suite's, copied rather than imported: that file
 * exports nothing, and importing it would re-run its whole suite here. Only the
 * parts a pass-path run touches are carried over — the judge is pass-only and
 * there is no redeveloper fixture, so a dismissal guard that failed and let a
 * revision through would surface as a loud "unexpected role" rather than as a
 * quietly passing assertion.
 */

/** See e2e.test.ts: engineered so the seating order is fixed and known. */
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

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
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

const registryContentDir = process.env.BRAIN_TEST_CONTENT_DIR ?? latestPublishedBundleDir();

function object(value: JsonValue | undefined, label: string): JsonObject {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is not an object`);
  return value as JsonObject;
}

function paperBody(label: string): JsonObject {
  return {
    abstract: [1, 2, 3].map((i) => `${label} abstract paragraph ${i}`),
    introduction: [1, 2, 3].map((i) => `${label} introduction paragraph ${i}`),
    method: [1, 2, 3].map((i) => `${label} method paragraph ${i}`),
    discussion: [1, 2, 3].map((i) => `${label} discussion paragraph ${i}`),
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

/**
 * panelSize 3 seats three disciplinary members and the weave appends the
 * interdisciplinary one, so the panel is four seats deep; the processor fixture
 * asks for a three-step chain. Every count in this file is derived from these
 * two, never written as a bare number.
 */
const PANEL_SEATS = ["member-1", "member-2", "member-3", "member-4"] as const;
const CHAIN_STEPS = 3;

/** The seat dismissed in these tests: the Computer Science / Machine Learning chair. */
const DISMISSED = "member-2";

function remainingSeats(): readonly string[] {
  return PANEL_SEATS.filter((id) => id !== DISMISSED);
}

interface SeenTask {
  readonly role: string;
  readonly agentId: string;
  readonly bindings: JsonObject;
  readonly task: AgentTask;
}

class FakeBrainstormExecutor implements AgentExecutor {
  readonly seen: SeenTask[] = [];
  readonly judgeOrder: string[] = [];
  /**
   * Stops the run at a chosen task, standing in for the worker being killed
   * mid-flight — which is exactly what a mid-run dismissal does.
   */
  failOn?: (task: SeenTask) => boolean;

  async execute(task: AgentTask): Promise<AgentResult> {
    const input = object(task.input, "task input");
    const bindings = object(input.bindings, "task bindings");
    const role = input.role as string;
    const agentId = task.agentId ?? role;
    const entry: SeenTask = { role, agentId, bindings, task };
    this.seen.push(entry);
    if (this.failOn?.(entry) === true) {
      throw new Error(`fixture stopped the run at ${role}/${agentId}`);
    }

    let output: JsonValue;
    switch (role) {
      case "processor":
        output = {
          type: "research idea",
          title: "Distributional message passing over graphs",
          question: "Can the mechanism be tested against a held-out graph?",
          context: "A deterministic fixture standing in for a real submission.",
          attachments: [],
          assumptions: [],
          cotSteps: CHAIN_STEPS,
          files: [
            {
              path: "attachments/1-repo/src/model.py",
              label: "code",
              note: "Prototype the question refers to.",
            },
            { path: "attachments/1-repo/package-lock.json", label: "NA", note: "" },
          ],
        };
        break;
      case "classifier":
        output = {
          primary: {
            type: "research idea",
            reason: "The fixture submission sketches a mechanism to be developed into a full contribution.",
          },
          alternative: {
            type: "unverified claim",
            reason: "A reader could take the held-out-graph question as a single checkable claim instead.",
          },
          cotSteps: CHAIN_STEPS,
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
        // The chain steps carry the developing seat's id, which is what lets a
        // later assertion name the seat a review task is working ON — the
        // reviewing roles bind a chain but no member id of their own.
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
      case "judge": {
        const step = bindings.currentStep as number;
        this.judgeOrder.push(`${agentId}:${step}`);
        const comments = object(bindings.comments, "comments");
        output = {
          verdict: "Pass",
          reason: "The step is sound and no comment demonstrates a flaw in it",
          suggestion: "",
          evidence: noEvidence,
          issues: [],
          assessment: Object.keys(comments).map((commentorId) => ({
            commentorId,
            basis: "verified",
          })),
        };
        break;
      }
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

  tasks(role: string): readonly SeenTask[] {
    return this.seen.filter((entry) => entry.role === role);
  }

  /** Every comment task, whichever of the two commenting skills authored it. */
  comments(): readonly SeenTask[] {
    return this.seen.filter(
      (entry) => entry.role === "commentor" || entry.role === "interdisciplinary-commentor",
    );
  }
}

/** See e2e.test.ts: without these the placer's REQUIRED capability is unavailable. */
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

/**
 * The e2e factory with the dismissal list moved to the front, because that is
 * the one thing every test here varies. Passing `undefined` is the pre-feature
 * configuration and must stay distinguishable from passing an empty list.
 */
function runtime(
  executor: AgentExecutor,
  dismissedMembers?: readonly string[],
  humanGateMode: "manual" | "autoApproveSkippable" = "autoApproveSkippable",
  stores?: Pick<BrainstormRuntime, "checkpoints" | "artifacts">,
) {
  return new BrainstormRuntime({
    bundle: loadContent(registryContentDir),
    agentExecutor: executor,
    humanGateMode,
    activities: taxonomyActivities(new StubTaxonomy()),
    routeResolver: new StaticBrainstormRouteResolver({
      reasoning: { modelId: "configured-reasoner", providerId: "fake" },
      writing: { modelId: "configured-writer", providerId: "fake" },
      balanced: { modelId: "configured-balanced", providerId: "fake" },
    }),
    hostTools: TEST_HOST_TOOLS,
    enabledHostToolIds: new Set(TEST_HOST_TOOLS.map((manifest) => manifest.toolId)),
    ...(stores ?? {}),
    ...(dismissedMembers !== undefined ? { dismissedMembers } : {}),
  });
}

const SUBMISSION = { prompt: "Investigate the mechanism", attachments: [] };

/** The member ids of a bound roster, which is an array of member objects. */
function rosterIds(roster: JsonValue | undefined): readonly string[] {
  assert.ok(Array.isArray(roster), "roster is not an array");
  return roster.map((member) => String(object(member, "roster member").id));
}

/**
 * The seat whose chain a review task is working ON. Judges, commentors and
 * redevelopers bind a chain but never a member id, so the developing seat's
 * signature in its own chain text is the only thing that names the seat under
 * review — which is exactly what has to be absent for a dismissed seat.
 */
function chainOwner(bindings: JsonObject): string | undefined {
  const chain = bindings.chain;
  const first = Array.isArray(chain) ? chain[0] : undefined;
  const match = typeof first === "string" ? /^(?:COT|REVISED):([^:]+):/.exec(first) : null;
  return match?.[1];
}

/** Every seat judged, mapped to the walk positions it was judged at, in order. */
function judgedWalks(executor: FakeBrainstormExecutor): Map<string, number[]> {
  const walks = new Map<string, number[]>();
  for (const entry of executor.judgeOrder) {
    const [memberId, step] = entry.split(":");
    const walk = walks.get(memberId!) ?? [];
    walk.push(Number(step));
    walks.set(memberId!, walk);
  }
  return walks;
}

/** Fails with the run's own error text, which is the only useful diagnostic. */
function completed(result: RunResult): void {
  assert.equal(
    result.status,
    "completed",
    result.status === "failed" ? `${result.error.name}: ${result.error.message}` : undefined,
  );
}

test("a dismissed seat buys no model call: it develops nothing, comments on nobody, and is never judged", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor, [DISMISSED]);
  const result = await app.run({
    runId: "dismissed-seat",
    submission: SUBMISSION,
    params: { panelSize: 3 },
  });
  completed(result);
  assert.deepEqual(result.status === "completed" && result.output, finalProposal());

  // agentId is the commentor when a task authors a comment and otherwise the
  // seat being worked on, so ONE filter covers all three ways a dismissed seat
  // could still cost a model call: its own first pass, a comment it authors on
  // somebody else's chain, and a judge or redeveloper on its chain.
  assert.deepEqual(
    executor.seen.filter((entry) => entry.agentId === DISMISSED).map((entry) => entry.role),
    [],
    "no task was dispatched for the dismissed seat",
  );
  // Read the other way round, from the chain the task was handed: nothing
  // reviews the dismissed seat's walk, whoever the reviewer was.
  assert.deepEqual(
    executor.seen.filter((entry) => chainOwner(entry.bindings) === DISMISSED).map((entry) => entry.role),
    [],
    "no reviewer received the dismissed seat's chain",
  );

  // The remaining seats' walks are untouched: each develops once, and each is
  // judged once at every position of its chain, in chain order.
  assert.deepEqual(
    executor.tasks("brain").map((entry) => entry.agentId).sort(),
    [...remainingSeats()],
  );
  const walks = judgedWalks(executor);
  assert.deepEqual([...walks.keys()].sort(), [...remainingSeats()]);
  for (const [memberId, walk] of walks) {
    assert.deepEqual(
      walk,
      [1, 2, 3],
      `${memberId}'s walk is judged at every position in chain order`,
    );
  }

  // Commenting is where the dismissal is felt twice over: the dismissed seat
  // neither receives comments (its walk never runs) nor gives them, so each
  // remaining seat's every position gathers one comment fewer than the
  // undismissed run's three.
  const commentors = remainingSeats().length - 1;
  assert.equal(executor.comments().length, remainingSeats().length * CHAIN_STEPS * commentors);
  for (const seat of remainingSeats()) {
    assert.equal(
      executor.comments().filter((entry) => chainOwner(entry.bindings) === seat).length,
      CHAIN_STEPS * commentors,
      `${seat} was commented on by every remaining seat but itself`,
    );
  }

  // The interdisciplinary seat is the one role that reads the roster while
  // commenting; it must not be told to weigh a seat that is gone.
  const bridgeComments = executor.tasks("interdisciplinary-commentor");
  assert.ok(bridgeComments.length > 0, "the interdisciplinary seat still commented");
  for (const entry of bridgeComments) {
    assert.deepEqual(rosterIds(entry.bindings.roster), [...remainingSeats()]);
  }
});

test("the integrator and the chair never receive a dismissed member", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor, [DISMISSED]);
  completed(
    await app.run({
      runId: "dismissed-withheld",
      submission: SUBMISSION,
      params: { panelSize: 3 },
    }),
  );

  for (const role of ["integrator", "chair"] as const) {
    const tasks = executor.tasks(role);
    assert.equal(tasks.length, 1, `${role} ran exactly once`);
    const task = tasks[0]!;
    assert.deepEqual(
      Object.keys(object(task.bindings.ideas, `${role} ideas`)).sort(),
      [...remainingSeats()],
      `${role} receives one idea per remaining seat and none for the dismissed one`,
    );
    assert.deepEqual(
      rosterIds(task.bindings.roster),
      [...remainingSeats()],
      `${role} receives the roster without the dismissed seat`,
    );
    // Nothing derived from the seat may reach the synthesis by another route
    // either — an audit entry, a comment attribution, a stray novelty claim.
    assert.ok(
      !JSON.stringify(task.bindings).includes(DISMISSED),
      `the dismissed member id appears nowhere in the ${role} bindings`,
    );
  }

  // The audit the chair reads is one entry per seat the integrator saw, so the
  // dismissed seat's novelty claim is never adjudicated at all.
  const bridge = object(executor.tasks("chair")[0]!.bindings.bridge, "chair bridge report");
  assert.ok(Array.isArray(bridge.noveltyAudit));
  assert.equal(bridge.noveltyAudit.length, remainingSeats().length);
});

test("a run with nothing dismissed seats and walks the full panel, list or no list", async () => {
  // The whole feature must be inert by default, so this is the pre-feature run
  // written out: four seats, each developing once, each judged at every walk
  // position, each commented on by all three others.
  const baseline = new FakeBrainstormExecutor();
  const app = runtime(baseline);
  const result = await app.run({
    runId: "no-dismissal",
    submission: SUBMISSION,
    params: { panelSize: 3 },
  });
  completed(result);
  assert.deepEqual(result.status === "completed" && result.output, finalProposal());
  assert.deepEqual(
    baseline.tasks("brain").map((entry) => [entry.agentId, entry.bindings.department, entry.bindings.umbrella]),
    [
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
  const walks = judgedWalks(baseline);
  assert.deepEqual([...walks.keys()].sort(), [...PANEL_SEATS]);
  for (const [memberId, walk] of walks) {
    assert.deepEqual(walk, [1, 2, 3], `${memberId}'s walk is judged at every position`);
  }
  assert.equal(
    baseline.comments().length,
    PANEL_SEATS.length * CHAIN_STEPS * (PANEL_SEATS.length - 1),
  );
  for (const role of ["integrator", "chair"] as const) {
    assert.deepEqual(
      Object.keys(object(baseline.tasks(role)[0]!.bindings.ideas, `${role} ideas`)).sort(),
      [...PANEL_SEATS],
    );
    assert.deepEqual(rosterIds(baseline.tasks(role)[0]!.bindings.roster), [...PANEL_SEATS]);
  }

  // A list that names nobody is the same run again. The server sends the
  // accumulated list on every resume, so the empty and whitespace-only forms
  // are what an untouched job record actually looks like on the wire.
  for (const empty of [[], ["   "]] as const) {
    const executor = new FakeBrainstormExecutor();
    completed(
      await runtime(executor, empty).run({
        runId: `empty-dismissal-${empty.length}`,
        submission: SUBMISSION,
        params: { panelSize: 3 },
      }),
    );
    assert.deepEqual(
      executor.seen.map((entry) => `${entry.role}:${entry.agentId}`).sort(),
      baseline.seen.map((entry) => `${entry.role}:${entry.agentId}`).sort(),
      `dismissedMembers ${JSON.stringify(empty)} changed which tasks ran`,
    );
  }
});

test("a seat dismissed while commenting on another member never resumes that comment", async () => {
  // The case a submitter actually hits: at the moment a seat is stopped it is
  // usually mid-flight COMMENTING on somebody else's chain. The worker is killed,
  // which ends that call, and the question is what the resume does with it — the
  // round it belonged to is already journalled WITH that seat in its fan-out, so
  // the branch is re-entered and only the guard can keep the call from being
  // bought a second time for a seat that has left.
  const executor = new FakeBrainstormExecutor();
  // Stop the run inside exactly that call: the dismissed seat commenting on
  // another member's step. Its own walk is untouched at this point.
  // Every commentor task this seat runs is by definition on ANOTHER member's
  // chain: the round's fan-out excludes the thinker from its own review.
  executor.failOn = (entry) =>
    entry.agentId === DISMISSED && entry.role === "commentor";
  const app = runtime(executor);
  const stopped = await app.run({
    runId: "dismiss-mid-comment",
    submission: SUBMISSION,
    params: { panelSize: 3 },
  });
  assert.equal(stopped.status, "failed", "the fixture stopped the run mid-comment");
  const killedComment = executor.seen.find(
    (entry) => entry.agentId === DISMISSED && entry.role === "commentor",
  );
  assert.ok(killedComment, "the dismissed seat was mid-comment when the run stopped");
  const journalled = executor.seen
    .filter((entry) => entry.task.taskId !== killedComment.task.taskId)
    .map((entry) => entry.task.taskId);

  // Now the dismissal, exactly as the server delivers it: same stores, same
  // pinned workflow, the seat named on the resume. Everything before this line
  // is work the run had already bought and is entitled to keep.
  const boughtBefore = executor.seen.length;
  executor.failOn = undefined;
  const resumed = await runtime(executor, [DISMISSED], undefined, {
    checkpoints: app.checkpoints,
    artifacts: app.artifacts,
  }).resume("dismiss-mid-comment");
  completed(resumed);
  const afterDismissal = executor.seen.slice(boughtBefore);

  // Nothing further is bought for the dismissed seat: not the comment the
  // dismissal interrupted, not another comment on anybody else's chain, and
  // nothing on its own walk either.
  assert.deepEqual(
    afterDismissal
      .filter((entry) => entry.agentId === DISMISSED)
      .map((entry) => `${entry.role} ${entry.task.taskId}`),
    [],
    "the dismissed seat bought work after the dismissal",
  );
  // Work already journalled replays instead of being paid for twice.
  for (const taskId of journalled) {
    assert.equal(
      afterDismissal.filter((entry) => entry.task.taskId === taskId).length,
      0,
      `task ${taskId} was re-executed after the dismissal`,
    );
  }
  // And the seats still in the review finish their walks, judged on the comments
  // they did receive — one fewer, from a seat that no longer sits.
  assert.deepEqual(
    executor.tasks("chair").length > 0
      ? Object.keys(object(executor.tasks("chair")[0]!.bindings.ideas, "chair ideas")).sort()
      : [],
    [...remainingSeats()],
  );
});

test("a dismissal cannot reach back into a finished run's record", async () => {
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor);
  completed(
    await app.run({
      runId: "dismiss-after-finish",
      submission: SUBMISSION,
      params: { panelSize: 3 },
    }),
  );
  // Artifact names carry the run id, so the seat's own record is identified by
  // the state path it was written under — the identity the dashboard reads.
  const ideaPath = `ideas.${DISMISSED}`;
  const seatIdeas = async () =>
    (await app.artifacts.list()).filter((ref) => ref.metadata?.path === ideaPath);
  const recorded = await seatIdeas();
  assert.equal(recorded.length, 1, "the seat's first pass was recorded before the dismissal");

  // A completed run refuses resume by contract — its result already stands —
  // so a dismissal arriving after the fact is rejected rather than replayed.
  const dismissed = runtime(executor, [DISMISSED], "autoApproveSkippable", {
    checkpoints: app.checkpoints,
    artifacts: app.artifacts,
  });
  const before = executor.seen.length;
  await assert.rejects(
    () => dismissed.resume("dismiss-after-finish"),
    /already finished/,
    "resuming a completed run must be refused, dismissal or not",
  );
  assert.equal(executor.seen.length, before, "the refused resume re-bought nothing");

  // Which is the point of the guards being placed inside existing nodes: what
  // the seat produced before the dismissal stays in the artifact history, so
  // the dashboard's record of what happened is never rewritten.
  assert.deepEqual(
    (await seatIdeas()).map((ref) => ref.id),
    recorded.map((ref) => ref.id),
  );
});

test("a dismissal arriving on a resume skips the seat without re-buying journalled work", async () => {
  // The real delivery path: the run suspends at the panel gate, the submitter
  // dismisses a seat, and the resume carries the list. Everything recorded
  // before the gate must replay from the journal — a dismissal is not a reason
  // to pay for the pool, the placement or the classification twice.
  const executor = new FakeBrainstormExecutor();
  const app = runtime(executor, undefined, "manual");
  let state = await app.run({
    runId: "dismiss-on-resume",
    submission: SUBMISSION,
    params: { panelSize: 3 },
  });
  assert.equal(state.status, "suspended");
  if (state.status !== "suspended") throw new Error("unreachable");
  const stores = { checkpoints: app.checkpoints, artifacts: app.artifacts };
  if (state.pendingGates[0]?.gateKey === "confirm-classification") {
    state = await runtime(executor, [DISMISSED], "manual", stores).resume("dismiss-on-resume", {
      responses: { "confirm-classification": { action: "approve" } },
    });
    assert.equal(state.status, "suspended");
    if (state.status !== "suspended") throw new Error("unreachable");
  }
  assert.equal(state.pendingGates[0]?.gateKey, "confirm-panel");
  const prePanel = executor.seen.map((entry) => entry.task.taskId);
  assert.ok(prePanel.length > 0, "the run bought its pre-panel tasks before suspending");

  const resumed = await runtime(executor, [DISMISSED], "manual", stores).resume("dismiss-on-resume", {
    responses: { "confirm-panel": { action: "approve" } },
  });
  completed(resumed);
  // Every pre-gate task was journalled, so the resumed run re-executes none of
  // them: each of their task ids still appears exactly once.
  for (const taskId of prePanel) {
    assert.equal(
      executor.seen.filter((entry) => entry.task.taskId === taskId).length,
      1,
      `task ${taskId} was re-executed after the dismissed resume`,
    );
  }
  assert.deepEqual(
    executor.seen.filter((entry) => entry.agentId === DISMISSED).map((entry) => entry.role),
    [],
    "the seat dismissed at the gate bought nothing after it",
  );
  assert.deepEqual(
    executor.tasks("brain").map((entry) => entry.agentId).sort(),
    [...remainingSeats()],
  );
  assert.deepEqual(
    Object.keys(object(executor.tasks("chair")[0]!.bindings.ideas, "chair ideas")).sort(),
    [...remainingSeats()],
  );
});
