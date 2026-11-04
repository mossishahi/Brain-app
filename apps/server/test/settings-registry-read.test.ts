import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityCatalog } from "../src/capability-catalog.js";
import { WorkflowParamsCatalog } from "../src/panel-composition.js";
import type { SettingsRegistryReadOptions } from "../src/settings-registry-read.js";

for (const kind of ["capabilities", "workflow parameters"] as const) {
  test(`${kind} coalesce reads, retain cached data on timeout, and reject late updates`, { timeout: 2000 }, async t => {
    let now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    let clients = 0;
    let closes = 0;
    let lateReads = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const options: SettingsRegistryReadOptions = {
      timeoutMs: 20,
      createClient: () => {
        const generation = ++clients;
        return {
          resolvePin: async () => {
            if (generation === 2) await held;
            return { version: `1.0.${generation}` };
          },
          readText: async path => {
            if (generation === 2) lateReads++;
            if (path.endsWith("capabilities.json")) return JSON.stringify({ version: `1.0.${generation}`, capabilities: { "web-search": { description: "Search", operations: ["web.search"] } } });
            if (path.endsWith("bundle.json")) return JSON.stringify({ entrypoints: { workflow: "workflow.json" } });
            return JSON.stringify({ params: { maxCalls: { default: generation } } });
          },
          // The settings request must finish even if transport cleanup hangs.
          close: () => { closes++; return new Promise<void>(() => {}); },
        };
      },
    };
    const capabilities = new CapabilityCatalog(options);
    const parameters = new WorkflowParamsCatalog(options);
    const read = (): Promise<unknown> => kind === "capabilities"
      ? capabilities.options("test://registry", "brainstorm")
      : parameters.declared("test://registry", "brainstorm");
    const initial = await read();
    assert.ok(initial);
    assert.equal(closes, 1);
    assert.deepEqual(await read(), initial);
    assert.equal(clients, 1, "fresh cached reads never reconnect");
    now += 6 * 60_000;
    const first = read();
    const concurrent = read();
    assert.equal(clients, 2, "concurrent expired reads share one connection");
    assert.deepEqual(await first, initial);
    assert.deepEqual(await concurrent, initial);
    assert.equal(closes, 2);
    const newer = await read();
    assert.notDeepEqual(newer, initial);
    assert.equal(clients, 3);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(lateReads, 0, "the abandoned connection cannot start its next request");
    assert.deepEqual(await read(), newer, "late completion cannot replace the newer snapshot");
    assert.equal(clients, 3);
  });
}
