/**
 * The fact table on the content side: the optional catalog/fact-table.json
 * control (its schema, its loading by every bundle loader, and the rules that
 * tie it to its verifier role and to the skills declaring the fact-table
 * capability) and the factVerdict artifact the verifier rules in.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentValidationError,
  artifactSchemas,
  directoryContentSource,
  factTableCatalogSchema,
  factVerdictSchema,
  loadControlContent,
  memoryContentSource,
  readContentBundle,
  skillMetaSchema,
  validateBundle,
  type ContentBundle,
  type FactTableCatalog,
  type Skill,
} from "../src/index.js";
import { expectIssue, freshBundle, registryContentDir } from "./helpers.js";

/** A control in the exact shape of catalog/fact-table.json. */
function control(): FactTableCatalog {
  return {
    version: "0.1.0",
    verifier: { skill: "fact_verifier", route: "reasoning", output: "factVerdict" },
    cases: {
      justified: "An entry of the table already covers the claim.",
      "justified-new": "Verified now; a new badge enters the table.",
      narrowed: "True only under narrower conditions; a badge for the narrowed claim.",
      conflict: "It contradicts an entry that stands.",
      refuted: "The evidence shows it false; recorded as refuted.",
      unverified: "It could not be checked with the verifier's tools or time.",
      "not-a-fact": "No independently asserted substantive fact: a nonfactual opinion, preference, or ordinary connective reasoning. Checkable mathematical results and familiar background are not categorically excluded.",
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
}

const VERIFIER_VARS = ["input", "files", "request", "related", "caseCatalog", "methodCatalog", "resolutionCatalog"];
const VERIFIER_PAYLOAD = ["input", "files", "request", "related"];

/** The test's verifier role: it renders every non-payload var, so only the rule under test can fail. */
function verifierSkill(
  overrides: {
    readonly vars?: readonly string[];
    readonly payload?: readonly string[];
    readonly techniques?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly output?: string;
  } = {},
): Skill {
  const vars = overrides.vars ?? VERIFIER_VARS;
  const payload = overrides.payload ?? VERIFIER_PAYLOAD;
  return {
    meta: skillMetaSchema.parse({
      name: "fact_verifier",
      kind: "role",
      description: "Rules on one claim submitted to the fact table.",
      vars,
      payload,
      techniques: overrides.techniques ?? [],
      capabilities: overrides.capabilities ?? [],
      output: overrides.output ?? "factVerdict",
    }),
    body: [
      "Rule on the submitted claim with your own checks.",
      ...vars.filter((name) => !payload.includes(name)).map((name) => `{{${name}}}`),
    ].join("\n\n"),
    sourcePath: "test/fact_verifier.md",
  };
}

/**
 * The registry bundle with a fact table: the fact-table capability in the
 * catalog (the bundle's own definition when it already ships one), the
 * test's verifier, the control naming it, and the commentor declaring the
 * capability.
 */
function factBundle(): ContentBundle {
  const bundle = freshBundle();
  bundle.capabilities.capabilities["fact-table"] ??= {
    description: "Consult the run's fact table before relying on a fact.",
    contract: "The runtime keeps one fact table per run and rules on every submission.",
    operations: ["fact.lookup", "fact.status", "fact.submit"],
    whenUnavailable: "State each fact you rely on together with your own evidence.",
  };
  bundle.skills["fact_verifier"] = verifierSkill();
  const commentor = bundle.skills["commentor"]!;
  if (!commentor.meta.capabilities.includes("fact-table")) commentor.meta.capabilities.push("fact-table");
  return { ...bundle, factTable: control() };
}

/** Every file of the registry bundle, held in memory so a test can add, change or drop one. */
function bundleFiles(): Map<string, string> {
  const source = directoryContentSource(registryContentDir());
  return new Map(source.list("", "").map((path) => [path, source.read(path)!]));
}

const FACT_TABLE = "catalog/fact-table.json";

test("the control's schema: the exact shape of catalog/fact-table.json, strict at every level", () => {
  const base = control();
  assert.deepEqual(factTableCatalogSchema.parse(base), base);
  const fails = (value: unknown) => !factTableCatalogSchema.safeParse(value).success;
  assert.ok(fails({ ...base, extra: true }), "no key beyond the documented ones");
  assert.ok(fails({ ...base, version: "1.0" }), "the version is semver");
  assert.ok(fails({ ...base, verifier: { ...base.verifier, output: "comment" } }), "the verifier rules in factVerdict");
  assert.ok(fails({ ...base, verifier: { ...base.verifier, skill: "Supreme Judge" } }), "the verifier skill is an identifier");
  assert.ok(fails({ ...base, verifier: { ...base.verifier, route: "" } }), "the verifier route is an identifier");
  assert.ok(fails({ ...base, verifier: { ...base.verifier, model: "any" } }), "the verifier is strict");
  const consultation = { skill: "fact_consultant", route: "reasoning", output: "factConsultation" };
  assert.equal(factTableCatalogSchema.safeParse({ ...base, accessMode: "supreme-mediated/v1", consultation }).success, true);
  assert.ok(fails({ ...base, accessMode: "supreme-mediated/v1" }), "mediated access requires its Supreme consultation role");
  assert.ok(fails({ ...base, consultation }), "consultation cannot silently change a legacy table's access mode");
  assert.ok(fails({ ...base, accessMode: "supreme-mediated/v1", consultation: { ...consultation, output: "factVerdict" } }), "consultations and verification have distinct output contracts");
  const { refuted: _refuted, ...withoutRefuted } = base.cases;
  assert.ok(fails({ ...base, cases: withoutRefuted }), "every case is defined");
  assert.ok(fails({ ...base, cases: { ...base.cases, pending: "Long checks." } }), "no case beyond the seven");
  assert.ok(fails({ ...base, cases: { ...base.cases, refuted: "" } }), "a definition is non-empty prose");
  const { none: _none, ...withoutNone } = base.methods;
  assert.ok(fails({ ...base, methods: withoutNone }), "every method is defined");
  assert.ok(fails({ ...base, methods: { ...base.methods, guessed: "No check." } }), "no method beyond the five");
  const { disputed: _disputed, ...withoutDisputed } = base.resolutions;
  assert.ok(fails({ ...base, resolutions: withoutDisputed }), "every resolution is defined");
  assert.ok(fails({ ...base, resolutions: { ...base.resolutions, ignored: "No." } }), "no resolution beyond the four");
  const bounds = [
    ["submissionsPerTask", 1, 50],
    ["relatedFacts", 1, 30],
    ["lookupResults", 1, 10],
    ["verificationMinutes", 1, 120],
  ] as const;
  for (const [field, low, high] of bounds) {
    assert.ok(!fails({ ...base, limits: { ...base.limits, [field]: low } }), `${field} may be ${low}`);
    assert.ok(!fails({ ...base, limits: { ...base.limits, [field]: high } }), `${field} may be ${high}`);
    assert.ok(fails({ ...base, limits: { ...base.limits, [field]: low - 1 } }), `${field} is at least ${low}`);
    assert.ok(fails({ ...base, limits: { ...base.limits, [field]: high + 1 } }), `${field} is at most ${high}`);
    assert.ok(fails({ ...base, limits: { ...base.limits, [field]: low + 0.5 } }), `${field} is an integer`);
  }
  const { verificationMinutes: _minutes, ...withoutMinutes } = base.limits;
  assert.ok(fails({ ...base, limits: withoutMinutes }), "every limit is given");
  assert.ok(fails({ ...base, limits: { ...base.limits, extra: 1 } }), "the limits are strict");
});

test("every bundle loader reads catalog/fact-table.json when the bundle carries it, and only then", () => {
  const files = bundleFiles();
  const workflowPath = [...files.keys()].find((path) => path.endsWith(".workflow.json"))!;
  assert.ok(workflowPath, "the registry bundle ships a workflow");
  files.delete(FACT_TABLE);
  const without = readContentBundle(memoryContentSource("without", files));
  assert.equal(without.factTable, undefined);
  assert.ok(!("factTable" in without), "a bundle that predates the control loads unchanged");
  const roles = new Set(
    Object.values(without.skills)
      .filter((skill) => skill.meta.kind === "role")
      .map((skill) => skill.meta.name),
  );
  assert.ok(!("factTable" in loadControlContent(memoryContentSource("without", files), workflowPath, roles)));

  files.set(FACT_TABLE, JSON.stringify(control()));
  assert.deepEqual(readContentBundle(memoryContentSource("with", files)).factTable, control());
  // The control-plane loader of a pinned run loads it too; the verifier's
  // role file, like every role's, is only listed by the manifest so far.
  const pinned = loadControlContent(
    memoryContentSource("with", files),
    workflowPath,
    new Set([...roles, "fact_verifier"]),
  );
  assert.deepEqual(pinned.factTable, control());
  assert.throws(
    () => loadControlContent(memoryContentSource("with", files), workflowPath, roles),
    (error: unknown) =>
      error instanceof ContentValidationError &&
      error.issues.some((issue) => issue.code === "MISSING_SKILL" && issue.path === "catalog fact-table > verifier"),
    "a verifier the manifest does not list is an issue",
  );

  files.set(FACT_TABLE, "{not json");
  assert.throws(() => readContentBundle(memoryContentSource("broken", files)), /not valid JSON/);
  assert.throws(() => loadControlContent(memoryContentSource("broken", files), workflowPath, roles), /not valid JSON/);
  files.set(FACT_TABLE, JSON.stringify({ ...control(), limits: { ...control().limits, verificationMinutes: 0 } }));
  assert.throws(
    () => readContentBundle(memoryContentSource("invalid", files)),
    (error: unknown) =>
      error instanceof ContentValidationError &&
      error.issues.some(
        (issue) => issue.code === "SCHEMA_INVALID" && issue.path === "invalid/catalog/fact-table.json > limits.verificationMinutes",
      ),
  );
});

test("validation: a bundle whose control names a conforming verifier validates cleanly", () => {
  assert.deepEqual(validateBundle(factBundle()), []);
});

test("validation: the verifier must be a role the bundle has, or one a pinned manifest lists", () => {
  const bundle = factBundle();
  delete bundle.skills["fact_verifier"];
  const issues = expectIssue(bundle, "MISSING_SKILL");
  assert.ok(issues.some((issue) => issue.code === "MISSING_SKILL" && issue.path === "catalog fact-table > verifier"));
  // A pinned run loads its roles lazily: the verifier is checked when its task is built.
  assert.deepEqual(validateBundle(bundle, { availableRoleNames: new Set(["fact_verifier"]) }), []);

  const technique = factBundle();
  technique.skills["fact_verifier"] = {
    meta: skillMetaSchema.parse({ name: "fact_verifier", kind: "technique", description: "Checks a claim." }),
    body: "Check the claim with your own tools.",
    sourcePath: "test/fact_verifier.md",
  };
  expectIssue(technique, "WRONG_SKILL_KIND");
});

test("validation: the verifier rules in factVerdict", () => {
  const bundle = factBundle();
  bundle.skills["fact_verifier"] = verifierSkill({ output: "bridgeReport" });
  const issues = expectIssue(bundle, "SKILL_OUTPUT_MISMATCH");
  assert.ok(issues.some((issue) => issue.code === "SKILL_OUTPUT_MISMATCH" && issue.path === "catalog fact-table > verifier"));
});

test("validation: the verifier never declares the fact table, itself or through a technique", () => {
  const itself = factBundle();
  itself.skills["fact_verifier"] = verifierSkill({ capabilities: ["fact-table"] });
  expectIssue(itself, "FACT_VERIFIER_RECURSION");

  const throughTechnique = factBundle();
  throughTechnique.skills["deep-understanding"]!.meta.capabilities.push("fact-table");
  throughTechnique.skills["fact_verifier"] = verifierSkill({ techniques: ["deep-understanding"] });
  expectIssue(throughTechnique, "FACT_VERIFIER_RECURSION");
});

test("validation: Supreme consultation binds scoped entries and cannot recursively consult itself", () => {
  const base = factBundle();
  const vars = ["input", "files", "request", "entries"];
  const role = verifierSkill({ vars, payload: vars, output: "factConsultation" });
  base.skills["fact_consultant"] = { ...role, meta: { ...role.meta, name: "fact_consultant" } };
  const bundle: ContentBundle = {
    ...base,
    factTable: { ...control(), accessMode: "supreme-mediated/v1", consultation: { skill: "fact_consultant", route: "reasoning", output: "factConsultation" } },
  };
  assert.deepEqual(validateBundle(bundle), []);
  bundle.skills["fact_consultant"]!.meta.capabilities.push("fact-table");
  assert.ok(expectIssue(bundle, "FACT_VERIFIER_RECURSION").some((issue) => issue.path === "catalog fact-table > consultation"));
  bundle.skills["fact_consultant"]!.meta.capabilities = [];
  bundle.skills["fact_consultant"]!.meta.vars = vars.filter((name) => name !== "entries");
  bundle.skills["fact_consultant"]!.meta.payload = vars.filter((name) => name !== "entries");
  assert.ok(expectIssue(bundle, "UNKNOWN_BINDING").some((issue) => issue.path === "catalog fact-table > consultation" && issue.message.includes('"entries"')));
});

test("validation: the verifier's vars are exactly the ones the runtime binds, and its route exists", () => {
  const fewer = factBundle();
  fewer.skills["fact_verifier"] = verifierSkill({
    vars: VERIFIER_VARS.filter((name) => name !== "related"),
    payload: VERIFIER_PAYLOAD.filter((name) => name !== "related"),
  });
  const missing = expectIssue(fewer, "UNKNOWN_BINDING");
  assert.ok(missing.some((issue) => issue.code === "UNKNOWN_BINDING" && issue.message.includes('"related"')));

  const more = factBundle();
  more.skills["fact_verifier"] = verifierSkill({ vars: [...VERIFIER_VARS, "board"] });
  const extra = expectIssue(more, "UNBOUND_VAR");
  assert.ok(extra.some((issue) => issue.code === "UNBOUND_VAR" && issue.message.includes('"board"')));

  const unrouted = factBundle();
  const issues = expectIssue(
    { ...unrouted, factTable: { ...control(), verifier: { ...control().verifier, route: "nowhere" } } },
    "MISSING_ROUTE",
  );
  assert.ok(issues.some((issue) => issue.code === "MISSING_ROUTE" && issue.path === "catalog fact-table > verifier"));
});

test("validation: a skill declaring fact-table in a bundle without the control is an issue", () => {
  const { factTable: _control, ...withoutControl } = factBundle();
  const issues = expectIssue(withoutControl, "MISSING_CONTROL");
  assert.ok(issues.some((issue) => issue.code === "MISSING_CONTROL" && issue.path === "skill commentor"));
});

// ---------------------------------------------------------------------------
// fact updates (spec/fact-updates.md 11.1, section 10 test 37)
// ---------------------------------------------------------------------------

/** The vars the runtime binds into each reconsideration role (11.1). */
const RECONSIDERATION_VARS = {
  chain: ["input", "files", "department", "umbrella", "subfields", "board", "chain", "previousOutput", "factUpdates", "totalSteps", "type", "shape", "shapeGuide"],
  gameReport: ["input", "files", "department", "umbrella", "subfields", "shape", "chain", "currentStep", "type", "report", "factUpdates"],
  comment: ["input", "files", "department", "umbrella", "subfields", "shape", "chain", "currentStep", "type", "comment", "factUpdates", "verdictOptions", "verdictCatalog"],
} as const;
const RECONSIDERATION_OUTPUTS = {
  chain: "chainReconsiderationParts",
  gameReport: "gameReportReconsideration",
  comment: "commentReconsideration",
} as const;
const RECONSIDERATION_SKILLS = { chain: "reconsider_chain", gameReport: "reconsider_game_report", comment: "reconsider_comment" } as const;

/** A reconsideration role whose payload is every var, so only the rule under test can fail. */
function reconsiderationSkill(name: string, vars: readonly string[], output: string): Skill {
  return {
    meta: skillMetaSchema.parse({
      name,
      kind: "role",
      description: "Reconsiders work that cites a badge the fact table deleted.",
      vars,
      payload: vars,
      techniques: [],
      capabilities: ["fact-table"],
      output,
    }),
    body: "Reconsider the work against the notices.",
    sourcePath: `test/${name}.md`,
  };
}

/** The test bundle with fact updates: the three reconsideration roles and the control naming them. */
function updatesBundle(): ContentBundle {
  const bundle = factBundle();
  for (const key of ["chain", "gameReport", "comment"] as const) {
    bundle.skills[RECONSIDERATION_SKILLS[key]] = reconsiderationSkill(RECONSIDERATION_SKILLS[key], RECONSIDERATION_VARS[key], RECONSIDERATION_OUTPUTS[key]);
  }
  return {
    ...bundle,
    factTable: {
      ...control(),
      updates: "delete-or-replace/v1",
      reconsideration: {
        chain: { skill: RECONSIDERATION_SKILLS.chain, route: "reasoning", output: "chainReconsiderationParts" },
        gameReport: { skill: RECONSIDERATION_SKILLS.gameReport, route: "reasoning", output: "gameReportReconsideration" },
        comment: { skill: RECONSIDERATION_SKILLS.comment, route: "reasoning", output: "commentReconsideration" },
      },
    },
  };
}

test("fact updates: the control declares updates and its reconsideration roles together, or neither", () => {
  const together = "fact updates and their reconsideration roles must be configured together";
  const messages = (value: unknown): string[] => {
    const parsed = factTableCatalogSchema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };
  const full = updatesBundle().factTable!;
  assert.deepEqual(messages(full), []);
  const { reconsideration: _roles, ...updatesOnly } = full;
  assert.deepEqual(messages(updatesOnly), [together]);
  const { updates: _updates, ...rolesOnly } = full;
  assert.deepEqual(messages(rolesOnly), [together]);
  assert.deepEqual(messages(control()), [], "a control without fact updates is unchanged");
  assert.equal(factTableCatalogSchema.safeParse({ ...full, updates: "delete/v2" }).success, false);
});

test("fact updates: a reconsideration role binds exactly the runtime's vars, returns its output, and may declare the fact table", () => {
  assert.deepEqual(validateBundle(updatesBundle()), [], "a reconsideration role may consult the table it revises against");

  const fewer = updatesBundle();
  fewer.skills[RECONSIDERATION_SKILLS.chain] = reconsiderationSkill(
    RECONSIDERATION_SKILLS.chain, RECONSIDERATION_VARS.chain.filter((name) => name !== "board"), "chainReconsiderationParts");
  assert.ok(expectIssue(fewer, "UNKNOWN_BINDING").some((issue) =>
    issue.path === "catalog fact-table > reconsideration.chain" &&
    issue.message === `the fact table binds "board", which skill "${RECONSIDERATION_SKILLS.chain}" does not declare`));

  const more = updatesBundle();
  more.skills[RECONSIDERATION_SKILLS.comment] = reconsiderationSkill(
    RECONSIDERATION_SKILLS.comment, [...RECONSIDERATION_VARS.comment, "history"], "commentReconsideration");
  assert.ok(expectIssue(more, "UNBOUND_VAR").some((issue) =>
    issue.path === "catalog fact-table > reconsideration.comment" && issue.message === 'skill var "history" is not bound by the fact table'));

  const output = updatesBundle();
  output.skills[RECONSIDERATION_SKILLS.gameReport] = reconsiderationSkill(
    RECONSIDERATION_SKILLS.gameReport, RECONSIDERATION_VARS.gameReport, "gameCritique");
  assert.ok(expectIssue(output, "SKILL_OUTPUT_MISMATCH").some((issue) =>
    issue.path === "catalog fact-table > reconsideration.gameReport" &&
    issue.message === `the gameReport reconsideration role returns "gameReportReconsideration" but skill "${RECONSIDERATION_SKILLS.gameReport}" declares output "gameCritique"`));

  const technique = updatesBundle();
  technique.skills[RECONSIDERATION_SKILLS.chain] = {
    meta: skillMetaSchema.parse({ name: RECONSIDERATION_SKILLS.chain, kind: "technique", description: "Reconsiders a chain." }),
    body: "Reconsider the chain.",
    sourcePath: `test/${RECONSIDERATION_SKILLS.chain}.md`,
  };
  assert.ok(expectIssue(technique, "WRONG_SKILL_KIND").some((issue) =>
    issue.message === `skill "${RECONSIDERATION_SKILLS.chain}" is a technique skill; a reconsideration role must be a role skill`));

  const unrouted = updatesBundle();
  const issues = expectIssue({
    ...unrouted,
    factTable: { ...unrouted.factTable!, reconsideration: { ...unrouted.factTable!.reconsideration!, comment: { skill: RECONSIDERATION_SKILLS.comment, route: "nowhere", output: "commentReconsideration" } } },
  }, "MISSING_ROUTE");
  assert.ok(issues.some((issue) => issue.path === "catalog fact-table > reconsideration.comment"));

  // The verifier still never consults the table it serves.
  const verifier = updatesBundle();
  verifier.skills["fact_verifier"] = verifierSkill({ capabilities: ["fact-table"] });
  expectIssue(verifier, "FACT_VERIFIER_RECURSION");
});

test("a bundle's fact table names the supreme judge, and exactly the roles in its review strategies declare it", () => {
  const bundle = freshBundle();
  const hasGameReview = bundle.workflows["brainstorm"]!.params["gamifiedReview"] !== undefined;
  const hasCommittee = bundle.workflows["brainstorm"]!.params["gameDecisionThreshold"] !== undefined;
  if (hasGameReview) assert.ok(bundle.factTable, "the game strategy preserves fact-table verification");
  if (bundle.factTable === undefined) {
    // A bundle that predates the fact table: nothing may declare it.
    for (const skill of Object.values(bundle.skills)) {
      assert.ok(!skill.meta.capabilities.includes("fact-table"), `${skill.meta.name} declares no fact table`);
    }
    return;
  }
  assert.deepEqual(bundle.factTable.verifier, { skill: "supreme_judge", route: "reasoning", output: "factVerdict" });
  const verifier = bundle.skills["supreme_judge"]!;
  assert.equal(verifier.meta.output, "factVerdict");
  assert.deepEqual(verifier.meta.vars, VERIFIER_VARS);
  assert.deepEqual(verifier.meta.payload, VERIFIER_PAYLOAD);
  if (hasCommittee) {
    const sharedPolicy = bundle.skills["claim-evidence"];
    assert.ok(sharedPolicy, "the committee-era scientific roles share a claim-level evidence policy");
    assert.equal(sharedPolicy.meta.kind, "technique");
    assert.deepEqual(sharedPolicy.meta.vars, []);
    assert.deepEqual(sharedPolicy.meta.capabilities, [], "the shared policy cannot give the verifier recursive fact-table access");
    for (const skill of Object.values(bundle.skills)) {
      if (skill.meta.capabilities.includes("fact-table") || skill.meta.name === "supreme_judge" || skill.meta.name === "supreme_judge_consult") {
        assert.ok(skill.meta.techniques.includes("claim-evidence"), `${skill.meta.name} includes the common evidence policy`);
      }
    }
  }
  if (bundle.factTable.accessMode === "supreme-mediated/v1") {
    assert.deepEqual(bundle.factTable.consultation, { skill: "supreme_judge_consult", route: "reasoning", output: "factConsultation" });
    const consult = bundle.skills["supreme_judge_consult"]!;
    assert.equal(consult.meta.output, "factConsultation");
    assert.deepEqual(consult.meta.vars, ["input", "files", "request", "entries"]);
    assert.deepEqual(consult.meta.payload, consult.meta.vars);
    assert.equal(consult.meta.capabilities.includes("fact-table"), false);
    assert.ok(bundle.capabilities.capabilities["fact-table"]!.operations.includes("fact.approve"));
    const committee = bundle.skills["committee-chair"]!;
    assert.equal(committee.meta.vars.includes("verifiedFacts"), false, "only Supreme receives raw table records");
    assert.equal(committee.meta.payload.includes("verifiedFacts"), false);
  }
  assert.deepEqual(
    Object.values(bundle.skills)
      .filter((skill) => skill.meta.capabilities.includes("fact-table"))
      .map((skill) => skill.meta.name)
      .sort(),
    [
      "brain", "chair", "commentor", "integrator", "interdisciplinary-commentor", "judge", "redeveloper",
      // Key this expectation to the declared strategy, not to the skills that
      // happen to exist: a missing game role must fail, while old pins stay valid.
      ...(hasGameReview ? ["game-commentor", "game-interdisciplinary-commentor", ...(hasCommittee ? ["committee-chair", "game-redeveloper"] : ["review-chair"])] : []),
      // Fact updates: the reconsideration roles revise work that cites the table.
      ...(bundle.factTable.updates !== undefined ? ["reconsider-chain", "reconsider-comment", "reconsider-game-report"] : []),
    ].sort(),
    "every role that reasons on the brainstorm consults the table; preprocessing roles and the verifier do not",
  );
});

// ---------------------------------------------------------------------------
// factVerdict
// ---------------------------------------------------------------------------

/** A well-formed justified-new ruling; each test varies the fields its rule reads. */
function ruling(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case: "justified-new",
    claim: "The attached estimator is unbiased for n = 1,200 at seed 7.",
    conditions: "n = 1,200; seed 7; src/estimator.py at the submitted version",
    method: "re-executed",
    evidence: "python check.py --n 1200 --seed 7 printed: bias = 0.0004 (95% CI -0.0021 to 0.0029)",
    explanation: "The re-run reproduces the estimate; its bias is indistinguishable from zero at these conditions.",
    conflicts: [],
    integrity: "honest",
    ...fields,
  };
}

function conflictOn(id: string, resolution: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, resolution, explanation: `The ruling on ${id}: ${resolution}.`, ...fields };
}

const accepts = (value: unknown): boolean => factVerdictSchema.safeParse(value).success;

/** The paths of the issues a ruling raises, dotted. */
function issuePaths(value: unknown): string[] {
  const result = factVerdictSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

test("factVerdict is the registered artifact schema of the verifier's output", () => {
  assert.equal(artifactSchemas.factVerdict, factVerdictSchema);
  assert.ok(accepts(ruling()));
});

test("factVerdict: justified names the entry that covers the claim, no other case names one, and it contradicts nothing", () => {
  assert.ok(accepts(ruling({ case: "justified", method: "record-match", existing: "F:3" })));
  assert.deepEqual(issuePaths(ruling({ case: "justified", method: "record-match" })), ["existing"]);
  for (const name of ["justified-new", "narrowed", "conflict", "refuted", "unverified", "not-a-fact"]) {
    assert.ok(issuePaths(ruling({ case: name, existing: "F:3" })).includes("existing"), `${name} names no existing entry`);
  }
  assert.deepEqual(
    issuePaths(ruling({ case: "justified", existing: "F:3", conflicts: [conflictOn("F:4", "incumbent-stands")] })),
    ["conflicts"],
  );
});

test("factVerdict: a conflict contradicts at least one entry, each of which stands or is disputed", () => {
  const conflict = (conflicts: unknown[]) => ruling({ case: "conflict", conflicts });
  assert.ok(accepts(conflict([conflictOn("F:2", "incumbent-stands")])));
  assert.ok(accepts(conflict([conflictOn("F:2", "disputed")])));
  assert.ok(accepts(conflict([conflictOn("F:2", "incumbent-stands"), conflictOn("F:5", "disputed")])));
  assert.deepEqual(issuePaths(conflict([])), ["conflicts"]);
  assert.deepEqual(issuePaths(conflict([conflictOn("F:2", "incumbent-revoked")])), ["conflicts.0.resolution"]);
  assert.deepEqual(
    issuePaths(conflict([conflictOn("F:2", "disputed"), conflictOn("F:5", "both-narrowed", { conditions: "n = 60,000" })])),
    ["conflicts.1.resolution"],
  );
});

test("factVerdict: a new or narrowed badge was checked, and revokes or narrows every entry it contradicts", () => {
  for (const name of ["justified-new", "narrowed"]) {
    assert.ok(accepts(ruling({ case: name })), name);
    assert.ok(accepts(ruling({ case: name, conflicts: [conflictOn("F:2", "incumbent-revoked")] })));
    assert.ok(
      accepts(ruling({ case: name, conflicts: [conflictOn("F:2", "both-narrowed", { conditions: "n = 60,000 only" })] })),
    );
    assert.deepEqual(issuePaths(ruling({ case: name, conflicts: [conflictOn("F:2", "both-narrowed")] })), [
      "conflicts.0.conditions",
    ]);
    assert.deepEqual(issuePaths(ruling({ case: name, conflicts: [conflictOn("F:2", "incumbent-stands")] })), [
      "conflicts.0.resolution",
    ]);
    assert.deepEqual(issuePaths(ruling({ case: name, conflicts: [conflictOn("F:2", "disputed")] })), [
      "conflicts.0.resolution",
    ]);
    assert.deepEqual(issuePaths(ruling({ case: name, method: "none" })), ["method"]);
    assert.deepEqual(issuePaths(ruling({ case: name, evidence: "" })), ["evidence"]);
    assert.deepEqual(issuePaths(ruling({ case: name, evidence: " \n " })), ["evidence"], "blank evidence is no evidence");
  }
});

test("factVerdict: refuted carries its evidence and contradicts nothing; unverified and not-a-fact contradict nothing", () => {
  assert.ok(accepts(ruling({ case: "refuted" })));
  assert.deepEqual(issuePaths(ruling({ case: "refuted", evidence: "" })), ["evidence"]);
  assert.deepEqual(issuePaths(ruling({ case: "refuted", conflicts: [conflictOn("F:2", "incumbent-stands")] })), [
    "conflicts",
  ]);
  for (const name of ["unverified", "not-a-fact"]) {
    assert.ok(accepts(ruling({ case: name, method: "none", evidence: "" })), `${name} may rest on no check`);
    assert.deepEqual(issuePaths(ruling({ case: name, conflicts: [conflictOn("F:2", "disputed")] })), ["conflicts"]);
  }
});

test("factVerdict: no entry is ruled on twice", () => {
  assert.deepEqual(
    issuePaths(ruling({ case: "conflict", conflicts: [conflictOn("F:2", "incumbent-stands"), conflictOn("F:2", "disputed")] })),
    ["conflicts.1.id"],
  );
});

test("factVerdict: a strict shape with bounded fields and closed vocabularies", () => {
  const rejects = (value: unknown) => !accepts(value);
  assert.ok(rejects(ruling({ requester: "member-1" })), "no field beyond the documented ones");
  assert.ok(rejects(ruling({ case: "pending" })), "pending is not a case in v1");
  assert.ok(rejects(ruling({ method: "guessed" })));
  assert.ok(rejects(ruling({ integrity: "dishonest" })));
  const { integrity: _integrity, ...withoutIntegrity } = ruling();
  assert.ok(rejects(withoutIntegrity), "the integrity flag is always recorded");
  for (const id of ["F:0", "F:01", "S:3", "f:3", "F:3 "]) {
    assert.ok(rejects(ruling({ case: "justified", existing: id })), `"${id}" is not an entry id`);
    assert.ok(rejects(ruling({ case: "conflict", conflicts: [conflictOn(id, "disputed")] })), `"${id}" is not an entry id`);
  }
  assert.ok(rejects(ruling({ claim: "" })));
  assert.ok(accepts(ruling({ claim: "c".repeat(600) })));
  assert.ok(rejects(ruling({ claim: "c".repeat(601) })));
  assert.ok(rejects(ruling({ conditions: "" })));
  assert.ok(accepts(ruling({ conditions: "c".repeat(1200) })));
  assert.ok(rejects(ruling({ conditions: "c".repeat(1201) })));
  assert.ok(accepts(ruling({ evidence: "e".repeat(8000) })));
  assert.ok(rejects(ruling({ evidence: "e".repeat(8001) })));
  assert.ok(rejects(ruling({ explanation: "" })));
  assert.ok(accepts(ruling({ explanation: "x".repeat(2000) })));
  assert.ok(rejects(ruling({ explanation: "x".repeat(2001) })));
  const revoked = (index: number) => conflictOn(`F:${index + 1}`, "incumbent-revoked");
  assert.ok(accepts(ruling({ conflicts: Array.from({ length: 8 }, (_, index) => revoked(index)) })));
  assert.ok(rejects(ruling({ conflicts: Array.from({ length: 9 }, (_, index) => revoked(index)) })), "at most 8 conflicts");
  assert.ok(rejects(ruling({ conflicts: [{ ...revoked(0), requester: "member-1" }] })), "a conflict ruling is strict");
  assert.ok(rejects(ruling({ conflicts: [{ ...revoked(0), explanation: "" }] })));
  assert.ok(rejects(ruling({ conflicts: [{ ...revoked(0), explanation: "x".repeat(1201) }] })));
  assert.ok(rejects(ruling({ conflicts: [{ ...revoked(0), resolution: "both-narrowed", conditions: "" }] })));
  assert.ok(rejects(ruling({ conflicts: [{ ...revoked(0), resolution: "both-narrowed", conditions: "c".repeat(1201) }] })));
});
