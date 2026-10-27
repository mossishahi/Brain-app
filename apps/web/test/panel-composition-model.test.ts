import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveValue,
  nextOverrides,
  parseParamInput,
  type PanelParamView,
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
