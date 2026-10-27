import { timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** Desktop tunnels terminate on shared machines. Loopback alone is not authentication. */
export function readDesktopApiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.BRAINSTORM_API_TOKEN_FILE;
  if (!path) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Desktop API token must be an owner-only regular file (mode 0600)");
    }
    const token = readFileSync(fd, "utf8").trim();
    validateDesktopApiToken(token);
    return token;
  } finally { closeSync(fd); }
}

export function validateDesktopApiToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("Desktop API token must contain 32–256 URL-safe characters");
  }
}

export function authorizedDesktopRequest(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function allowsSourceUpdates(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CO_INFERENCE_PACKAGED !== "1" && env.BRAINSTORM_DISABLE_SELF_UPDATE !== "1";
}
