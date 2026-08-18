import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ContentValidationError,
  loadControlContent,
  SUPPORTED_RUNTIME_PROTOCOLS,
  memoryContentSource,
  parseSkillText,
  type ContentBundle,
  type Skill,
  type ValidationIssue,
} from "@brainstorm-agentic/content";
import { atLeastVersion } from "@brainstorm-agentic/core";
import type {
  ResolvedRole,
  SkillResolver,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  ContentRegistryStore,
  ContentRegistryClient,
  normalizeContentRegistryUrl,
  readContentPin,
  writeContentPin,
  type ContentRegistryPin,
} from "@brainstorm-agentic/registry-client";

/** Parses a fetched, hash-verified skill document straight from memory. */
function skillFromText(text: string, path: string): Skill {
  const issues: ValidationIssue[] = [];
  const skill = parseSkillText(text, path, issues);
  if (!skill || issues.length > 0) throw new ContentValidationError(issues);
  return skill;
}

/**
 * Resolves roles from the store's in-memory cache. Since the up-front skill
 * prefetch (see openLazyRegistryContent) the laziness is parse-only: every
 * file is already in memory, so resolution never touches the network.
 */
class LazyRegistrySkillResolver implements SkillResolver {
  private readonly resolved = new Map<string, Promise<ResolvedRole>>();

  constructor(private readonly store: ContentRegistryStore) {}

  hasRole(name: string): boolean {
    return this.store.roleNames().has(name);
  }

  resolveRole(name: string): Promise<ResolvedRole> {
    const existing = this.resolved.get(name);
    if (existing) return existing;
    const pending = this.resolve(name);
    this.resolved.set(name, pending);
    return pending;
  }

  private async resolve(name: string): Promise<ResolvedRole> {
    const rolePath = this.store.rolePath(name);
    const role = skillFromText(await this.store.ensure(rolePath), rolePath);
    const techniques: Skill[] = [];
    for (const techniqueName of role.meta.techniques) {
      const path = this.store.techniquePath(techniqueName);
      techniques.push(skillFromText(await this.store.ensure(path), path));
    }
    return { role, techniques };
  }
}

export interface LazyRegistryContent {
  readonly bundle: ContentBundle;
  readonly skillResolver: SkillResolver;
  readonly pin: ContentRegistryPin;
  /** The open registry connection — also carries the taxonomy MCP tools. */
  readonly client: ContentRegistryClient;
  /** The pinned taxonomy document, held in memory like the rest of the bundle. */
  readonly taxonomySeed: string | undefined;
  close(): Promise<void>;
}

/**
 * Opens a version-pinned lazy content view held entirely in memory. Nothing is
 * written to disk, so a run leaves no copy of the pipeline behind; the pin
 * (names and hashes only) is the durable record, and a resume re-fetches the
 * same immutable version and re-verifies every byte.
 */
export async function openLazyRegistryContent(options: {
  readonly registryUrl: string;
  readonly contentDir: string;
  readonly resume: boolean;
  readonly bundle?: string;
  readonly version?: string;
  /**
   * This app's release version, checked against any floor the bundle
   * declares. Omitted only where no build identifies itself (tests), which
   * skips the check rather than inventing a version to compare.
   */
  readonly appVersion?: string;
}): Promise<LazyRegistryContent> {
  const pinPath = join(options.contentDir, "content-pin.json");
  const client = new ContentRegistryClient(options.registryUrl);
  let pin: ContentRegistryPin;
  if (options.resume) {
    if (!existsSync(pinPath)) {
      throw new Error(`cannot resume: content pin is missing at "${pinPath}"`);
    }
    pin = readContentPin(pinPath);
    if (pin.registryUrl !== normalizeContentRegistryUrl(options.registryUrl)) {
      throw new Error(
        `content registry URL changed since the run was pinned: ${pin.registryUrl}`,
      );
    }
  } else {
    if (existsSync(pinPath)) {
      throw new Error(`new run already has a content pin at "${pinPath}"`);
    }
    pin = await client.resolvePin(options.bundle ?? "brainstorm", options.version);
    writeContentPin(pinPath, pin);
  }

  // Refuse a bundle built for a runtime dialect this host does not implement.
  // The declaration was parsed into the pin but never checked, so a future
  // bundle would have loaded here and failed somewhere downstream looking like
  // a content bug rather than a version mismatch.
  if (!SUPPORTED_RUNTIME_PROTOCOLS.has(pin.manifest.runtimeProtocol)) {
    throw new Error(
      `bundle ${pin.bundle}@${pin.version} targets runtime protocol ` +
        `"${pin.manifest.runtimeProtocol}", which this app does not implement ` +
        `(supported: ${[...SUPPORTED_RUNTIME_PROTOCOLS].join(", ")}). Update the app.`,
    );
  }

  // Refuse a bundle that needs a newer app than this one. The protocol above
  // says which dialect the content speaks; this says which app implements the
  // parts this version actually uses. Without it the mismatch surfaces as a
  // content error at compile — or, worse, as a bind that resolves to nothing
  // partway through a run, after the panel has already been paid for, and the
  // journaled artifact then replays into the same failure on every resume.
  const floor = pin.manifest.minAppVersion;
  if (
    floor !== undefined &&
    options.appVersion !== undefined &&
    !atLeastVersion(options.appVersion, floor)
  ) {
    throw new Error(
      `bundle ${pin.bundle}@${pin.version} needs app ${floor} or newer; this app is ` +
        `${options.appVersion}. Update the app, or pin an older bundle version in ` +
        `settings.json (contentRegistry.version).`,
    );
  }

  const store = new ContentRegistryStore(pin, client);
  await store.ensureMany([
    pin.manifest.entrypoints.workflow,
    ...pin.manifest.entrypoints.controls,
  ]);
  // EVERY skill file is fetched up front, while the connection that just
  // resolved the pin is proven alive. Skills used to be fetched lazily, the
  // first time their role ran — which made a run's success depend on the
  // registry connection surviving into its final hours: an overnight run
  // lost its connection at 03:08 and the one never-yet-fetched skill (the
  // interdisciplinary commentor, first needed deep in review) failed every
  // walk that reached it. The whole set is a few hundred kilobytes and a
  // couple dozen requests — far inside the registry's per-minute budget —
  // so buying it now removes the mid-run network dependency entirely;
  // resolveRole afterwards always answers from memory.
  await store.ensureMany(
    pin.manifest.files
      .map((file) => file.path)
      .filter((path) => path.startsWith("skills/")),
  );
  const bundle = loadControlContent(
    memoryContentSource(`${pin.bundle}@${pin.version}`, store.loaded()),
    pin.manifest.entrypoints.workflow,
    store.roleNames(),
  );
  return {
    bundle,
    skillResolver: new LazyRegistrySkillResolver(store),
    pin,
    client,
    taxonomySeed: store.loaded().get("catalog/taxonomy.json"),
    close: () => client.close(),
  };
}
