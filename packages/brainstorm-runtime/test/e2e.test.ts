import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent, type ContentBundle } from "@brainstorm-agentic/content";
import {
  systemPromptSegments,
  systemPromptText,
  textContent,
  type AgentExecutor,
  type AgentResult,
  type AgentTask,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import {
  BrainstormRuntime,
  StaticBrainstormRouteResolver,
} from "../src/index.js";

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
      case "decomposer":
        output = {
          // Leaf scores (i*j*k): photon counting 2*4*4=32, network inference
          // 3*3*3=27, representation learning 2*4*2=16, transport 1*1*4=4,
          // single-molecule 1*1*3=3 — so panelSize 3 seats QO, SysBio, ML in
          // that order and panelSize 2 seats the first two.
          departments: [
            {
              name: "Physics",
              domain: "natural_sciences",
              count: 4,
              umbrellas: [
                {
                  name: "Quantum Optics",
                  count: 4,
                  subfields: [{ name: "photon counting", count: 2 }],
                },
                {
                  name: "Condensed Matter",
                  count: 1,
                  subfields: [{ name: "transport", count: 1 }],
                },
              ],
            },
            {
              name: "Biology",
              domain: "life_sciences_and_medicine",
              count: 3,
              umbrellas: [
                {
                  name: "Systems Biology",
                  count: 3,
                  subfields: [{ name: "network inference", count: 3 }],
                },
                {
                  name: "Biophysics",
                  count: 1,
                  subfields: [{ name: "single-molecule methods", count: 1 }],
                },
              ],
            },
            {
              name: "Computer Science",
              domain: "engineering_and_applied_sciences",
              count: 2,
              umbrellas: [
                {
                  name: "Machine Learning",
                  count: 4,
                  subfields: [{ name: "representation learning", count: 2 }],
                },
              ],
            },
          ],
          // Literature grounding rides on the experts artifact; panel
          // selection must ignore it.
          grounding: {
            papers: [
              {
                title: "Deterministic Test Paper",
                authors: ["Test Author"],
                year: 2024,
                relation: "Grounds the machine-learning umbrella.",
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
      case "brain":
        output = {
          output: developedOutput(agentId),
          cot: [1, 2, 3].map((step) => `COT:${agentId}:${step}`),
          novelty: `Novelty for ${agentId}`,
        };
        break;
      case "commentor":
        output = {
          verdict: "Pass",
          reason: `Comment from ${agentId}: the step is sound as developed.`,
          suggestion: "",
          evidence: noEvidence,
        };
        break;
      case "judge":
        output = this.judge(agentId, bindings);
        break;
      case "redeveloper":
        output = this.redevelop(agentId, bindings);
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
        reason: "A complementary point is needed",
        suggestion: "Add the missing control",
        evidence: noEvidence,
        assessment,
      };
    }
    if (this.mode === "cap-step-1" && memberId === "member-1" && step === 1) {
      return {
        verdict: "Interrupt",
        reason: "The premise needs repair before the chain can continue",
        suggestion: "",
        evidence: {
          kind: "math",
          code: "",
          result: "",
          derivation: "Assume A; derive not-A.",
          citation: "",
          locator: "",
          shows: "",
        },
        assessment,
      };
    }
    return {
      verdict: "Pass",
      reason: "The step is sound and no comment would materially improve it",
      suggestion: "",
      evidence: noEvidence,
      assessment,
    };
  }

  private redevelop(memberId: string, bindings: JsonObject): JsonValue {
    const step = bindings.currentStep as number;
    const total = bindings.totalSteps as number;
    const key = `${memberId}:${step}`;
    this.revisionCalls.set(key, (this.revisionCalls.get(key) ?? 0) + 1);
    return {
      fromStep: step,
      output: developedOutput(`${memberId} revised at ${step}`),
      revisedSteps: Array.from(
        { length: total - step + 1 },
        (_unused, offset) => `REVISED:${memberId}:${step + offset}`,
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

function runtime(
  executor: AgentExecutor,
  humanGateMode: "manual" | "autoApproveSkippable" = "autoApproveSkippable",
  stores?: Pick<BrainstormRuntime, "checkpoints" | "artifacts">,
) {
  return new BrainstormRuntime({
    bundle: loadContent(registryContentDir),
    agentExecutor: executor,
    humanGateMode,
    routeResolver: new StaticBrainstormRouteResolver({
      reasoning: { modelId: "configured-reasoner", providerId: "fake" },
      writing: { modelId: "configured-writer", providerId: "fake" },
      balanced: { modelId: "configured-balanced", providerId: "fake" },
    }),
    ...(stores ?? {}),
  });
}

test("Pass path executes member -> step -> round order and keeps C-O-T from chair", async () => {
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
      ["member-1", "Physics", "Quantum Optics"],
      ["member-2", "Biology", "Systems Biology"],
      ["member-3", "Computer Science", "Machine Learning"],
    ],
  );
  assert.deepEqual(executor.judgeOrder, [
    "member-1:1:1",
    "member-1:2:1",
    "member-1:3:1",
    "member-2:1:1",
    "member-2:2:1",
    "member-2:3:1",
    "member-3:1:1",
    "member-3:2:1",
    "member-3:3:1",
  ]);

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
    Array.isArray(bridge.noveltyAudit) && bridge.noveltyAudit.length === 3,
    "the chair receives one audit entry per member",
  );

  for (const task of executor.seen) {
    assert.equal(task.task.logicalRoute, task.role === "chair" ? "writing" : "reasoning");
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
  const processorType = object(
    object(deliveredSchema("processor").properties, "processor properties").type,
    "processor type property",
  );
  assert.ok(Array.isArray(processorType.enum), "processor type is enum-narrowed");
  assert.ok((processorType.enum as JsonValue[]).includes("research idea"));
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
  assert.deepEqual(executor.tasks("processor")[0]!.task.allowedCapabilities, [
    "attachment-access",
  ]);
  assert.deepEqual(executor.tasks("processor")[0]!.task.tools, ["attachment-access"]);
  assert.deepEqual(chair.task.allowedCapabilities, ["attachment-access"]);
  assert.deepEqual(chair.task.tools, ["attachment-access"]);

  // The orchestrator partitions the processor's file map deterministically:
  // every later model call receives the useful files only, and the raw map is
  // withheld from the bound input.
  const usefulEntry = {
    path: "attachments/1-repo/src/model.py",
    label: "code",
    note: "Prototype the question refers to.",
  };
  for (const task of executor.seen) {
    if (task.role === "processor") continue;
    assert.deepEqual(
      task.bindings.files,
      [usefulEntry],
      `${task.role} must receive exactly the useful files`,
    );
    const boundInput = object(task.bindings.input, `${task.role} input`);
    assert.equal(
      boundInput.files,
      undefined,
      `${task.role} must not see the unpartitioned file map`,
    );
  }
  const artifacts = await app.artifacts.list();
  const schemas = artifacts.map((ref) => ref.metadata?.schema);
  assert.ok(schemas.includes("usefulFiles"), "useful-files artifact persisted");
  assert.ok(schemas.includes("ignoredFiles"), "ignored-files artifact persisted");
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
      const rendered = JSON.stringify(value, null, 2);
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

test("Build redevelops the current tail, freezes earlier steps, and cannot immediately repeat", async () => {
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

  const secondRoundJudge = executor
    .tasks("judge")
    .find((task) => task.agentId === "member-1" && task.bindings.currentStep === 2 &&
      executor.tasks("judge").filter((candidate) =>
        candidate.agentId === "member-1" && candidate.bindings.currentStep === 2,
      ).indexOf(task) === 1)!;
  const options = object(secondRoundJudge.bindings.verdictOptions, "verdict options");
  assert.equal(options.Build, undefined, "Build must be removed after a Build verdict");
  assert.ok(options.Pass);
  assert.ok(options.Interrupt);

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
  const roundTwoSchema = roundTwoComment!.task.outputSchema!.schema;
  const verdictSchema = (roundTwoSchema.properties as JsonObject)
    .verdict as JsonObject;
  assert.deepEqual(verdictSchema.enum, ["Pass", "Interrupt"]);
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
  const first = await app.run({
    runId: "manual-resume",
    submission: "Checkpoint test",
    params: { panelSize: 2 },
  });
  assert.equal(first.status, "suspended");
  if (first.status !== "suspended") throw new Error("unreachable");
  assert.equal(first.pendingGates[0]?.gateKey, "confirm-panel");
  assert.equal(executor.tasks("processor").length, 1);
  assert.equal(executor.tasks("decomposer").length, 1);

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
  assert.equal(executor.tasks("decomposer").length, 1);
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
