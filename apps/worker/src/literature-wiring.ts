/**
 * Worker wiring of the paper-based panel composition: the encoder provider
 * (@brainstorm-agentic/encoder when that package is installed, the runtime's
 * hash-ngram-v1 fallback otherwise), node vectors served by the registry,
 * the bundle's node texts, which key-gated sources have keys, and the run's
 * retrieval cache.
 */
import { join } from "node:path";

import { hashNgramEncoderProvider } from "@brainstorm-agentic/brainstorm-runtime";
import type { ContentBundle } from "@brainstorm-agentic/content";
import type { EncoderProvider, NodeTextsAccess, NodeVectorIndex } from "@brainstorm-agentic/core";

/** The optional encoder package (not a declared dependency: resolved at run time). */
export const ENCODER_PACKAGE = "@brainstorm-agentic/encoder";

/** Registry-served node vectors (contract I): undefined when the registry holds none. */
export interface RegistryNodeVectors {
  nodeIndex(encoderId: string, revision: number): Promise<NodeVectorIndex | undefined>;
}

export interface EncoderProviderOptions {
  readonly modelDir?: string;
  readonly openRouterApiKey?: string;
  readonly cacheDir?: string;
  readonly registry?: RegistryNodeVectors;
  readonly threads?: number;
  /** Test seam: how the encoder package is imported. */
  readonly importer?: (specifier: string) => Promise<unknown>;
  /** Where the fallback is announced. */
  readonly log?: (line: string) => void;
}

/**
 * An EncoderProvider that resolves the encoder package on first use. When the
 * package cannot be imported (not installed in this deployment) every call
 * goes to the hash-ngram-v1 fallback, announced once.
 */
export function lazyEncoderProvider(options: EncoderProviderOptions = {}): EncoderProvider & {
  readonly origin: () => Promise<"package" | "fallback">;
} {
  const log = options.log ?? ((line: string) => console.error(line));
  let loaded: Promise<{ readonly provider: EncoderProvider; readonly origin: "package" | "fallback" }> | undefined;
  const load = () => {
    loaded ??= (async () => {
      try {
        const importer = options.importer ?? ((specifier: string) => import(specifier) as Promise<unknown>);
        const module = (await importer(ENCODER_PACKAGE)) as {
          readonly createEncoderProvider?: (settings: Record<string, unknown>) => EncoderProvider;
        };
        if (typeof module.createEncoderProvider !== "function") {
          throw new Error("the package exports no createEncoderProvider");
        }
        return {
          provider: module.createEncoderProvider({
            ...(options.modelDir !== undefined ? { modelDir: options.modelDir } : {}),
            ...(options.openRouterApiKey !== undefined ? { openRouterApiKey: options.openRouterApiKey } : {}),
            ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
            ...(options.registry !== undefined ? { registry: options.registry } : {}),
            ...(options.threads !== undefined ? { threads: options.threads } : {}),
          }),
          origin: "package" as const,
        };
      } catch (error) {
        log(
          `[encoder] ${ENCODER_PACKAGE} is unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            "the panel composition embeds with hash-ngram-v1",
        );
        return { provider: hashNgramEncoderProvider(), origin: "fallback" as const };
      }
    })();
    return loaded;
  };
  return {
    async encoder(id) {
      return (await load()).provider.encoder(id);
    },
    async nodeIndex(encoder, taxonomyRevision, texts) {
      return (await load()).provider.nodeIndex(encoder, taxonomyRevision, texts);
    },
    async origin() {
      return (await load()).origin;
    },
  };
}

/**
 * Node vectors from the registry's taxonomy_embeddings tool with an encoder
 * argument (contract I): float32 little-endian vectors in base64, served
 * only for the registry's current revision.
 */
export function registryNodeVectors(client: {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}): RegistryNodeVectors {
  return {
    async nodeIndex(encoderId, revision) {
      try {
        const answer = (await client.callTool("taxonomy_embeddings", { encoder: encoderId })) as Record<string, unknown>;
        if (
          typeof answer !== "object" ||
          answer === null ||
          typeof answer.vectorsB64 !== "string" ||
          !Array.isArray(answer.ids) ||
          typeof answer.dim !== "number"
        ) {
          return undefined;
        }
        if (typeof answer.revision === "number" && answer.revision !== revision) return undefined;
        const bytes = Buffer.from(answer.vectorsB64, "base64");
        const dim = answer.dim;
        const ids = answer.ids.map(String);
        if (bytes.byteLength !== ids.length * dim * 4) return undefined;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const vectors = new Float32Array(ids.length * dim);
        for (let i = 0; i < vectors.length; i += 1) vectors[i] = view.getFloat32(i * 4, true);
        return {
          encoderId,
          taxonomyRevision: revision,
          nodeTextsSha256: typeof answer.nodeTextsSha256 === "string" ? answer.nodeTextsSha256 : "",
          vectorsSha256: typeof answer.vectorsSha256 === "string" ? answer.vectorsSha256 : "",
          ids,
          dim,
          vectors,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/** The bundle's catalog/taxonomy-texts.json as NodeTextsAccess (undefined texts when absent). */
export function nodeTextsFromBundle(bundle: ContentBundle): NodeTextsAccess {
  return {
    async texts() {
      const texts = bundle.taxonomyTexts;
      return texts === undefined ? undefined : { sha256: texts.sha256, entries: texts.entries };
    },
  };
}

/** Which key-gated literature sources have a configured key. */
export function keyedSourcesFromSecrets(secrets: {
  readonly openAlexApiKey?: string;
  readonly coreApiKey?: string;
  readonly semanticScholarApiKey?: string;
}): ReadonlySet<string> {
  const keyed = new Set<string>();
  if (secrets.openAlexApiKey !== undefined && secrets.openAlexApiKey !== "") keyed.add("openalex");
  if (secrets.coreApiKey !== undefined && secrets.coreApiKey !== "") keyed.add("core");
  if (secrets.semanticScholarApiKey !== undefined && secrets.semanticScholarApiKey !== "") keyed.add("semantic-scholar");
  return keyed;
}

/** The literature wiring of one run (encoders, caches under the workspace, keyed sources). */
export function literatureWiringForRun(options: {
  readonly workspaceRoot: string;
  readonly secrets: { readonly openAlexApiKey?: string; readonly coreApiKey?: string; readonly semanticScholarApiKey?: string };
  readonly openRouterApiKey?: string;
  readonly registry?: { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
  readonly env?: NodeJS.ProcessEnv;
}): { readonly encoders: EncoderProvider; readonly cacheDir: string; readonly keyedSources: ReadonlySet<string> } {
  const env = options.env ?? process.env;
  const modelDir = env.BRAINSTORM_AGENTIC_ENCODER_DIR?.trim();
  return {
    encoders: lazyEncoderProvider({
      ...(modelDir !== undefined && modelDir !== "" ? { modelDir } : {}),
      ...(options.openRouterApiKey !== undefined ? { openRouterApiKey: options.openRouterApiKey } : {}),
      cacheDir: join(options.workspaceRoot, "encoder-cache"),
      ...(options.registry !== undefined ? { registry: registryNodeVectors(options.registry) } : {}),
    }),
    cacheDir: join(options.workspaceRoot, "literature-cache"),
    keyedSources: keyedSourcesFromSecrets(options.secrets),
  };
}
