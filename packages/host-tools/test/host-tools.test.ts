import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  attachmentTools,
  insideRoots,
  ATTACHMENT_MANIFESTS,
  ALL_HOST_TOOL_MANIFESTS,
  createHostToolRegistry,
  executableHostToolIds,
  availableHostToolManifests,
} from "../src/index.js";

describe("insideRoots", () => {
  it("accepts paths within roots", () => {
    assert.ok(insideRoots(["/a/b"], "/a/b/c.txt"));
    assert.ok(insideRoots(["/a/b"], "/a/b"));
  });

  it("rejects paths outside roots", () => {
    assert.ok(!insideRoots(["/a/b"], "/a/c.txt"));
    assert.ok(!insideRoots(["/a/b"], "/a/b/../c.txt"));
    assert.ok(!insideRoots(["/a/b"], "/etc/passwd"));
  });
});

describe("attachmentTools", () => {
  it("creates two tools", () => {
    const tools = attachmentTools(["/tmp"]);
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.definition.name, "attachment_list");
    assert.equal(tools[1]!.definition.name, "attachment_read");
  });

  it("attachment_list walks the root directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "a.txt"), "hello");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "world");

    const tools = attachmentTools([root]);
    const result = await tools[0]!.execute({}, { runId: "r1" });
    const files = (result.output as { files: { path: string; bytes: number }[] }).files;
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.path.endsWith("a.txt")));
    assert.ok(files.some((f) => f.path.endsWith("b.txt")));
  });

  it("attachment_read returns text content", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "file.txt"), "content here");

    const tools = attachmentTools([root]);
    const result = await tools[1]!.execute({ path: join(root, "file.txt") }, { runId: "r1" });
    assert.equal(result.output, "content here");
    assert.equal(result.isError, undefined);
  });

  it("attachment_read refuses paths outside roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    const tools = attachmentTools([root]);
    const result = await tools[1]!.execute({ path: "/etc/passwd" }, { runId: "r1" });
    assert.equal(result.isError, true);
  });
});

describe("manifests", () => {
  it("ATTACHMENT_MANIFESTS has correct operations", () => {
    assert.equal(ATTACHMENT_MANIFESTS.length, 2);
    assert.deepEqual(ATTACHMENT_MANIFESTS[0]!.operations, ["attachment.list"]);
    assert.deepEqual(ATTACHMENT_MANIFESTS[1]!.operations, ["attachment.read"]);
  });

  it("ALL_HOST_TOOL_MANIFESTS includes all tools", () => {
    const ids = ALL_HOST_TOOL_MANIFESTS.map((m) => m.toolId);
    assert.ok(ids.includes("attachment_list"));
    assert.ok(ids.includes("attachment_read"));
    assert.ok(ids.includes("web_search"));
    assert.ok(ids.includes("web_fetch"));
    assert.ok(ids.includes("code_execute"));
  });
});

describe("createHostToolRegistry", () => {
  it("registers only enabled tools with roots", () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    const { registry, registeredToolNames } = createHostToolRegistry({
      attachmentRoots: [root],
      enabledToolIds: new Set(["attachment_list"]),
    });
    assert.equal(registeredToolNames.length, 1);
    assert.equal(registeredToolNames[0], "attachment_list");
    assert.ok(registry.get("attachment_list"));
    assert.equal(registry.get("attachment_read"), undefined);
  });

  it("registers nothing without roots", () => {
    const { registeredToolNames } = createHostToolRegistry({
      enabledToolIds: new Set(["attachment_list", "attachment_read"]),
    });
    assert.equal(registeredToolNames.length, 0);
  });
});

describe("executableHostToolIds", () => {
  it("returns attachment tool ids when roots available", () => {
    const ids = executableHostToolIds({ attachmentRoots: ["/tmp"] });
    assert.ok(ids.has("attachment_list"));
    assert.ok(ids.has("attachment_read"));
    assert.equal(ids.size, 2);
  });

  it("returns empty when no roots", () => {
    const ids = executableHostToolIds({});
    assert.equal(ids.size, 0);
  });
});

describe("availableHostToolManifests", () => {
  it("includes all manifests (some non-executable)", () => {
    const manifests = availableHostToolManifests({ attachmentRoots: ["/tmp"] });
    assert.ok(manifests.length >= 5);
    const ids = manifests.map((m) => m.toolId);
    assert.ok(ids.includes("attachment_list"));
    assert.ok(ids.includes("web_search"));
    assert.ok(ids.includes("code_execute"));
  });
});
