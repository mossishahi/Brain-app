import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LiveTextStore } from "../src/live-text.js";

function temp(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "live-store-"));
  const file = join(dir, "live-text.jsonl");
  writeFileSync(file, "");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const record = (p: string, t?: string, done?: true): string =>
  JSON.stringify(done === true ? { p, done } : { p, t }) + "\n";

test("a reader is sent only what it has not seen", () => {
  // The point of the whole channel: a thread grows to tens of kilobytes over
  // minutes, and re-sending it on every frame is what would hurt the network.
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    const seen = new Map<string, number>();
    appendFileSync(file, record("member[0]", "I am reading "));
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", append: "I am reading " }]);

    appendFileSync(file, record("member[0]", "step five."));
    store.poll();
    assert.deepEqual(
      store.deltas(seen),
      [{ path: "member[0]", append: "step five." }],
      "the second frame carries the second sentence alone",
    );
    assert.deepEqual(store.deltas(seen), [], "and nothing at all when nothing was written");
  } finally {
    cleanup();
  }
});

test("two readers each get their own position in the same thread", () => {
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    const first = new Map<string, number>();
    const second = new Map<string, number>();
    appendFileSync(file, record("member[0]", "one "));
    store.poll();
    assert.deepEqual(store.deltas(first), [{ path: "member[0]", append: "one " }]);
    appendFileSync(file, record("member[0]", "two"));
    store.poll();
    assert.deepEqual(store.deltas(first), [{ path: "member[0]", append: "two" }]);
    assert.deepEqual(
      store.deltas(second),
      [{ path: "member[0]", append: "one two" }],
      "a reader that has just opened the page gets what it walked in on",
    );
  } finally {
    cleanup();
  }
});

test("a thread ends when its task's output exists, and the reader is told once", () => {
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    const seen = new Map<string, number>();
    appendFileSync(file, record("member[0]", "thinking"));
    store.poll();
    store.deltas(seen);
    appendFileSync(file, record("member[0]", undefined, true));
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", ended: true }]);
    assert.equal(store.liveCount, 0, "and nothing of it is kept");
    assert.deepEqual(store.deltas(seen), [], "the end is reported once, not forever");
  } finally {
    cleanup();
  }
});

test("a stale thread is dropped even though no end record arrived", () => {
  // A worker killed mid-task writes no end record, and a thread left standing
  // would show a dead agent as talking.
  const { file, cleanup } = temp();
  try {
    let now = 1_000_000;
    const store = new LiveTextStore(file, () => now);
    const seen = new Map<string, number>();
    appendFileSync(file, record("member[0]", "mid-sentence"));
    store.poll();
    store.deltas(seen);
    now += 10 * 60_000;
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", ended: true }]);
  } finally {
    cleanup();
  }
});

test("a fresh worker's truncation ends every thread of the last one", () => {
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    const seen = new Map<string, number>();
    appendFileSync(file, record("member[0]", "a long thought from the attempt that died"));
    store.poll();
    store.deltas(seen);
    writeFileSync(file, ""); // the next worker starts fresh
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", ended: true }]);
  } finally {
    cleanup();
  }
});

test("a half-written line is not parsed until its newline lands", () => {
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    const seen = new Map<string, number>();
    appendFileSync(file, '{"p":"member[0]","t":"half a re');
    store.poll();
    assert.deepEqual(store.deltas(seen), [], "nothing is guessed at");
    appendFileSync(file, 'cord"}\n');
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", append: "half a record" }]);
  } finally {
    cleanup();
  }
});

test("a missing file is simply no live text", () => {
  const store = new LiveTextStore("/nonexistent/live-text.jsonl");
  store.poll();
  assert.deepEqual(store.deltas(new Map()), []);
});
