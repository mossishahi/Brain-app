import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ContentValidationError,
  loadControlContent,
  memoryContentSource,
  parseSkillText,
  type ContentBundle,
  type Skill,
  type ValidationIssue,
} from "@brainstorm-agentic/content";
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

  const store = new ContentRegistryStore(pin, client);
  await store.ensureMany([
    pin.manifest.entrypoints.workflow,
    ...pin.manifest.entrypoints.controls,
  ]);
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
