import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

export type RuntimeComponent = "claude" | "cursor" | "encoder";
interface ComponentArchive { file: string; sha256: string; size: number; url?: string; minimumLibc?: string; unavailableReason?: string }
interface Distribution {
  schemaVersion: number; platform: string; arch: string; nodeMajor: number | string; nodeAbi: string;
  libc: "glibc" | "none"; minimumLibc?: string; development?: boolean;
  components: Partial<Record<RuntimeComponent, ComponentArchive>>;
}
interface ComponentFile { path: string; size: number; executable: boolean; sha256: string }
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const pending = new Map<string, Promise<string>>();
const allowed: Record<RuntimeComponent, readonly string[]> = {
  claude: ["@anthropic-ai/claude-agent-sdk"], cursor: ["@cursor/sdk"],
  encoder: ["onnxruntime-node", "@huggingface/tokenizers"],
};

async function distributionAt(caller: string): Promise<Distribution | undefined> {
  let dir = dirname(fileURLToPath(caller));
  for (;;) {
    try {
      const metadata = join(dir, ".co-inference-distribution.json"), info = await lstat(metadata);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Invalid research runtime distribution metadata");
      const value = JSON.parse(await readFile(metadata, "utf8")) as Distribution;
      if (value.schemaVersion !== 2 || value.development === true || value.platform !== process.platform || value.arch !== process.arch ||
          String(value.nodeMajor) !== process.versions.node.split(".")[0] || value.nodeAbi !== process.versions.modules) {
        throw new Error("This research runtime belongs to a different platform or Node version. Reinstall the matching release.");
      }
      const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header;
      if (process.platform === "linux") {
        if (value.libc !== "glibc" || !header.glibcVersionRuntime || !value.minimumLibc || !versionAtLeast(header.glibcVersionRuntime, value.minimumLibc)) throw new Error("This research runtime requires newer or different system libraries. Install a compatible release.");
      } else if (value.libc !== "none") throw new Error("Invalid research runtime system library metadata");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function versionAtLeast(actual: string, minimum: string): boolean {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(actual) || !/^\d+\.\d+(?:\.\d+)?$/.test(minimum)) return false;
  const a = actual.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
}

function assertComponentLibraries(minimum: unknown, component?: RuntimeComponent): void {
  const name = component === "cursor" ? "Cursor" : component === "claude" ? "Claude" : component === "encoder" ? "Local encoder" : "Selected provider";
  if (minimum === undefined) return;
  if (typeof minimum !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minimum)) {
    throw new Error(`Invalid ${name} runtime system library requirement`);
  }
  if (process.platform !== "linux") return;
  const actual = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
  if (!actual || !versionAtLeast(actual, minimum)) {
    throw new Error(`${name} runtime requires glibc ${minimum} or newer; this host ${actual ? `provides glibc ${actual}` : "does not provide glibc"}. Use a compatible Linux host or choose another engine.`);
  }
}

function assertComponentAvailable(reason: unknown): void {
  if (reason === undefined) return;
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500 || /[\x00-\x1f\x7f-\x9f]/.test(reason)) {
    throw new Error("Invalid runtime component availability metadata");
  }
  throw new Error(reason);
}

function safePath(input: string): string {
  const value = input.replace(/^\.\//, "").replace(/\/$/, "");
  if (!value || value.startsWith("/") || /[\\\x00-\x1f:]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe runtime component path");
  return value;
}

/** Streaming, bounded extraction: provider executables need not be held in memory. */
export async function extractRuntimeComponent(archive: string, destination: string): Promise<ComponentFile[]> {
  const input = createReadStream(archive);
  const unzip = createGunzip();
  input.on("error", error => unzip.destroy(error));
  const iterator = input.pipe(unzip)[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0), expanded = 0, entries = 0;
  const files: ComponentFile[] = [];
  const take = async (size: number, optional = false): Promise<Buffer> => {
    const parts: Buffer[] = []; let remaining = size;
    while (remaining) {
      if (!buffered.length) {
        const next = await iterator.next();
        if (next.done) { if (optional && remaining === size) return Buffer.alloc(0); throw new Error("Truncated runtime component archive"); }
        buffered = Buffer.from(next.value);
        expanded += buffered.length;
        if (expanded > MAX_EXPANDED) throw new Error("Runtime component expands beyond its limit");
      }
      const n = Math.min(remaining, buffered.length);
      parts.push(buffered.subarray(0, n)); buffered = buffered.subarray(n); remaining -= n;
    }
    return Buffer.concat(parts, size);
  };
  const field = (header: Buffer, start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const number = (header: Buffer, start: number, length: number) => {
    const raw = field(header, start, length).trim();
    if (!/^[0-7]*$/.test(raw)) throw new Error("Invalid runtime component archive number");
    const n = parseInt(raw || "0", 8);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid runtime component archive number");
    return n;
  };
  let nextPath: string | undefined;
  try {
    for (;;) {
      const header = await take(512);
      if (header.every(byte => byte === 0)) {
        if (!(await take(512)).every(byte => byte === 0)) throw new Error("Invalid runtime component tar terminator");
        for (;;) { const padding = await take(512, true); if (!padding.length) break; if (!padding.every(byte => byte === 0)) throw new Error("Unexpected trailing runtime component data"); }
        break;
      }
      if (++entries > 100_000) throw new Error("Too many runtime component entries");
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum !== number(header, 148, 8)) throw new Error("Invalid runtime component tar checksum");
      const size = number(header, 124, 12), type = header[156] || 48;
      if (size > MAX_ARCHIVE) throw new Error("Runtime component file exceeds its limit");
      if (type === 120) {
        if (size > 65536) throw new Error("Runtime component metadata exceeds its limit");
        const data = await take(size);
        for (let offset = 0; offset < data.length;) {
          const space = data.indexOf(32, offset);
          const length = Number(data.subarray(offset, space).toString());
          if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length || data[offset + length - 1] !== 10) throw new Error("Invalid runtime component metadata");
          const record = data.subarray(space + 1, offset + length - 1).toString();
          const eq = record.indexOf("=");
          if (eq < 1) throw new Error("Invalid runtime component metadata");
          const key = record.slice(0, eq), value = record.slice(eq + 1);
          if (key === "path") nextPath = value;
          else if (!["mtime", "atime", "ctime"].includes(key)) throw new Error("Unsupported runtime component metadata");
          offset += length;
        }
      } else {
        if (type !== 48 && type !== 53) throw new Error("Runtime components may not contain links or special files");
        const prefix = field(header, 345, 155);
        const name = nextPath ?? (prefix ? prefix + "/" : "") + field(header, 0, 100);
        nextPath = undefined;
        if (name !== "." && name !== "./") {
          const relative = safePath(name);
          if (!/^(?:node_modules(?:\/.*)?|(?:apps|packages)(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/node_modules(?:\/.*)?)?)?)$/.test(relative) || relative.split("/").some(part => [".git", ".bin"].includes(part))) throw new Error("Runtime component contains files outside its dependency tree");
          const target = join(destination, relative);
          if (type === 53) {
            if (size) throw new Error("Invalid runtime component directory");
            await mkdir(target, { recursive: true, mode: 0o700 });
          } else {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            if (!relative.split("/").includes("node_modules")) throw new Error("Runtime component contains application files");
            const executable = Boolean(number(header, 100, 8) & 0o111), hash = createHash("sha256");
            const file = await open(target, "wx", executable ? 0o700 : 0o600);
            try {
              for (let remaining = size; remaining > 0;) {
                const chunk = await take(Math.min(remaining, 65536));
                hash.update(chunk); await file.writeFile(chunk); remaining -= chunk.length;
              }
            } finally { await file.close(); }
            files.push({ path: relative, size, executable, sha256: hash.digest("hex") });
          }
        } else if (size || type !== 53) throw new Error("Invalid runtime component root");
      }
      if (size % 512) await take(512 - size % 512);
    }
    if (!files.length) throw new Error("Runtime component archive is empty");
    return files;
  } finally { input.destroy(); unzip.destroy(); }
}

async function owned(target: string, directory: boolean, privateMode = false) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid && info.uid !== process.getuid()) || (info.mode & (privateMode ? 0o077 : 0o022))) {
    throw new Error(`Unsafe runtime component cache path: ${target}`);
  }
  return info;
}

/** Canonicalize an existing parent, then create each private cache directory safely. */
async function prepareCache(requested: string): Promise<string> {
  const target = resolve(requested), missing: string[] = [];
  let ancestor = target;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (ancestor === target) await owned(ancestor, true, true);
      else if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error("Runtime component cache parent is not a directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Runtime component cache has no existing parent");
      ancestor = parent;
    }
  }
  let current = await realpath(ancestor);
  const outer = await lstat(await realpath(dirname(current)));
  if ((process.getuid && outer.uid !== process.getuid() && outer.uid !== 0) || ((outer.mode & 0o022) && !(outer.uid === 0 && (outer.mode & 0o1000)))) throw new Error("Unsafe runtime component cache parent");
  const parentInfo = await lstat(current);
  const systemTemporary = parentInfo.uid === 0 && Boolean(parentInfo.mode & 0o1000);
  if (!parentInfo.isDirectory() || (process.getuid && parentInfo.uid !== process.getuid() && parentInfo.uid !== 0) || ((parentInfo.mode & 0o022) && !systemTemporary)) throw new Error("Unsafe runtime component cache parent");
  for (const name of missing) {
    current = join(current, name);
    await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await owned(current, true, true);
  }
  await owned(current, true, true);
  return current;
}

function runtimeIdentity() { return { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules }; }
async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function validComponent(directory: string, sha256: string): Promise<boolean> {
  try {
    await owned(directory, true, true);
    const marker = join(directory, ".verified"), integrity = join(directory, ".component-integrity.json");
    if ((await owned(marker, false, true)).size !== 64) return false;
    if ((await readFile(marker, "utf8")) !== sha256) return false;
    const info = await owned(integrity, false, true);
    if (info.size > 32 * 1024 * 1024) return false;
    const state = JSON.parse(await readFile(integrity, "utf8"));
    if (state.schemaVersion !== 1 || state.sha256 !== sha256 || JSON.stringify(state.runtime) !== JSON.stringify(runtimeIdentity()) || !Array.isArray(state.files) || state.files.length < 2 || state.files.length > 100001 || !state.files.some((file: ComponentFile) => file.path === ".component-loader.mjs")) return false;
    const directories = new Set<string>(), files = new Set<string>();
    for (const file of state.files as ComponentFile[]) {
      if (!file || safePath(file.path) !== file.path || files.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_EXPANDED || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
      files.add(file.path);
      let parent = directory;
      for (const part of file.path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if (!directories.has(parent)) { await owned(parent, true); directories.add(parent); }
      }
      const target = join(directory, file.path), info = await owned(target, false);
      if (info.size !== file.size || Boolean(info.mode & 0o111) !== file.executable || await fileDigest(target) !== file.sha256) return false;
    }
    let entries = 0;
    const inspect = async (relative: string): Promise<boolean> => {
      for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
        if (++entries > 200000 || entry.isSymbolicLink()) return false;
        const name = relative ? relative + "/" + entry.name : entry.name;
        if (entry.isDirectory()) { if (!directories.has(join(directory, name)) || !await inspect(name)) return false; }
        else if (!entry.isFile() || (!files.has(name) && ![".verified", ".component-integrity.json"].includes(name))) return false;
      }
      return true;
    };
    if (!await inspect("")) return false;
    return true;
  } catch { return false; }
}

async function discoverComponent(cache: string, sha256: string): Promise<string | undefined> {
  const names = (await readdir(cache)).filter(name => name === sha256 || new RegExp("^" + sha256 + "-repair-[a-f0-9-]{36}$").test(name)).slice(-64);
  for (const name of names) {
    const directory = join(cache, name);
    if (await validComponent(directory, sha256)) return directory;
  }
  return undefined;
}

function secureDownloadUrl(value: string | undefined): URL {
  const url = new URL(value ?? "missing:");
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("This release has no secure download configured for the selected provider. Install a published release.");
  return url;
}

async function downloadResponse(initial: URL, fetcher: typeof fetch): Promise<Response> {
  let url = initial;
  const signal = AbortSignal.timeout(300_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Runtime component download redirect has no destination");
      url = secureDownloadUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body || (response.url && secureDownloadUrl(response.url).protocol !== "https:")) {
      await response.body?.cancel();
      throw new Error("The provider runtime could not be downloaded. Try again when the connection is available.");
    }
    return response;
  }
  throw new Error("Too many runtime component download redirects");
}

export async function installRuntimeComponent(descriptor: ComponentArchive, cacheRoot: string,
  fetcher: typeof fetch = fetch): Promise<string> {
  assertComponentAvailable(descriptor.unavailableReason);
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 || descriptor.size > MAX_ARCHIVE) throw new Error("Invalid runtime component descriptor");
  assertComponentLibraries(descriptor.minimumLibc);
  const url = secureDownloadUrl(descriptor.url);
  const cache = await prepareCache(cacheRoot);
  const existing = await discoverComponent(cache, descriptor.sha256);
  if (existing) return existing;
  const staging = join(cache, ".install-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  const archive = staging + ".tar.gz";
  try {
    const response = await downloadResponse(url, fetcher);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== descriptor.size) { await response.body?.cancel(); throw new Error("Runtime component size did not match this release"); }
    const hash = createHash("sha256"); let bytes = 0;
    const output = await open(archive, "wx", 0o600);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > descriptor.size) throw new Error("Runtime component size did not match this release");
        hash.update(chunk); await output.writeFile(chunk);
      }
    } finally { await output.close(); }
    if (bytes !== descriptor.size || hash.digest("hex") !== descriptor.sha256) throw new Error("Runtime component integrity check failed");
    const files = await extractRuntimeComponent(archive, staging);
    const loader = Buffer.from("export const load = specifier => import(specifier);\n");
    await writeFile(join(staging, ".component-loader.mjs"), loader, { flag: "wx", mode: 0o600 });
    files.push({ path: ".component-loader.mjs", size: loader.length, executable: false, sha256: createHash("sha256").update(loader).digest("hex") });
    await writeFile(join(staging, ".component-integrity.json"), JSON.stringify({ schemaVersion: 1, sha256: descriptor.sha256, runtime: runtimeIdentity(), files }), { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, ".verified"), descriptor.sha256, { flag: "wx", mode: 0o600 });
    const winner = await discoverComponent(cache, descriptor.sha256);
    if (winner) return winner;
    let destination = join(cache, descriptor.sha256);
    if (await lstat(destination).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; })) destination += "-repair-" + randomUUID();
    try { await rename(staging, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const winner = await discoverComponent(cache, descriptor.sha256);
      if (winner) return winner;
      destination = join(cache, descriptor.sha256 + "-repair-" + randomUUID());
      await rename(staging, destination);
    }
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); await rm(archive, { force: true }); }
}

/** Only the selected provider is acquired. Source checkouts use their installed SDKs. */
export async function importRuntimeComponent<T = unknown>(component: RuntimeComponent, specifier: string, caller: string,
  sourceImport?: () => Promise<T>): Promise<T> {
  if (!allowed[component].includes(specifier)) throw new Error("Unknown runtime component package");
  const manifest = await distributionAt(caller);
  const require = createRequire(caller);
  if (!manifest) return sourceImport ? sourceImport() : import(pathToFileURL(require.resolve(specifier)).href) as Promise<T>;
  const descriptor = manifest.components[component];
  if (!descriptor) throw new Error(`This release does not provide the ${component} runtime`);
  assertComponentAvailable(descriptor.unavailableReason);
  // Optional engines can require newer libraries than the small core. Check
  // before consulting a cached/pending installation as well as before download.
  assertComponentLibraries(descriptor.minimumLibc === undefined ? manifest.minimumLibc : descriptor.minimumLibc, component);
  const cache = resolve(process.env.BRAINSTORM_RUNTIME_COMPONENT_CACHE ?? join(homedir(), ".brainstorm-agentic", "runtime-components"));
  const key = cache + ":" + descriptor.sha256;
  let installation = pending.get(key);
  if (!installation) {
    installation = installRuntimeComponent(descriptor, cache);
    pending.set(key, installation);
    void installation.catch(() => pending.delete(key));
  }
  const installed = await installation;
  const target = join(installed, ".component-loader.mjs");
  await owned(target, false, true);
  const loader = await import(pathToFileURL(target).href) as { load: (specifier: string) => Promise<T> };
  return loader.load(specifier);
}
