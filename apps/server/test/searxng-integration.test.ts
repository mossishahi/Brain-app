/**
 * Opt-in smoke test against a real container and live search engines.
 *
 * From the repository root, after building the workspace dependencies:
 *   npm run build -w brainstorm-agentic-server
 *   BRAINSTORM_SEARXNG_INTEGRATION=1 node --test apps/server/dist/test/searxng-integration.test.js
 *
 * Optional controls:
 * - BRAINSTORM_SEARXNG_IMAGE: a pinned image reference or a cached local SIF.
 * - BRAINSTORM_SEARXNG_RUNTIME: apptainer (default), singularity, docker, podman.
 * - BRAINSTORM_SEARXNG_ADVERTISE_HOST: the address workers should connect to.
 * - BRAINSTORM_SEARXNG_START_TIMEOUT_MS: 1,000–420,000 (default 300,000).
 * - BRAINSTORM_SEARXNG_REMOTE_PROBE_HOST: SSH host for a separate-node HTTP probe;
 *   it needs noninteractive SSH access and curl, and a non-loopback advertised host.
 * - BRAINSTORM_SEARXNG_HOLD_MS: keep the service up for a manual probe (0–60,000).
 *
 * The default suite skips this test: enabling it permits image downloads and
 * one public search query. All state lives in an isolated temporary workspace.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as directFetch } from "undici";
import { searxngProvider } from "@brainstorm-agentic/host-tools";

import { SettingsStore } from "../src/settings.js";
import { SearxngLauncher, type SearxngRuntime } from "../src/searxng-launcher.js";

const exec = promisify(execFile);

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= min && value <= max,
    `${name} must be an integer between ${min} and ${max}`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

test("real SearXNG container serves JSON search through the configured provider", {
  skip: process.env.BRAINSTORM_SEARXNG_INTEGRATION !== "1",
  timeout: 9 * 60_000,
}, async (t) => {
  const runtime = process.env.BRAINSTORM_SEARXNG_RUNTIME ?? "apptainer";
  assert.ok(["apptainer", "singularity", "docker", "podman"].includes(runtime),
    `unsupported BRAINSTORM_SEARXNG_RUNTIME: ${runtime}`);
  const startTimeoutMs = boundedNumber("BRAINSTORM_SEARXNG_START_TIMEOUT_MS", 300_000, 1_000, 420_000);
  const holdMs = boundedNumber("BRAINSTORM_SEARXNG_HOLD_MS", 0, 0, 60_000);
  const advertiseHost = process.env.BRAINSTORM_SEARXNG_ADVERTISE_HOST ?? "127.0.0.1";
  const remoteProbeHost = process.env.BRAINSTORM_SEARXNG_REMOTE_PROBE_HOST;
  if (remoteProbeHost !== undefined) {
    assert.match(remoteProbeHost, /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/,
      "REMOTE_PROBE_HOST must be an SSH hostname, optionally with a user");
    assert.ok(!["127.0.0.1", "localhost", "::1"].includes(advertiseHost),
      "a remote probe requires a worker-reachable advertised address");
  }

  const workspace = mkdtempSync(join(tmpdir(), "brainstorm-searxng-smoke-"));
  // Explicitly direct only the internal HTTP requests. The launched container
  // still inherits the operator's outbound proxy for its search-engine requests.
  const dispatcher = new Agent();
  const children: ChildProcess[] = [];
  const launcher = new SearxngLauncher({
    workspace,
    advertiseHost,
    ...(process.env.BRAINSTORM_SEARXNG_IMAGE
      ? { imageRef: process.env.BRAINSTORM_SEARXNG_IMAGE }
      : {}),
    startTimeoutMs,
    probeRuntime: async (candidate: SearxngRuntime) => {
      if (candidate !== runtime) return false;
      await exec(candidate, ["version"], { timeout: 10_000 });
      return true;
    },
    spawnImpl: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    }) as typeof spawn,
    log: (line) => console.info(`[smoke] ${line}`),
  });
  t.after(async () => {
    try {
      await launcher.stop();
      for (const child of children) {
        if (!await waitForExit(child, 10_000)) {
          child.kill("SIGKILL");
          assert.ok(await waitForExit(child, 5_000), "the smoke-test container did not exit");
        }
      }
      assert.equal(launcher.status().state, "off");
    } finally {
      await dispatcher.destroy();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  const settings = new SettingsStore(workspace);
  await settings.put({
    ...settings.get(),
    llm: { provider: "offline" },
    webSearch: { provider: "searxng-local", scholarly: false },
  });
  const status = await launcher.ensureRunning();
  assert.equal(status.state, "running", status.detail);
  assert.equal(status.runtime, runtime);
  assert.ok(status.url, "a running container must advertise its URL");
  const baseUrl = status.url;
  assert.ok(!["0.0.0.0", "[::]"].includes(new URL(baseUrl).hostname),
    "the worker URL must not be a wildcard bind address");
  console.info(`[smoke] advertised URL: ${baseUrl}`);

  const health = await directFetch(`${baseUrl}/healthz`, {
    dispatcher,
    signal: AbortSignal.timeout(5_000),
  });
  await health.text();
  assert.equal(health.status, 200, "the advertised endpoint must serve /healthz");

  if (remoteProbeHost !== undefined) {
    const command = `curl --noproxy '*' --fail --silent --show-error --max-time 15 -- ${shellQuote(`${baseUrl}/healthz`)}`;
    await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", remoteProbeHost, command], {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    t.diagnostic(`separate-node /healthz passed from ${remoteProbeHost}`);
  }

  const config = settings.webSearchRuntimeConfig();
  assert.equal(config.general, "searxng");
  assert.equal(config.searxngBaseUrl, baseUrl,
    "the configured worker endpoint must match the running container");
  const provider = searxngProvider({
    baseUrl: config.searxngBaseUrl!,
    fetchImpl: async (url, init) => {
      const response = await directFetch(url, { ...init, dispatcher });
      assert.equal(response.status, 200, "the search endpoint must accept JSON requests");
      assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
      return response;
    },
  });
  const answer = await provider.search({
    query: "SearXNG documentation",
    kind: "general",
    maxResults: 5,
    signal: AbortSignal.timeout(30_000),
  });
  t.diagnostic(JSON.stringify({
    runtime,
    image: process.env.BRAINSTORM_SEARXNG_IMAGE ?? "default image",
    results: answer.hits.length,
    engineFailures: answer.engineFailures ?? [],
  }));
  assert.ok(answer.hits.length > 0,
    `live general search returned no results; engine failures: ${JSON.stringify(answer.engineFailures ?? [])}`);
  for (const hit of answer.hits) {
    assert.match(hit.url, /^https?:\/\//);
    assert.ok(hit.title.length > 0);
    assert.equal(hit.source, "searxng");
  }

  if (holdMs > 0) {
    console.info(`[smoke] keeping ${baseUrl} available for ${holdMs} ms for an external probe`);
    await delay(holdMs, undefined, { signal: t.signal });
  }
});
