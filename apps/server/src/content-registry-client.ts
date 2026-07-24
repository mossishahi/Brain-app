import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { loadContent } from "@brainstorm-agentic/content";

const INDEX_SCHEMA = "content-registry-index/v1";
const MANIFEST_SCHEMA = "content-registry-manifest/v1";
const SUPPORTED_RUNTIME_PROTOCOL = "brainstorm.workflow/v1";
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface ContentRegistryIndexBundle {
  readonly id: string;
  readonly latest: string;
  readonly versions: readonly string[];
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

export interface ContentRegistryManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA;
  readonly bundle: string;
  readonly version: string;
  readonly runtimeProtocol: string;
  readonly files: readonly ContentRegistryManifestFile[];
}

export interface FetchContentRegistryBundleOptions {
  readonly url: string;
  readonly bundle?: string;
  readonly version?: string;
  readonly signal?: AbortSignal;
}

export interface FetchedContentRegistryBundle {
  readonly manifest: ContentRegistryManifest;
  readonly manifestSha256: string;
  readonly files: ReadonlyMap<string, Buffer>;
}

export interface MaterializedContentRegistryBundle {
  readonly bundle: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly skills: number;
  readonly workflows: number;
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

function safeRelativePath(value: unknown, label: string): string {
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

function parseIndex(value: unknown): ContentRegistryIndex {
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
      throw new Error(`content-registry index has duplicate bundle/version entries`);
    }
    seen.add(id);
    return { id, latest, versions };
  });
  return { schemaVersion: INDEX_SCHEMA, bundles };
}

function parseManifest(
  value: unknown,
  expectedBundle: string,
  expectedVersion: string,
): ContentRegistryManifest {
  const raw = object(value, "content-registry manifest");
  if (raw.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(raw.files)) {
    throw new Error(`content-registry manifest must use ${MANIFEST_SCHEMA}`);
  }
  const bundle = safeId(raw.bundle, "manifest.bundle");
  const version = safeId(raw.version, "manifest.version");
  if (bundle !== expectedBundle || version !== expectedVersion) {
    throw new Error(
      `content-registry manifest identifies ${bundle}@${version}, expected ${expectedBundle}@${expectedVersion}`,
    );
  }
  const runtimeProtocol = string(raw.runtimeProtocol, "manifest.runtimeProtocol");
  if (runtimeProtocol !== SUPPORTED_RUNTIME_PROTOCOL) {
    throw new Error(
      `unsupported content-registry runtime protocol "${runtimeProtocol}"`,
    );
  }
  if (raw.files.length === 0 || raw.files.length > MAX_FILES) {
    throw new Error(`manifest files must contain 1..${MAX_FILES} entries`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = raw.files.map((candidate, index): ContentRegistryManifestFile => {
    const item = object(candidate, `manifest.files[${index}]`);
    const path = safeRelativePath(item.path, `manifest.files[${index}].path`);
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
  return {
    schemaVersion: MANIFEST_SCHEMA,
    bundle,
    version,
    runtimeProtocol,
    files,
  };
}

function baseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

async function responseJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`content-registry request ${url} failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchContentRegistryIndex(
  url: string,
  signal?: AbortSignal,
): Promise<ContentRegistryIndex> {
  return parseIndex(await responseJson(`${baseUrl(url)}/v1/index.json`, signal));
}

export async function fetchContentRegistryBundle(
  options: FetchContentRegistryBundleOptions,
): Promise<FetchedContentRegistryBundle> {
  const root = baseUrl(options.url);
  const requestedBundle = options.bundle ?? "brainstorm";
  const index = await fetchContentRegistryIndex(root, options.signal);
  const indexed = index.bundles.find((entry) => entry.id === requestedBundle);
  if (!indexed) throw new Error(`content registry has no bundle "${requestedBundle}"`);
  const version = options.version ?? indexed.latest;
  if (!indexed.versions.includes(version)) {
    throw new Error(`content registry has no ${requestedBundle}@${version}`);
  }

  const prefix =
    `${root}/v1/bundles/${encodeURIComponent(requestedBundle)}/${encodeURIComponent(version)}`;
  const manifestJson = await responseJson(`${prefix}/manifest.json`, options.signal);
  const manifest = parseManifest(manifestJson, requestedBundle, version);
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");

  const downloaded = await Promise.all(
    manifest.files.map(async (entry): Promise<readonly [string, Buffer]> => {
      const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${prefix}/${encodedPath}`, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `content-registry file "${entry.path}" failed with HTTP ${response.status}`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== entry.bytes) {
        throw new Error(
          `content-registry file "${entry.path}" has ${bytes.length} bytes; expected ${entry.bytes}`,
        );
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== entry.sha256) {
        throw new Error(`content-registry file "${entry.path}" failed SHA-256 verification`);
      }
      return [entry.path, bytes] as const;
    }),
  );
  return { manifest, manifestSha256, files: new Map(downloaded) };
}

function destinationPath(rootDir: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath, "bundle file path");
  const root = resolve(rootDir);
  const destination = resolve(root, ...safe.split("/"));
  if (!destination.startsWith(`${root}${sep}`)) {
    throw new Error(`bundle file escapes destination: "${safe}"`);
  }
  return destination;
}

/**
 * Host-owned processing boundary: fetch immutable bytes, verify hashes,
 * materialize atomically, then parse and cross-validate the bundle locally.
 */
export async function fetchAndMaterializeContentRegistryBundle(
  options: FetchContentRegistryBundleOptions & { readonly destination: string },
): Promise<MaterializedContentRegistryBundle> {
  const fetched = await fetchContentRegistryBundle(options);
  const destination = resolve(options.destination);
  const staging = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const [relativePath, contents] of fetched.files) {
      const path = destinationPath(staging, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    writeFileSync(
      resolve(staging, ".content-registry-manifest.json"),
      `${JSON.stringify({
        ...fetched.manifest,
        manifestSha256: fetched.manifestSha256,
      }, null, 2)}\n`,
      "utf8",
    );

    // Structural and cross-document validation happens here, in the host.
    loadContent(staging);

    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    bundle: fetched.manifest.bundle,
    version: fetched.manifest.version,
    manifestSha256: fetched.manifestSha256,
    skills: fetched.manifest.files.filter((file) =>
      file.path.startsWith("skills/") && file.path.endsWith(".md")
    ).length,
    workflows: fetched.manifest.files.filter((file) =>
      file.path.startsWith("workflows/") && file.path.endsWith(".workflow.json")
    ).length,
  };
}
