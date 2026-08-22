import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

test("a keepalive holds a quiet thread through the staleness bound", () => {
  // A model writing its structured output is silent for minutes (its deltas
  // are never shown), and a long verification command is silent for as long
  // as it runs. The worker vouches for the task with bare records; the thread
  // must survive them — and still expire once even those stop, because that
  // is a worker that died.
  const { file, cleanup } = temp();
  try {
    let now = 1_000_000;
    const store = new LiveTextStore(file, () => now);
    const seen = new Map<string, number>();
    appendFileSync(file, record("member[0]", "now writing the final output"));
    store.poll();
    store.deltas(seen);
    now += 100_000;
    appendFileSync(file, JSON.stringify({ p: "member[0]" }) + "\n"); // keepalive
    store.poll();
    now += 100_000; // 200s since the words — but 100s since the keepalive
    store.poll();
    assert.deepEqual(store.deltas(seen), [], "the thread survives: its task still runs");
    now += 130_000; // no further keepalive: the worker is gone
    store.poll();
    assert.deepEqual(store.deltas(seen), [{ path: "member[0]", ended: true }]);
  } finally {
    cleanup();
  }
});

test("a keepalive never conjures a thread", () => {
  // A keepalive for a thread that ended (or never spoke) must not put an
  // empty box on the page: it refreshes what exists, nothing more.
  const { file, cleanup } = temp();
  try {
    const store = new LiveTextStore(file);
    appendFileSync(file, JSON.stringify({ p: "member[0]" }) + "\n");
    store.poll();
    assert.equal(store.liveCount, 0);
    assert.deepEqual(store.deltas(new Map()), []);
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

test("the worker's keepalive cadence fits inside this reader's staleness bound", () => {
  // The heartbeat and the bound live in different processes that share only a
  // file, so nothing at runtime checks they agree — and a staleness bound
  // tightened below two heartbeats would silently bring back the vanishing
  // threads this pair of constants exists to prevent.
  const constant = (source: string, name: string): number =>
    Number(
      new RegExp(`${name} = ([\\d_]+)`).exec(source)?.[1]?.replaceAll("_", ""),
    );
  const keepalive = constant(
    readFileSync(new URL("../../../worker/src/live-text.ts", import.meta.url), "utf8"),
    "LIVE_TEXT_KEEPALIVE_MS",
  );
  const stale = constant(
    readFileSync(new URL("../../src/live-text.ts", import.meta.url), "utf8"),
    "STALE_MS",
  );
  assert.ok(Number.isFinite(keepalive) && keepalive > 0, "the worker declares its heartbeat");
  assert.ok(Number.isFinite(stale) && stale > 0, "the reader declares its bound");
  assert.ok(
    keepalive * 2 <= stale,
    `two heartbeats (${keepalive}ms apart) must fit inside the staleness bound (${stale}ms), ` +
      "so one lost write cannot kill a live thread",
  );
});
