import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOrchestrationCommand } from "../src/command.js";
import { SettingsStore } from "../src/settings.js";

test("argument steps default to six, persist separately from review rounds, and validate before saving", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "argument-steps-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new SettingsStore(workspace);
  assert.equal(store.get().argumentSteps, 6);
  await store.put({ llm: { provider: "offline" }, argumentSteps: 3, review: { maxRounds: 7 } });
  await store.put({ panel: { size: 4 } });
  assert.equal(new SettingsStore(workspace).get().argumentSteps, 3);
  await store.put({ review: {} });
  assert.equal(store.get().argumentSteps, 3);
  assert.equal(store.get().review, undefined);
  await store.put({ argumentSteps: 9 });
  for (const argumentSteps of [2, 10, 3.5, "6", null, false, NaN, Infinity]) {
    await assert.rejects(store.put({ argumentSteps }), /argumentSteps must be an integer between 3 and 9/);
    assert.equal(store.get().argumentSteps, 9, "invalid edits must keep the previous saved count");
  }
  // Existing installations obtain the new user default without rewriting their other preferences.
  const path = join(workspace, "settings.json");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  delete legacy.argumentSteps;
  writeFileSync(path, JSON.stringify(legacy));
  const restored = new SettingsStore(workspace).get();
  assert.equal(restored.argumentSteps, 6);
  assert.equal(restored.panel?.size, 4);
});

test("the launch snapshot keeps the selected argument count after settings change", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "argument-steps-snapshot-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new SettingsStore(workspace);
  await store.put({ llm: { provider: "offline" }, argumentSteps: 4 });
  const snapshot = await store.snapshotForLaunch();
  await store.put({ argumentSteps: 8 });
  const command = (mode: "run" | "resume", settings = snapshot) => buildOrchestrationCommand({
    workerPath: "/tmp/worker.js", mode, runId: "argument-count", topic: "Test",
    sessionRoot: "/tmp/sessions", eventsFile: "/tmp/events.jsonl", contentDir: "/tmp/content", settings,
  });
  assert.equal(snapshot.argumentSteps, 4);
  assert.match(command("run"), /BRAINSTORM_AGENTIC_ARGUMENT_STEPS='4'/);
  assert.match(command("resume"), /BRAINSTORM_AGENTIC_ARGUMENT_STEPS='4'/);
  assert.match(command("run", await store.snapshotForLaunch()), /BRAINSTORM_AGENTIC_ARGUMENT_STEPS='8'/);
  const { argumentSteps: _count, ...legacySnapshot } = snapshot;
  assert.doesNotMatch(command("resume", legacySnapshot), /BRAINSTORM_AGENTIC_ARGUMENT_STEPS=/);
});
