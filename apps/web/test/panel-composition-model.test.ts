import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveValue,
  encoderPreparationMessage,
  nextOverrides,
  parseParamInput,
  type PanelParamView,
  type EncoderReadinessView,
} from "../src/components/settings/panel-composition-model.js";

function param(partial: Partial<PanelParamView> & Pick<PanelParamView, "name" | "type" | "effectiveDefault">): PanelParamView {
  return { group: "needs", default: partial.effectiveDefault, description: "", declared: true, ...partial };
}

const params: PanelParamView[] = [
  param({ name: "maxCalls", type: "int", effectiveDefault: 150, min: 10, max: 600 }),
  param({ name: "coreWeight", type: "number", effectiveDefault: 1, min: 0, max: 1 }),
  param({ name: "relevanceScreen", type: "bool", effectiveDefault: false, override: true }),
  param({ name: "routePairs", type: "string", effectiveDefault: "all", values: ["off", "central", "all"] }),
  param({ name: "encoder", type: "string", effectiveDefault: "specter2" }),
];

test("typed values are parsed against the param's type and range; blank means default", () => {
  const [maxCalls, coreWeight, , routePairs, encoder] = params;
  assert.deepEqual(parseParamInput(maxCalls!, "300"), { value: 300 });
  assert.deepEqual(parseParamInput(maxCalls!, ""), {});
  assert.match(parseParamInput(maxCalls!, "2.5").error!, /integer/);
  assert.match(parseParamInput(maxCalls!, "5").error!, /at least 10/);
  assert.match(parseParamInput(coreWeight!, "1.5").error!, /at most 1/);
  assert.deepEqual(parseParamInput(coreWeight!, "0.25"), { value: 0.25 });
  assert.match(parseParamInput(routePairs!, "some").error!, /one of/);
  assert.deepEqual(parseParamInput(encoder!, "openrouter:qwen/qwen3-embedding"), { value: "openrouter:qwen/qwen3-embedding" });
  assert.match(parseParamInput(encoder!, "word2vec").error!, /openrouter/);
});

test("a save sends only the values that differ from the bundle defaults", () => {
  assert.deepEqual(nextOverrides(params, "maxCalls", 300), { maxCalls: 300, relevanceScreen: true });
  assert.deepEqual(nextOverrides(params, "maxCalls", 150), { relevanceScreen: true });
  assert.deepEqual(nextOverrides(params, "relevanceScreen", undefined), {});
  assert.deepEqual(nextOverrides(params, "relevanceScreen", false), {});
  assert.equal(effectiveValue(params[2]!), true);
  assert.equal(effectiveValue(params[0]!), 150);
});

test("encoder guidance distinguishes managed preparation from an unavailable explicit installation", () => {
  const report = (state: "ready" | "prepared" | "missing" | "preparing" | "failed" | "unavailable", managed = true): EncoderReadinessView => ({
    selected: "specter2", selectedAvailable: state === "ready",
    encoders: [{ id: "specter2", available: state === "ready", state, managed, detail: "Test installation" }],
  });
  assert.match(encoderPreparationMessage(report("missing"))!, /downloaded and checked automatically when research first needs it/);
  assert.match(encoderPreparationMessage(report("missing"))!, /Opening settings does not start the download/);
  assert.match(encoderPreparationMessage(report("preparing"))!, /is being prepared/);
  assert.match(encoderPreparationMessage(report("prepared"))!, /model files are present.*Runtime checks/);
  assert.match(encoderPreparationMessage(report("prepared", false))!, /model files are present.*Runtime checks/);
  assert.match(encoderPreparationMessage(report("failed"))!, /will not silently switch/);
  assert.match(encoderPreparationMessage(report("unavailable", false))!, /explicitly choose another encoder/);
  assert.equal(encoderPreparationMessage(report("ready")), undefined);
});
