import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadContent, type ContentBundle } from "@brainstorm-agentic/content";
import {
  resolveCapabilityPlan,
  systemPromptText,
  type HostToolManifest,
} from "@brainstorm-agentic/core";

import { compileSkillPrompt } from "../src/prompts.js";

// These checks exercise the editable role declarations and their actual
// prompt/broker path. Historical release bundles intentionally keep their
// original GPU scope and remain covered by shipped-content.test.ts.
const sourceDir = process.env.BRAIN_TEST_CONTENT_DIR ?? [
  new URL("../../../../../Brain/content-src/brainstorm/", import.meta.url),
  new URL("../../../../../brain/content-src/brainstorm/", import.meta.url),
].map((url) => fileURLToPath(url)).find((path) => existsSync(path));

let cached: ContentBundle | undefined;
function bundle(): ContentBundle {
  assert.ok(sourceDir, "set BRAIN_TEST_CONTENT_DIR to the editable Brain bundle");
  return cached ??= loadContent(sourceDir);
}

const gpuRoles = [
  "brain", "redeveloper", "commentor", "interdisciplinary-commentor", "judge", "integrator",
] as const;

// The broker cares about the operation, not the implementation that submits
// a scheduler job. No test here submits a job or approves a deployment.
const gpuTool: HostToolManifest = {
  toolId: "gpu_run",
  displayName: "GPU verification test",
  operations: ["gpu.run"],
  risk: "high",
  defaultEnabled: false,
  definition: {
    name: "gpu_run",
    description: "Run one approved GPU verification",
    inputSchema: { type: "object" },
  },
};

function promptFor(name: string) {
  const content = bundle();
  const role = content.skills[name]!;
  return compileSkillPrompt(
    role,
    Object.values(content.skills).filter((skill) => skill.meta.kind === "technique"),
    Object.fromEntries(role.meta.vars.map((name) => [name, "test binding"])),
  );
}

function planFor(name: string, setup: "ready" | "absent" | "disabled") {
  const content = bundle();
  return resolveCapabilityPlan({
    requiredCapabilities: promptFor(name).capabilities.map((capabilityId) => ({
      capabilityId,
      operations: content.capabilities.capabilities[capabilityId]!.operations,
      whenUnavailable: content.capabilities.capabilities[capabilityId]!.whenUnavailable,
    })),
    providerOffers: [],
    hostTools: [gpuTool],
    enabledHostToolIds: new Set(setup === "absent" ? [] : ["gpu_run"]),
    ...(setup === "absent"
      ? { vacantCapabilities: new Map([["gpu-execution", "No approved GPU profile is configured."]]) }
      : {}),
    ...(setup === "disabled" ? { disabledCapabilityIds: new Set(["gpu-execution"]) } : {}),
  });
}

test("GPU verification reaches the scientific roles through compiled prompts and the broker", () => {
  for (const name of gpuRoles) {
    const role = bundle().skills[name]!;
    const prompt = promptFor(name);
    const text = systemPromptText(prompt.system) ?? "";
    assert.ok(!role.meta.requiredCapabilities.includes("gpu-execution"), `${name}: GPU remains optional`);
    assert.ok(prompt.skills.includes("gpu-verification"), `${name}: shared procedure is compiled`);
    assert.match(text, /at most two GPU submissions in this task/, `${name}: work is bounded`);
    assert.match(text, /approved profile/, `${name}: setup approval reaches the prompt`);
    const plan = planFor(name, "ready");
    assert.deepEqual(plan.operations.find((operation) => operation.operationId === "gpu.run"), {
      operationId: "gpu.run", source: "host", toolNames: ["gpu_run"], capabilityId: "gpu-execution",
    });
    assert.equal(plan.hostToolDefinitions.filter((tool) => tool.name === "gpu_run").length, 1);
  }
});

test("an absent or disabled GPU never advertises a tool or makes the roles GPU-dependent", () => {
  for (const name of gpuRoles) {
    for (const setup of ["absent", "disabled"] as const) {
      const plan = planFor(name, setup);
      const status = plan.capabilities.find((capability) => capability.capabilityId === "gpu-execution");
      assert.equal(status?.availability, setup === "absent" ? "vacant" : "withheld", `${name}: ${setup}`);
      assert.ok(!plan.hostToolDefinitions.some((tool) => tool.name === "gpu_run"));
      assert.ok(!bundle().skills[name]!.meta.requiredCapabilities.includes("gpu-execution"));
      if (setup === "disabled") assert.match(plan.unavailableInstructions, /Do NOT claim to have run anything on a GPU/);
    }
  }
});

test("preprocessing, composition and synthesis cannot acquire GPU access through techniques", () => {
  for (const name of ["processor", "classifier", "code-annotator", "pool-builder", "placer", "literature-screener", "chair"]) {
    const plan = planFor(name, "ready");
    assert.ok(!promptFor(name).capabilities.includes("gpu-execution"), name);
    assert.ok(!plan.hostToolDefinitions.some((tool) => tool.name === "gpu_run"), name);
  }
});
