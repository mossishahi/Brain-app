import { WorkflowConfigError } from "../errors.js";

export type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

/**
 * Runs `fn` over `items` with at most `limit` invocations in flight.
 * Starts items in index order and returns per-index settlement results
 * (never rejects), so callers can apply deterministic outcome precedence.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly Settled<R>[]> {
  if (!Number.isFinite(limit) && limit !== Infinity) {
    throw new WorkflowConfigError(`invalid concurrency limit: ${limit}`);
  }
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
    throw new WorkflowConfigError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results: Settled<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit === Infinity ? items.length : limit, items.length);
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
