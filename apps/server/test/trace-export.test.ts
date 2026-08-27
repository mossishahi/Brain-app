import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";

import yauzl, { type Entry } from "yauzl";

import { buildRunTrace } from "../src/trace-export.js";
import { crc32Table, zipArchive, type ZipEntry } from "../src/zip.js";

/** Reads a zipArchive buffer back through yauzl: name -> content. */
function readZip(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zipfile) => {
      if (error) return rejectPromise(error);
      const found = new Map<string, Buffer>();
      zipfile.on("entry", (entry: Entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return rejectPromise(streamError);
          const pieces: Buffer[] = [];
          stream.on("data", (piece: Buffer) => pieces.push(piece));
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(pieces));
            zipfile.readEntry();
          });
          stream.on("error", rejectPromise);
        });
      });
      zipfile.on("end", () => resolvePromise(found));
      zipfile.on("error", rejectPromise);
      zipfile.readEntry();
    });
  });
}

test("zipArchive round-trips through yauzl, the reader the app already trusts", async () => {
  const entries: ZipEntry[] = [
    { path: "README.md", data: "# hello\n" },
    // Compressible: deflate wins and the entry goes method 8.
    { path: "journal/01-setup.json", data: JSON.stringify({ a: "x".repeat(5000) }) },
    // Incompressible bytes: store wins and the entry goes method 0.
    { path: "noise.bin", data: Buffer.from([1, 2, 3, 255, 128, 7]) },
  ];
  const archive = await zipArchive(entries);
  const found = await readZip(archive);
  assert.equal(found.size, entries.length);
  for (const entry of entries) {
    const raw =
      typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    assert.deepEqual(found.get(entry.path), raw, entry.path);
  }
});

test("the table crc32 agrees with zlib's native one", () => {
  const native = (zlib as { crc32?: (data: Buffer) => number }).crc32;
  // Every supported Node carries zlib.crc32; if this ever fails, the writer
  // silently fell back to the table — which this test then still validates.
  assert.equal(typeof native, "function");
  for (const sample of ["", "a", "hello world", "x".repeat(10_000)]) {
    const data = Buffer.from(sample, "utf8");
    assert.equal(crc32Table(data), native!(data) >>> 0, JSON.stringify(sample.slice(0, 16)));
  }
});

/** One fake run on disk: session + job directories with the record files. */
function writeFixture(root: string, runId: string): { sessionDir: string; jobDir: string } {
  const sessionDir = join(root, "sessions", runId);
  const jobDir = join(root, "jobs", runId);
  mkdirSync(join(sessionDir, "artifacts"), { recursive: true });
  mkdirSync(join(sessionDir, "final"), { recursive: true });
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "checkpoint.json"),
    JSON.stringify({
      runId,
      workflowId: "brainstorm",
      workflowVersion: "0.28.0",
      status: "completed",
      input: { __brainstormState: { session: { submission: { prompt: "trace me" } } } },
      journalFormat: 2,
      journal: [
        {
          key: "brainstorm-root/process-input/process-input-execute::result",
          kind: "agent",
          value: { output: { title: "t" } },
        },
        {
          key: "brainstorm-root/classify-input/classify-input-execute::result",
          kind: "agent",
          value: { output: { primary: { type: "research idea" } } },
        },
        {
          key: "brainstorm-root/build-pool/build-pool-execute::result",
          kind: "agent",
          value: { output: { pool: [] } },
        },
        {
          key: "brainstorm-root/first-pass/member[0]/develop-idea/develop-idea-execute::result",
          kind: "agent",
          value: { output: { cot: ["step"] } },
        },
        {
          key: "brainstorm-root/review-members/member[0]/review-steps/cotStep[0]/review-round/iter[0]/review-round-body/judge-step/judge-step-execute::result",
          kind: "agent",
          value: { output: { verdict: "Pass" } },
        },
        {
          key: "brainstorm-root/review-members/member[1]/review-steps/cotStep[0]/review-round/iter[0]/review-round-body/judge-step/judge-step-execute::result",
          kind: "agent",
          value: { output: { verdict: "Pass" } },
        },
        {
          key: "brainstorm-root/synthesize-proposal/synthesize-proposal-execute::result",
          kind: "agent",
          value: { output: { title: "proposal" } },
        },
      ],
      pendingGates: [],
      seq: 9,
      updatedAt: 1,
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "index.json"),
    JSON.stringify({
      counter: 1,
      refs: [
        {
          id: "artifact-1",
          name: `${runId}/brainstorm-root/first-pass/member[1]/develop-idea/develop-idea-execute.thinking.json`,
          size: 1,
          contentType: "application/json",
          metadata: {
            kind: "thinking",
            nodePath: "brainstorm-root/first-pass/member[1]/develop-idea/develop-idea-execute",
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(sessionDir, "artifacts", "artifact-1"),
    JSON.stringify({
      nodePath: "brainstorm-root/first-pass/member[1]/develop-idea/develop-idea-execute",
      segments: [{ turn: 1, text: "first thought" }, { turn: 2, text: "second thought" }],
      stepTurns: [],
    }),
  );
  writeFileSync(join(sessionDir, "searches.jsonl"), '{"query":"q"}\n');
  writeFileSync(join(sessionDir, "final", "member-1.json"), '{"done":true}\n');
  writeFileSync(join(jobDir, "events.jsonl"), '{"type":"run:started"}\n');
  writeFileSync(join(jobDir, "job.json"), JSON.stringify({ jobId: runId }));
  return { sessionDir, jobDir };
}

test("buildRunTrace deals the record into named, attachable files", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-export-"));
  try {
    const runId = "bsa_trace_fixture";
    const { sessionDir, jobDir } = writeFixture(root, runId);
    const files = await buildRunTrace({ runId, sessionDir, jobDir });
    assert.ok(files !== undefined);
    const byPath = new Map(files.map((file) => [file.path, file.data]));
    assert.deepEqual(
      [...byPath.keys()].sort(),
      [
        "README.md",
        "events.jsonl",
        "final/member-1.json",
        "job.json",
        "journal/00-run.json",
        "journal/01-setup.json",
        "journal/02-first-pass.json",
        "journal/03-review-seat-1.json",
        "journal/03-review-seat-2.json",
        "journal/04-closing.json",
        "searches.jsonl",
        "thinking-seat-2.md",
      ],
    );
    // The frame keeps everything but the journal — the submission included.
    const frame = JSON.parse(byPath.get("journal/00-run.json")!);
    assert.equal(frame.journal, undefined);
    assert.equal(
      frame.input.__brainstormState.session.submission.prompt,
      "trace me",
    );
    // A seat's walk lands in its own file, named as the dashboard names seats.
    assert.match(byPath.get("journal/03-review-seat-2.json")!, /member\[1\]/);
    // The thinking renders as prose under its task's path.
    const thinking = byPath.get("thinking-seat-2.md")!;
    assert.match(thinking, /## brainstorm-root\/first-pass\/member\[1\]/);
    assert.match(thinking, /first thought\n\nsecond thought/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files split into parts before they reach the per-file cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-export-"));
  try {
    const runId = "bsa_trace_split";
    const { sessionDir, jobDir } = writeFixture(root, runId);
    // A tiny cap forces every multi-entry file to split.
    const files = await buildRunTrace({ runId, sessionDir, jobDir, splitBytes: 200 });
    assert.ok(files !== undefined);
    const setupParts = files.filter((file) => file.path.startsWith("journal/01-setup"));
    assert.ok(setupParts.length > 1, "expected the setup journal to split");
    for (const file of files) {
      // Parts must respect the cap wherever a file HAS more than one entry to
      // split over (a single oversized entry cannot be cut, by design).
      if (/-part\d+\.json$/.test(file.path)) {
        assert.ok(Buffer.byteLength(file.data) <= 400, file.path);
      }
    }
    // The parts reassemble to the same entries, in order.
    const reassembled = setupParts.flatMap(
      (file) => JSON.parse(file.data) as { key?: string }[],
    );
    assert.deepEqual(
      reassembled.map((entry) => entry.key),
      [
        "brainstorm-root/process-input/process-input-execute::result",
        "brainstorm-root/classify-input/classify-input-execute::result",
        "brainstorm-root/build-pool/build-pool-execute::result",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run with no checkpoint has nothing to export", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-export-"));
  try {
    const files = await buildRunTrace({
      runId: "bsa_missing",
      sessionDir: join(root, "sessions", "bsa_missing"),
      jobDir: join(root, "jobs", "bsa_missing"),
    });
    assert.equal(files, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
