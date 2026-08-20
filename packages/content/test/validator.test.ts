import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_REPEAT_BOUND,
  activitiesSchema,
  skillMetaSchema,
  validateBundle,
  workflowSchema,
  type RepeatUntilNode,
  type SequenceNode,
} from "../src/index.js";
import { expectIssue, findActivity, findAgent, findNode, freshBundle } from "./helpers.js";

test("baseline: the untouched bundle validates cleanly", () => {
  assert.deepEqual(validateBundle(freshBundle()), []);
});

test("rejects a bind that reads a field the produced artifact does not define", () => {
  // What a bundle written for a NEWER app looks like from here. Checking only
  // reference roots let it load: `poolMatches` exists, so `placerOutline` on
  // an app that never produced it passed validation, and the run died on the
  // bind long after the panel had been paid for — with the half-finished
  // artifact journaled, so every resume died the same way.
  const bundle = freshBundle();
  const placer = findAgent(bundle.workflows["brainstorm"]!.root, "place-fields");
  placer.bind = { ...placer.bind, outline: "poolMatches.fieldFromAFutureApp" };
  const issues = expectIssue(bundle, "UNKNOWN_ARTIFACT_FIELD");
  const named = issues.find((issue) => issue.code === "UNKNOWN_ARTIFACT_FIELD")!;
  assert.match(named.message, /fieldFromAFutureApp/);
  assert.match(named.message, /update the app/);
});

test("a per-item output key is field-checked one subscript deep, where the artifact starts", () => {
  // `ideas[member.id]` writes one brainIdea PER MEMBER, so the field is what
  // follows the subscript. Reading the key as its bare root would look one
  // level too shallow and check a member id against brainIdea's fields.
  const bundle = freshBundle();
  const judge = findAgent(bundle.workflows["brainstorm"]!.root, "judge-step");
  judge.bind = { ...judge.bind, good: { ref: "ideas[member.id].cot", through: "stepIndex" } };
  assert.deepEqual(
    validateBundle(bundle).filter((issue) => issue.code === "UNKNOWN_ARTIFACT_FIELD"),
    [],
    "a real brainIdea field one subscript deep is accepted",
  );

  const broken = freshBundle();
  const judge2 = findAgent(broken.workflows["brainstorm"]!.root, "judge-step");
  judge2.bind = { ...judge2.bind, bad: "ideas[member.id].notAField" };
  expectIssue(broken, "UNKNOWN_ARTIFACT_FIELD");
});

test("a loop variable shadowing a produced root is never field-checked", () => {
  // At runtime a loop variable wins over a produced root of the same name, so
  // a reference rooted in one reads the ITEM, not the artifact — checking it
  // against the artifact's schema would reject a legitimate bundle.
  const bundle = freshBundle();
  const firstPass = findNode(bundle.workflows["brainstorm"]!.root, "first-pass");
  assert.equal(firstPass.kind, "forEach");
  if (firstPass.kind !== "forEach") return;
  // Rename the loop variable to collide with a produced artifact root, then
  // read a field only the ITEM has.
  firstPass.itemVar = "panel";
  const develop = findAgent(firstPass.body, "develop-idea");
  develop.bind = { ...develop.bind, department: "panel.department" };
  assert.deepEqual(
    validateBundle(bundle).filter((issue) => issue.code === "UNKNOWN_ARTIFACT_FIELD"),
    [],
    "the shadowing item's own fields are not measured against the artifact schema",
  );
});

test("field checking stays silent wherever it cannot be certain", () => {
  // The rule must never reject a legitimate bundle. It speaks only for a
  // plain first segment of a root the workflow itself produces, so loop
  // variables, catalog projections, deeper paths into shapes that vary, and
  // seat state all pass untouched.
  const bundle = freshBundle();
  const placer = findAgent(bundle.workflows["brainstorm"]!.root, "place-fields");
  placer.bind = {
    ...placer.bind,
    deeper: "poolMatches.unmatched.anythingAtAll",
    catalog: "bundle.inputTypes.types",
    session: "session.submission",
  };
  assert.deepEqual(
    validateBundle(bundle).filter((issue) => issue.code === "UNKNOWN_ARTIFACT_FIELD"),
    [],
  );
});

test("rejects a workflow that references a missing skill", () => {
  const bundle = freshBundle();
  delete bundle.skills["judge"];
  expectIssue(bundle, "MISSING_SKILL");
});

test("rejects an agent node pointing at a technique instead of a role", () => {
  const bundle = freshBundle();
  const judge = findAgent(bundle.workflows["brainstorm"]!.root, "judge-step");
  judge.skill = "deep-understanding";
  expectIssue(bundle, "WRONG_SKILL_KIND");
});

test("rejects a node that uses an undefined model route", () => {
  const bundle = freshBundle();
  findAgent(bundle.workflows["brainstorm"]!.root, "process-input").route = "turbo";
  expectIssue(bundle, "MISSING_ROUTE");
});

test("rejects a routes document whose defaultRoute does not exist", () => {
  const bundle = freshBundle();
  bundle.routes.defaultRoute = "nonexistent";
  expectIssue(bundle, "MISSING_DEFAULT_ROUTE");
});

test("rejects an activity whose logical handler is not registered", () => {
  const bundle = freshBundle();
  findActivity(bundle.workflows["brainstorm"]!.root, "select-panel").handler = "panel.missing";
  expectIssue(bundle, "MISSING_ACTIVITY_HANDLER");
});

test("rejects an activity missing or adding registered handler inputs", () => {
  const bundle = freshBundle();
  const selector = findActivity(bundle.workflows["brainstorm"]!.root, "select-panel");
  delete selector.bind["panelSize"];
  selector.bind["policy"] = "params.panelSize";
  expectIssue(bundle, "ACTIVITY_INPUT_MISMATCH");
});

test("rejects an activity output that disagrees with its registered handler", () => {
  const bundle = freshBundle();
  findActivity(bundle.workflows["brainstorm"]!.root, "select-panel").output.schema = "experts";
  expectIssue(bundle, "ACTIVITY_OUTPUT_MISMATCH");
});

test("rejects a non-deterministic activity registration structurally and semantically", () => {
  const bundle = freshBundle();
  const handler = bundle.activities.handlers["panel.select"]!;
  (handler as { deterministic: boolean }).deterministic = false;
  assert.equal(activitiesSchema.safeParse(bundle.activities).success, false);
  expectIssue(bundle, "NONDETERMINISTIC_ACTIVITY");
});

test("rejects an activity registration without a finite output bound", () => {
  const bundle = freshBundle();
  const handler = bundle.activities.handlers["panel.select"]!;
  delete (handler as Partial<typeof handler>).bounds;
  assert.equal(activitiesSchema.safeParse(bundle.activities).success, false);
  expectIssue(bundle, "UNBOUNDED_ACTIVITY");
});

test("rejects activity bindings with the wrong artifact or parameter type", () => {
  const bundle = freshBundle();
  const selector = findActivity(bundle.workflows["brainstorm"]!.root, "select-panel");
  selector.bind["experts"] = "input";
  selector.bind["panelSize"] = "input.cotSteps";
  const issues = validateBundle(bundle);
  assert.equal(
    issues.filter((issue) => issue.code === "ACTIVITY_INPUT_TYPE_MISMATCH").length,
    1,
    "an artifact input bound to the wrong schema is a type mismatch",
  );
  assert.equal(
    issues.filter((issue) => issue.code === "UNBOUNDED_ACTIVITY").length,
    1,
    "the output-bound input mis-bound is an unbounded activity, not a plain type mismatch",
  );
});

test("rejects an activity whose output bound param has no finite maximum", () => {
  const bundle = freshBundle();
  delete bundle.workflows["brainstorm"]!.params["panelSize"]!.max;
  expectIssue(bundle, "UNBOUNDED_ACTIVITY");
});

test("activity schemas reject embedded implementation code and arbitrary expressions", () => {
  const bundle = freshBundle();
  const activitiesWithCode = structuredClone(bundle.activities);
  Object.assign(activitiesWithCode.handlers["panel.select"]!, { implementation: "return select(tree)" });
  assert.equal(activitiesSchema.safeParse(activitiesWithCode).success, false);

  const workflowWithExpression = structuredClone(bundle.workflows["brainstorm"]!);
  Object.assign(findActivity(workflowWithExpression.root, "select-panel"), {
    expression: "experts.flatMap(select)",
  });
  assert.equal(workflowSchema.safeParse(workflowWithExpression).success, false);
});

test("rejects a node whose output schema is unknown", () => {
  const bundle = freshBundle();
  const chair = findAgent(bundle.workflows["brainstorm"]!.root, "synthesize-proposal");
  chair.output.schema = "ghostSchema";
  expectIssue(bundle, "MISSING_SCHEMA");
});

test("rejects a node whose schema disagrees with the skill's declared output", () => {
  const bundle = freshBundle();
  const chair = findAgent(bundle.workflows["brainstorm"]!.root, "synthesize-proposal");
  chair.output.schema = "brainIdea"; // valid schema, wrong for the chair skill
  expectIssue(bundle, "SKILL_OUTPUT_MISMATCH");
});

test("rejects a node that leaves a skill variable unbound", () => {
  const bundle = freshBundle();
  const commentor = findAgent(bundle.workflows["brainstorm"]!.root, "comment-step");
  delete commentor.bind!["verdictOptions"];
  expectIssue(bundle, "UNBOUND_VAR");
});

test("rejects a bind key the skill never declared", () => {
  const bundle = freshBundle();
  const judge = findAgent(bundle.workflows["brainstorm"]!.root, "judge-step");
  judge.bind!["mystery"] = "input";
  expectIssue(bundle, "UNKNOWN_BINDING");
});

test("rejects a role skill whose technique is missing", () => {
  const bundle = freshBundle();
  delete bundle.skills["literature-review"];
  expectIssue(bundle, "MISSING_TECHNIQUE");
});

test("rejects a shape-rules dictionary that leaves a mapped shape without a rule", () => {
  const bundle = freshBundle();
  const [firstType] = Object.keys(bundle.catalogs.inputTypes.shapeGuides);
  delete bundle.catalogs.inputTypes.shapeGuides[firstType!];
  expectIssue(bundle, "INPUT_TYPES_MIXED_FORMAT");
});

test("rejects template syntax inside a shape rule, which is injected after rendering", () => {
  const bundle = freshBundle();
  const [firstType] = Object.keys(bundle.catalogs.inputTypes.shapeGuides);
  bundle.catalogs.inputTypes.shapeGuides[firstType!] += "\nUse exactly {{cotSteps}} steps.";
  expectIssue(bundle, "FORBIDDEN_PROMPT_CONTENT");
});

test("rejects a technique var the including role does not cover as a non-payload var", () => {
  const bundle = freshBundle();
  const technique = bundle.skills["deep-understanding"]!;
  technique.meta.vars.push("umbrella");
  technique.body += "\nRead the material as {{umbrella}} would.";
  // deep-understanding is included by roles that do not declare `umbrella`
  // (e.g. the processor), so coverage must fail there.
  expectIssue(bundle, "TECHNIQUE_VAR_UNCOVERED");
});

test("a technique cannot require a capability, because nothing would enforce it", () => {
  // The trap: the guard reads the ROLE's requiredCapabilities, and a technique
  // is folded into a role's instructions without its metadata being unioned in.
  // Written on a technique, a load-bearing declaration would be accepted,
  // ignored, and believed — no protection and no error.
  const parsed = skillMetaSchema.safeParse({
    name: "deep-understanding",
    kind: "technique",
    description: "read the material closely",
    vars: [],
    capabilities: ["attachment-access"],
    requiredCapabilities: ["attachment-access"],
  });
  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues.map((issue) => issue.message).join(" ") ?? "",
    /technique skills cannot require capabilities/,
  );
});

test("a role may require a capability it declares", () => {
  const parsed = skillMetaSchema.safeParse({
    name: "commentor",
    kind: "role",
    description: "comment on one step",
    vars: [],
    output: "comment",
    capabilities: ["attachment-access"],
    requiredCapabilities: ["attachment-access"],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("rejects a skill that requires a capability missing from the catalog", () => {
  const bundle = freshBundle();
  delete bundle.capabilities.capabilities["code-execution"];
  expectIssue(bundle, "MISSING_CAPABILITY");
});

test("rejects a skill body that uses an undeclared template variable", () => {
  const bundle = freshBundle();
  bundle.skills["chair"]!.body += "\nAlso consider {{secretExtra}}.";
  expectIssue(bundle, "UNDECLARED_VAR");
});

test("rejects a skill that declares a variable its body never uses", () => {
  const bundle = freshBundle();
  bundle.skills["chair"]!.meta.vars.push("unusedThing");
  expectIssue(bundle, "UNUSED_VAR");
});

test("a payload var is delivered as task data, so declaring it is not an unused var", () => {
  const bundle = freshBundle();
  const chair = bundle.skills["chair"]!;
  assert.ok(chair.meta.payload.includes("ideas"), "chair delivers ideas as task data");
  assert.ok(!chair.body.includes("{{ideas}}"), "payload vars stay out of the instructions");
  assert.deepEqual(validateBundle(bundle), []);
});

test("rejects a payload var rendered back into the instruction body", () => {
  const bundle = freshBundle();
  bundle.skills["chair"]!.body += "\nThe members' outputs are {{ideas}}.";
  expectIssue(bundle, "PAYLOAD_VAR_IN_BODY");
});

test("rejects a payload var that is not a declared skill var", () => {
  const meta = { ...freshBundle().skills["chair"]!.meta };
  const result = skillMetaSchema.safeParse({ ...meta, payload: [...meta.payload, "notAVar"] });
  assert.equal(result.success, false);
});

test("rejects unbounded loops: repeatUntil without maxIterations fails schema and validator", () => {
  const bundle = freshBundle();
  const round = findNode(bundle.workflows["brainstorm"]!.root, "review-round") as RepeatUntilNode;
  delete (round as Partial<RepeatUntilNode>).maxIterations;

  // Structural: the workflow schema itself refuses the document.
  const reparsed = workflowSchema.safeParse(bundle.workflows["brainstorm"]);
  assert.equal(reparsed.success, false);

  // Cross-validator: the mutated in-memory bundle is rejected too.
  expectIssue(bundle, "UNBOUNDED_LOOP");
});

test("rejects loop bounds above the ceiling as effectively unbounded", () => {
  const bundle = freshBundle();
  const round = findNode(bundle.workflows["brainstorm"]!.root, "review-round") as RepeatUntilNode;
  round.maxIterations = MAX_REPEAT_BOUND + 1;
  expectIssue(bundle, "LOOP_BOUND_TOO_HIGH");
});

test("rejects duplicate node ids", () => {
  const bundle = freshBundle();
  findNode(bundle.workflows["brainstorm"]!.root, "build-pool").id = "process-input";
  expectIssue(bundle, "DUPLICATE_NODE_ID");
});

test("rejects a workflow with no terminal node", () => {
  const bundle = freshBundle();
  const root = bundle.workflows["brainstorm"]!.root as SequenceNode;
  root.steps = root.steps.filter((s) => s.kind !== "terminal");
  expectIssue(bundle, "NO_TERMINAL");
});

test("rejects references to data no prior step defines", () => {
  const bundle = freshBundle();
  const chair = findAgent(bundle.workflows["brainstorm"]!.root, "synthesize-proposal");
  chair.bind!["roster"] = "committee.members";
  expectIssue(bundle, "UNKNOWN_REF");
});

test("rejects references to undeclared params and unknown catalogs", () => {
  const bundle = freshBundle();
  const selector = findActivity(bundle.workflows["brainstorm"]!.root, "select-panel");
  selector.bind["panelSize"] = "params.committeeSize";
  const processor = findAgent(bundle.workflows["brainstorm"]!.root, "process-input");
  processor.bind!["typeOptions"] = "bundle.faculties";
  const issues = validateBundle(bundle);
  assert.ok(issues.some((i) => i.code === "UNKNOWN_PARAM"));
  assert.ok(issues.some((i) => i.code === "UNKNOWN_CATALOG"));
});

test("rejects review builtins used outside a repeatUntil loop", () => {
  const bundle = freshBundle();
  const processor = findAgent(bundle.workflows["brainstorm"]!.root, "process-input");
  processor.bind!["typeOptions"] = "reviews[member.id].allowedVerdicts";
  expectIssue(bundle, "REVIEW_REF_OUTSIDE_LOOP");
});

test("rejects verdict sequencing rules that name unknown verdicts", () => {
  const bundle = freshBundle();
  bundle.catalogs.verdicts.sequencing.advanceOn = "Approve";
  expectIssue(bundle, "UNKNOWN_VERDICT");
});

describe("prompt hygiene", () => {
  const cases: Array<[label: string, contamination: string]> = [
    ["MCP mentions", "Report your result over MCP when finished."],
    ["brainstorm_submit calls", "Then call brainstorm_submit with the artifacts."],
    ["subagent spawning", "For each member, spawn one subagent per prompt file."],
    ["sub-task language", "Delegate this to a sub-task and collect its result."],
    ["legacy path templates", "Write the JSON to {{OUTPUT_PATH}} when done."],
    ["literal file paths", "Read the chain at brain/brain_3/raw_cot.json under /tmp/session/state before commenting."],
    ["write-to-disk instructions", "Finally, write the proposal to a markdown file in the session directory."],
  ];
  for (const [label, contamination] of cases) {
    test(`rejects ${label}`, () => {
      const bundle = freshBundle();
      bundle.skills["brain"]!.body += `\n${contamination}`;
      expectIssue(bundle, "FORBIDDEN_PROMPT_CONTENT");
    });
  }

  test("shipped skills contain none of the forbidden content", () => {
    assert.deepEqual(
      validateBundle(freshBundle()).filter((i) => i.code === "FORBIDDEN_PROMPT_CONTENT"),
      [],
    );
  });
});
