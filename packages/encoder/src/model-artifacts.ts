/** Pinned model files are shared by workers on the execution host, separately from the native engine. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { PINNED_MODEL_ARTIFACTS } from "./model-catalog.js";

export interface ModelArtifactFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ModelArtifactBundle {
  readonly id: string;
  readonly revision: string;
  readonly files: readonly ModelArtifactFile[];
}

export interface ModelProvisionOptions {
  /** Authoritative external export root; it is never populated or modified automatically. */
  readonly modelDir?: string;
  readonly cacheRoot?: string;
  readonly catalog?: Readonly<Record<string, ModelArtifactBundle>>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModelDownloadOptions extends ModelProvisionOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly downloadTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}

export interface ModelProvisionStatus {
  readonly state: "ready" | "prepared" | "missing" | "preparing" | "failed" | "unavailable";
  readonly managed: boolean;
  /** Parent of the encoder-id directory, as expected by createLocalEncoder. */
  readonly modelDir?: string;
  readonly detail?: string;
  readonly totalBytes?: number;
}

const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;
const LOCK_STALE_MS = 120_000;
const pending = new Map<string, Promise<string>>();
const safeName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(name);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Model downloads require HTTPS URLs without credentials or fragments");
  return url;
}

export function modelArtifactKey(bundle: ModelArtifactBundle): string {
  if (!safeName(bundle.id) || !bundle.revision || bundle.revision.length > 200 || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 32) {
    throw new Error("Invalid pinned model bundle");
  }
  const names = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    if (!safeName(file.path) || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error("Invalid pinned model file");
    httpsUrl(file.url);
    names.add(file.path);
    total += file.size;
  }
  if (total > MAX_BUNDLE_BYTES) throw new Error("Pinned model bundle exceeds its size limit");
  for (const name of ["manifest.json", "tokenizer.json", "tokenizer_config.json", "doc.onnx", ...(bundle.id === "specter2" ? ["query.onnx"] : [])]) {
    if (!names.has(name)) throw new Error(`Pinned model bundle is missing ${name}`);
  }
  return createHash("sha256").update(JSON.stringify({ id: bundle.id, revision: bundle.revision,
    files: [...bundle.files].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, size, sha256 }) => ({ path, size, sha256 })) })).digest("hex");
}

export function defaultModelCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME?.trim();
  return join(cacheHome && isAbsolute(cacheHome) ? cacheHome : join(env.HOME || homedir(), ".cache"), "co-inference", "encoders");
}

/** Keep this aligned with the pinned onnxruntime-node dependency (1.30 has no darwin/x64 binding). */
export function managedModelPlatformIssue(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  return platform === "darwin" && arch === "x64"
    ? "The bundled local encoder engine does not support Intel Macs. Connect to a Linux or Apple Silicon research host to use SPECTER2."
    : undefined;
}

function location(id: string, options: ModelProvisionOptions) {
  if (!safeName(id)) throw new Error("Invalid local encoder id");
  const env = options.env ?? process.env;
  const external = options.modelDir?.trim() || env.BRAINSTORM_AGENTIC_ENCODER_DIR?.trim();
  if (external) return { external: resolve(external) };
  const unsupported = managedModelPlatformIssue();
  if (unsupported) throw new Error(unsupported);
  const bundle = (options.catalog ?? PINNED_MODEL_ARTIFACTS)[id];
  if (!bundle) return {};
  if (bundle.id !== id) throw new Error("Pinned model catalog id mismatch");
  const key = modelArtifactKey(bundle);
  const root = resolve(options.cacheRoot ?? defaultModelCacheRoot(env));
  return { bundle, key, root, modelDir: join(root, key), lock: join(root, `${key}.lock`), failure: join(root, `${key}.failed.json`) };
}

async function regularFile(path: string, size?: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (size !== undefined && info.size !== size)) throw new Error("Missing or invalid model file");
  return info;
}

async function readSmallJson(path: string): Promise<any> {
  if ((await regularFile(path)).size > 16_384) throw new Error("Model cache metadata exceeds its limit");
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function validBundle(modelDir: string, bundle: ModelArtifactBundle, key: string, hashes: boolean): Promise<boolean> {
  try {
    for (const path of [modelDir, join(modelDir, bundle.id)]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    const receipt = await readSmallJson(join(modelDir, ".verified.json"));
    if (receipt.schemaVersion !== 1 || receipt.key !== key) return false;
    for (const file of bundle.files) {
      const path = join(modelDir, bundle.id, file.path);
      await regularFile(path, file.size);
      if (hashes && await fileDigest(path) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function runtimeMetadata(id: string, modelDir: string, options: ModelProvisionOptions) {
  const at = location(id, options);
  const root = resolve(options.cacheRoot ?? defaultModelCacheRoot(options.env ?? process.env));
  const identity = { id, modelDir, host: hostname(), platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
    engine: "onnxruntime-node@1.30.0" };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const names = at.bundle?.files.map((file) => file.path) ?? await (async () => {
    const manifest = await readSmallJson(join(modelDir, id, "manifest.json"));
    return [...new Set<string>(["manifest.json", "tokenizer.json", "tokenizer_config.json",
      ...Object.values(manifest.graphs ?? {}).map((graph) => (graph as { file: string }).file)])];
  })();
  const files = [];
  for (const name of names) {
    if (!safeName(name)) throw new Error("Invalid model filename");
    const info = await regularFile(join(modelDir, id, name));
    files.push({ name, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, ino: info.ino });
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { root, path: join(root, `${key}.runtime.json`), fingerprint };
}

async function inspectRuntime(id: string, modelDir: string, options: ModelProvisionOptions): Promise<Pick<ModelProvisionStatus, "state" | "detail">> {
  try {
    const metadata = await runtimeMetadata(id, modelDir, options);
    const receipt = await readSmallJson(metadata.path);
    if (receipt.schemaVersion === 1 && receipt.fingerprint === metadata.fingerprint) {
      if (receipt.state === "ready") return { state: "ready" };
      if (receipt.state === "failed" && typeof receipt.detail === "string") return { state: "failed", detail: receipt.detail };
    }
  } catch { /* no current successful native/conformance check */ }
  return { state: "prepared", detail: "The model files are present. The encoder engine and model will be checked before use on this host." };
}

/** Provider-only result reporting. Metadata stays in our cache even when the export directory is external/read-only. */
export async function recordModelRuntimeResult(id: string, result: { readonly error?: string }, options: ModelProvisionOptions = {}): Promise<void> {
  const at = location(id, options);
  const modelDir = at.external ?? at.modelDir;
  if (!modelDir) return;
  const metadata = await runtimeMetadata(id, modelDir, options);
  await prepareRoot(metadata.root);
  const temporary = `${metadata.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, fingerprint: metadata.fingerprint,
      state: result.error === undefined ? "ready" : "failed", ...(result.error === undefined ? {} : { detail: result.error.slice(0, 1000) }),
      checkedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, metadata.path);
  } finally { await rm(temporary, { force: true }); }
}

/** Read-only, small metadata/stat checks. Full checksums and model conformance run before use. */
export async function inspectModelProvision(id: string, options: ModelProvisionOptions = {}): Promise<ModelProvisionStatus> {
  try {
    const at = location(id, options);
    if (at.external) {
      try {
        const directory = join(at.external, id);
        const manifest = await readSmallJson(join(directory, "manifest.json"));
        if (manifest.id !== id || !manifest.graphs?.doc?.file || (id === "specter2" && !manifest.graphs?.query?.file)) throw new Error("Model manifest does not identify the selected encoder");
        const graphNames = [manifest.graphs.doc.file, manifest.graphs.query?.file].filter((name): name is string => typeof name === "string");
        for (const name of [...graphNames, "tokenizer.json", "tokenizer_config.json"]) {
          if (!safeName(name)) throw new Error("Invalid model filename");
          await regularFile(join(directory, name));
        }
        return { ...await inspectRuntime(id, at.external, options), managed: false, modelDir: at.external };
      } catch { return { state: "unavailable", managed: false, modelDir: at.external, detail: "The configured model directory is missing a complete encoder export." }; }
    }
    if (!at.bundle) return { state: "unavailable", managed: true, detail: `No automatic model download is available for ${id}. Configure BRAINSTORM_AGENTIC_ENCODER_DIR with its exported model files.` };
    const common = { managed: true, modelDir: at.modelDir, totalBytes: at.bundle.files.reduce((sum, file) => sum + file.size, 0) };
    try {
      if (!(await staleLock(at.lock))) return { ...common, state: "preparing" };
    } catch (error) { if (code(error) !== "ENOENT") throw error; }
    try {
      const failure = await readSmallJson(at.failure);
      if (failure.key === at.key && typeof failure.detail === "string") return { ...common, state: "failed", detail: failure.detail };
    } catch { /* no previous failed preparation */ }
    if (await validBundle(at.modelDir, at.bundle, at.key, false)) return { ...common, ...await inspectRuntime(id, at.modelDir, options) };
    return { ...common, state: "missing", detail: "The model will be downloaded and verified on this host when it is first needed." };
  } catch (error) { return { state: "unavailable", managed: true, detail: error instanceof Error ? error.message : String(error) }; }
}

function knownDeadOwner(owner: { host?: unknown; pid?: unknown }): boolean {
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || Number(owner.pid) <= 0) return false;
  try { process.kill(Number(owner.pid), 0); return false; }
  catch (error) { return code(error) === "ESRCH"; }
}

async function observedLock(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid encoder preparation lock");
  const names = await readdir(path);
  if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(names[0]!)) return undefined;
  const name = names[0]!;
  const owner = await readSmallJson(join(path, name));
  const heartbeat = await regularFile(join(path, name));
  const stale = Date.now() - heartbeat.mtimeMs >= LOCK_STALE_MS &&
    (owner.host !== hostname() || knownDeadOwner(owner));
  return { name, stale };
}

async function staleLock(path: string): Promise<boolean> { return (await observedLock(path))?.stale ?? false; }

async function removeOwner(path: string, name: string) {
  try { await unlink(join(path, name)); }
  catch (error) { if (code(error) === "ENOENT") return; throw error; }
  // A fresh owner may already have atomically replaced the empty directory. It is nonempty and cannot be removed here.
  await rmdir(path).catch((error) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; });
}

async function acquireLock(path: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID(), name = `owner-${token}.json`;
  const owner = { token, pid: process.pid, host: hostname() };
  const candidate = await mkdtemp(`${path}.claim-`);
  const file = await open(join(candidate, name), "wx", 0o600);
  let claimed = false;
  try {
    await file.writeFile(JSON.stringify(owner));
    for (;;) {
      signal?.throwIfAborted();
      try {
        // The token exists before publication. Two claimants cannot replace each other's nonempty directory.
        const now = new Date();
        await file.utimes(now, now);
        await rename(candidate, path);
        claimed = true;
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error;
        try {
          const observed = await observedLock(path);
          if (observed?.stale) {
            // A stale observation cannot delete a new owner's different token: no path-based stale-lock ABA race.
            await removeOwner(path, observed.name);
            continue;
          }
        } catch (retryError) { if (code(retryError) !== "ENOENT") throw retryError; }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for another worker to prepare the encoder model. Retry the run.");
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    }
    const heartbeat = setInterval(() => { const now = new Date(); void file.utimes(now, now).catch(() => {}); }, 10_000);
    heartbeat.unref();
    const owns = async () => { try { return (await readSmallJson(join(path, name))).token === token; } catch { return false; } };
    return {
      owner, owns,
      async release() {
        clearInterval(heartbeat);
        await file.close();
        await removeOwner(path, name);
      },
    };
  } catch (error) { await file.close(); throw error; }
  finally { if (!claimed) await rm(candidate, { recursive: true, force: true }); }
}

class DownloadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function responseFor(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  let current = httpsUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(current.href, { signal, redirect: "manual", headers: { "accept-encoding": "identity" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw new DownloadError("Encoder download redirect has no location", false);
      current = httpsUrl(new URL(next, current).href);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DownloadError(`Encoder model download failed (HTTP ${response.status}). Retry the run when the download is available.`, response.status === 429 || response.status >= 500);
    }
    return response;
  }
  throw new DownloadError("Too many encoder model download redirects", false);
}

async function download(file: ModelArtifactFile, target: string, options: ModelDownloadOptions) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([AbortSignal.timeout(options.downloadTimeoutMs ?? 15 * 60_000), ...(options.signal ? [options.signal] : [])]);
    let response: Response | undefined;
    try {
      response = await responseFor(file.url, options.fetch ?? fetch, signal);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== file.size) throw new DownloadError(`Encoder model ${file.path} has an unexpected download size`, false);
      if (!response.body) throw new DownloadError(`Encoder model ${file.path} has no download body`, false);
      const handle = await open(target, "wx", 0o600);
      let size = 0;
      const digest = createHash("sha256");
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted();
          size += chunk.byteLength;
          if (size > file.size) throw new DownloadError(`Encoder model ${file.path} exceeds its pinned size`, false);
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
        if (size !== file.size || digest.digest("hex") !== file.sha256) throw new DownloadError(`Encoder model ${file.path} failed size/checksum verification`, false);
        await handle.sync();
      } finally { await handle.close(); }
      return;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      await rm(target, { force: true });
      if (options.signal?.aborted || attempt >= 2 || (error instanceof DownloadError && !error.retryable)) throw error;
      await sleep(500 * 2 ** attempt, undefined, { signal: options.signal });
    }
  }
}

async function prepareRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.getuid && rootInfo.uid !== process.getuid()) || (rootInfo.mode & 0o022)) {
    throw new Error("Encoder model cache must be an owned directory that other users cannot modify");
  }
}

async function install(id: string, options: ModelDownloadOptions): Promise<string> {
  const at = location(id, options);
  if (at.external) return at.external;
  if (!at.bundle) throw new Error(`No pinned download is available for ${id}; configure BRAINSTORM_AGENTIC_ENCODER_DIR with its exported model files.`);
  await prepareRoot(at.root);
  const lock = await acquireLock(at.lock, options.lockTimeoutMs ?? 30 * 60_000, options.signal);
  let temporary: string | undefined;
  try {
    if (await validBundle(at.modelDir, at.bundle, at.key, true)) {
      await rm(at.failure, { force: true });
      return at.modelDir;
    }
    // Clean only staging whose recorded owner on this machine is dead. Another live/remote worker may still hold open files.
    for (const name of await readdir(at.root)) {
      if (name.startsWith(`${at.key}.partial-`)) {
        try {
          const owner = await readSmallJson(join(at.root, name, ".owner.json"));
          if (knownDeadOwner(owner)) await rm(join(at.root, name), { recursive: true, force: true });
        } catch { /* unrecognized staging remains untouched */ }
      }
    }
    temporary = await mkdtemp(join(at.root, `${at.key}.partial-`));
    await writeFile(join(temporary, ".owner.json"), JSON.stringify(lock.owner), { mode: 0o600 });
    const directory = join(temporary, id);
    await mkdir(directory, { mode: 0o700 });
    for (const file of at.bundle.files) await download(file, join(directory, file.path), options);
    await rm(join(temporary, ".owner.json"));
    await writeFile(join(temporary, ".verified.json"), JSON.stringify({ schemaVersion: 1, key: at.key }), { mode: 0o600 });
    if (!await lock.owns()) throw new Error("Another worker took over encoder preparation. Retry the run.");
    // A corrupt old cache is never trusted or replaced until the new bundle is fully verified.
    await rm(at.modelDir, { recursive: true, force: true });
    await rename(temporary, at.modelDir);
    temporary = undefined;
    await rm(at.failure, { force: true });
    return at.modelDir;
  } catch (error) {
    if (await lock.owns()) {
      const detail = error instanceof Error ? error.message : String(error);
      await writeFile(at.failure, JSON.stringify({ key: at.key, detail: detail.slice(0, 1000), at: new Date().toISOString() }), { mode: 0o600 }).catch(() => {});
    }
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.release();
  }
}

/** Download once per pinned bundle, verify cached files before use, and share preparation across workers. */
export function provisionModel(id: string, options: ModelDownloadOptions = {}): Promise<string> {
  // Cross-process locks also serialize independent provider instances. In-process sharing avoids rehashing concurrently.
  let at: ReturnType<typeof location>;
  try { at = location(id, options); } catch (error) { return Promise.reject(error); }
  if (at.external) return Promise.resolve(at.external);
  const key = at.modelDir;
  if (!key || options.signal) return install(id, options);
  let promise = pending.get(key);
  if (!promise) {
    promise = install(id, options);
    pending.set(key, promise);
    void promise.then(() => pending.delete(key), () => pending.delete(key));
  }
  return promise;
}
