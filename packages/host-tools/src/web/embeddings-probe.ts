/**
 * The OpenRouter embeddings probe (availability spec, Section 1: the
 * "openrouter-embeddings" tool): one one-word embedding request against the
 * configured model, exported for the server's availability service. Without
 * a key no request is made.
 */
import type { ProviderFetch } from "./providers.js";
import { runProbe, type WebSourceStatusWithLog } from "./probe.js";

export const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export async function probeOpenRouterEmbeddings(
  apiKey: string | undefined,
  model: string,
  fetchImpl?: ProviderFetch,
  options: { readonly signal?: AbortSignal; readonly now?: () => number; readonly url?: string } = {},
): Promise<WebSourceStatusWithLog> {
  const id = "openrouter-embeddings";
  const key = apiKey !== undefined && apiKey.trim() !== "" ? apiKey.trim() : undefined;
  const now = options.now ?? (() => Date.now());
  if (key === undefined) {
    const checkedAt = now();
    return {
      id,
      state: "needs-key",
      detail: "OpenRouter embeddings need an API key (openRouterApiKey in Settings)",
      checkedAt,
      log: [{ at: checkedAt, level: "warn", text: "no OpenRouter API key: not probed" }],
    };
  }
  const doFetch = fetchImpl ?? (fetch as unknown as ProviderFetch);
  const url = options.url ?? OPENROUTER_EMBEDDINGS_URL;
  return runProbe(
    id,
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      now,
      secrets: [key],
      request: `POST ${url} model=${model} input="hello"`,
    },
    async (signal) => {
      const started = now();
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model, input: ["hello"], encoding_format: "float", provider: { data_collection: "deny" } }),
        signal,
      });
      const text = await response.text();
      const elapsed = now() - started;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenRouter refused the API key (HTTP ${response.status}) — check it in Settings`);
      }
      if (response.status >= 400) throw new Error(`OpenRouter embeddings answered HTTP ${response.status} in ${elapsed} ms`);
      let payload: { data?: { embedding?: unknown }[]; model?: string; error?: { message?: string } };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        throw new Error("OpenRouter embeddings returned non-JSON content");
      }
      if (payload.error !== undefined) throw new Error(`OpenRouter embeddings error: ${payload.error.message ?? "request failed"}`);
      const vector = payload.data?.[0]?.embedding;
      const dim = Array.isArray(vector) ? vector.length : 0;
      const served = payload.model !== undefined ? ` by ${payload.model}` : "";
      return dim > 0
        ? { ok: true, summary: `HTTP ${response.status}, 1 vector of ${dim} dimensions${served}`, detail: `${dim} dimensions${served}` }
        : { ok: false, detail: `answered HTTP ${response.status} without an embedding vector${served}` };
    },
  );
}
