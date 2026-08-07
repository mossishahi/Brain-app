/**
 * Outbound HTTP hardening for the environments this app really runs in
 * (HPC nodes, institute networks), matching what curl does out of the box:
 *
 * - Proxies: curl honors HTTPS_PROXY/http_proxy; Node's global fetch does
 *   NOT — on proxied clusters every in-process HTTP call tries to connect
 *   directly and is dropped by the firewall while curl works. When any
 *   proxy variable is set, route undici's global dispatcher (the engine
 *   behind global fetch) through it; NO_PROXY is honored. Spawned processes
 *   (git, npm, the claude CLI) read the same variables natively.
 * - Broken IPv6: dual-stack DNS with unrouted IPv6 (AAAA published, packets
 *   go nowhere) hangs a v6-first connect until timeout; curl's happy
 *   eyeballs falls back to IPv4 instantly. Direct connections get the same
 *   resilience via autoSelectFamily.
 *
 * undici is pinned to the same major Node 22 bundles, so the dispatcher this
 * module installs speaks the exact protocol the built-in fetch expects.
 */
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Give the preferred family this long before racing the other one. */
const FAMILY_ATTEMPT_TIMEOUT_MS = 300;

/** Installs the dispatcher and returns a printable description of the mode. */
export function configureOutboundHttp(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  const proxy = httpsProxy ?? httpProxy;
  if (proxy && proxy.trim() !== "") {
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
      }),
    );
    return `proxy ${proxy}`;
  }
  // undici's BuildOptions type demands a complete TcpNetConnectOpts (port
  // included) although the runtime merges these with per-request values;
  // the partial is what the API actually accepts.
  const connect = {
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: FAMILY_ATTEMPT_TIMEOUT_MS,
  } as unknown as Agent.Options["connect"];
  setGlobalDispatcher(new Agent({ connect }));
  return "direct (IPv4/IPv6 auto-selection)";
}
