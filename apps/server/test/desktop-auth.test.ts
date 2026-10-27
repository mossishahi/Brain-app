import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowsSourceUpdates, authorizedDesktopRequest, readDesktopApiToken } from "../src/desktop-auth.js";

test("desktop auth accepts only the exact bearer token", () => {
  const token = "a".repeat(64);
  for (const header of [undefined, token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${"b".repeat(64)}`]) {
    assert.equal(authorizedDesktopRequest(header, token), false);
  }
  assert.equal(authorizedDesktopRequest(`Bearer ${token}`, token), true);
});

test("desktop token is read only from an owner-only regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-token-"));
  const path = join(root, "token");
  try {
    assert.equal(readDesktopApiToken({}), undefined);
    writeFileSync(path, "a".repeat(64), { mode: 0o600 });
    assert.equal(readDesktopApiToken({ BRAINSTORM_API_TOKEN_FILE: path }), "a".repeat(64));
    chmodSync(path, 0o644);
    assert.throws(() => readDesktopApiToken({ BRAINSTORM_API_TOKEN_FILE: path }), /owner-only/);
    chmodSync(path, 0o600);
    writeFileSync(path, "weak");
    assert.throws(() => readDesktopApiToken({ BRAINSTORM_API_TOKEN_FILE: path }), /32/);
    const link = join(root, "link"); symlinkSync(path, link);
    assert.throws(() => readDesktopApiToken({ BRAINSTORM_API_TOKEN_FILE: link }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packaged releases cannot enable the source-code updater", () => {
  assert.equal(allowsSourceUpdates({}), true);
  assert.equal(allowsSourceUpdates({ CO_INFERENCE_PACKAGED: "1" }), false);
  assert.equal(allowsSourceUpdates({ BRAINSTORM_DISABLE_SELF_UPDATE: "1" }), false);
});
