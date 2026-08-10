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
