import assert from "node:assert/strict";
import test from "node:test";

import {
  isCreditLimitMessage,
  parseCreditResetDeterministically,
  resolveCreditReset,
} from "../src/index.js";

test("parses Claude session reset clock in its explicit timezone", async () => {
  const now = new Date("2026-07-22T15:14:00.000Z"); // 17:14 Berlin
  const message =
    "You've hit your session limit · resets 5:30pm (Europe/Berlin)";
  assert.equal(isCreditLimitMessage(message), true);
  const parsed = parseCreditResetDeterministically(
    message,
    now,
    "Europe/Berlin",
  );
  assert.equal(new Date(parsed!.retryAt).toISOString(), "2026-07-22T15:30:00.000Z");
  const buffered = await resolveCreditReset({
    message,
    now,
    timeZone: "Europe/Berlin",
    safetyBufferSeconds: 60,
  });
  assert.equal(
    new Date(buffered.retryAt).toISOString(),
    "2026-07-22T15:31:00.000Z",
  );
});

test("rolls an already-passed reset clock to the next local day", () => {
  const parsed = parseCreditResetDeterministically(
    "resets 5:30pm (Europe/Berlin)",
    new Date("2026-07-22T16:00:00.000Z"),
    "Europe/Berlin",
  );
  assert.equal(new Date(parsed!.retryAt).toISOString(), "2026-07-23T15:30:00.000Z");
});

test("uses OpenRouter only when deterministic parsing cannot resolve", async () => {
  let calls = 0;
  const resolved = await resolveCreditReset({
    message: "Your allowance returns later this evening",
    now: new Date("2026-07-22T15:00:00.000Z"),
    timeZone: "Europe/Berlin",
    openRouterApiKey: "test-key",
    safetyBufferSeconds: 0,
    fetchFn: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  retryAt: "2026-07-22T16:30:00.000Z",
                  timeZone: "Europe/Berlin",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(calls, 1);
  assert.equal(resolved.source, "openrouter");
  assert.equal(resolved.retryAt, Date.parse("2026-07-22T16:30:00.000Z"));
});

