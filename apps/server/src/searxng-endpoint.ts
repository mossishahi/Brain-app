import { isIP } from "node:net";
import { hostname } from "node:os";

/**
 * A listen address is not necessarily a usable destination. In particular,
 * SLURM workers must reach the server's node, rather than their own wildcard
 * interface. Sites with separate service networks can override that hostname.
 */
export function searxngAdvertiseHost(
  bindHost: string,
  env: NodeJS.ProcessEnv = process.env,
  machineHostname: string = hostname(),
): string {
  const override = env.BRAINSTORM_SEARXNG_ADVERTISE_HOST?.trim();
  const bind = unbracketHost(bindHost.trim());
  const selected = unbracketHost(
    override || (isWildcard(bind) ? machineHostname.trim() : bind),
  );
  if (
    selected.length === 0 ||
    isWildcard(selected) ||
    (isIP(selected) === 0 && !/^[a-zA-Z0-9_.-]+$/.test(selected))
  ) {
    throw new Error(
      "SearXNG needs a reachable hostname or IP address; set " +
        "BRAINSTORM_SEARXNG_ADVERTISE_HOST to a host without a scheme or port.",
    );
  }
  return selected;
}

/**
 * Remote workers need a predictable port that a site can allow through its
 * firewall. Use 8080 for remote deployments, with a site-approved override;
 * local-only deployments can continue allocating an available ephemeral port.
 */
export function searxngPort(
  advertiseHost: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configured = env.BRAINSTORM_SEARXNG_PORT?.trim();
  if (configured) {
    const port = Number(configured);
    if (!/^\d+$/.test(configured) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("BRAINSTORM_SEARXNG_PORT must be an integer between 1 and 65535.");
    }
    return port;
  }
  const host = unbracketHost(advertiseHost).toLowerCase();
  const loopback = host === "localhost" || host === "localhost." || host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."));
  return loopback ? undefined : 8080;
}

/** Keep managed search traffic inside the cluster while public APIs use its proxy. */
export function localSearxngProxyEnvironment(
  baseUrl: string,
  env: NodeJS.ProcessEnv,
): { NO_PROXY: string; no_proxy: string } {
  const url = new URL(baseUrl);
  const endpoint = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  const entries = new Set(
    [env.NO_PROXY ?? "", env.no_proxy ?? ""]
      .flatMap((value) => value.split(/[,\s]+/))
      .filter(Boolean),
  );
  entries.add(endpoint);
  // Both casings are passed to children: Node and subprocess clients may use
  // different precedence. Keep an existing wildcard's original meaning.
  const noProxy = entries.has("*") ? "*" : [...entries].join(",");
  return { NO_PROXY: noProxy, no_proxy: noProxy };
}

function unbracketHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" ||
    (isIP(host) === 6 && new URL(`http://[${host}]`).hostname === "[::]");
}
