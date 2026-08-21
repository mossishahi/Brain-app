import assert from "node:assert/strict";
import test from "node:test";

import { artifactSchemas, mergeRedevelopmentParts } from "@brainstorm-agentic/content";
import type { AgentTask, JsonObject, JsonValue } from "@brainstorm-agentic/core";

import { OfflineBrainstormExecutor } from "../src/offline-executor.js";

/**
 * The offline provider exists to give byte-stable fixtures, so every artifact
 * it writes is validated here against the REAL schema the workflow node would
 * name. A stand-in that drifts from the schema is worse than no stand-in: the
 * failure surfaces mid-run, in the adapter's retry loop, on a task that can
 * never succeed.
 */
function taskFor(
  role: string,
  schemaName: string,
  bindings: JsonObject,
  agentId = "member-1",
): AgentTask {
  return {
    taskId: `offline-${role}-${schemaName}`,
    kind: role,
    agentId,
    input: { role, bindings },
    // Only the NAME is read; the offline executor never renders a request, so
    // the JSON schema body a live provider would constrain against is empty.
    outputSchema: { name: schemaName, schema: {} },
  };
}

async function artifactOf(task: AgentTask): Promise<JsonObject> {
  const result = await new OfflineBrainstormExecutor().execute(task);
  assert.equal(result.status, "ok", `offline executor refused ${task.taskId}`);
  assert.ok(result.status === "ok");
  return result.output as JsonObject;
}

/** The requested-output ask every offline run carries, echoed by the members. */
const brainBindings: JsonObject = {
  input: {
    requestedOutputs: [
      {
        title: "Submitter takeaway",
        ask: "State the single most decision-relevant takeaway of this treatment.",
      },
    ],
  },
};

test("the first pass writes four-part steps under brainIdeaParts and paragraphs under brainIdea", async () => {
  const parts = await artifactOf(taskFor("brain", "brainIdeaParts", brainBindings));
  artifactSchemas.brainIdeaParts.parse(parts);
  const cot = parts.cot as JsonValue[];
  assert.equal(cot.length, 3, "the default offline chain is three steps long");
  for (const step of cot) {
    // Strict schema, no optional part: all four keys, always, in chain order.
    assert.deepEqual(Object.keys(step as JsonObject), ["part1", "part2", "part3", "part4"]);
  }

  const legacy = await artifactOf(taskFor("brain", "brainIdea", brainBindings));
  artifactSchemas.brainIdea.parse(legacy);
  for (const step of legacy.cot as JsonValue[]) {
    assert.equal(typeof step, "string", "the legacy chain is unchanged");
  }
});

test("a part-aware comment carries a per-step flaw draft and no top-level step", async () => {
  const bindings: JsonObject = { currentStep: 3 };
  const comment = await artifactOf(taskFor("commentor", "commentParts", bindings));
  artifactSchemas.commentParts.parse(comment);
  assert.equal(comment.step, undefined, "the part-aware form is strict and has no scalar step");

  // The DRAFT, not a pre-pruned list: one entry per step the reviewer was
  // shown, every part key present. Emitting it unpruned is the point — the
  // runtime's prune is what produces the recorded list, so the fixture drives
  // both halves of it (an empty box inside a kept entry, and an entry whose
  // four boxes are all empty).
  const flaws = comment.flaws as JsonObject[];
  assert.deepEqual(
    flaws.map((entry) => entry.step),
    [1, 2, 3],
    "one entry per reviewed step, in order",
  );
  assert.deepEqual(flaws[0], { step: 1, part1: "", part2: "", part3: "", part4: "" });
  assert.deepEqual(flaws[1], { step: 2, part1: "", part2: "", part3: "", part4: "" });
  assert.deepEqual(Object.keys(flaws[2]!), ["step", "part1", "part2", "part3", "part4"]);
  assert.match(String(flaws[2]!.part2), /thin/, "the one filled box sits at the current step");
  assert.equal(flaws[2]!.part1, "");
  assert.equal(flaws[2]!.part4, "");

  // Every entry names a step the review has reached, which is what the
  // runtime's STEP_TARGET_OUT_OF_RANGE check reads off the raw parsed value.
  for (const entry of flaws) {
    assert.ok(typeof entry.step === "number" && entry.step >= 1 && entry.step <= 3);
  }

  const legacy = await artifactOf(taskFor("commentor", "comment", bindings));
  artifactSchemas.comment.parse(legacy);
  assert.equal(legacy.step, 3, "the legacy comment still says its step once, at the top");
  assert.equal(legacy.flaws, undefined);
});

test("the interdisciplinary seat writes the same two forms, with its own seam text", async () => {
  const bindings: JsonObject = { currentStep: 2 };
  const parts = await artifactOf(taskFor("interdisciplinary-commentor", "commentParts", bindings));
  artifactSchemas.commentParts.parse(parts);
  assert.match(String(parts.reason), /cross-field/);
  assert.match(String((parts.flaws as JsonObject[])[1]!.part3), /crossing/);

  const legacy = await artifactOf(taskFor("interdisciplinary-commentor", "comment", bindings));
  artifactSchemas.comment.parse(legacy);
  assert.equal(legacy.step, 2);
});

test("a part-aware decision keeps one assessment entry per commentor beside its own flaw draft", async () => {
  const bindings: JsonObject = {
    currentStep: 2,
    comments: { "member-2": { verdict: "Pass" }, "member-3": { verdict: "Pass" } },
  };
  const decision = await artifactOf(taskFor("judge", "judgeDecisionParts", bindings));
  artifactSchemas.judgeDecisionParts.parse(decision);
  assert.deepEqual(decision.assessment, [
    { commentorId: "member-2", basis: "authority" },
    { commentorId: "member-3", basis: "authority" },
  ]);
  // Pass confirmed nothing, so `issues` is empty (the schema forbids any other
  // answer) and the judge's own marks are an all-empty draft the prune reduces
  // to `flaws: []` — "was shown the parts, faulted none of them".
  assert.deepEqual(decision.issues, []);
  assert.deepEqual(decision.flaws, [
    { step: 1, part1: "", part2: "", part3: "", part4: "" },
    { step: 2, part1: "", part2: "", part3: "", part4: "" },
  ]);

  const legacy = await artifactOf(taskFor("judge", "judgeDecision", bindings));
  artifactSchemas.judgeDecision.parse(legacy);
  assert.equal(legacy.flaws, undefined, "the legacy decision is strict and has no flaws field");
  assert.deepEqual(legacy.assessment, decision.assessment);
});

test("a revision patch names only the rewritten step, in the shape its schema asks for", async () => {
  const bindings: JsonObject = { currentStep: 2, totalSteps: 3, chain: ["one.", "two.", "three."] };
  const parts = await artifactOf(taskFor("redeveloper", "redevelopmentPatchParts", bindings));
  artifactSchemas.redevelopmentPatchParts.parse(parts);
  assert.deepEqual(Object.keys((parts.steps as JsonObject[])[0]!), [
    "index",
    "part1",
    "part2",
    "part3",
    "part4",
  ]);
  assert.equal((parts.steps as JsonObject[])[0]!.index, 2);
  assert.equal(parts.output, undefined, "a patch carries no full envelope");

  const patch = await artifactOf(taskFor("redeveloper", "redevelopmentPatch", bindings));
  artifactSchemas.redevelopmentPatch.parse(patch);
  assert.deepEqual((patch.steps as JsonObject[])[0], {
    index: 2,
    text: "member-1 revised step 2 paragraph.",
  });

  // The full re-emission of the pre-patch bundles is untouched: whole chain,
  // whole envelope, current step rewritten and the rest copied verbatim.
  const full = await artifactOf(taskFor("redeveloper", "redevelopment", bindings));
  artifactSchemas.redevelopment.parse(full);
  assert.equal((full.steps as JsonValue[]).length, 3);
  assert.ok(full.output !== undefined);
});

test("the offline patch merges onto the offline first pass into a valid idea", async () => {
  // The patch is the only artifact validated LOOSELY on its own — a rule
  // relating two sections cannot be judged from a patch naming one of them —
  // so the shape that actually has to hold is the MERGED whole. A fixture
  // whose outputPatch named the wrong body key would pass every assertion
  // above and only fail at the merge, inside a live run.
  const idea = await artifactOf(taskFor("brain", "brainIdeaParts", brainBindings));
  const parsed = artifactSchemas.brainIdeaParts.parse(idea);
  const patch = artifactSchemas.redevelopmentPatchParts.parse(
    await artifactOf(
      taskFor("redeveloper", "redevelopmentPatchParts", {
        currentStep: 2,
        totalSteps: 3,
        chain: [],
      }),
    ),
  );
  const merged = mergeRedevelopmentParts(parsed, patch);
  artifactSchemas.brainIdeaParts.parse({
    output: merged.output,
    cot: merged.steps,
    ...(merged.novelty !== undefined ? { novelty: merged.novelty } : {}),
    ...(parsed.literature !== undefined ? { literature: parsed.literature } : {}),
  });
  assert.equal(merged.steps[0], parsed.cot[0], "an unnamed step rides through by reference");
  assert.notDeepEqual(merged.steps[1], parsed.cot[1], "the named step was replaced whole");
  assert.deepEqual(
    (merged.output.paper as { conclusion?: unknown }).conclusion,
    ["member-1 revised conclusion paragraph."],
    "the patched body section landed, and the rest of the paper stands",
  );
});

test("both shapes are byte-stable across runs", async () => {
  // The whole reason the offline provider exists: the same task must produce
  // the same bytes, so a fixture diff means a code change and nothing else.
  const cases: readonly (readonly [string, string, JsonObject])[] = [
    ["brain", "brainIdeaParts", brainBindings],
    ["brain", "brainIdea", brainBindings],
    ["commentor", "commentParts", { currentStep: 3 }],
    ["commentor", "comment", { currentStep: 3 }],
    ["judge", "judgeDecisionParts", { currentStep: 2, comments: { "member-2": {} } }],
    ["judge", "judgeDecision", { currentStep: 2, comments: { "member-2": {} } }],
    ["redeveloper", "redevelopmentPatchParts", { currentStep: 1, chain: [] }],
    ["redeveloper", "redevelopment", { currentStep: 1, chain: [] }],
  ];
  for (const [role, schemaName, bindings] of cases) {
    const first = await artifactOf(taskFor(role, schemaName, bindings));
    const second = await artifactOf(taskFor(role, schemaName, bindings));
    assert.equal(
      JSON.stringify(first),
      JSON.stringify(second),
      `${role} under ${schemaName} is not deterministic`,
    );
  }
});

test("an unknown schema name falls through to the legacy shape", async () => {
  // A bundle this worker has never heard of must not silently produce a
  // half-new artifact; the pre-parts shape is the one every old bundle names.
  const comment = await artifactOf(taskFor("commentor", "commentSomethingElse", { currentStep: 1 }));
  artifactSchemas.comment.parse(comment);
  assert.equal(comment.step, 1);
});
