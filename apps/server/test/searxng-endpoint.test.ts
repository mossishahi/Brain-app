import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { EnvHttpProxyAgent, fetch } from "undici";

import {
  localSearxngProxyEnvironment,
  searxngAdvertiseHost,
  searxngPort,
} from "../src/searxng-endpoint.js";

test("SearXNG advertises the server node for wildcard listeners", () => {
  for (const bind of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"]) {
    assert.equal(searxngAdvertiseHost(bind, {}, "compute06"), "compute06");
  }
});

test("SearXNG preserves local and explicitly bound destinations", () => {
  for (const bind of ["127.0.0.1", "::1", "localhost", "10.0.0.5", "search.cluster"])
    assert.equal(searxngAdvertiseHost(bind, {}, "compute06"), bind);
  assert.equal(searxngAdvertiseHost("[::1]", {}, "compute06"), "::1");
});

test("SearXNG allows an explicit advertised host on a separate service network", () => {
  const env = { BRAINSTORM_SEARXNG_ADVERTISE_HOST: " search.internal " };
  for (const bind of ["0.0.0.0", "::", "127.0.0.1"])
    assert.equal(searxngAdvertiseHost(bind, env, "compute06"), "search.internal");
  assert.equal(
    searxngAdvertiseHost("::", { BRAINSTORM_SEARXNG_ADVERTISE_HOST: "[fd00::5]" }),
    "fd00::5",
  );
  assert.equal(
    searxngAdvertiseHost("0.0.0.0", { BRAINSTORM_SEARXNG_ADVERTISE_HOST: " " }, "compute06"),
    "compute06",
  );
});

test("SearXNG rejects wildcard overrides and URLs where a host is required", () => {
  for (const override of ["0.0.0.0", "::", "[::]", "https://search.internal", "search.internal:8080", "user@search.internal", "search.internal/path", "bad host"]) {
    assert.throws(
      () => searxngAdvertiseHost("0.0.0.0", { BRAINSTORM_SEARXNG_ADVERTISE_HOST: override }),
      /BRAINSTORM_SEARXNG_ADVERTISE_HOST/,
    );
  }
});

test("SearXNG uses a predictable remote port and keeps local allocation dynamic", () => {
  for (const host of ["compute06", "10.233.0.16", "fd00::5"])
    assert.equal(searxngPort(host, {}), 8080);
  for (const host of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost", "LOCALHOST"])
    assert.equal(searxngPort(host, {}), undefined);
  assert.equal(searxngPort("compute06", { BRAINSTORM_SEARXNG_PORT: " " }), 8080);
});

test("SearXNG accepts a site-approved port override and rejects invalid values", () => {
  for (const host of ["compute06", "127.0.0.1"])
    assert.equal(searxngPort(host, { BRAINSTORM_SEARXNG_PORT: " 8999 " }), 8999);
  for (const value of ["0", "65536", "-1", "8080.5", "1e3", "0x1f90", "http:8080", "automatic"])
    assert.throws(() => searxngPort("compute06", { BRAINSTORM_SEARXNG_PORT: value }), /BRAINSTORM_SEARXNG_PORT/);
});

test("managed search proxy bypass preserves both existing rule lists without mutation", () => {
  const env = { NO_PROXY: "localhost,.cluster", no_proxy: "127.0.0.1 localhost" };
  const bypass = localSearxngProxyEnvironment("http://compute06:43210", env);
  assert.equal(bypass.NO_PROXY, "localhost,.cluster,127.0.0.1,compute06:43210");
  assert.equal(bypass.no_proxy, bypass.NO_PROXY);
  assert.deepEqual(env, { NO_PROXY: "localhost,.cluster", no_proxy: "127.0.0.1 localhost" });
  assert.equal(localSearxngProxyEnvironment("http://compute06:43210", bypass).NO_PROXY, bypass.NO_PROXY);
  assert.deepEqual(localSearxngProxyEnvironment("http://compute06:43210", { no_proxy: "*" }), {
    NO_PROXY: "*",
    no_proxy: "*",
  });
  assert.equal(localSearxngProxyEnvironment("http://[fd00::5]:43210", {}).NO_PROXY, "[fd00::5]:43210");
});

test("managed search bypasses an outbound proxy while another port still uses it", async () => {
  const search = createServer((_request, response) => {
    response.end(JSON.stringify({ results: [{ title: "Local search works" }] }));
  });
  let proxyCalls = 0;
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    proxyCalls += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const searchPort = await listen(search);
  const proxyPort = await listen(proxy);
  const searchUrl = `http://127.0.0.1:${searchPort}`;
  const bypass = localSearxngProxyEnvironment(searchUrl, {});
  const agent = new EnvHttpProxyAgent({
    httpProxy: `http://127.0.0.1:${proxyPort}`,
    noProxy: bypass.NO_PROXY,
  });
  try {
    const response = await fetch(`${searchUrl}/search?q=test&format=json`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Local search works/);
    assert.equal(proxyCalls, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${proxyPort}/unrelated`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(2_000),
    }));
    assert.equal(proxyCalls, 1);
  } finally {
    await agent.close();
    await Promise.all([close(search), close(proxy)]);
  }
});
