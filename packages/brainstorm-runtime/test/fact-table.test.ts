/**
 * The fact table on the runtime side: the scope a task whose role declares
 * `fact-table` is stamped with (and no other task is), and the supreme
 * judge's task the compiled workflow builds for one submission.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FACT_VERDICT_CASES,
  FACT_VERDICT_INTEGRITY,
  FACT_VERDICT_KINDS,
  FACT_VERDICT_METHODS,
  FACT_VERDICT_RESOLUTIONS,
  factVerdictSchema,
  loadContent,
  skillMetaSchema,
  workflowSchema,
  type ContentBundle,
  type FactTableCatalog,
  type Skill,
} from "@brainstorm-agentic/content";
import {
  FACT_CASES,
  FACT_INTEGRITY,
  FACT_KINDS,
  FACT_METHODS,
  FACT_RESOLUTIONS,
  Scope,
  factScopeOf,
  systemPromptText,
  textContent,
  type AgentTaskSpec,
  type ContentBlock,
  type HostToolManifest,
  type JsonObject,
  type JsonValue,
} from "@brainstorm-agentic/core";

import {
  BRAINSTORM_STATE,
  BrainstormRuntimeError,
  StaticBrainstormRouteResolver,
  artifactSchemaToJsonSchema,
  compileContentWorkflow,
  type CompiledContentWorkflow,
  type FactVerificationTaskRequest,
} from "../src/index.js";

const CONTROL: FactTableCatalog = {
  version: "0.1.0",
  verifier: { skill: "supreme_judge", route: "reasoning", output: "factVerdict" },
  cases: {
    justified: "An entry of the table already covers the claim.",
    "justified-new": "Verified now; a new badge enters the table.",
    narrowed: "True only under narrower conditions; a badge for the narrowed claim.",
    conflict: "It contradicts an entry that stands.",
    refuted: "The evidence shows it false; recorded as refuted.",
    unverified: "It could not be checked with the verifier's tools or time.",
    "not-a-fact": "An opinion, a design choice, or connective reasoning that asserts no independently checkable claim.",
  },
  methods: {
    "re-executed": "The verifier ran the computation itself.",
    "source-quoted": "The verifier quotes the source that states the fact.",
    "record-match": "The verifier matched the value against the run's record.",
    "judgement-only": "The verifier worked the argument through itself.",
    none: "Nothing was checked.",
  },
  resolutions: {
    "incumbent-stands": "The entry holds and the submission is rejected.",
    "incumbent-revoked": "The entry is revoked and the new badge supersedes it.",
    "both-narrowed": "Both hold, each under its own conditions.",
    disputed: "Neither can be settled; both are disputed.",
  },
  limits: { submissionsPerTask: 6, relatedFacts: 8, lookupResults: 5, verificationMinutes: 30 },
};

const VERIFIER_VARS = ["input", "files", "request", "related", "caseCatalog", "methodCatalog", "resolutionCatalog"];
const VERIFIER_PAYLOAD = ["input", "files", "request", "related"];

function role(
  name: string,
  meta: {
    readonly vars: readonly string[];
    readonly payload: readonly string[];
    readonly capabilities: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly output: string;
  },
): Skill {
  return {
    meta: skillMetaSchema.parse({ name, kind: "role", description: `The ${name} fixture role.`, ...meta }),
    // Every non-payload var rendered, nothing else: the role is valid by construction.
    body: [
      `Do the ${name} work on the task data.`,
      ...meta.vars.filter((variable) => !meta.payload.includes(variable)).map((variable) => `{{${variable}}}`),
    ].join("\n\n"),
    sourcePath: `test/${name}.md`,
  };
}

/** The verifier: one probe it can run, one vault it cannot reach, the seven vars the runtime binds. */
function verifier(
  overrides: {
    readonly vars?: readonly string[];
    readonly payload?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
  } = {},
): Skill {
  return role("supreme_judge", {
    vars: overrides.vars ?? VERIFIER_VARS,
    payload: overrides.payload ?? VERIFIER_PAYLOAD,
    capabilities: overrides.capabilities ?? ["probe-access", "vault-access"],
    ...(overrides.requiredCapabilities !== undefined
      ? { requiredCapabilities: overrides.requiredCapabilities }
      : {}),
    output: "factVerdict",
  });
}

/** A self-contained bundle: three reviewing roles, the verifier, and the control unless switched off. */
function bundle(options: { readonly factTable?: boolean; readonly verifier?: Skill } = {}): ContentBundle {
  const review = { vars: ["chain", "currentStep"], payload: ["chain", "currentStep"], output: "bridgeReport" };
  return {
    workflows: {},
    routes: {
      version: "0.1.0",
      defaultRoute: "reasoning",
      routes: { reasoning: { description: "Careful multi-step reasoning.", traits: ["extended-reasoning"] } },
    },
    activities: { version: "0.1.0", handlers: {} },
    capabilities: {
      version: "0.1.0",
      capabilities: {
        "fact-table": {
          description: "Consult the run's fact table.",
          contract: "The runtime keeps one fact table per run.",
          operations: ["fact.lookup", "fact.status", "fact.submit"],
          whenUnavailable: "Cite no badges; state your own evidence.",
        },
        "probe-access": {
          description: "Run a probe.",
          contract: "The host runs the probe.",
          operations: ["probe.run"],
          whenUnavailable: "Reason without probes.",
        },
        "vault-access": {
          description: "Read the vault.",
          contract: "The host reads the vault.",
          operations: ["vault.read"],
          whenUnavailable: "The vault was unavailable; say so.",
        },
      },
    },
    catalogs: {
      inputTypes: { version: "0.1.0", types: {}, shapes: {}, guidance: {}, outlines: {}, shapeGuides: {} },
      verdicts: {
        version: "0.1.0",
        verdicts: {},
        sequencing: { noImmediateRepeat: [], advanceOn: "Pass", redevelopOn: ["Build"] },
      },
      departments: { version: "0.1.0", groups: {} },
    },
    skills: {
      checker: role("checker", { ...review, capabilities: ["fact-table", "probe-access"] }),
      plain: role("plain", { ...review, capabilities: ["probe-access"] }),
      supreme_judge: options.verifier ?? verifier(),
    },
    ...(options.factTable === false ? {} : { factTable: CONTROL }),
  };
}

const VERIFIER_BIND = Object.fromEntries(VERIFIER_VARS.map((name) => [name, name]));

/**
 * Review tasks with and without the capability, the same role outside any
 * seat, and the verifier role as an ordinary agent node (the yardstick the
 * fact-verification task is held against).
 */
const WORKFLOW = workflowSchema.parse({
  apiVersion: "brainstorm.workflow/v1",
  name: "facts",
  version: "0.28.0",
  description: "Fact-table fixture workflow.",
  root: {
    kind: "sequence",
    id: "root",
    steps: [
      {
        kind: "agent",
        id: "check",
        skill: "checker",
        route: "reasoning",
        bind: { chain: { ref: "ideas[member.id].cot", through: "stepIndex" }, currentStep: "stepIndex" },
        output: { key: "checked", schema: "bridgeReport" },
      },
      {
        kind: "agent",
        id: "plain",
        skill: "plain",
        route: "reasoning",
        bind: { chain: { ref: "ideas[member.id].cot", through: "stepIndex" }, currentStep: "stepIndex" },
        output: { key: "plainChecked", schema: "bridgeReport" },
      },
      {
        kind: "agent",
        id: "audit",
        skill: "checker",
        route: "reasoning",
        bind: { chain: "draft", currentStep: "draftStep" },
        output: { key: "audited", schema: "bridgeReport" },
      },
      {
        kind: "agent",
        id: "verify",
        skill: "supreme_judge",
        route: "reasoning",
        bind: VERIFIER_BIND,
        output: { key: "verdict", schema: "factVerdict" },
      },
      { kind: "terminal", id: "done" },
    ],
  },
});

const PROBE_TOOL: HostToolManifest = {
  toolId: "probe_run",
  displayName: "Probe",
  operations: ["probe.run"],
  risk: "low",
  defaultEnabled: true,
  definition: {
    name: "probe_run",
    description: "Run a probe.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
};

function compile(source: ContentBundle, vacant?: ReadonlyMap<string, string>): CompiledContentWorkflow {
  return compileContentWorkflow({
    bundle: source,
    workflow: WORKFLOW,
    routeResolver: new StaticBrainstormRouteResolver({
      reasoning: { modelId: "configured-reasoner", providerId: "fake", tools: ["route_tool"] },
    }),
    hostTools: [PROBE_TOOL],
    enabledHostToolIds: new Set([PROBE_TOOL.toolId]),
    ...(vacant !== undefined ? { vacantCapabilities: vacant } : {}),
  });
}

const REQUEST: FactVerificationTaskRequest = {
  taskId: "fact-verification:S:1",
  bindings: {
    input: { title: "Gaussian message passing on random graphs", question: "Does the iteration converge?" },
    files: [{ path: "attachments/1-repo/src/estimator.py", label: "code", note: "The estimator." }],
    request: {
      claim: "The attached estimator is unbiased for n = 1,200 at seed 7.",
      conditions: "n = 1,200; seed 7",
      evidence: "python check.py --n 1200 --seed 7 printed: bias = 0.0004",
      kind: "result",
      step: 2,
    },
    related: [
      {
        id: "F:1",
        status: "justified",
        claim: "The estimator's variance is below 0.01 for n = 1,200.",
        conditions: "n = 1,200",
        method: "re-executed",
        evidence: "variance = 0.0031",
      },
    ],
  },
};

const STATE: JsonObject = {
  ideas: {
    "member-2": {
      cot: [
        "The bound holds for n = 1,200 [F:1].",
        { part1: "The estimator is unbiased [F:2, F:3].", part2: "It rests on [F:1] again.", part3: "", part4: "" },
        "A step the reviewer has not reached cites [F:4].",
      ],
    },
    "member-3": { cot: ["A step that cites nothing.", "Another one."] },
  },
  draft: ["An audit draft that cites nothing."],
  draftStep: 1,
  ...REQUEST.bindings,
  caseCatalog: CONTROL.cases,
  methodCatalog: CONTROL.methods,
  resolutionCatalog: CONTROL.resolutions,
};

function scopeWith(vars: Readonly<Record<string, JsonValue>>): Scope {
  const scope = Scope.root({ [BRAINSTORM_STATE]: STATE });
  for (const [name, value] of Object.entries(vars)) scope.set(name, value);
  return scope;
}

async function nodeTask(compiled: CompiledContentWorkflow, nodeId: string, scope: Scope): Promise<AgentTaskSpec> {
  return compiled.functions.taskBuilder(`brainstorm.facts.${nodeId}.task`)(scope, undefined, {
    runId: "facts",
    nodePath: `root/${nodeId}`,
    signal: new AbortController().signal,
  });
}

/** A request with each message reduced to the text it carries: cache boundaries split bytes, never change them. */
function readText(request: unknown): JsonValue {
  const value = structuredClone(request) as { messages?: { role: string; content: ContentBlock[] }[] };
  return {
    ...(value as JsonObject),
    messages: (value.messages ?? []).map((message) => ({ role: message.role, text: textContent(message.content) })),
  };
}

test("a task whose role declares fact-table carries its fact scope, with the badges its chain cites", async () => {
  const compiled = compile(bundle());
  // A reviewer of member-2's chain at step 2: the chain binding stops at step 2.
  const review = await nodeTask(
    compiled,
    "check",
    scopeWith({ member: { id: "member-2" }, commentor: { id: "member-1" }, stepIndex: 2 }),
  );
  const expected = {
    role: "checker",
    agent: "member-1",
    seat: "member-2",
    step: 2,
    cited: [
      { step: 1, ids: ["F:1"] },
      { step: 2, ids: ["F:2", "F:3", "F:1"] },
    ],
  };
  assert.deepEqual(review.metadata?.factScope, expected);
  assert.equal(review.agentId, expected.agent, "the scope's agent is exactly the agent id the task gets");
  assert.deepEqual(factScopeOf(review.metadata), expected, "core reads the stamp back unchanged");
  assert.ok(review.allowedCapabilities?.includes("fact-table"));

  // The thinker's own seat, at a step whose chain cites nothing: no `cited`.
  const own = await nodeTask(compiled, "check", scopeWith({ member: { id: "member-3" }, stepIndex: 1 }));
  assert.deepEqual(own.metadata?.factScope, { role: "checker", agent: "member-3", seat: "member-3", step: 1 });
  assert.equal(own.agentId, "member-3");

  // Outside any seat and step: the role itself asks, and nothing else is stamped.
  const audit = await nodeTask(compiled, "audit", scopeWith({}));
  assert.deepEqual(audit.metadata?.factScope, { role: "checker", agent: "checker" });
  assert.equal(audit.agentId, "checker");
});

test("a task whose role does not declare fact-table carries no fact scope, and the control changes nothing about it", async () => {
  const scope = () => scopeWith({ member: { id: "member-2" }, commentor: { id: "member-1" }, stepIndex: 2 });
  const plain = await nodeTask(compile(bundle()), "plain", scope());
  assert.deepEqual(plain.metadata, {
    workflow: "facts",
    nodeId: "plain",
    schema: "bridgeReport",
    logicalRoute: "reasoning",
    providerId: "fake",
  });
  assert.equal(factScopeOf(plain.metadata), undefined);
  const withoutControl = await nodeTask(compile(bundle({ factTable: false })), "plain", scope());
  assert.equal(JSON.stringify(plain), JSON.stringify(withoutControl), "byte-identical with or without the fact table");
});

test("the supreme judge's task: its role, the factVerdict schema, the three catalogs bound and the plan's tools", async () => {
  const compiled = compile(bundle());
  assert.equal(typeof compiled.factVerificationTask, "function");
  const task = await compiled.factVerificationTask!(REQUEST);
  assert.equal(task.taskId, "fact-verification:S:1");
  assert.equal(task.kind, "brainstorm.supreme_judge");
  assert.equal(task.agentId, "supreme_judge");
  assert.equal(task.logicalRoute, "reasoning");
  const schema = artifactSchemaToJsonSchema(factVerdictSchema, "factVerdict");
  assert.deepEqual(task.outputSchema, { name: "factVerdict", schema });
  assert.deepEqual(task.modelRequest?.responseFormat, { type: "jsonSchema", name: "factVerdict", schema });
  assert.equal(task.modelRequest?.modelId, "configured-reasoner");

  const input = task.input as JsonObject;
  assert.equal(input.role, "supreme_judge");
  assert.deepEqual(input.bindings, {
    ...REQUEST.bindings,
    caseCatalog: CONTROL.cases,
    methodCatalog: CONTROL.methods,
    resolutionCatalog: CONTROL.resolutions,
  });
  // The definitions are instructions; the submission is task data.
  const system = systemPromptText(task.modelRequest?.system) ?? "";
  for (const text of [
    ...Object.values(CONTROL.cases),
    ...Object.values(CONTROL.methods),
    ...Object.values(CONTROL.resolutions),
  ]) {
    assert.ok(system.includes(text), `the instructions carry "${text}"`);
  }
  const claim = (REQUEST.bindings.request as { claim: string }).claim;
  assert.ok(!system.includes(claim), "the submission never enters the instructions");
  const turn = (task.modelRequest?.messages ?? []).map((message) => textContent(message.content)).join("");
  assert.ok(turn.includes(claim), "the submission rides the task turn");

  // The plan's tools: the probe's host tool, the legacy name of the probe
  // capability, the route's own tool — and nothing for the unreachable vault,
  // which the instructions report instead.
  assert.deepEqual(task.allowedCapabilities, ["probe-access", "vault-access"]);
  assert.deepEqual(task.tools, ["probe_run", "probe-access", "route_tool"]);
  assert.deepEqual(
    task.capabilityPlan?.capabilities.map((status) => [status.capabilityId, status.availability]),
    [
      ["probe-access", "available"],
      ["vault-access", "unwired"],
    ],
  );
  assert.ok(system.includes("The vault was unavailable; say so."));
  assert.deepEqual(task.metadata, {
    workflow: "facts",
    nodeId: "fact-verification",
    schema: "factVerdict",
    logicalRoute: "reasoning",
    providerId: "fake",
  });
  assert.equal(factScopeOf(task.metadata), undefined, "the verifier never reaches the table");
  assert.ok(!("requirements" in task), "no requirements were resolved");
});

test("workflow and fact-control tasks resolve by stable node identity and retain execution controls", async () => {
  const requested: string[] = [];
  const compiled = compileContentWorkflow({
    bundle: bundle(), workflow: WORKFLOW,
    routeResolver: { resolve(request) {
      requested.push(request.nodeId!);
      return {
        modelId: request.nodeId === "fact-verification" ? "verification-model" : "workflow-model",
        execution: { effort: "low", thinking: "disabled", supportedEffortLevels: ["low"] },
      };
    } },
    hostTools: [PROBE_TOOL], enabledHostToolIds: new Set([PROBE_TOOL.toolId]),
  });
  const node = await nodeTask(compiled, "verify", scopeWith({}));
  const control = await compiled.factVerificationTask!(REQUEST);
  assert.deepEqual(requested, ["verify", "fact-verification"]);
  assert.equal(node.modelRequest?.modelId, "workflow-model");
  assert.equal(control.modelRequest?.modelId, "verification-model");
  for (const task of [node, control]) {
    assert.deepEqual(task.modelRequest?.execution, { effort: "low", thinking: "disabled", supportedEffortLevels: ["low"] });
    assert.deepEqual((task.input as JsonObject).modelRequest, task.modelRequest);
  }
});

test("the supreme judge's task is the task an agent node running the verifier gets", async () => {
  const compiled = compile(bundle());
  const task = await compiled.factVerificationTask!(REQUEST);
  const node = await nodeTask(compiled, "verify", scopeWith({}));
  const { taskId, metadata, modelRequest, input, ...rest } = task;
  const { metadata: nodeMetadata, modelRequest: nodeRequest, input: nodeInput, ...nodeRest } = node;
  assert.equal(taskId, REQUEST.taskId);
  assert.deepEqual(rest, nodeRest);
  assert.deepEqual(readText(modelRequest), readText(nodeRequest));
  const { modelRequest: inputRequest, ...inputRest } = input as JsonObject;
  const { modelRequest: nodeInputRequest, ...nodeInputRest } = nodeInput as JsonObject;
  assert.deepEqual(inputRest, nodeInputRest);
  assert.deepEqual(readText(inputRequest), readText(nodeInputRequest));
  assert.deepEqual(metadata, { ...nodeMetadata, nodeId: "fact-verification" }, "only the identity differs");
});

test("the supreme judge's task keeps an agent node's required-capability guard", async () => {
  const guarded = compile(bundle({ verifier: verifier({ requiredCapabilities: ["vault-access"] }) }));
  await assert.rejects(
    guarded.factVerificationTask!(REQUEST),
    (error: unknown) =>
      error instanceof BrainstormRuntimeError &&
      error.code === "REQUIRED_CAPABILITY_UNAVAILABLE" &&
      error.message.includes('requires "vault-access"'),
  );
  // An absence the host vouches for is not a defect.
  const vouched = compile(
    bundle({ verifier: verifier({ requiredCapabilities: ["vault-access"] }) }),
    new Map([["vault-access", "This run has no vault."]]),
  );
  assert.equal((await vouched.factVerificationTask!(REQUEST)).kind, "brainstorm.supreme_judge");
});

test("a verifier that would reach the table, or whose vars disagree with the bindings, is refused", async () => {
  const recursive = compile(bundle({ verifier: verifier({ capabilities: ["probe-access", "fact-table"] }) }));
  await assert.rejects(recursive.factVerificationTask!(REQUEST), /never consults the table it serves/);
  const narrow = compile(
    bundle({
      verifier: verifier({
        vars: VERIFIER_VARS.filter((name) => name !== "related"),
        payload: VERIFIER_PAYLOAD.filter((name) => name !== "related"),
      }),
    }),
  );
  await assert.rejects(narrow.factVerificationTask!(REQUEST), /bindings disagree with role "supreme_judge"; unexpected: related/);
});

test("without the control the compiled workflow has no fact verification task", () => {
  const compiled = compile(bundle({ factTable: false }));
  assert.equal(compiled.factVerificationTask, undefined);
  assert.ok(!("factVerificationTask" in compiled));
});

test("mediated Supreme consultation receives only its scoped batch and cannot recurse into the table", async () => {
  const consultant = role("supreme_judge_consult", { vars: ["input", "files", "request", "entries"], payload: ["input", "files", "request", "entries"], capabilities: [], output: "factConsultation" });
  const base = bundle();
  const mediated: ContentBundle = { ...base, factTable: { ...CONTROL, accessMode: "supreme-mediated/v1", consultation: { skill: consultant.meta.name, route: "reasoning", output: "factConsultation" } }, skills: { ...base.skills, [consultant.meta.name]: consultant } };
  const compiled = compile(mediated);
  const request = { taskId: "supreme:batch-2", bindings: { input: "The submission", files: {}, request: { phase: "match", claim: "A semantically equivalent reformulation." }, entries: [{ id: "F:19", claim: "The supplied premise." }] } };
  const task = await compiled.factConsultationTask!(request);
  assert.equal(task.kind, "brainstorm.supreme_judge_consult");
  assert.equal(task.outputSchema?.name, "factConsultation");
  assert.deepEqual((task.input as JsonObject).bindings, request.bindings);
  assert.equal(factScopeOf(task.metadata), undefined);
  assert.ok(!task.allowedCapabilities?.includes("fact-table"));
  assert.equal(compile(base).factConsultationTask, undefined, "legacy bundles retain their old verifier-only API");
  const recursive = { ...mediated, skills: { ...mediated.skills, [consultant.meta.name]: role(consultant.meta.name, { ...consultant.meta, output: "factConsultation", capabilities: ["fact-table"] }) } };
  await assert.rejects(compile(recursive).factConsultationTask!(request), /never consults the table it serves/);
});

test("content's restated fact-table vocabularies equal core's", () => {
  assert.deepEqual([...FACT_VERDICT_CASES], [...FACT_CASES]);
  assert.deepEqual([...FACT_VERDICT_METHODS], [...FACT_METHODS]);
  assert.deepEqual([...FACT_VERDICT_RESOLUTIONS], [...FACT_RESOLUTIONS]);
  assert.deepEqual([...FACT_VERDICT_KINDS], [...FACT_KINDS]);
  assert.deepEqual([...FACT_VERDICT_INTEGRITY], [...FACT_INTEGRITY]);
});

const sourceContentDir = process.env.BRAIN_TEST_CONTENT_DIR;

test(
  "the shipped verifier compiles into the supreme judge's task",
  { skip: sourceContentDir === undefined ? "BRAIN_TEST_CONTENT_DIR names no content tree" : false },
  async () => {
    const shipped = loadContent(sourceContentDir!);
    const terminal = workflowSchema.parse({
      apiVersion: "brainstorm.workflow/v1",
      name: "facts",
      version: "0.28.0",
      description: "Fact-table fixture workflow.",
      root: { kind: "terminal", id: "done" },
    });
    const compiled = compileContentWorkflow({ bundle: shipped, workflow: terminal });
    if (shipped.factTable === undefined) {
      assert.equal(compiled.factVerificationTask, undefined);
      return;
    }
    const task = await compiled.factVerificationTask!(REQUEST);
    assert.equal(task.kind, `brainstorm.${shipped.factTable.verifier.skill}`);
    assert.equal(task.outputSchema?.name, "factVerdict");
    const system = systemPromptText(task.modelRequest?.system) ?? "";
    for (const text of [
      ...Object.values(shipped.factTable.cases),
      ...Object.values(shipped.factTable.methods),
      ...Object.values(shipped.factTable.resolutions),
    ]) {
      assert.ok(system.includes(JSON.stringify(text).slice(1, -1)), "every definition reaches the instructions");
    }
    assert.ok(!(task.allowedCapabilities ?? []).includes("fact-table"));
    assert.equal(factScopeOf(task.metadata), undefined);
  },
);
