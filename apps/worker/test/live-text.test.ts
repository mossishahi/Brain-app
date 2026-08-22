import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiveTextLog, noLiveText } from "../src/live-text.js";

function temp(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "live-text-"));
  return { file: join(dir, "live-text.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const lines = (file: string): { p: string; t?: string; done?: true }[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { p: string; t?: string; done?: true });

test("fragments are batched into one write, in order, per task", async () => {
  // A model emits deltas continuously; the worker and the server share only a
  // network filesystem, so a write per delta would be hundreds of tiny writes a
  // second for something a reader looks at once a second.
  const { file, cleanup } = temp();
  try {
    const log = createLiveTextLog(file);
    for (const word of ["I ", "am ", "reading ", "step ", "five"]) log.note("member[0]", word);
    log.note("member[1]", "meanwhile");
    await log.close();
    const written = lines(file);
    assert.equal(written.length, 2, "one record per task, not one per fragment");
    assert.deepEqual(
      written.find((line) => line.p === "member[0]"),
      { p: "member[0]", t: "I am reading step five" },
      "fragments concatenate in the order the model produced them",
    );
    assert.equal(written.find((line) => line.p === "member[1]")?.t, "meanwhile");
  } finally {
    cleanup();
  }
});

test("a task's end is recorded, and its unsent fragments are dropped with it", async () => {
  // The end is the whole point of the channel's lifetime: the task's OUTPUT now
  // exists, so the thread must vanish rather than linger beside the real thing.
  const { file, cleanup } = temp();
  try {
    const log = createLiveTextLog(file);
    log.note("member[0]", "half a thought");
    log.end("member[0]");
    await log.close();
    assert.deepEqual(lines(file), [{ p: "member[0]", done: true }]);
  } finally {
    cleanup();
  }
});

test("a fresh worker starts a fresh file", async () => {
  // The previous attempt's fragments describe work that is no longer running:
  // its tasks either finished or will replay from the journal.
  const { file, cleanup } = temp();
  try {
    writeFileSync(file, JSON.stringify({ p: "member[0]", t: "from the attempt that died" }) + "\n");
    const log = createLiveTextLog(file);
    log.note("member[1]", "this attempt");
    await log.close();
    const written = lines(file);
    assert.deepEqual(
      written.map((line) => line.p),
      ["member[1]"],
      "nothing of the previous attempt survives",
    );
  } finally {
    cleanup();
  }
});

test("a quiet thread is kept alive until its task ends", async () => {
  // The regression this pins: a model writing its structured output emits no
  // forwardable fragments for minutes, and a long verification command is
  // silent for as long as it runs. The reader drops any thread that is quiet
  // past its staleness bound (a killed worker writes no end record), so
  // without a heartbeat the panel went blank exactly while the model did its
  // final work — as if the output existed when it did not.
  const { file, cleanup } = temp();
  try {
    const log = createLiveTextLog(file, 20); // a test-sized heartbeat
    log.note("member[0]", "about to go quiet");
    log.end("member[1]"); // ended without ever speaking: nothing to vouch for
    await new Promise((resolve) => setTimeout(resolve, 100));
    log.end("member[0]");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await log.close();
    const written = lines(file);
    const isTick = (line: { t?: string; done?: true }): boolean =>
      line.t === undefined && line.done !== true;
    const ticks = written.filter((line) => line.p === "member[0]" && isTick(line));
    assert.ok(
      ticks.length >= 2,
      `the quiet thread is re-announced on a cadence (saw ${ticks.length})`,
    );
    const doneIndex = written.findIndex(
      (line) => line.p === "member[0]" && line.done === true,
    );
    assert.ok(doneIndex >= 0, "the end record still lands");
    assert.equal(
      written
        .slice(doneIndex + 1)
        .filter((line) => line.p === "member[0]" && isTick(line)).length,
      0,
      "an ended thread is vouched for no further",
    );
    assert.equal(
      written.filter((line) => line.p === "member[1]" && isTick(line)).length,
      0,
      "a task that never spoke has no thread to keep alive",
    );
  } finally {
    cleanup();
  }
});

test("an unwritable file never touches the run", async () => {
  // Live text is the one channel allowed to fail silently: it exists so a reader
  // has something to watch, and the run must not notice a filesystem blip.
  const log = createLiveTextLog("/nonexistent-directory-for-live-text/x.jsonl");
  log.note("member[0]", "text");
  log.end("member[0]");
  await log.close();
});

test("a host that shows no live text spends nothing", async () => {
  const log = noLiveText();
  log.note("member[0]", "ignored");
  log.end("member[0]");
  await log.close();
});
