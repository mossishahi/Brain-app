import type { JsonObject } from "../types/json.js";

export interface ArtifactRef {
  readonly id: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size: number;
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

export interface ArtifactStore {
  put(artifact: ArtifactInput): Promise<ArtifactRef>;
  get(id: string): Promise<StoredArtifact | undefined>;
  list(): Promise<readonly ArtifactRef[]>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private counter = 0;

  async put(artifact: ArtifactInput): Promise<ArtifactRef> {
    const id = `artifact-${++this.counter}`;
    const stored: StoredArtifact = {
      id,
      name: artifact.name,
      size: artifact.data.length,
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
