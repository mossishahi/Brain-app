import { Worker } from "node:worker_threads";

export type ParserRequest =
  | { readonly operation: "html"; readonly html: string }
  | { readonly operation: "pdf"; readonly bytes: Uint8Array; readonly maxPages: number }
  | { readonly operation: "image"; readonly bytes: Uint8Array; readonly page: number };

/** Untrusted document parsing cannot monopolize the research worker's event loop or JS heap. */
export async function parseDocumentIsolated<T>(request: ParserRequest, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL("./document-parser-worker.js", import.meta.url), {
      workerData: request,
      // Do not inherit debugger flags, loader hooks or service credentials.
      execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let finished = false;
    const finish = (error?: Error, value?: T): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const abort = (): void => finish(new Error("Document parsing was cancelled."));
    const timer = setTimeout(() => finish(new Error(`Document parsing exceeded ${Math.round(timeoutMs / 1000)}s; no partial extraction was accepted.`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { ok?: boolean; value?: T; error?: string }) => {
      if (message.ok) finish(undefined, message.value);
      else finish(new Error(message.error ?? "Document parser failed."));
    });
    worker.once("error", error => finish(new Error(`Document parser failed: ${error.message}`)));
    worker.once("exit", code => { if (!finished) finish(new Error(`Document parser stopped before returning a result (exit ${code}).`)); });
    if (signal?.aborted) abort();
  });
}
