import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadContent,
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

test("every published Brain Registry version loads and cross-validates with zero issues", () => {
  const published = publishedContentDirs();
  assert.ok(published.length > 0, "the registry index publishes at least one version");
  for (const { version, dir } of published) {
    const bundle = loadContent(dir);
    assert.deepEqual(validateBundle(bundle), [], `bundle ${version} has validation issues`);
    assert.ok(bundle.workflows["brainstorm"], `bundle ${version} ships the brainstorm workflow`);
    assert.equal(bundle.workflows["brainstorm"]!.version, version);
  }
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
      "bridge-audit",
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

test("skills split into 8 roles and 4 techniques, with clean prompt bodies", () => {
  const bundle = freshBundle();
  const roles = Object.values(bundle.skills).filter((s) => s.meta.kind === "role");
  const techniques = Object.values(bundle.skills).filter((s) => s.meta.kind === "technique");
  assert.deepEqual(
    roles.map((s) => s.meta.name).sort(),
    ["brain", "chair", "commentor", "decomposer", "integrator", "judge", "processor", "redeveloper"],
  );
  assert.deepEqual(
    techniques.map((s) => s.meta.name).sort(),
    ["academic-profile-lookup", "deep-understanding", "literature-review", "term-unification"],
  );
  for (const role of roles) {
    assert.ok(role.meta.output, `role ${role.meta.name} declares an output schema`);
  }
  for (const technique of techniques) {
    assert.equal(technique.meta.output, undefined);
  }
  // The literature review is parameterized by the seat's expertise; the other
  // techniques stay var-free and universal.
  assert.deepEqual(
    bundle.skills["literature-review"]!.meta.vars.sort(),
    ["department", "subfields", "umbrella"],
  );
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
      "catalog.inputTypes.outlines[input.type]",
      `${nodeId} binds the outline for the submission's type`,
    );
    assert.equal(
      node.bind?.["shape"],
      "catalog.inputTypes.shapes[input.type]",
      `${nodeId} binds the shape for the submission's type`,
    );
    assert.equal(
      node.bind?.["shapeGuide"],
      "catalog.inputTypes.shapeGuides[input.type]",
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
  for (const name of ["processor", "brain", "redeveloper", "commentor", "judge", "chair", "integrator"]) {
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
