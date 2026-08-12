import { createHash } from "node:crypto";

import type { JsonObject } from "../types/json.js";

export interface ArtifactRef {
  readonly id: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size: number;
  /** SHA-256 of the payload; the identity idempotent puts dedupe on. */
  readonly sha256?: string;
  readonly metadata?: JsonObject;
}

export interface ArtifactInput {
  readonly name: string;
  /** Text or base64-encoded payload; contentType tells consumers which. */
  readonly data: string;
  readonly contentType?: string;
  readonly metadata?: JsonObject;
}

export interface StoredArtifact extends ArtifactRef {
  readonly data: string;
}

/**
 * Stores artifacts. `put` MUST be idempotent on (name, payload): putting
 * bytes that already exist under the same name returns the existing ref
 * instead of writing a copy. Deterministic replay relies on this — a
 * resumed run re-executes its state folds, which re-persist the same
 * artifacts, and must observe the identical ref history the original run
 * produced.
 */
export interface ArtifactStore {
  put(artifact: ArtifactInput): Promise<ArtifactRef>;
  get(id: string): Promise<StoredArtifact | undefined>;
  list(): Promise<readonly ArtifactRef[]>;
}

/** The payload hash idempotent puts dedupe on. */
export function artifactSha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private counter = 0;

  async put(artifact: ArtifactInput): Promise<ArtifactRef> {
    const sha256 = artifactSha256(artifact.data);
    for (const stored of this.artifacts.values()) {
      if (stored.name === artifact.name && stored.sha256 === sha256) {
        const { data: _data, ...ref } = stored;
        return ref;
      }
    }
    const id = `artifact-${++this.counter}`;
    const stored: StoredArtifact = {
      id,
      name: artifact.name,
      size: artifact.data.length,
      sha256,
      data: artifact.data,
      ...(artifact.contentType !== undefined ? { contentType: artifact.contentType } : {}),
      ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
    };
    this.artifacts.set(id, stored);
    const { data: _data, ...ref } = stored;
    return ref;
  }

  async get(id: string): Promise<StoredArtifact | undefined> {
    return this.artifacts.get(id);
  }

  async list(): Promise<readonly ArtifactRef[]> {
    return [...this.artifacts.values()].map(({ data: _data, ...ref }) => ref);
  }
}
