import assert from "node:assert/strict";
import test from "node:test";

import { OUTPUT_SHAPES as CONTENT_SHAPES } from "@brainstorm-agentic/content";
import {
  OUTPUT_SHAPES as PROTOCOL_SHAPES,
  STAGE_IDS,
} from "@brainstorm-agentic/protocol";

/**
 * Guards against two modules that hold the same knowledge drifting apart.
 *
 * These live in the server package because it is the only one that depends on
 * both `content` (which owns the schemas) and `protocol` (which owns the
 * browser contract). `protocol` deliberately has zero dependencies so it can be
 * consumed by a browser bundle, which is exactly why it restates these lists
 * instead of importing them — and exactly why the restatement needs a test.
 */

test("the protocol's output-shape list matches the content schemas it mirrors", () => {
  // A shape added to the schemas but not the protocol renders as an unknown
  // body in the dashboard: the run succeeds and the user sees nothing, which
  // is the worst kind of failure — silent and downstream of the real change.
  assert.deepEqual(
    [...PROTOCOL_SHAPES].sort(),
    [...CONTENT_SHAPES].sort(),
    "protocol OUTPUT_SHAPES and content OUTPUT_SHAPES must agree",
  );
});

test("stage ids are unique and non-empty", () => {
  assert.ok(STAGE_IDS.length > 0);
  assert.equal(
    new Set(STAGE_IDS).size,
    STAGE_IDS.length,
    "a duplicated stage id would make two stages share a dashboard slot",
  );
});
