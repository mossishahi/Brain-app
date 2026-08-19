import assert from "node:assert/strict";
import test from "node:test";

import { MIN_WIND_DOWN_HORIZON_MS, windDownFromEnv } from "../src/wind-down.js";

const quiet = { ...console };
function withoutStderr<T>(body: () => T): T {
  console.error = () => {};
  try {
    return body();
  } finally {
    console.error = quiet.error;
  }
}

test("a deadline in the future is honoured, with the host's own words", () => {
  const at = Date.now() + 3_600_000;
  const parsed = windDownFromEnv({
    BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS: String(at),
    BRAINSTORM_AGENTIC_WIND_DOWN_REASON: "the host job ends at 2026-08-20T11:48:35",
  });
  assert.deepEqual(parsed, { at, reason: "the host job ends at 2026-08-20T11:48:35" });
});

test("no deadline at all means the run behaves exactly as it did before", () => {
  assert.equal(windDownFromEnv({}), undefined);
  assert.equal(windDownFromEnv({ BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS: "" }), undefined);
});

test("a deadline already gone is refused instead of handing straight back", () => {
  // The resubmission loop this prevents: a host whose walltime is SHORTER than
  // the lead would refuse the first task of the run, wind down having done
  // nothing, be resumed, and do it again. That is a misconfigured walltime, not
  // one to survive, so the run takes the old behaviour — killed, then resumed.
  const passed = withoutStderr(() =>
    windDownFromEnv({ BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS: String(Date.now() - 60_000) }),
  );
  assert.equal(passed, undefined);
  const tooSoon = withoutStderr(() =>
    windDownFromEnv({
      BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS: String(Date.now() + MIN_WIND_DOWN_HORIZON_MS - 5_000),
    }),
  );
  assert.equal(tooSoon, undefined);
});

test("a malformed deadline is ignored loudly, never guessed at", () => {
  for (const raw of ["soon", "-5", "1e400", "0"]) {
    assert.equal(
      withoutStderr(() => windDownFromEnv({ BRAINSTORM_AGENTIC_WIND_DOWN_AT_MS: raw })),
      undefined,
      `"${raw}" is not a deadline`,
    );
  }
});
