import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  loadControlContent,
  readSkillFile,
  type ContentBundle,
  type Skill,
} from "@brainstorm-agentic/content";
import type {
  ResolvedRole,
  SkillResolver,
} from "@brainstorm-agentic/brainstorm-runtime";
import {
  ContentRegistryCache,
  ContentRegistryClient,
  normalizeContentRegistryUrl,
  readContentPin,
  writeContentPin,
  type ContentRegistryPin,
} from "@brainstorm-agentic/registry-client";

class LazyRegistrySkillResolver implements SkillResolver {
  private readonly resolved = new Map<string, Promise<ResolvedRole>>();

  constructor(private readonly cache: ContentRegistryCache) {}

  hasRole(name: string): boolean {
    return this.cache.roleNames().has(name);
  }

  resolveRole(name: string): Promise<ResolvedRole> {
    const existing = this.resolved.get(name);
    if (existing) return existing;
    const pending = this.resolve(name);
    this.resolved.set(name, pending);
    return pending;
  }

  private async resolve(name: string): Promise<ResolvedRole> {
    const role = readSkillFile(
      await this.cache.ensure(this.cache.rolePath(name)),
    );
    const techniques: Skill[] = [];
    for (const techniqueName of role.meta.techniques) {
      techniques.push(
        readSkillFile(
          await this.cache.ensure(this.cache.techniquePath(techniqueName)),
        ),
      );
    }
    return { role, techniques };
  }
}

export interface LazyRegistryContent {
  readonly bundle: ContentBundle;
  readonly skillResolver: SkillResolver;
  readonly pin: ContentRegistryPin;
  close(): Promise<void>;
}

/**
 * Opens a version-pinned lazy content view. Existing pins are usable offline
 * for already cached resources; a network read happens only for a cache miss.
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

  const cache = new ContentRegistryCache(options.contentDir, pin, client);
  await cache.ensureMany([
    pin.manifest.entrypoints.workflow,
    ...pin.manifest.entrypoints.controls,
  ]);
  const bundle = loadControlContent(
    cache.root,
    pin.manifest.entrypoints.workflow,
    cache.roleNames(),
  );
  return {
    bundle,
    skillResolver: new LazyRegistrySkillResolver(cache),
    pin,
    close: () => client.close(),
  };
}
