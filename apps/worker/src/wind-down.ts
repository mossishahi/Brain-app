/**
 * When the host wants the run to stop starting work.
 *
 * A scheduler ends its jobs at the allocation boundary with no regard for what
 * is running, and every call not yet journalled is bought again on the resume —
 * across a review fan-out, that is the whole panel's round. Told when its host
 * expires, the run instead lets what is running finish, writes an ordinary
 * resumable checkpoint, and exits with nothing in flight.
 *
 * The value arrives through the environment because the submit script is what
 * can answer the question: it asks the scheduler for THIS job's end time at job
 * start, which is the only moment the answer exists — a job's walltime begins
 * when it begins, and it may have waited hours in the queue.
 */

/**
 * The least time a wind-down deadline must leave to be worth honouring. Below
 * it the run would stop before doing anything, and every resume would too.
 */
export const MIN_WIND_DOWN_HORIZON_MS = 120_000;

export function windDownFromEnv(
  env: NodeJS.ProcessEnv,
): { readonly at: number; readonly reason: string } | undefined {
  const raw = env.BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const at = Number(raw);
  if (!Number.isSafeInteger(at) || at <= 0) {
    console.error(
      `[config] ignoring invalid BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS="${raw}"`,
    );
    return undefined;
  }
  // A deadline that has already passed, or is about to, would refuse the first
  // task of the run and hand straight back — a resubmission loop that makes no
  // progress. It can only happen when the host's walltime is shorter than the
  // lead, which is a misconfiguration, not a walltime to survive: run without
  // the wind-down and let the old behaviour (killed, then resumed) apply.
  const horizon = at - Date.now();
  if (horizon < MIN_WIND_DOWN_HORIZON_MS) {
    console.error(
      `[config] the wind-down deadline is only ${Math.round(horizon / 1000)}s away — ` +
        "the host's walltime is shorter than the lead, so this run will not wind down",
    );
    return undefined;
  }
  const reason =
    env.BRAINSTORM_AGENTIC_WIND_DOWN_REASON?.trim() ||
    `the host job's walltime ends shortly after ${new Date(at).toISOString()}`;
  return { at, reason };
}
