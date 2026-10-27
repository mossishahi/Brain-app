import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ServerSettings } from "@brainstorm-agentic/protocol";

import { buildOrchestrationCommand } from "../src/command.js";
import type { JobRecord } from "../src/model.js";
import {
  PANEL_COMPOSITION_PARAMS,
  PANEL_PARAM_GROUPS,
  declaredParams,
  panelCompositionView,
  validatePanelComposition,
  workflowParamsJson,
} from "../src/panel-composition.js";
import { buildNeedsGateView } from "../src/panel-evidence.js";
import { encoderReadiness } from "../src/readiness.js";
import { SettingsStore } from "../src/settings.js";
import { buildJobDetail, compositionInputs, stageForPath } from "../src/stage-mapper.js";

const baseSettings: ServerSettings = {
  slurmTemplate: "{{BRAIN_COMMAND}}",
  runner: "local",
  llm: { provider: "offline" },
  panelConfirmation: "manual",
  contentRegistry: { url: "http://127.0.0.1:1", bundle: "brainstorm" },
  creditRecovery: { autoResume: true, safetyBufferSeconds: 60, openRouterModel: "openrouter/free" },
};

/** A field the protocol does not declare yet, read off a settings document. */
function extra(value: unknown, key: string): unknown {
  return (value as Record<string, unknown> | undefined)?.[key];
}

function withComposition(params: Record<string, number | boolean | string>): ServerSettings {
  return { ...baseSettings, panelComposition: { params } } as ServerSettings;
}

function command(settings: ServerSettings, gate?: Parameters<typeof buildOrchestrationCommand>[0]["gate"]): string {
  return buildOrchestrationCommand({
    workerPath: "/w/main.js",
    mode: gate ? "resume" : "run",
    runId: "job-1",
    ...(gate ? {} : { topic: "t" }),
    sessionRoot: "/s",
    eventsFile: "/e",
    contentDir: "/c",
    settings,
    ...(gate ? { gate } : {}),
  });
}

test("every spec v2 Section 0 param is declared once, with a default of its type", () => {
  assert.equal(PANEL_COMPOSITION_PARAMS.length, 60);
  const names = PANEL_COMPOSITION_PARAMS.map((param) => param.name);
  assert.equal(new Set(names).size, names.length);
  const groups = new Set(PANEL_PARAM_GROUPS.map((group) => group.id));
  for (const param of PANEL_COMPOSITION_PARAMS) {
    assert.ok(groups.has(param.group), param.name);
    const expected = param.type === "bool" ? "boolean" : param.type === "string" ? "string" : "number";
    assert.equal(typeof param.default, expected, param.name);
    if (param.type === "int") assert.ok(Number.isInteger(param.default), param.name);
    if (param.values) assert.ok(param.values.includes(param.default as string), param.name);
  }
  const byName = new Map(PANEL_COMPOSITION_PARAMS.map((param) => [param.name, param]));
  assert.equal(byName.get("askUserToConfirmNeeds")!.default, false);
  assert.equal(byName.get("encoder")!.default, "specter2");
  assert.equal(byName.get("criticalCoverage")!.default, 0.75);
  assert.equal(byName.get("seatsPerSubfield")!.default, 0);
  assert.equal(byName.get("sourceCore")!.key, "required");
  assert.deepEqual([byName.get("maxCalls")!.min, byName.get("maxCalls")!.max], [10, 600]);
  assert.deepEqual([byName.get("knnK")!.min, byName.get("knnK")!.max], [1, 50]);
  assert.deepEqual(byName.get("routePairs")!.values, ["off", "central", "all"]);
});

test("panel composition overrides are validated against the spec's types and ranges", () => {
  assert.deepEqual(
    validatePanelComposition({ params: { relevanceScreen: true, maxCalls: 300, encoder: "openrouter:qwen/qwen3-embedding" } }),
    { params: { encoder: "openrouter:qwen/qwen3-embedding", maxCalls: 300, relevanceScreen: true } },
  );
  assert.deepEqual(validatePanelComposition({}), { params: {} });
  const refused: [unknown, RegExp][] = [
    [{ params: { notAParam: 1 } }, /is not a panel composition param/],
    [{ params: { maxCalls: 5 } }, /at least 10/],
    [{ params: { maxCalls: 700 } }, /at most 600/],
    [{ params: { knnK: 2.5 } }, /integer/],
    [{ params: { coreWeight: 1.2 } }, /at most 1/],
    [{ params: { routePairs: "some" } }, /one of off, central, all/],
    [{ params: { encoder: "word2vec" } }, /openrouter:<model id>/],
    [{ params: { anchors: "yes" } }, /boolean/],
    [{ params: [] }, /params must be an object/],
  ];
  for (const [value, pattern] of refused) {
    assert.throws(() => validatePanelComposition(value), pattern);
  }
});

test("new runs carry the overrides as BRAINSTORM_AGENTIC_WORKFLOW_PARAMS next to the panel size", () => {
  assert.equal(workflowParamsJson(baseSettings), undefined);
  assert.equal(command(baseSettings).includes("BRAINSTORM_AGENTIC_WORKFLOW_PARAMS"), false);
  const settings = {
    ...withComposition({ relevanceScreen: true, maxCalls: 300 }),
    panel: { size: 4 },
  } as ServerSettings;
  const line = command(settings);
  assert.match(line, /BRAINSTORM_AGENTIC_PANEL_SIZE='4'/);
  assert.match(line, /BRAINSTORM_AGENTIC_WORKFLOW_PARAMS='\{"maxCalls":300,"relevanceScreen":true\}'/);
  // An empty section sends nothing.
  assert.equal(command(withComposition({})).includes("BRAINSTORM_AGENTIC_WORKFLOW_PARAMS"), false);
});

test("a needs edit rides the JSON gate transport; a plain approval stays compact", () => {
  const embeddingInput = { title: "T", facets: [] };
  const edit = command(baseSettings, { gateKey: "confirm-needs", action: "edit", embeddingInput });
  const json = /--gate-json '([^']+)'/.exec(edit)?.[1];
  assert.ok(json, edit);
  assert.deepEqual(JSON.parse(json), { gateKey: "confirm-needs", action: "edit", embeddingInput });
  assert.match(command(baseSettings, { gateKey: "confirm-needs", action: "approve" }), /--gate 'confirm-needs=approve'/);
});

test("the settings store keeps panel composition overrides and the CORE key", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-panel-composition-"));
  try {
    const store = new SettingsStore(workspace, { validateAnthropic: async () => undefined });
    await store.put({ llm: { provider: "anthropic", model: "claude-x", apiKey: "key" } });
    assert.equal(extra(store.get(), "panelComposition"), undefined);
    assert.equal(extra(store.get().webSearch, "coreKeyConfigured"), undefined);

    await store.put({ panelComposition: { params: { relevanceScreen: true, gainStop: 0.02 } } });
    assert.deepEqual(extra(store.get(), "panelComposition"), {
      params: { gainStop: 0.02, relevanceScreen: true },
    });
    // An unrelated section save keeps the overrides.
    await store.put({ gateAutoApprove: false });
    assert.deepEqual(extra(store.get(), "panelComposition"), {
      params: { gainStop: 0.02, relevanceScreen: true },
    });
    await assert.rejects(store.put({ panelComposition: { params: { gainStop: "x" } } }), /must be a number/);

    await store.put({ webSearch: { provider: "none", coreApiKey: "core-secret" } });
    assert.equal(extra(store.get().webSearch, "coreKeyConfigured"), true);
    assert.equal(store.getCoreApiKey(), "core-secret");
    assert.equal(readFileSync(join(workspace, "settings.json"), "utf8").includes("core-secret"), false);
    const env = store.executionEnvironment({}, store.get());
    assert.equal(env.CORE_API_KEY, "core-secret");
    assert.match(command(store.get()), /BRAINSTORM_AGENTIC_WORKFLOW_PARAMS='\{"gainStop":0.02,"relevanceScreen":true\}'/);

    await store.put({ webSearch: { provider: "none", clearCoreApiKey: true } });
    assert.equal(store.getCoreApiKey(), undefined);
    assert.equal(store.executionEnvironment({}, store.get()).CORE_API_KEY, undefined);

    await store.put({ panelComposition: { params: {} } });
    assert.equal(extra(store.get(), "panelComposition"), undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("encoder readiness reports the local exports, the built-in fallback and OpenRouter", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-encoders-"));
  try {
    mkdirSync(join(dir, "specter2"));
    for (const file of ["doc.onnx", "query.onnx", "tokenizer.json", "tokenizer_config.json", "manifest.json"]) {
      writeFileSync(join(dir, "specter2", file), "x");
    }
    mkdirSync(join(dir, "bge-base-en-v1.5"));
    writeFileSync(join(dir, "bge-base-en-v1.5", "doc.onnx"), "x");
    const report = encoderReadiness({ env: { BRAINSTORM_AGENTIC_ENCODER_DIR: dir }, openRouterKeyConfigured: false });
    const byId = new Map(report.encoders.map((encoder) => [encoder.id, encoder]));
    assert.equal(report.selected, "specter2");
    assert.equal(report.selectedAvailable, true);
    assert.equal(byId.get("specter2")!.available, true);
    assert.equal(byId.get("bge-base-en-v1.5")!.available, false);
    assert.match(byId.get("bge-base-en-v1.5")!.detail, /missing tokenizer\.json, tokenizer_config\.json, manifest\.json/);
    assert.equal(byId.get("hash-ngram-v1")!.available, true);
    assert.equal(byId.get("openrouter:<model>")!.available, false);

    const unset = encoderReadiness({ env: {}, openRouterKeyConfigured: true, selected: "openrouter:m" });
    assert.equal(unset.modelDir, undefined);
    assert.equal(unset.selectedAvailable, true);
    assert.match(unset.encoders[0]!.detail, /BRAINSTORM_AGENTIC_ENCODER_DIR is not set/);
    assert.equal(unset.fallback, "hash-ngram-v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the drawer view shows the bundle's defaults and marks undeclared params", () => {
  const declared = {
    bundle: "brainstorm",
    version: "0.29.0",
    params: declaredParams({
      maxCalls: { description: "d", default: 200, min: 10, max: 400 },
      relevanceScreen: { description: "d", default: false },
      broken: "x",
    }),
  };
  const view = panelCompositionView(withComposition({ maxCalls: 300 }), declared, true);
  const byName = new Map(view.params.map((param) => [param.name, param]));
  assert.deepEqual(view.bundle, { id: "brainstorm", version: "0.29.0" });
  assert.equal(view.coreKeyConfigured, true);
  assert.equal(byName.get("maxCalls")!.declared, true);
  assert.equal(byName.get("maxCalls")!.effectiveDefault, 200);
  assert.equal(byName.get("maxCalls")!.max, 400);
  assert.equal(byName.get("maxCalls")!.override, 300);
  assert.equal(byName.get("routeKnn")!.declared, false);
  assert.equal(byName.get("routeKnn")!.effectiveDefault, true);
  const offline = panelCompositionView(baseSettings, undefined, false);
  assert.equal(offline.params.every((param) => param.declared === null), true);
});

test("the new workflow nodes map onto the dashboard's stages", () => {
  assert.equal(stageForPath("brainstorm/retrieve-literature"), "decompose-experts");
  assert.equal(stageForPath("brainstorm/maybe-screen-literature/screen-literature"), "decompose-experts");
  assert.equal(stageForPath("brainstorm/maybe-screen-literature/skip-screen-literature"), "decompose-experts");
  assert.equal(stageForPath("brainstorm/compose-panel/compose-panel-run"), "decompose-experts");
  assert.equal(stageForPath("brainstorm/seat-panel"), "select-panel");
  assert.equal(stageForPath("brainstorm/maybe-confirm-needs/confirm-needs"), "process-input");
});

const record: JobRecord = {
  jobId: "job-1",
  topic: "topic",
  status: "suspended",
  runner: "local",
  createdAt: 1,
  updatedAt: 2,
};

test("a run suspended on the needs gate shows it on Process input with its needs payload", () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-needs-gate-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    const embeddingInput = { title: "T", abstract: "A", facets: [] };
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "suspended",
        input: { __brainstormState: { params: { coreWeight: 0.8, formulationWeight: 0.5, equivalentProblemWeight: 0.2 } } },
        journal: [],
        pendingGates: [{ gateKey: "confirm-needs", path: "brainstorm/maybe-confirm-needs/confirm-needs", prompt: "Confirm the needs" }],
        seq: 1,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(
      join(sessionDir, "artifacts", "index.json"),
      JSON.stringify({ refs: [{ id: "a-class", metadata: { schema: "taskClassification", path: "classification" } }] }),
    );
    writeFileSync(join(sessionDir, "artifacts", "a-class"), JSON.stringify({ embeddingInput }));
    const detail = buildJobDetail({ record, status: "suspended", sessionDir, jobDir, settings: baseSettings });
    assert.equal(detail.pendingGate?.gateKey, "confirm-needs");
    assert.equal(detail.pendingGate?.members, undefined);
    assert.equal(detail.stages.find((stage) => stage.id === "process-input")?.status, "suspended");
    const inputs = compositionInputs(sessionDir);
    assert.equal(inputs.pendingGateKey, "confirm-needs");
    assert.equal(inputs.panelEvidence, undefined);
    const view = buildNeedsGateView(inputs.pendingGateKey!, inputs.classification, inputs.params);
    assert.deepEqual(view?.weights, { coreWeight: 0.8, formulationWeight: 0.5, equivalentProblemWeight: 0.2 });
    assert.deepEqual(view?.embeddingInput, embeddingInput);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the seated panel and the evidence record come from seat-panel and compose-panel", () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-seat-panel-"));
  try {
    const sessionDir = join(workspace, "session");
    const jobDir = join(workspace, "job");
    mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    const members = [
      { id: "member-1", department: "Computer Science", umbrella: "Artificial Intelligence", subfields: ["GNNs"] },
      { id: "member-2", department: "Mathematics", umbrella: "Statistics", subfields: ["Graphical models"] },
    ];
    const evidence = { version: 1, params: {}, evidence: [], candidates: [], greedy: { trace: [], droppedByCap: [], rescued: [], kStar: 2, kCov: null, epsW: 0.1 }, seats: [], flags: {}, determinismSha256: "0" };
    writeFileSync(
      join(sessionDir, "checkpoint.json"),
      JSON.stringify({
        runId: "job-1",
        workflowId: "brainstorm",
        status: "suspended",
        input: {},
        journal: [
          { key: "brainstorm/compose-panel/compose-panel-run::result", kind: "activity", value: evidence },
          { key: "brainstorm/seat-panel/seat-panel-run::result", kind: "activity", value: { members } },
        ],
        pendingGates: [{ gateKey: "confirm-panel", path: "brainstorm/confirm-panel", prompt: "Confirm" }],
        seq: 2,
        updatedAt: Date.now(),
      }),
    );
    writeFileSync(join(sessionDir, "artifacts", "index.json"), JSON.stringify({ refs: [] }));
    const detail = buildJobDetail({ record, status: "suspended", sessionDir, jobDir, settings: baseSettings });
    assert.deepEqual(detail.pendingGate?.members?.map((member) => member.id), ["member-1", "member-2"]);
    const select = detail.stages.find((stage) => stage.id === "select-panel");
    assert.ok(select && select.id === "select-panel");
    assert.equal(select.panel?.length, 2);
    assert.deepEqual(compositionInputs(sessionDir).panelEvidence, evidence);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
