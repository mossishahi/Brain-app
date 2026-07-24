import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadContent,
  validateBundle,
  type ForEachNode,
  type RepeatUntilNode,
  type SequenceNode,
} from "../src/index.js";
import {
  registryContentDir,
  findActivity,
  findAgent,
  findNode,
  freshBundle,
} from "./helpers.js";

test("Brain Registry content loads and cross-validates with zero issues", () => {
  const bundle = loadContent(registryContentDir());
  assert.deepEqual(validateBundle(bundle), []);
  assert.ok(bundle.workflows["brainstorm"], "brainstorm workflow present");
  assert.equal(bundle.workflows["brainstorm"]!.version, "0.1.0");
});

test("workflow phases appear in the canonical order", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  assert.equal(root.kind, "sequence");
  assert.deepEqual(
    root.steps.map((s) => s.id),
    [
      "process-input",
      "partition-files-useful",
      "partition-files-ignored",
      "decompose-experts",
      "select-panel",
      "confirm-panel",
      "first-pass",
      "review-members",
      "synthesize-proposal",
      "done",
    ],
  );
  assert.equal(root.steps[root.steps.length - 1]!.kind, "terminal");
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
    "decompose-experts",
    "develop-idea",
    "comment-step",
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
});

test("decomposer returns experts only, then panel.select seats the panel deterministically", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  const decomposerIndex = root.steps.findIndex((step) => step.id === "decompose-experts");
  const selectorIndex = root.steps.findIndex((step) => step.id === "select-panel");
  const gateIndex = root.steps.findIndex((step) => step.id === "confirm-panel");
  assert.equal(selectorIndex, decomposerIndex + 1, "panel selection immediately follows decomposition");
  assert.equal(gateIndex, selectorIndex + 1, "the human gate immediately follows deterministic selection");

  const decomposer = findAgent(root, "decompose-experts");
  assert.equal(decomposer.skill, "decomposer");
  assert.deepEqual(decomposer.output, { key: "experts", schema: "experts" });
  assert.deepEqual(Object.keys(decomposer.bind ?? {}).sort(), ["departments", "files", "input"]);
  assert.equal(bundle.skills["decomposer"]!.meta.output, "experts");
  assert.deepEqual(bundle.skills["decomposer"]!.meta.vars.sort(), ["departments", "files", "input"]);

  const selector = findActivity(root, "select-panel");
  assert.equal(selector.handler, "panel.select");
  assert.deepEqual(selector.bind, {
    experts: "experts",
    panelSize: "params.panelSize",
    moduleSize: "params.moduleSize",
  });
  assert.deepEqual(selector.output, { key: "panel", schema: "panel" });

  const handler = bundle.activities.handlers["panel.select"]!;
  assert.equal(handler.deterministic, true);
  assert.deepEqual(handler.inputs, {
    experts: { kind: "artifact", schema: "experts" },
    panelSize: { kind: "positiveInteger" },
    moduleSize: { kind: "positiveInteger" },
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
  assert.equal(bundle.workflows["brainstorm"]!.params["moduleSize"]!.default, 2);
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
  assert.equal(brain.output.schema, "brainIdea");
});

test("review nests member -> step -> bounded round, with commentors excluding the thinker", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root;

  const members = findNode(root, "review-members") as ForEachNode;
  assert.equal(members.kind, "forEach");
  assert.equal(members.mode, "sequential");

  const steps = findNode(root, "review-steps") as ForEachNode;
  assert.equal(steps.kind, "forEach");
  assert.equal(steps.mode, "sequential");
  assert.equal(steps.items, "ideas[member.id].cot");

  const round = findNode(root, "review-round") as RepeatUntilNode;
  assert.equal(round.kind, "repeatUntil");
  assert.equal(round.maxIterations, 4, "1 initial review + at most 3 redevelopments");
  assert.equal(round.onExhausted, "proceed", "hitting the cap force-passes the step");
  assert.deepEqual(round.until, { ref: "round.decision.verdict", equals: "Pass" });

  const commentors = findNode(root, "gather-comments") as ForEachNode;
  assert.equal(commentors.mode, "parallel");
  assert.equal(commentors.exclude, "member", "the thinker never comments on their own step");

  const commentor = findAgent(root, "comment-step");
  const chainBind = commentor.bind?.["chain"];
  assert.ok(
    typeof chainBind === "object" && chainBind !== null && "through" in chainBind,
    "commentors see the chain only through the current step",
  );

  const judge = findAgent(root, "judge-step");
  assert.equal(judge.output.schema, "judgeDecision");

  const gate = findNode(root, "maybe-redevelop");
  assert.equal(gate.kind, "condition");
  if (gate.kind !== "condition") return;
  assert.equal(gate.then.kind, "agent", "redevelopment is conditional on the verdict");
  const redev = findAgent(root, "redevelop-idea");
  assert.equal(redev.output.schema, "redevelopment");

  // The redevelopment budget in the condition matches the loop bound: on the
  // final permitted round a failing step is force-passed instead of redeveloped.
  const guard = JSON.stringify(gate.if);
  assert.ok(guard.includes(`"notEquals":${round.maxIterations}`) || guard.includes(`"notEquals": ${round.maxIterations}`));
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
  const fixedFields = ["verdict", "reason", "suggestion", "evidence"];
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

test("skills split into 7 roles and 3 techniques, with clean prompt bodies", () => {
  const bundle = freshBundle();
  const roles = Object.values(bundle.skills).filter((s) => s.meta.kind === "role");
  const techniques = Object.values(bundle.skills).filter((s) => s.meta.kind === "technique");
  assert.deepEqual(
    roles.map((s) => s.meta.name).sort(),
    ["brain", "chair", "commentor", "decomposer", "judge", "processor", "redeveloper"],
  );
  assert.deepEqual(
    techniques.map((s) => s.meta.name).sort(),
    ["academic-profile-lookup", "deep-understanding", "literature-review"],
  );
  for (const role of roles) {
    assert.ok(role.meta.output, `role ${role.meta.name} declares an output schema`);
  }
  for (const technique of techniques) {
    assert.equal(technique.meta.output, undefined);
    assert.deepEqual(technique.meta.vars, []);
  }
  // Executable needs are declared as capabilities, never prose-only:
  assert.ok(bundle.skills["commentor"]!.meta.capabilities.includes("code-execution"));
  assert.ok(bundle.skills["literature-review"]!.meta.capabilities.includes("web-search"));
});
