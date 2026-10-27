import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewStepView } from "@brainstorm-agentic/protocol";
import { REVISED_AFTER_REVIEW_BADGE, revisedAfterReviewText } from "../src/components/panels/game-review-model.js";

type Marks = NonNullable<ReviewStepView["revisedAfterReview"]>;

test("a step revised after review is marked with each notice its rewrite answered", () => {
  const replaced: Marks = [{ notice: "N:1", deleted: "F:7", replacedBy: "F:12", at: 1 }];
  const deletedOnly: Marks = [{ notice: "N:2", deleted: "F:7", at: 2 }];
  const twoNotices: Marks = [...replaced, { notice: "N:3", deleted: "F:9", at: 3 }];
  assert.equal(REVISED_AFTER_REVIEW_BADGE, "revised after review");
  assert.equal(revisedAfterReviewText(replaced), "A fact-table update changed this step after the walk passed it (F:7 was deleted and replaced by F:12); it was not reviewed again.");
  assert.equal(revisedAfterReviewText(deletedOnly), "A fact-table update changed this step after the walk passed it (F:7 was deleted); it was not reviewed again.");
  assert.equal(revisedAfterReviewText(twoNotices),
    "A fact-table update changed this step after the walk passed it (F:7 was deleted and replaced by F:12; F:9 was deleted); it was not reviewed again.");
});
