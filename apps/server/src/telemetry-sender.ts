import { TelemetrySpool, type TelemetryEvent } from "@brainstorm-agentic/telemetry";

/**
 * Drains the local spool and posts it to the ingest endpoint.
 *
 * Everything here is best-effort by design. The worker writes records and
 * exits; this is the only place that touches the network, and it must never
 * affect a run: a failed send returns the records to the spool for the next
 * attempt, and every error is swallowed. Nothing about a job's outcome, status
 * or timing depends on whether telemetry reached anyone.
 *
 * Sends are idempotent at the receiver because every record carries an
 * `eventId`, so a retry after a response that was lost in flight cannot
 * double-count.
 */
export class TelemetrySender {
  private inFlight = false;

  constructor(
    private readonly spool: TelemetrySpool,
    private readonly options: {
      readonly ingestUrl: () => string | undefined;
      readonly enabled: () => boolean;
      readonly timeoutMs?: number;
      /** Injectable for tests; defaults to global fetch. */
      readonly fetch?: typeof globalThis.fetch;
    },
  ) {}

  /** One flush attempt. Safe to call on a timer; overlapping calls are dropped. */
  async flush(): Promise<number> {
    if (this.inFlight) return 0;
    const url = this.options.ingestUrl();
    // A disabled or unconfigured sender leaves the spool alone rather than
    // draining and discarding: turning telemetry back on should not have
    // silently thrown away what was already recorded.
    if (!this.options.enabled() || !url) return 0;

    this.inFlight = true;
    let batch: readonly TelemetryEvent[] = [];
    try {
      batch = this.spool.drain();
      if (batch.length === 0) return 0;
      const send = this.options.fetch ?? globalThis.fetch;
      const response = await send(`${url.replace(/\/+$/, "")}/v1/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2000),
      });
      if (!response.ok) {
        this.spool.restore(batch);
        return 0;
      }
      return batch.length;
    } catch {
      // Unreachable endpoint, timeout, offline laptop: keep the records for
      // the next attempt rather than losing them.
      this.spool.restore(batch);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
