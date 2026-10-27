import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsStore } from "../src/settings.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("wrapped Claude setup tokens are normalized before verification, persistence, and worker use", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-claude-token-"));
  const verified: string[] = [];
  const token = "sk-ant-oat01-test_TOKEN";
  try {
    const store = new SettingsStore(workspace, { validateClaudeAgent: async ({ token }) => { verified.push(token); } });
    const saved = await store.put({ llm: { provider: "claude-agent", setupToken: " \r\nsk-ant-oat01-test_\n\u00a0TOKEN\t " } });
    assert.deepEqual(verified, [token]);
    assert.equal(saved.llm.setupTokenConfigured, true);
    assert.equal(store.getClaudeSetupToken(), token);
    assert.equal(JSON.parse(readFileSync(join(workspace, "credentials.json"), "utf8")).claudeSetupToken, token);
    assert.equal(store.executionEnvironment({}).CLAUDE_CODE_OAUTH_TOKEN, token);
    assert.ok(!JSON.stringify(saved).includes(token));
    await assert.rejects(store.put({ llm: { setupToken: " \n\u00a0\t" } }), /non-empty/);
    assert.deepEqual(verified, [token], "blank input must not call the SDK");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("a rejected replacement Claude token keeps the verified credential and normalizes legacy reads", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-claude-replacement-"));
  try {
    const store = new SettingsStore(workspace, { validateClaudeAgent: async ({ token }) => {
      if (token === "bad-token") throw new Error("401 OAuth access token is invalid");
    } });
    await store.put({ llm: { provider: "claude-agent", setupToken: "working-token" } });
    await assert.rejects(store.put({ llm: { setupToken: "bad-\n\u00a0token" } }), /401 OAuth/);
    assert.equal(store.getClaudeSetupToken(), "working-token");
    writeFileSync(join(workspace, "credentials.json"), JSON.stringify({ claudeSetupToken: "working-\n\u00a0token" }));
    assert.equal(new SettingsStore(workspace).getClaudeSetupToken(), "working-token");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("model routing waits for in-flight connection verification and preserves both updates", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-settings-writes-"));
  const verifying = deferred();
  const release = deferred();
  let verificationCalls = 0;
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => {
        verificationCalls += 1;
        verifying.resolve();
        await release.promise;
      },
    });
    await store.put({ llm: { provider: "offline" } });

    const connection = store.put({
      llm: { provider: "anthropic", model: "claude-default", apiKey: "test-key" },
    });
    await verifying.promise;
    const routing = store.putModelsByRoute({
      modelsByRoute: { writing: "claude-writer" },
    });
    try {
      // The old synchronous routing path wrote here, while connection still
      // held a stale settings snapshot that would later overwrite the map.
      await Promise.resolve();
      assert.equal(store.get().llm.modelsByRoute, undefined);
    } finally {
      release.resolve();
      await Promise.all([connection, routing]);
    }

    const saved = await routing;
    assert.equal(saved.llm.provider, "anthropic");
    assert.equal(saved.llm.model, "claude-default");
    assert.equal(saved.llm.apiKeyConfigured, true);
    assert.deepEqual(saved.llm.modelsByRoute, { writing: "claude-writer" });
    assert.deepEqual(new SettingsStore(workspace).get().llm, saved.llm);
    assert.equal(verificationCalls, 1, "routing must not reverify credentials");
  } finally {
    release.resolve();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejected connection verification does not block a queued model-routing save", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-settings-writes-"));
  const verifying = deferred();
  const release = deferred();
  try {
    const store = new SettingsStore(workspace, {
      validateAnthropic: async () => {
        verifying.resolve();
        await release.promise;
        throw new Error("Connection rejected");
      },
    });
    await store.put({ llm: { provider: "offline" } });
    const rejected = assert.rejects(store.put({
      llm: { provider: "anthropic", model: "rejected-model", apiKey: "bad-key" },
    }), /Connection rejected/);
    await verifying.promise;
    const routing = store.putModelsByRoute({ modelsByRoute: { review: "reviewer" } });
    release.resolve();
    await rejected;

    const saved = await routing;
    assert.equal(saved.llm.provider, "offline");
    assert.equal(saved.llm.apiKeyConfigured, false);
    assert.deepEqual(saved.llm.modelsByRoute, { review: "reviewer" });
    assert.deepEqual(store.get().llm, saved.llm);
  } finally {
    release.resolve();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("invalid routing does not poison later writes and clearing routing retains other settings", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "brain-settings-writes-"));
  try {
    const store = new SettingsStore(workspace);
    await store.put({ llm: { provider: "offline" } });
    await store.putModelsByRoute({ modelsByRoute: { review: "reviewer" } });

    const rejected = assert.rejects(
      store.putModelsByRoute({ modelsByRoute: { review: 42 } }),
      /modelsByRoute.review must be a string/,
    );
    const policy = store.put({ gateAutoApprove: false });
    await rejected;
    assert.deepEqual((await policy).llm.modelsByRoute, { review: "reviewer" });

    const cleared = await store.putModelsByRoute({ modelsByRoute: { review: "  " } });
    assert.equal(cleared.llm.modelsByRoute, undefined);
    assert.equal(cleared.gateAutoApprove, false);
    assert.equal(cleared.llm.provider, "offline");
    assert.deepEqual(store.get(), cleared);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
