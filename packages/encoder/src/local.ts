/**
 * Local ONNX encoders (specter2, bge-base-en-v1.5) on onnxruntime-node with the
 * Hugging Face tokenizer reproduced by @huggingface/tokenizers.
 *
 * Model files: <modelDir>/<id>/{doc.onnx, query.onnx (specter2 only),
 * tokenizer.json, tokenizer_config.json, manifest.json}; the int8 variant uses
 * {doc,query}.int8.onnx (manifest.variants.int8). Each graph maps
 * (input_ids, attention_mask) int64 to `embedding` = L2-normalised CLS vector;
 * the SPECTER2 graphs carry one bottleneck adapter each (doc: proximity,
 * query: adhoc_query). Inputs are truncated to manifest.maxTokens (512)
 * including [CLS] and [SEP], exactly like the Python tokenizer call
 * `tok(texts, truncation=True, max_length=512, return_token_type_ids=False)`.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { EncodeMode, EncoderManifest, TextEncoder } from "@brainstorm-agentic/core";
import { importRuntimeComponent } from "@brainstorm-agentic/core";

import { formatQuery } from "./util.js";

export const LOCAL_ENCODER_IDS: readonly string[] = ["specter2", "bge-base-en-v1.5"];

export type Precision = "fp32" | "int8";

interface GraphEntry {
  readonly file: string;
  readonly sha256: string;
  readonly bytes?: number;
  readonly adapter?: string | null;
}

interface ManifestFile extends EncoderManifest {
  readonly maxTokens?: number;
  readonly output?: string;
  readonly graphs: Readonly<Record<string, GraphEntry>>;
  readonly variants?: Readonly<
    Record<string, { readonly graphs: Readonly<Record<string, GraphEntry>>; readonly verification: EncoderManifest["verification"] }>
  >;
  readonly tokenizer?: Readonly<Record<string, string>>;
}

interface TokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] };
  token_to_id(token: string): number | undefined;
}

interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

interface OrtModule {
  readonly InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<OrtSession> };
  readonly Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
}

export interface LocalEncoderOptions {
  readonly modelDir: string;
  readonly id: string;
  /** intra-op threads of onnxruntime (default 8). */
  readonly threads?: number;
  readonly precision?: Precision;
  /** Texts per forward pass (default 32, as in the prototype). */
  readonly batchSize?: number;
  /** Check graph and tokenizer files against the manifest sha256 (default true). */
  readonly verifyChecksums?: boolean;
}

export interface LocalEncoder extends TextEncoder {
  readonly precision: Precision;
  readonly threads: number;
  /** Model input ids (with [CLS]/[SEP], truncated) of one text in one mode. */
  tokenize(text: string, mode: EncodeMode): number[];
  release(): Promise<void>;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function loadOrt(): Promise<OrtModule> {
  const loaded = (await importRuntimeComponent("encoder", "onnxruntime-node", import.meta.url,
    () => import("onnxruntime-node"))) as unknown as Partial<OrtModule> & { readonly default?: OrtModule };
  const ort = loaded.InferenceSession ? (loaded as OrtModule) : loaded.default;
  if (!ort?.InferenceSession || !ort.Tensor) throw new Error("onnxruntime-node did not load");
  return ort;
}

async function loadTokenizer(json: object, config: object): Promise<TokenizerLike> {
  const loaded = (await importRuntimeComponent("encoder", "@huggingface/tokenizers", import.meta.url,
    () => import("@huggingface/tokenizers"))) as unknown as {
    readonly Tokenizer: new (tokenizer: object, config: object) => TokenizerLike;
  };
  return new loaded.Tokenizer(json, config);
}

export async function createLocalEncoder(options: LocalEncoderOptions): Promise<LocalEncoder> {
  const { id } = options;
  const dir = join(options.modelDir, id);
  const file = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ManifestFile;
  if (file.id !== id) throw new Error(`${id}: manifest.json declares id "${file.id}"`);
  const precision = options.precision ?? "fp32";
  const variant = precision === "fp32" ? { graphs: file.graphs, verification: file.verification } : file.variants?.[precision];
  if (!variant) throw new Error(`${id}: manifest.json has no ${precision} variant`);
  const docGraph = variant.graphs.doc;
  if (!docGraph) throw new Error(`${id}: manifest.json names no doc graph`);
  const queryGraph = variant.graphs.query ?? docGraph;
  if (options.verifyChecksums !== false) {
    for (const graph of new Set([docGraph, queryGraph])) {
      const actual = await fileSha256(join(dir, graph.file));
      if (actual !== graph.sha256) throw new Error(`${id}: ${graph.file} sha256 ${actual} != manifest ${graph.sha256}`);
    }
    for (const [name, expected] of Object.entries(file.tokenizer ?? {})) {
      const actual = await fileSha256(join(dir, name));
      if (actual !== expected) throw new Error(`${id}: ${name} sha256 ${actual} != manifest ${expected}`);
    }
  }
  const tokenizerConfig = JSON.parse(await readFile(join(dir, "tokenizer_config.json"), "utf8")) as Record<string, unknown>;
  const tokenizer = await loadTokenizer(
    JSON.parse(await readFile(join(dir, "tokenizer.json"), "utf8")) as object,
    tokenizerConfig,
  );
  const special = (key: string, fallback: string): number => {
    const token = typeof tokenizerConfig[key] === "string" ? (tokenizerConfig[key] as string) : fallback;
    const value = tokenizer.token_to_id(token);
    if (value === undefined) throw new Error(`${id}: tokenizer has no ${token}`);
    return value;
  };
  const cls = special("cls_token", "[CLS]");
  const sep = special("sep_token", "[SEP]");
  const pad = special("pad_token", "[PAD]");
  const maxTokens = file.maxTokens ?? 512;
  const outputName = file.output ?? "embedding";
  const threads = Math.max(1, Math.floor(options.threads ?? 8));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 32));

  const ort = await loadOrt();
  const sessionOptions = {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  };
  const docSession = await ort.InferenceSession.create(join(dir, docGraph.file), sessionOptions);
  const querySession =
    queryGraph === docGraph ? docSession : await ort.InferenceSession.create(join(dir, queryGraph.file), sessionOptions);

  const manifest: EncoderManifest = {
    id: file.id,
    dim: file.dim,
    version: file.version,
    models: {
      ...file.models,
      "onnx:doc": docGraph.sha256,
      ...(queryGraph !== docGraph ? { "onnx:query": queryGraph.sha256 } : {}),
    },
    pooling: file.pooling,
    docFormat: file.docFormat,
    queryFormat: file.queryFormat,
    verification: variant.verification,
  };

  // onnxruntime sessions run one call at a time per encoder (the intra-op pool is the parallelism).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  const tokenize = (text: string, mode: EncodeMode): number[] => {
    const input = mode === "query" ? formatQuery(manifest, text) : text;
    const ids = tokenizer.encode(input, { add_special_tokens: false }).ids;
    const body = ids.length > maxTokens - 2 ? ids.slice(0, maxTokens - 2) : ids;
    return [cls, ...body, sep];
  };

  return {
    manifest,
    precision,
    threads,
    tokenize,
    async embed(texts: readonly string[], mode: EncodeMode, signal?: AbortSignal): Promise<Float32Array[]> {
      signal?.throwIfAborted();
      const tokens = texts.map((text) => tokenize(text, mode));
      const order = tokens.map((_, index) => index).sort((a, b) => tokens[a]!.length - tokens[b]!.length || a - b);
      const out = new Array<Float32Array>(texts.length);
      const session = mode === "query" ? querySession : docSession;
      for (let start = 0; start < order.length; start += batchSize) {
        signal?.throwIfAborted();
        const rows = order.slice(start, start + batchSize);
        const width = Math.max(...rows.map((row) => tokens[row]!.length));
        const ids = new BigInt64Array(rows.length * width).fill(BigInt(pad));
        const mask = new BigInt64Array(rows.length * width);
        rows.forEach((row, r) => {
          tokens[row]!.forEach((token, t) => {
            ids[r * width + t] = BigInt(token);
            mask[r * width + t] = 1n;
          });
        });
        const result = await serial(() =>
          session.run({
            input_ids: new ort.Tensor("int64", ids, [rows.length, width]),
            attention_mask: new ort.Tensor("int64", mask, [rows.length, width]),
          }),
        );
        const output = result[outputName];
        const data = output?.data;
        if (!(data instanceof Float32Array) || data.length !== rows.length * manifest.dim) {
          throw new Error(`${id}: unexpected ${outputName} output`);
        }
        rows.forEach((row, r) => {
          out[row] = data.slice(r * manifest.dim, (r + 1) * manifest.dim);
        });
      }
      return out;
    },
    async release(): Promise<void> {
      await docSession.release?.();
      if (querySession !== docSession) await querySession.release?.();
    },
  };
}
