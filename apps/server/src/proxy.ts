/**
 * Outbound proxy support. curl honors HTTPS_PROXY/http_proxy; Node's global
 * fetch does NOT — on proxied clusters (typical HPC deployments) every
 * in-process HTTP call tries to connect directly and is dropped by the
 * firewall while curl works, which reads as "the app is broken" on a node
 * that plainly has internet. When any proxy variable is set, route undici's
 * global dispatcher (the engine behind global fetch) through the environment
 * proxy; NO_PROXY is honored. Spawned processes (git, npm, the claude CLI)
 * read the same variables natively and need no help.
 *
 * undici is pinned to the same major Node 22 bundles, so the dispatcher this
 * module installs speaks the exact protocol the built-in fetch expects.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Returns the proxy URL now in effect, or undefined when the environment
 * configures none (the default direct dispatcher then stays in place).
 */
export function configureProxyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  const proxy = httpsProxy ?? httpProxy;
  if (!proxy || proxy.trim() === "") return undefined;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      ...(noProxy ? { noProxy } : {}),
    }),
  );
  return proxy;
}
