import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { providerConfigFromEnv } from "../src/wiring.js";

// Held pilots are queued with --export=NONE long before any run exists, so
// secrets cannot ride the scheduler environment; the server points the
// worker at the owner-only credentials file instead
// (BRAINSTORM_AGENTIC_CREDENTIALS_FILE, emitted by the pilot channel).
test("the credentials file fills secrets the scheduler environment cannot carry", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-creds-"));
  try {
    const file = join(dir, "credentials.json");
    writeFileSync(
      file,
      JSON.stringify({
        anthropicApiKey: "file-key",
        claudeSetupToken: "file-token",
        openRouterApiKey: "file-router",
      }),
    );

    const fromFile = providerConfigFromEnv(
      {
        BRAINSTORM_AGENTIC_CREDENTIALS_FILE: file,
        BRAINSTORM_AGENTIC_PROVIDER: "anthropic",
        BRAINSTORM_AGENTIC_MODEL: "claude-test",
      },
      false,
    );
    assert.equal(fromFile.apiKey, "file-key");
    assert.equal(fromFile.setupToken, "file-token");
    assert.equal(fromFile.creditRecovery?.openRouterApiKey, "file-router");

    // The environment always wins; the file only fills gaps.
    const envWins = providerConfigFromEnv(
      {
        BRAINSTORM_AGENTIC_CREDENTIALS_FILE: file,
        ANTHROPIC_API_KEY: "env-key",
      },
      false,
    );
    assert.equal(envWins.apiKey, "env-key");

    // A missing or unreadable file contributes nothing — the run then fails
    // with the normal missing-credential error, never a crash here.
    const missing = providerConfigFromEnv(
      { BRAINSTORM_AGENTIC_CREDENTIALS_FILE: join(dir, "absent.json") },
      false,
    );
    assert.equal(missing.apiKey, undefined);

    // Offline runs read no credentials at all.
    const offline = providerConfigFromEnv(
      { BRAINSTORM_AGENTIC_CREDENTIALS_FILE: file },
      true,
    );
    assert.equal(offline.provider, "offline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini credentials use explicit environment keys before the queued-worker credential file", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gemini-creds-"));
  try {
    const file = join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ geminiApiKey: "synthetic-file-gemini", anthropicApiKey: "synthetic-file-anthropic" }));
    const env = { BRAINSTORM_AGENTIC_PROVIDER: "gemini", BRAINSTORM_AGENTIC_CREDENTIALS_FILE: file,
      BRAINSTORM_AGENTIC_MODEL: "gemini-3.5-flash-lite", ANTHROPIC_BASE_URL: "https://anthropic.invalid",
      GEMINI_BASE_URL: "https://gemini.invalid", BRAINSTORM_AGENTIC_TRANSCRIPT: "off",
    };
    const fromFile = providerConfigFromEnv(env, false);
    assert.equal(fromFile.provider, "gemini");
    assert.equal(fromFile.geminiApiKey, "synthetic-file-gemini");
    assert.equal(fromFile.defaultModel, "gemini-3.5-flash-lite");
    assert.equal(fromFile.baseURL, "https://gemini.invalid");
    assert.equal(fromFile.transcript, "off");
    assert.equal(providerConfigFromEnv({ ...env, GOOGLE_API_KEY: "synthetic-google" }, false).geminiApiKey, "synthetic-google");
    assert.equal(providerConfigFromEnv({ ...env, GOOGLE_API_KEY: "synthetic-google", GEMINI_API_KEY: "synthetic-gemini" }, false).geminiApiKey, "synthetic-gemini");
    // A deliberately empty primary value must not revive a previously saved key.
    assert.equal(providerConfigFromEnv({ ...env, GEMINI_API_KEY: "" }, false).geminiApiKey, undefined);
    assert.equal(providerConfigFromEnv({ ...env, BRAINSTORM_AGENTIC_PROVIDER: "anthropic" }, false).baseURL, "https://anthropic.invalid");
    assert.equal(providerConfigFromEnv({ ...env, GEMINI_BASE_URL: undefined }, false).baseURL, undefined);
    const offline = providerConfigFromEnv({ ...env, GEMINI_API_KEY: "synthetic-unused" }, true);
    assert.equal(offline.provider, "offline");
    assert.equal(offline.geminiApiKey, undefined);
    assert.equal(offline.apiKey, undefined);
    assert.equal(offline.transcript, "off");
    writeFileSync(file, JSON.stringify({ geminiApiKey: { unexpected: "value" } }));
    assert.equal(providerConfigFromEnv(env, false).geminiApiKey, undefined);
    writeFileSync(file, "invalid-json");
    assert.equal(providerConfigFromEnv(env, false).geminiApiKey, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
