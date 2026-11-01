import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ServerSettings } from "@brainstorm-agentic/protocol";

import { defaultReadinessProbes, ReadinessProbeError } from "../src/readiness.js";
import { defaultServerSettings } from "../src/settings.js";

const probes = defaultReadinessProbes({
  validateAnthropic: async () => undefined,
  validateClaudeAgent: async () => undefined,
  validateCursorAgent: async () => undefined,
});

function context(workspace: string, settings: ServerSettings) {
  return {
    settings, workspace, env: {}, signal: new AbortController().signal,
    credentials: {}, onProgress: () => undefined,
  };
}

test("Gemini readiness resolves explicitly enabled code execution through the host", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-code-readiness-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const defaults = defaultServerSettings();
  const settings: ServerSettings = {
    ...defaults,
    llm: { provider: "gemini", model: "test-model" },
    hostTools: { enabledToolIds: [...defaults.hostTools!.enabledToolIds, "code_execute"] },
  };
  const result = await probes.capabilities(context(workspace, settings));
  assert.match(result.message ?? "", /code-execution: host tools/);
  assert.match(result.detail ?? "", /^code-execution \/ code.execute -> host$/m);
  assert.doesNotMatch(result.detail ?? "", /unavailable/);
});

test("Gemini readiness preserves the code-execution opt-in and names the setting", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-code-disabled-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const settings: ServerSettings = {
    ...defaultServerSettings(), llm: { provider: "gemini", model: "test-model" },
  };
  for (const hostTools of [settings.hostTools, undefined]) {
    await assert.rejects(probes.capabilities(context(workspace, { ...settings, hostTools })), (error: unknown) => {
      assert.ok(error instanceof ReadinessProbeError);
      assert.match(error.message, /Enable Code execution in Settings → Tools → Capabilities & host tools/);
      assert.match(error.detail ?? "", /^code-execution \/ code.execute -> unavailable$/m);
      return true;
    });
  }
});

test("providers with native execution do not need the host code opt-in", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-native-code-readiness-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const provider of ["anthropic", "claude-agent", "cursor-agent"] as const) {
    const settings: ServerSettings = {
      ...defaultServerSettings(), llm: { provider, model: "test-model" },
    };
    const result = await probes.capabilities(context(workspace, settings));
    assert.match(result.detail ?? "", /^code-execution \/ code.execute -> provider$/m);
  }
});
