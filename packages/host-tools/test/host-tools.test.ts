import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  attachmentTools,
  codeExecutionTools,
  insideRoots,
  prepareCodeWorkspace,
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
  it("creates three tools", () => {
    const tools = attachmentTools(["/tmp"]);
    assert.equal(tools.length, 3);
    assert.equal(tools[0]!.definition.name, "attachment_list");
    assert.equal(tools[1]!.definition.name, "attachment_read");
    assert.equal(tools[2]!.definition.name, "attachment_search");
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

  it("attachment_list hides the ingest manifest but not a nested one", async () => {
    // The server writes its record of what it ingested AT the root of the store
    // it describes, while every submitted file is materialized one directory
    // down. Listing it presented host bookkeeping as one of the submitter's
    // files and put the inventory one ahead of the count the manifest reports.
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "manifest.json"), '{"version":1}');
    mkdirSync(join(root, "0-project"));
    writeFileSync(join(root, "0-project", "paper.txt"), "hello");
    // A file the SUBMITTER happens to have named manifest.json is theirs, and
    // it can only ever appear below the root.
    writeFileSync(join(root, "0-project", "manifest.json"), '{"mine":true}');

    const tools = attachmentTools([root]);
    const result = await tools[0]!.execute({}, { runId: "r1" });
    const files = (result.output as { files: { path: string }[] }).files;
    assert.deepEqual(
      files.map((f) => f.path.slice(root.length + 1)).sort(),
      [join("0-project", "manifest.json"), join("0-project", "paper.txt")].sort(),
    );
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

  it("attachment_list returns a nested tree when shape is tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "a.txt"), "hello");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "world");

    const tools = attachmentTools([root]);
    const result = await tools[0]!.execute({ shape: "tree" }, { runId: "r1" });
    const roots = (result.output as { roots: Record<string, Record<string, unknown>> }).roots;
    const tree = Object.values(roots)[0]!;
    assert.equal(tree["a.txt"], 5);
    assert.deepEqual(tree["sub"], { "b.txt": 5 });
  });

  it("attachment_search returns matching lines with path and line number", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "a.py"), "import torch\nclass Encoder:\n    pass\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.py"), "# encoder utilities\nENCODER = 1\n");
    writeFileSync(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const tools = attachmentTools([root]);
    const result = await tools[2]!.execute({ query: "encoder" }, { runId: "r1" });
    assert.equal(result.isError, undefined);
    const output = result.output as {
      matches: { path: string; line: number; text: string }[];
      files: { path: string; matches: number }[];
      totalMatches: number;
      filesSearched: number;
    };
    assert.equal(output.totalMatches, 3);
    assert.equal(output.filesSearched, 2);
    assert.ok(
      output.matches.some((m) => m.path.endsWith("a.py") && m.line === 2 && /Encoder/.test(m.text)),
    );
    assert.ok(output.matches.some((m) => m.path.endsWith("b.py") && m.line === 1));
    assert.equal(output.files.length, 2);
  });

  it("attachment_search respects case sensitivity, regex, and filesOnly", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    writeFileSync(join(root, "a.txt"), "Alpha\nalpha\nbeta-42\n");

    const tools = attachmentTools([root]);
    const caseSensitive = await tools[2]!.execute(
      { query: "Alpha", caseSensitive: true },
      { runId: "r1" },
    );
    assert.equal((caseSensitive.output as { totalMatches: number }).totalMatches, 1);

    const viaRegex = await tools[2]!.execute(
      { query: "beta-\\d+", regex: true },
      { runId: "r1" },
    );
    assert.equal((viaRegex.output as { totalMatches: number }).totalMatches, 1);

    const filesOnly = await tools[2]!.execute(
      { query: "alpha", filesOnly: true },
      { runId: "r1" },
    );
    const output = filesOnly.output as {
      matches?: unknown;
      files: { path: string; matches: number }[];
    };
    assert.equal(output.matches, undefined);
    assert.equal(output.files[0]!.matches, 2);
  });

  it("attachment_search refuses an empty query and a broken regex", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-test-"));
    const tools = attachmentTools([root]);
    const empty = await tools[2]!.execute({}, { runId: "r1" });
    assert.equal(empty.isError, true);
    const broken = await tools[2]!.execute({ query: "([", regex: true }, { runId: "r1" });
    assert.equal(broken.isError, true);
  });
});

describe("manifests", () => {
  it("ATTACHMENT_MANIFESTS has correct operations", () => {
    assert.equal(ATTACHMENT_MANIFESTS.length, 3);
    assert.deepEqual(ATTACHMENT_MANIFESTS[0]!.operations, ["attachment.list"]);
    assert.deepEqual(ATTACHMENT_MANIFESTS[1]!.operations, ["attachment.read"]);
    assert.deepEqual(ATTACHMENT_MANIFESTS[2]!.operations, ["attachment.search"]);
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
    assert.ok(ids.has("attachment_search"));
    assert.ok(ids.has("web_fetch"));
    assert.equal(ids.size, 4);
  });

  it("returns only the config-free web_fetch when nothing is configured", () => {
    const ids = executableHostToolIds({});
    assert.deepEqual([...ids], ["web_fetch"]);
  });

  it("includes gpu_run only when the deployment completed a template", () => {
    const gpuRun = {
      template: "#!/bin/bash\n{{AGENT_COMMAND}}\n",
      timeLimitMinutes: 30,
      jobsRoot: "/tmp/gpu-jobs",
    };
    assert.ok(executableHostToolIds({ gpuRun }).has("gpu_run"));
    assert.ok(!executableHostToolIds({}).has("gpu_run"));

    const withConfig = createHostToolRegistry({
      gpuRun,
      enabledToolIds: new Set(["gpu_run"]),
    });
    assert.deepEqual(withConfig.registeredToolNames, ["gpu_run"]);
    const withoutConfig = createHostToolRegistry({
      enabledToolIds: new Set(["gpu_run"]),
    });
    assert.equal(withoutConfig.registeredToolNames.length, 0);
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

describe("code execution", () => {
  it("prepares a workspace and runs a JavaScript script", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root);
    assert.ok(environment.node.version.startsWith("v"));

    const tools = codeExecutionTools(environment);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.definition.name, "code_execute");
    const result = await tools[0]!.execute(
      { language: "javascript", code: "console.log(6 * 7)" },
      { runId: "r1" },
    );
    const output = result.output as { exitCode: number; stdout: string };
    assert.equal(result.isError, undefined);
    assert.equal(output.exitCode, 0);
    assert.match(output.stdout, /42/);
  });

  it("reports a non-zero exit as a readable result, not an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root);
    const tools = codeExecutionTools(environment);
    const result = await tools[0]!.execute(
      {
        language: "javascript",
        code: 'console.error("assertion failed"); process.exit(3)',
      },
      { runId: "r1" },
    );
    const output = result.output as { exitCode: number; stderr: string; debug: string };
    assert.equal(result.isError, undefined);
    assert.equal(output.exitCode, 3);
    assert.match(output.stderr, /assertion failed/);
    // The debug-and-relaunch contract: a failure is addressed back to the
    // submitter with standing permission to rerun the fixed script.
    assert.match(output.debug, /bug report addressed to you, the submitter/i);
    assert.match(output.debug, /rerun this tool/i);
  });

  it("refuses python honestly when no interpreter exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root, {
      pythonCandidates: ["definitely-not-a-python-binary"],
    });
    assert.equal(environment.python, undefined);
    const tools = codeExecutionTools(environment);
    const result = await tools[0]!.execute(
      { language: "python", code: "print('hi')" },
      { runId: "r1" },
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output), /python interpreter/);
  });

  it("kills scripts at the timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root);
    const tools = codeExecutionTools(environment);
    const result = await tools[0]!.execute(
      {
        language: "javascript",
        code: "setInterval(() => {}, 1000); console.log('spinning')",
        timeout_ms: 1000,
      },
      { runId: "r1" },
    );
    const output = result.output as { timedOut: boolean };
    assert.equal(result.isError, true);
    assert.equal(output.timedOut, true);
  });

  it("never leaks credentials into the script environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root);
    const tools = codeExecutionTools(environment, {
      ...process.env,
      ANTHROPIC_API_KEY: "super-secret",
      PATH: process.env.PATH,
    });
    const result = await tools[0]!.execute(
      {
        language: "javascript",
        code: "console.log(JSON.stringify(process.env))",
      },
      { runId: "r1" },
    );
    const output = result.output as { stdout: string };
    assert.ok(!output.stdout.includes("super-secret"));
  });

  it("registers code_execute only over a prepared workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-tools-code-"));
    const environment = await prepareCodeWorkspace(root);
    const withEnvironment = createHostToolRegistry({
      codeEnvironment: environment,
      enabledToolIds: new Set(["code_execute"]),
    });
    assert.deepEqual(withEnvironment.registeredToolNames, ["code_execute"]);
    const withoutEnvironment = createHostToolRegistry({
      enabledToolIds: new Set(["code_execute"]),
    });
    assert.equal(withoutEnvironment.registeredToolNames.length, 0);
    assert.ok(
      executableHostToolIds({ codeEnvironment: environment }).has("code_execute"),
    );
  });
});
