import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadContent,
  MIN_SUPPORTED_WORKFLOW_VERSION,
  SHAPE_FIELDS,
  validateBundle,
  type ForEachNode,
  type RepeatUntilNode,
  type SequenceNode,
} from "../src/index.js";
import {
  findActivity,
  findAgent,
  findNode,
  freshBundle,
  publishedContentDirs,
} from "./helpers.js";

function belowMinSupported(version: string): boolean {
  const left = version.split(".").map(Number);
  const right = MIN_SUPPORTED_WORKFLOW_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

test("every supported published Brain Registry version loads and cross-validates with zero issues", () => {
  const published = publishedContentDirs();
  assert.ok(published.length > 0, "the registry index publishes at least one version");
  for (const { version, dir } of published.filter((entry) => !belowMinSupported(entry.version))) {
    const bundle = loadContent(dir);
    assert.deepEqual(validateBundle(bundle), [], `bundle ${version} has validation issues`);
    assert.ok(bundle.workflows["brainstorm"], `bundle ${version} ships the brainstorm workflow`);
    assert.equal(bundle.workflows["brainstorm"]!.version, version);
  }
});

test("published versions below the supported floor are retired, not half-loadable", () => {
  // The per-seat review vocabulary (reviews[<seat>].*) and the read-only
  // bundle.* content root replaced catalog.*/review.*/round.*. Older published
  // bundles are deliberately unloadable rather than partially working: a run
  // must never execute a document whose references this runtime cannot resolve.
  const retired = publishedContentDirs().filter((entry) => belowMinSupported(entry.version));
  for (const { version, dir } of retired) {
    assert.throws(() => loadContent(dir), `retired bundle ${version} must not load`);
  }
});

test("workflow phases appear in the canonical order", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  assert.equal(root.kind, "sequence");
  // The code-annotation pass ships from workflow 0.11.0, the woven
  // interdisciplinary seat from 0.12.0, and the split classification stage
  // (classifier + merge + confirmation gate) from 0.14.0; earlier published
  // bundles stay valid without them, so the expected spine is presence-aware.
  const hasCodeAnnotation = root.steps.some((step) => step.id === "partition-files-code");
  const hasWeave = root.steps.some((step) => step.id === "weave-panel");
  const hasClassify = root.steps.some((step) => step.id === "classify-input");
  assert.deepEqual(
    root.steps.map((s) => s.id),
    [
      "process-input",
      ...(hasClassify
        ? ["classify-input", "apply-classification", "confirm-classification"]
        : []),
      "partition-files-useful",
      "partition-files-ignored",
      ...(hasCodeAnnotation ? ["partition-files-code", "maybe-annotate-code"] : []),
      "build-pool",
      "match-taxonomy",
      "place-fields",
      "submit-decisions",
      "bridge-experts",
      "select-panel",
      ...(hasWeave ? ["weave-panel"] : []),
      "confirm-panel",
      "first-pass",
      "review-members",
      "bridge-audit",
      "synthesize-proposal",
      "done",
    ],
  );
  assert.equal(root.steps[root.steps.length - 1]!.kind, "terminal");
});

test("the classification stage decides the type and gates before any panel cost", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  if (!root.steps.some((step) => step.id === "classify-input")) {
    return; // pre-split published bundle: the processor still classifies inline
  }

  // The classifier reasons over the structured input and the attachment
  // relation map only — no capabilities, and the catalog pins its options.
  const classifier = findAgent(root, "classify-input");
  assert.equal(classifier.skill, "classifier");
  assert.deepEqual(classifier.bind?.["input"], { ref: "input", omit: ["files"] });
  assert.equal(classifier.bind?.["files"], "input.files");
  assert.equal(classifier.bind?.["typeOptions"], "bundle.inputTypes.types");
  assert.deepEqual(classifier.output, {
    key: "classification",
    schema: "taskClassification",
  });

  // The deterministic merge REPLACES the structured input, so every later
  // task reads one merged record.
  const merge = findActivity(root, "apply-classification");
  assert.equal(merge.handler, "classification.apply");
  assert.deepEqual(merge.bind, {
    input: "input",
    classification: "classification",
    maxFiles: "params.maxAttachmentFiles",
  });
  assert.deepEqual(merge.output, { key: "input", schema: "processorOutput" });

  // The confirmation gate is skippable (countdown auto-approval) and its
  // revise action edits the merged input under the classification rule.
  const gate = findNode(root, "confirm-classification");
  assert.equal(gate.kind, "humanGate");
  if (gate.kind !== "humanGate") return;
  assert.equal(gate.skippable, true);
  const revise = gate.gate.actions.find((action) => action.id === "revise");
  assert.ok(revise, "the gate offers a revise action");
  assert.equal(revise!.editRule, "classification");
  assert.equal(revise!.edits, "input");

  // The slimmed processor no longer receives the type catalog.
  const processor = findAgent(root, "process-input");
  assert.equal(processor.bind?.["typeOptions"], undefined);
});

test("the code-annotation pass is gated on code files and folds summaries into the shared map", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  if (!root.steps.some((step) => step.id === "partition-files-code")) {
    return; // pre-annotation published bundle
  }

  // Deterministic projection: the code-labeled useful files plus their count.
  const projection = findActivity(root, "partition-files-code");
  assert.equal(projection.handler, "attachments.code");
  assert.deepEqual(projection.bind, {
    files: "usefulFiles",
    maxFiles: "params.maxAttachmentFiles",
  });
  assert.deepEqual(projection.output, { key: "codeFiles", schema: "codeFiles" });

  // The pass runs only when the run actually carries code files.
  const gate = findNode(root, "maybe-annotate-code");
  assert.equal(gate.kind, "condition");
  if (gate.kind !== "condition") return;
  assert.deepEqual(gate.if, { ref: "codeFiles.count", notEquals: 0 });

  // The annotator reads the code projection only, never the raw file map.
  const annotator = findAgent(root, "annotate-code");
  assert.equal(annotator.skill, "code-annotator");
  assert.deepEqual(annotator.bind?.["input"], { ref: "input", omit: ["files"] });
  assert.equal(annotator.bind?.["files"], "codeFiles.files");
  assert.deepEqual(annotator.output, { key: "codeAnnotations", schema: "codeAnnotations" });

  // The deterministic merge REPLACES usefulFiles, so every later task binds
  // the annotated map without any downstream wiring change.
  const merge = findActivity(root, "merge-code-annotations");
  assert.equal(merge.handler, "attachments.annotate");
  assert.deepEqual(merge.bind, {
    files: "usefulFiles",
    annotations: "codeAnnotations",
    maxFiles: "params.maxAttachmentFiles",
  });
  assert.deepEqual(merge.output, { key: "usefulFiles", schema: "usefulFiles" });

  const skill = bundle.skills["code-annotator"]!;
  assert.equal(skill.meta.kind, "role");
  assert.equal(skill.meta.output, "codeAnnotations");
  assert.ok(skill.meta.capabilities.includes("attachment-access"));
  assert.ok(skill.meta.capabilities.includes("code-execution"));

  // Every role in the decompose-through-review chain can run light scripts.
  for (const name of [
    "processor",
    "pool-builder",
    "placer",
    "code-annotator",
    "brain",
    "commentor",
    ...(bundle.skills["interdisciplinary-commentor"]
      ? ["interdisciplinary-commentor"]
      : []),
    "judge",
    "redeveloper",
    "integrator",
    "chair",
  ]) {
    const role = bundle.skills[name]!;
    assert.ok(
      role.meta.capabilities.includes("code-execution"),
      `${name} carries the code-execution capability`,
    );
  }

  // But attachment-access is only for roles that actually read submitted
  // material: the ones that read a file's content, or a panel member
  // reasoning about the submission itself. pool-builder and placer never
  // bind a file's content (pool-builder gets the file MAP with its
  // codeSummary already folded in; placer's own bind omits files entirely
  // — see the placer bind assertions below) — granting them the capability
  // anyway was unused scope, not a needed one.
  for (const name of [
    "processor",
    "code-annotator",
    "brain",
    "commentor",
    ...(bundle.skills["interdisciplinary-commentor"]
      ? ["interdisciplinary-commentor"]
      : []),
    "judge",
    "redeveloper",
    "integrator",
    "chair",
  ]) {
    const role = bundle.skills[name]!;
    assert.ok(
      role.meta.capabilities.includes("attachment-access"),
      `${name} carries the attachment-access capability`,
    );
  }
  for (const name of ["pool-builder", "placer"]) {
    const role = bundle.skills[name]!;
    assert.ok(
      !role.meta.capabilities.includes("attachment-access"),
      `${name} does not read attachments directly — it works from the file map's summaries`,
    );
  }
});

test("the processor's file map is partitioned deterministically and NA files never reach later calls", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;

  const useful = findActivity(root, "partition-files-useful");
  assert.equal(useful.handler, "attachments.useful");
  assert.deepEqual(useful.output, { key: "usefulFiles", schema: "usefulFiles" });
  const ignored = findActivity(root, "partition-files-ignored");
  assert.equal(ignored.handler, "attachments.ignored");
  assert.deepEqual(ignored.output, { key: "ignoredFiles", schema: "ignoredFiles" });
  for (const node of [useful, ignored]) {
    assert.deepEqual(node.bind, {
      input: "input",
      maxFiles: "params.maxAttachmentFiles",
    });
  }

  // Every downstream agent that receives the input gets it without the raw
  // file map, plus the useful-file list only.
  for (const id of [
    "build-pool",
    "develop-idea",
    "comment-step",
    ...(root.steps.some((step) => step.id === "weave-panel")
      ? ["comment-step-bridge"]
      : []),
    "judge-step",
    "redevelop-idea",
    "synthesize-proposal",
  ]) {
    const agent = findAgent(root, id);
    assert.deepEqual(
      agent.bind?.["input"],
      { ref: "input", omit: ["files"] },
      `${id} must not see the unpartitioned file map`,
    );
    assert.equal(
      agent.bind?.["files"],
      "usefulFiles.files",
      `${id} receives the useful files only`,
    );
  }

  // The placer reads the shared taxonomy, not the submission's attachments:
  // it gets the projected input and the unmatched members only.
  const placer = findAgent(root, "place-fields");
  assert.deepEqual(placer.bind?.["input"], { ref: "input", omit: ["files"] });
  assert.equal(placer.bind?.["files"], undefined, "place-fields receives no file map");
});

test("the decomposer split: pool with provenance, deterministic matching, placer over the live taxonomy, queued suggestions, bridge, then panel.select", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  const order = [
    "build-pool",
    "match-taxonomy",
    "place-fields",
    "submit-decisions",
    "bridge-experts",
    "select-panel",
    // The interdisciplinary seat weave (0.12.0+) sits between selection and
    // the confirmation gate, so the seat is human-confirmable like any other.
    ...(root.steps.some((step) => step.id === "weave-panel") ? ["weave-panel"] : []),
    "confirm-panel",
  ].map((id) => root.steps.findIndex((step) => step.id === id));
  for (let i = 1; i < order.length; i += 1) {
    assert.equal(order[i], order[i - 1]! + 1, "the decompose stages run back to back");
  }

  // Part one of the split: the pool builder returns members with provenance.
  const poolBuilder = findAgent(root, "build-pool");
  assert.equal(poolBuilder.skill, "pool-builder");
  assert.deepEqual(poolBuilder.output, { key: "pool", schema: "pool" });
  assert.deepEqual(Object.keys(poolBuilder.bind ?? {}).sort(), ["files", "input"]);
  assert.equal(bundle.skills["pool-builder"]!.meta.output, "pool");
  assert.deepEqual(bundle.skills["pool-builder"]!.meta.vars.slice().sort(), ["files", "input"]);

  // Deterministic matching: one server round-trip per member, no model call.
  // Bundles with the split classification stage (0.14.0+) additionally bind
  // the classification, whose facets warm the semantic lane's regions.
  const matcher = findActivity(root, "match-taxonomy");
  assert.equal(matcher.handler, "taxonomy.match");
  const hasClassification = root.steps.some((step) => step.id === "classify-input");
  assert.deepEqual(
    matcher.bind,
    hasClassification
      ? {
          pool: "pool",
          classification: "classification",
          maxMembers: "params.maxPoolMembers",
        }
      : { pool: "pool", maxMembers: "params.maxPoolMembers" },
  );
  assert.deepEqual(matcher.output, { key: "poolMatches", schema: "poolMatches" });
  const matchHandler = bundle.activities.handlers["taxonomy.match"]!;
  assert.equal(matchHandler.deterministic, true);
  assert.equal(matchHandler.outputSchema, "poolMatches");

  // Part two of the split: the placer reads the LIVE shared taxonomy through
  // its capability and decides only the unmatched members.
  const placer = findAgent(root, "place-fields");
  assert.equal(placer.skill, "placer");
  assert.equal(placer.bind?.["unmatched"], "poolMatches.unmatched");
  assert.deepEqual(placer.output, { key: "placements", schema: "placements" });
  assert.equal(bundle.skills["placer"]!.meta.output, "placements");
  assert.ok(bundle.skills["placer"]!.meta.capabilities.includes("taxonomy-access"));

  // Every member's decision is queued on the registry, never applied locally.
  const suggest = findActivity(root, "submit-decisions");
  assert.equal(suggest.handler, "taxonomy.suggest");
  assert.deepEqual(suggest.output, { key: "suggestionReceipt", schema: "suggestionReceipt" });

  // The temporary bridge keeps the legacy experts contract alive downstream.
  const bridge = findActivity(root, "bridge-experts");
  assert.equal(bridge.handler, "experts.bridge");
  assert.deepEqual(bridge.output, { key: "experts", schema: "experts" });

  const selector = findActivity(root, "select-panel");
  assert.equal(selector.handler, "panel.select");
  assert.deepEqual(selector.bind, {
    experts: "experts",
    panelSize: "params.panelSize",
  });
  assert.deepEqual(selector.output, { key: "panel", schema: "panel" });

  const handler = bundle.activities.handlers["panel.select"]!;
  assert.equal(handler.deterministic, true);
  assert.deepEqual(handler.inputs, {
    experts: { kind: "artifact", schema: "experts" },
    panelSize: { kind: "positiveInteger" },
  });
  assert.equal(handler.outputSchema, "panel");
  assert.deepEqual(handler.bounds, {
    outputField: "members",
    maxItemsFromInput: "panelSize",
  });
  assert.deepEqual(Object.keys(handler).sort(), [
    "bounds",
    "description",
    "deterministic",
    "inputs",
    "outputSchema",
  ]);

  assert.equal(bundle.workflows["brainstorm"]!.params["panelSize"]!.default, 6);
  assert.equal(
    bundle.workflows["brainstorm"]!.params["moduleSize"],
    undefined,
    "leaf-product selection replaced round-robin, so no moduleSize knob exists",
  );
});

test("the interdisciplinary seat is woven deterministically and comments through its own skill", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  if (!root.steps.some((step) => step.id === "weave-panel")) {
    return; // pre-weave published bundle
  }

  // Deterministic weave: one appended full member whose expertise is the
  // space between the seated fields, bounded and confirmable at the gate.
  const weave = findActivity(root, "weave-panel");
  assert.equal(weave.handler, "panel.weave");
  assert.deepEqual(weave.bind, { panel: "panel", maxSeats: "params.maxSeats" });
  assert.deepEqual(weave.output, { key: "panel", schema: "panel" });
  const weaveIndex = root.steps.findIndex((step) => step.id === "weave-panel");
  const gateIndex = root.steps.findIndex((step) => step.id === "confirm-panel");
  assert.ok(weaveIndex >= 0 && weaveIndex < gateIndex, "the seat is woven before the human gate");

  const handler = bundle.activities.handlers["panel.weave"]!;
  assert.equal(handler.deterministic, true);
  assert.deepEqual(handler.inputs, {
    panel: { kind: "artifact", schema: "panel" },
    maxSeats: { kind: "positiveInteger" },
  });
  assert.equal(handler.outputSchema, "panel");
  assert.deepEqual(handler.bounds, {
    outputField: "members",
    maxItemsFromInput: "maxSeats",
  });

  // Commenting dispatches on the seat marker; both arms return the same
  // comment artifact into the same round slot, so the judge and the ledger
  // treat the interdisciplinary seat like any other commentor.
  const dispatch = findNode(root, "dispatch-comment");
  assert.equal(dispatch.kind, "condition");
  if (dispatch.kind !== "condition") return;
  assert.deepEqual(dispatch.if, { ref: "commentor.seat", equals: "interdisciplinary" });
  const bridge = findAgent(root, "comment-step-bridge");
  assert.equal(bridge.skill, "interdisciplinary-commentor");
  assert.equal(bridge.bind?.["roster"], "panel.members", "the seat receives the roster");
  const disciplinary = findAgent(root, "comment-step");
  assert.equal(disciplinary.skill, "commentor");
  assert.equal(disciplinary.bind?.["roster"], undefined, "disciplinary seats stay roster-blind");
  // Both comment artifacts are live history: bundles up to 0.23.0 file one
  // scalar step target ("comment"), 0.24.0+ file the four-part flaw marks
  // ("commentParts"). What matters here is that BOTH seats write the same
  // artifact into the same slot, whichever form the bundle ships.
  const commentSchemas = new Set(
    [bridge, disciplinary].map((node) => node.output.schema),
  );
  assert.equal(commentSchemas.size, 1, "both seats file the same comment artifact");
  const commentSchema = [...commentSchemas][0]!;
  assert.ok(
    commentSchema === "comment" || commentSchema === "commentParts",
    `the seats must file a comment artifact, got "${commentSchema}"`,
  );
  for (const node of [bridge, disciplinary]) {
    assert.deepEqual(node.output, {
      key: "reviews[member.id].current.comments[commentor.id]",
      schema: commentSchema,
    });
  }

  // The interdisciplinary skill mirrors the commentor contract: same verdict
  // artifact, roster delivered as task data, interface literature review.
  const skill = bundle.skills["interdisciplinary-commentor"]!;
  assert.equal(skill.meta.kind, "role");
  assert.equal(skill.meta.output, commentSchema);
  assert.ok(skill.meta.payload.includes("roster"));
  assert.ok(skill.meta.techniques.includes("literature-review"));
});

test("panel confirmation is an optional, shrink-only human gate", () => {
  const bundle = freshBundle();
  const gate = findNode(bundle.workflows["brainstorm"]!.root, "confirm-panel");
  assert.equal(gate.kind, "humanGate");
  if (gate.kind !== "humanGate") return;
  assert.equal(gate.skippable, true);
  const editing = gate.gate.actions.filter((a) => a.edits !== undefined);
  assert.ok(editing.length >= 1, "gate has an editing action");
  for (const action of editing) {
    assert.equal(action.editRule, "removeOnly", "panel edits may only remove seats");
  }
});

test("first pass fans out over the panel in parallel", () => {
  const bundle = freshBundle();
  const fanout = findNode(bundle.workflows["brainstorm"]!.root, "first-pass") as ForEachNode;
  assert.equal(fanout.kind, "forEach");
  assert.equal(fanout.mode, "parallel");
  assert.equal(fanout.items, "panel.members");
  const brain = findAgent(bundle.workflows["brainstorm"]!.root, "develop-idea");
  assert.equal(brain.skill, "brain");
  // Both chain forms are shippable: the one-paragraph step published through
  // 0.23.0, and the four-part step from 0.24.0. The runtime keeps both, so a
  // run pinned to an older bundle develops exactly as it always did.
  assert.ok(
    brain.output.schema === "brainIdea" || brain.output.schema === "brainIdeaParts",
    `the thinker must produce an idea artifact, got "${brain.output.schema}"`,
  );
});

test("review nests member -> step -> bounded round, with commentors excluding the thinker", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root;

  const members = findNode(root, "review-members") as ForEachNode;
  assert.equal(members.kind, "forEach");
  // Both published shapes are live history: bundles up to 0.16.0 review the
  // seats sequentially, 0.17.0+ reviews them in parallel. Whatever the mode,
  // the seat fan-out must stay bounded — parallel mode carries the panel's
  // structural ceiling.
  assert.ok(
    members.mode === "sequential" ||
      (members.mode === "parallel" && typeof members.maxConcurrency === "number"),
    `review-members must be a bounded seat fan-out, got mode=${members.mode}`,
  );

  const steps = findNode(root, "review-steps") as ForEachNode;
  assert.equal(steps.kind, "forEach");
  // The walk itself must NEVER parallelize: each step's review depends on
  // the chain state the previous steps left behind.
  assert.equal(steps.mode, "sequential");
  assert.equal(steps.items, "ideas[member.id].cot");

  const round = findNode(root, "review-round") as RepeatUntilNode;
  assert.equal(round.kind, "repeatUntil");
  assert.equal(round.onExhausted, "proceed", "hitting the cap force-passes the step");

  // The round budget is declared in exactly ONE place — the maxReviewRounds
  // param. The loop's static bound is that param's ceiling; the per-run budget
  // is enforced by the runtime-stamped finalRound flag, so no literal round
  // count appears in the loop, the guard, or the dashboard.
  assert.equal(round.maxIterations, "params.maxReviewRounds");
  const budget = bundle.workflows["brainstorm"]!.params["maxReviewRounds"];
  assert.ok(budget, "the workflow declares the review round budget as a param");
  assert.equal(typeof budget!.max, "number", "the param bounds the loop with a finite ceiling");

  // The loop owns exactly one seat, which is what keeps two members reviewed
  // in parallel from colliding on shared review state.
  assert.equal(round.seat, "member.id");
  assert.deepEqual(round.until, {
    any: [
      { ref: "reviews[member.id].current.decision.verdict", equals: "Pass" },
      { ref: "reviews[member.id].finalRound", equals: true },
    ],
  });

  const commentors = findNode(root, "gather-comments") as ForEachNode;
  assert.equal(commentors.mode, "parallel");
  assert.equal(commentors.exclude, "member", "the thinker never comments on their own step");
  assert.equal(
    typeof commentors.maxConcurrency,
    "number",
    "every parallel fan-out declares a concurrency cap — unbounded fan-out is rejected",
  );

  const commentor = findAgent(root, "comment-step");
  const chainBind = commentor.bind?.["chain"];
  assert.ok(
    typeof chainBind === "object" && chainBind !== null && "through" in chainBind,
    "commentors see the chain only through the current step",
  );

  const judge = findAgent(root, "judge-step");
  assert.ok(
    judge.output.schema === "judgeDecision" || judge.output.schema === "judgeDecisionParts",
    `the judge must produce a decision artifact, got "${judge.output.schema}"`,
  );

  const gate = findNode(root, "maybe-redevelop");
  assert.equal(gate.kind, "condition");
  if (gate.kind !== "condition") return;
  assert.equal(gate.then.kind, "agent", "redevelopment is conditional on the verdict");
  const redev = findAgent(root, "redevelop-idea");
  // Either delivery contract is shippable: the full re-emission bundles
  // published before the patch form, and the patch itself. The runtime keeps
  // both, so a run pinned to an older bundle revises exactly as it always did.
  assert.ok(
    redev.output.schema === "redevelopment" ||
      redev.output.schema === "redevelopmentPatch" ||
      redev.output.schema === "redevelopmentPatchParts",
    `the reviser must produce a revision artifact, got "${redev.output.schema}"`,
  );
  if (redev.output.schema.startsWith("redevelopmentPatch")) {
    assert.equal(
      redev.bind?.["previousOutput"],
      "ideas[member.id].output",
      "a patching reviser must receive the version it patches",
    );
  }

  // The guard reads the SAME runtime flag the loop exits on, so the budget can
  // never desync between them — and it carries no literal round count.
  assert.deepEqual(gate.if, {
    all: [
      { ref: "reviews[member.id].current.decision.verdict", notEquals: "Pass" },
      { ref: "reviews[member.id].finalRound", notEquals: true },
    ],
  });
  assert.ok(
    !JSON.stringify(gate.if).includes(String(budget!.default)),
    "the redevelop guard must not hardcode the round budget",
  );

  // The runtime stamps a live per-seat phase before the long-running review
  // nodes, so the dashboard can show what each seat is doing without a cursor.
  assert.equal(findAgent(root, "judge-step").reviewPhase, "judging");
  assert.equal(findAgent(root, "redevelop-idea").reviewPhase, "redeveloping");
});

test("the chair receives papers and novelty only — never the chain of thought", () => {
  const bundle = freshBundle();
  const chair = findAgent(bundle.workflows["brainstorm"]!.root, "synthesize-proposal");
  assert.equal(chair.skill, "chair");
  assert.equal(chair.output.schema, "finalProposal");
  const ideasBind = chair.bind?.["ideas"];
  assert.ok(typeof ideasBind === "object" && ideasBind !== null && "pick" in ideasBind);
  if (typeof ideasBind !== "object" || ideasBind === null) return;
  assert.deepEqual([...(ideasBind.pick ?? [])].sort(), ["novelty", "output"]);
  assert.ok(!(ideasBind.pick ?? []).includes("cot"));
});

test("every agent node uses a defined logical route, and no provider model ids appear", () => {
  const bundle = freshBundle();
  const routeNames = new Set(Object.keys(bundle.routes.routes));
  assert.ok(routeNames.has(bundle.routes.defaultRoute));

  const providerish = /(claude|gpt-|gemini|sonnet|opus|haiku|mistral|llama|deepseek|grok)/i;
  for (const name of routeNames) {
    assert.ok(!providerish.test(name), `route name "${name}" must be logical, not a model id`);
  }
  for (const [name, route] of Object.entries(bundle.routes.routes)) {
    for (const trait of route.traits) {
      assert.ok(!providerish.test(trait), `trait "${trait}" of route "${name}" must be provider-neutral`);
    }
  }

  const workflowJson = JSON.stringify(bundle.workflows);
  assert.ok(!providerish.test(workflowJson), "workflow must not embed provider model ids");
});

test("verdict catalog preserves the Pass/Build/Interrupt contract", () => {
  const bundle = freshBundle();
  const catalog = bundle.catalogs.verdicts;
  assert.deepEqual(Object.keys(catalog.verdicts).sort(), ["Build", "Interrupt", "Pass"]);
  const fixedFields = ["verdict", "step", "reason", "suggestion", "evidence"];
  assert.deepEqual(catalog.verdicts["Pass"]!.requires, fixedFields);
  assert.deepEqual(catalog.verdicts["Build"]!.requires, fixedFields);
  assert.deepEqual(catalog.verdicts["Interrupt"]!.requires, fixedFields);
  assert.match(catalog.verdicts["Interrupt"]!.description, /evidence/i);
  assert.match(catalog.verdicts["Interrupt"]!.description, /script/i);
  assert.match(catalog.verdicts["Interrupt"]!.description, /math/i);
  assert.match(catalog.verdicts["Interrupt"]!.description, /reference/i);
  assert.equal(catalog.sequencing.advanceOn, "Pass");
  assert.deepEqual(catalog.sequencing.redevelopOn.sort(), ["Build", "Interrupt"]);
  assert.deepEqual(catalog.sequencing.noImmediateRepeat, ["Build"]);
});

test("skills split into the expected roles and its techniques, with clean prompt bodies", () => {
  const bundle = freshBundle();
  const roles = Object.values(bundle.skills).filter((s) => s.meta.kind === "role");
  const techniques = Object.values(bundle.skills).filter((s) => s.meta.kind === "technique");
  assert.deepEqual(
    roles.map((s) => s.meta.name).sort(),
    [
      "brain",
      "chair",
      // The code annotator ships with the code-annotation pass (0.11.0+),
      // the interdisciplinary seat's commenting role with the woven panel
      // (0.12.0+), and the classifier with the split classification stage
      // (0.14.0+); earlier published bundles carry the original roles.
      ...(bundle.skills["classifier"] ? ["classifier"] : []),
      ...(bundle.skills["code-annotator"] ? ["code-annotator"] : []),
      "commentor",
      "integrator",
      ...(bundle.skills["interdisciplinary-commentor"]
        ? ["interdisciplinary-commentor"]
        : []),
      "judge",
      "placer",
      "pool-builder",
      "processor",
      "redeveloper",
    ],
  );
  assert.deepEqual(
    techniques.map((s) => s.meta.name).sort(),
    [
      "academic-profile-lookup",
      "deep-understanding",
      "field-match",
      "field-placement",
      "literature-review",
      "term-unification",
      // The house style ships as a technique from 0.24.0 (bought once per
      // seat in the cached segment); earlier published bundles carry six.
      ...(bundle.skills["writing-style"] ? ["writing-style"] : []),
    ],
  );
  for (const role of roles) {
    assert.ok(role.meta.output, `role ${role.meta.name} declares an output schema`);
  }
  for (const technique of techniques) {
    assert.equal(technique.meta.output, undefined);
  }
  // The literature review is parameterized by the seat's expertise, and the two
  // taxonomy NA-resolution prompts by their per-call task data; the other
  // techniques stay var-free and universal.
  assert.deepEqual(
    bundle.skills["literature-review"]!.meta.vars.sort(),
    ["department", "subfields", "umbrella"],
  );
  assert.deepEqual(bundle.skills["field-match"]!.meta.vars.slice().sort(), ["options", "query"]);
  assert.deepEqual(bundle.skills["field-placement"]!.meta.vars.slice().sort(), ["query", "taxonomy"]);
  assert.deepEqual(bundle.skills["deep-understanding"]!.meta.vars, []);
  assert.deepEqual(bundle.skills["academic-profile-lookup"]!.meta.vars, []);
  assert.deepEqual(bundle.skills["term-unification"]!.meta.vars, []);
  // Executable needs are declared as capabilities, never prose-only:
  assert.ok(bundle.skills["commentor"]!.meta.capabilities.includes("code-execution"));
  assert.ok(bundle.skills["literature-review"]!.meta.capabilities.includes("web-search"));
});

/**
 * catalog/input-types.json is the single hand-edited reference that defines
 * the submission types. The loader projects it and validateBundle enforces
 * outline-vs-shape consistency at load time; this test pins the projections
 * for the shipped file so a partial edit can't slip through.
 */
test("the merged input-type reference defines every projection for every type", () => {
  const bundle = freshBundle();
  const { types, shapes, guidance, outlines, shapeGuides } = bundle.catalogs.inputTypes;
  const names = Object.keys(types);
  assert.ok(names.length >= 2, "the shipped catalog defines a real set of types");
  assert.deepEqual(Object.keys(shapes).sort(), [...names].sort());
  assert.deepEqual(Object.keys(guidance).sort(), [...names].sort());
  assert.deepEqual(Object.keys(outlines).sort(), [...names].sort());
  assert.deepEqual(Object.keys(shapeGuides).sort(), [...names].sort());

  for (const [name, outline] of Object.entries(outlines)) {
    assert.deepEqual(
      Object.keys(outline).sort(),
      [...SHAPE_FIELDS[shapes[name]!]].sort(),
      `outline sections for "${name}" must match the fields of its shape "${shapes[name]}"`,
    );
  }

  // The last entry is the residual default the processor falls back to; the
  // shipped default must be the open-ended shape.
  assert.equal(shapes[names[names.length - 1]!], "paper");
});

test("a broken hand edit of the reference file fails load-time validation with a named issue", () => {
  const bundle = freshBundle();
  const inputTypes = bundle.catalogs.inputTypes;
  const [firstType] = Object.keys(inputTypes.types);
  const tampered = {
    ...bundle,
    catalogs: {
      ...bundle.catalogs,
      inputTypes: {
        ...inputTypes,
        outlines: {
          ...inputTypes.outlines,
          [firstType!]: { madeUpSection: "This section does not exist on the shape's schema at all." },
        },
      },
    },
  };
  const issues = validateBundle(tampered);
  assert.ok(
    issues.some((issue) => issue.code === "OUTLINE_SHAPE_MISMATCH" && issue.path.includes(firstType!)),
    `expected OUTLINE_SHAPE_MISMATCH for "${firstType}", got: ${JSON.stringify(issues)}`,
  );
});

test("the developing skills read outline, shape, and shape rules from the reference catalog", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root;
  for (const [nodeId, skillName] of [
    ["develop-idea", "brain"],
    ["redevelop-idea", "redeveloper"],
  ] as const) {
    const node = findAgent(root, nodeId);
    assert.equal(
      node.bind?.["outline"],
      "bundle.inputTypes.outlines[input.type]",
      `${nodeId} binds the outline for the submission's type`,
    );
    assert.equal(
      node.bind?.["shape"],
      "bundle.inputTypes.shapes[input.type]",
      `${nodeId} binds the shape for the submission's type`,
    );
    assert.equal(
      node.bind?.["shapeGuide"],
      "bundle.inputTypes.shapeGuides[input.type]",
      `${nodeId} binds the mechanical rules of the submission's shape`,
    );
    const skill = bundle.skills[skillName]!;
    assert.ok(skill.meta.vars.includes("outline"));
    assert.ok(
      !skill.meta.payload.includes("outline"),
      "the outline is stable framing for the run, so it is rendered rather than sent as payload",
    );
    assert.match(skill.body, /\{\{outline\}\}/);
    assert.match(skill.body, /\{\{shape\}\}/);
    assert.match(skill.body, /\{\{shapeGuide\}\}/);
    assert.doesNotMatch(
      skill.body,
      /## If `\{\{shape\}\}` is/,
      "per-shape rule blocks live in the catalog, not the skill body",
    );
  }
});

test("no type-aware skill hardcodes a type name, so a JSON rename needs no prompt edits", () => {
  const bundle = freshBundle();
  // Types are data: the skills that work the submission may only speak of it
  // through {{type}}, {{shape}}, {{outline}}, and {{typeGuidance}} (plus the
  // processor's rendered {{typeOptions}}). A literal type name in one of these
  // bodies would silently rot the prompt the moment the catalog is edited.
  for (const name of [
    "processor",
    "brain",
    "redeveloper",
    "commentor",
    ...(bundle.skills["interdisciplinary-commentor"]
      ? ["interdisciplinary-commentor"]
      : []),
    "judge",
    "chair",
    "integrator",
  ]) {
    const skill = bundle.skills[name]!;
    for (const typeName of Object.keys(bundle.catalogs.inputTypes.types)) {
      assert.ok(
        !skill.body.toLowerCase().includes(typeName.toLowerCase()),
        `skill "${name}" hardcodes the type name "${typeName}"`,
      );
    }
    assert.doesNotMatch(
      skill.body,
      /requested act|epistemic act/i,
      `${name} must not describe the submission as a requested act`,
    );
  }
  for (const inputType of Object.keys(bundle.catalogs.inputTypes.types)) {
    assert.doesNotMatch(
      inputType,
      /^(develop|resolve|verify|critique|interpret|survey|explain|assess)/,
      `input type "${inputType}" must name the submission, not the action`,
    );
  }
});
