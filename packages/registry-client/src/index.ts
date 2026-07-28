import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const INDEX_SCHEMA = "content-registry-index/v1";
const MANIFEST_SCHEMA = "content-registry-manifest/v1";
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface ContentRegistryIndexBundle {
  readonly id: string;
  readonly latest: string;
  readonly versions: readonly string[];
  /** Release notes by version (from the publisher's tag annotations), when served. */
  readonly releaseNotes?: Readonly<Record<string, string>>;
}

export interface ContentRegistryIndex {
  readonly schemaVersion: typeof INDEX_SCHEMA;
  readonly bundles: readonly ContentRegistryIndexBundle[];
}

export interface ContentRegistryManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface ContentRegistryEntrypoints {
  readonly workflow: string;
  readonly controls: readonly string[];
}

export interface ContentRegistryManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly bundle: string;
  readonly version: string;
  readonly runtimeProtocol: string;
  readonly entrypoints: ContentRegistryEntrypoints;
  readonly files: readonly ContentRegistryManifestFile[];
}

export interface ContentRegistryPin {
  readonly registryUrl: string;
  readonly bundle: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly manifest: ContentRegistryManifest;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const found = string(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(found)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  return found;
}

export function safeRegistryPath(value: unknown, label = "registry path"): string {
  const path = string(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe: "${path}"`);
  }
  return path;
}

export function parseContentRegistryIndex(value: unknown): ContentRegistryIndex {
  const raw = object(value, "content-registry index");
  if (raw.schemaVersion !== INDEX_SCHEMA || !Array.isArray(raw.bundles)) {
    throw new Error(`content-registry index must use ${INDEX_SCHEMA}`);
  }
  const seen = new Set<string>();
  const bundles = raw.bundles.map((candidate, index): ContentRegistryIndexBundle => {
    const item = object(candidate, `content-registry index bundle[${index}]`);
    const id = safeId(item.id, `bundle[${index}].id`);
    const latest = safeId(item.latest, `bundle[${index}].latest`);
    if (!Array.isArray(item.versions) || item.versions.length === 0) {
      throw new Error(`bundle "${id}" must list at least one version`);
    }
    const versions = item.versions.map((version, versionIndex) =>
      safeId(version, `bundle "${id}" versions[${versionIndex}]`)
    );
    if (!versions.includes(latest)) {
      throw new Error(`bundle "${id}" latest version is not listed`);
    }
    if (new Set(versions).size !== versions.length || seen.has(id)) {
      throw new Error("content-registry index has duplicate bundle/version entries");
    }
    seen.add(id);
    // Optional release metadata: {version: {notes}} entries for listed versions.
    let releaseNotes: Record<string, string> | undefined;
    if (typeof item.releases === "object" && item.releases !== null && !Array.isArray(item.releases)) {
      for (const [version, release] of Object.entries(item.releases as Record<string, unknown>)) {
        if (!versions.includes(version)) continue;
        const notes = (release as { notes?: unknown } | null)?.notes;
        if (typeof notes === "string" && notes.length > 0) {
          (releaseNotes ??= {})[version] = notes;
        }
      }
    }
    return { id, latest, versions, ...(releaseNotes ? { releaseNotes } : {}) };
  });
  return { schemaVersion: INDEX_SCHEMA, bundles };
}

export function parseContentRegistryManifest(
  value: unknown,
  expectedBundle?: string,
  expectedVersion?: string,
): ContentRegistryManifest {
  const raw = object(value, "content-registry manifest");
  if (raw.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(raw.files)) {
    throw new Error(`content-registry manifest must use ${MANIFEST_SCHEMA}`);
  }
  const bundle = safeId(raw.bundle, "manifest.bundle");
  const version = safeId(raw.version, "manifest.version");
  if (
    (expectedBundle !== undefined && bundle !== expectedBundle) ||
    (expectedVersion !== undefined && version !== expectedVersion)
  ) {
    throw new Error(
      `content-registry manifest identifies ${bundle}@${version}, expected ` +
        `${expectedBundle ?? bundle}@${expectedVersion ?? version}`,
    );
  }
  const runtimeProtocol = string(raw.runtimeProtocol, "manifest.runtimeProtocol");
  const rawEntrypoints = object(raw.entrypoints, "manifest.entrypoints");
  const workflow = safeRegistryPath(
    rawEntrypoints.workflow,
    "manifest.entrypoints.workflow",
  );
  if (!Array.isArray(rawEntrypoints.controls)) {
    throw new Error("manifest.entrypoints.controls must be an array");
  }
  const controls = rawEntrypoints.controls.map((path, index) =>
    safeRegistryPath(path, `manifest.entrypoints.controls[${index}]`)
  );
  if (raw.files.length === 0 || raw.files.length > MAX_FILES) {
    throw new Error(`manifest files must contain 1..${MAX_FILES} entries`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = raw.files.map((candidate, index): ContentRegistryManifestFile => {
    const item = object(candidate, `manifest.files[${index}]`);
    const path = safeRegistryPath(item.path, `manifest.files[${index}].path`);
    const sha256 = string(item.sha256, `manifest.files[${index}].sha256`);
    const bytes = item.bytes;
    const mediaType = string(item.mediaType, `manifest.files[${index}].mediaType`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`manifest file "${path}" has an invalid SHA-256`);
    }
    if (
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_FILE_BYTES
    ) {
      throw new Error(`manifest file "${path}" has an invalid byte size`);
    }
    if (seen.has(path)) throw new Error(`manifest repeats file "${path}"`);
    seen.add(path);
    totalBytes += bytes;
    return { path, sha256, bytes, mediaType };
  });
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`content-registry bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
  for (const path of [workflow, ...controls]) {
    if (!seen.has(path)) throw new Error(`manifest entrypoint "${path}" is not listed`);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA,
    bundle,
    version,
    runtimeProtocol,
    entrypoints: { workflow, controls },
    files,
  };
}

export function normalizeContentRegistryUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/mcp")) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/mcp`;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function resourceUri(path: string): string {
  return `brain://file/${safeRegistryPath(path).split("/").map(encodeURIComponent).join("/")}`;
}

function textFromResource(value: unknown, path: string): string {
  const result = value as {
    contents?: Array<{ text?: unknown; blob?: unknown }>;
  };
  const item = result.contents?.[0];
  if (!item || typeof item.text !== "string" || item.blob !== undefined) {
    throw new Error(`Brain Registry resource "${path}" is not UTF-8 text`);
  }
  return item.text;
}

export class ContentRegistryClient {
  private readonly client = new Client({
    name: "brain-orchestrator",
    version: "0.1.0",
  });
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(readonly url: string) {
    this.transport = new StreamableHTTPClientTransport(
      new URL(normalizeContentRegistryUrl(url)),
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async readText(path: string): Promise<string> {
    await this.connect();
    const safe = safeRegistryPath(path);
    try {
      return textFromResource(
        await this.client.readResource({ uri: resourceUri(safe) }),
        safe,
      );
    } catch (error) {
      throw new Error(
        `failed to read Brain Registry resource "${safe}": ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  }

  async resolvePin(
    bundle = "brainstorm",
    requestedVersion?: string,
  ): Promise<ContentRegistryPin> {
    const index = parseContentRegistryIndex(
      JSON.parse(await this.readText("index.json")) as unknown,
    );
    const found = index.bundles.find((candidate) => candidate.id === bundle);
    if (!found) throw new Error(`Brain Registry has no bundle "${bundle}"`);
    const version = requestedVersion ?? found.latest;
    if (!found.versions.includes(version)) {
      throw new Error(`Brain Registry has no ${bundle}@${version}`);
    }
    const manifest = parseContentRegistryManifest(
      JSON.parse(
        await this.readText(`bundles/${bundle}/${version}/manifest.json`),
      ) as unknown,
      bundle,
      version,
    );
    const manifestSha256 = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    return {
      registryUrl: normalizeContentRegistryUrl(this.url),
      bundle,
      version,
      manifestSha256,
      manifest,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.transport.close();
  }
}

function cacheDestination(root: string, relativePath: string): string {
  const safe = safeRegistryPath(relativePath);
  const resolvedRoot = resolve(root);
  const destination = resolve(resolvedRoot, ...safe.split("/"));
  if (!destination.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`cache path escapes root: "${safe}"`);
  }
  return destination;
}

export class ContentRegistryCache {
  private readonly files: ReadonlyMap<string, ContentRegistryManifestFile>;
  private readonly inFlight = new Map<string, Promise<string>>();
  readonly root: string;

  constructor(
    readonly cacheRoot: string,
    readonly pin: ContentRegistryPin,
    private readonly client: ContentRegistryClient,
  ) {
    this.files = new Map(
      pin.manifest.files.map((entry) => [entry.path, entry]),
    );
    this.root = resolve(
      cacheRoot,
      pin.bundle,
      pin.version,
      pin.manifestSha256,
    );
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  roleNames(): ReadonlySet<string> {
    return new Set(
      this.pin.manifest.files.flatMap((entry) => {
        const match = /^skills\/roles\/([^/]+)\.md$/.exec(entry.path);
        return match ? [match[1]!] : [];
      }),
    );
  }

  rolePath(name: string): string {
    const path = `skills/roles/${safeId(name, "role name")}.md`;
    if (!this.has(path)) throw new Error(`manifest has no role "${name}"`);
    return path;
  }

  techniquePath(name: string): string {
    const path = `skills/techniques/${safeId(name, "technique name")}.md`;
    if (!this.has(path)) throw new Error(`manifest has no technique "${name}"`);
    return path;
  }

  async ensure(path: string): Promise<string> {
    const safe = safeRegistryPath(path);
    const existing = this.inFlight.get(safe);
    if (existing) return existing;
    const promise = this.ensureInner(safe).finally(() => {
      this.inFlight.delete(safe);
    });
    this.inFlight.set(safe, promise);
    return promise;
  }

  async ensureMany(paths: readonly string[]): Promise<readonly string[]> {
    return Promise.all(paths.map((path) => this.ensure(path)));
  }

  private async ensureInner(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`manifest does not list "${path}"`);
    const destination = cacheDestination(this.root, path);
    if (existsSync(destination)) {
      const existing = readFileSync(destination);
      if (
        existing.length === entry.bytes &&
        createHash("sha256").update(existing).digest("hex") === entry.sha256
      ) {
        return destination;
      }
      rmSync(destination, { force: true });
    }
    const registryPath =
      `bundles/${this.pin.bundle}/${this.pin.version}/${path}`;
    const text = await this.client.readText(registryPath);
    const contents = Buffer.from(text, "utf8");
    if (contents.length !== entry.bytes) {
      throw new Error(
        `Brain Registry file "${path}" has ${contents.length} bytes; expected ${entry.bytes}`,
      );
    }
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`Brain Registry file "${path}" failed SHA-256 verification`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, contents);
    renameSync(temporary, destination);
    return destination;
  }
}

export function writeContentPin(path: string, pin: ContentRegistryPin): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function readContentPin(path: string): ContentRegistryPin {
  const raw = object(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
    "content pin",
  );
  const registryUrl = string(raw.registryUrl, "content pin registryUrl");
  const manifest = parseContentRegistryManifest(raw.manifest);
  const manifestSha256 = string(
    raw.manifestSha256,
    "content pin manifestSha256",
  );
  const actual = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  if (actual !== manifestSha256) throw new Error("content pin manifest hash is invalid");
  return {
    registryUrl,
    bundle: manifest.bundle,
    version: manifest.version,
    manifestSha256,
    manifest,
  };
}
