import assert from "node:assert/strict";
import test from "node:test";
import { factReportHash, type JournalEntry, type JsonValue } from "@brainstorm-agentic/core";
import type { PanelMemberView } from "@brainstorm-agentic/protocol";
import { factUsageViews } from "../src/fact-usage.js";

const panel: PanelMemberView[] = [
  { id: "retained-seat", department: "Physics", umbrella: "Mechanics", subfields: [] },
  { id: "custom-seat", department: "Mathematics", umbrella: "Analysis", subfields: [] },
  { id: "third-seat", department: "Biology", umbrella: "Ecology", subfields: [] },
];
const shared = (...ids: string[]) => new Map(ids.map((id) => [id, { requesters: [] } as Record<string, unknown>]));
const prefix = "root/review-members/review-members-fanout/member[0]/review-steps/cotStep[1]/game-review-round/iter[0]";
const criticPath = `${prefix}/gather-game-comments/commentor[0]/game-comment-step-execute`;
const chairPath = `${prefix}/chair-step/chair-step-execute`;
const output = (path: string, value: JsonValue): JournalEntry => ({ key: `${path}::result`, kind: "agent", value: { taskId: `run:${path}`, status: "ok", output: value } });

test("recorded submission purpose is attributed precisely; discovery and challenged incumbents are not reliance", () => {
  const thinker = { taskId: "think", role: "brain", agent: "retained-seat", seat: "retained-seat" };
  const legacy = { taskId: "old-critic", role: "commentor", agent: "custom-seat", seat: "retained-seat", step: 3 };
  const facts = shared("F:1", "F:2", "F:3", "F:4");
  facts.set("F:1", { requesters: [thinker] }); facts.set("F:2", { requesters: [legacy] });
  const uses = factUsageViews([
    { type: "submission", requester: thinker, submission: { purpose: "Establish the boundary condition before deriving the update.", step: 2 }, badge: "F:1", conflicts: [{ id: "F:4" }], at: 10 },
    { type: "consultation", requester: legacy, request: { mode: "lookup", purpose: "Find a similar result." }, matches: [{ factId: "F:2", relation: "equivalent" }, { factId: "F:3", relation: "related" }] },
    { type: "consultation", requester: legacy, request: { mode: "status", ids: ["F:3"] }, matches: [{ factId: "F:3", relation: "related" }] },
  ], facts, { panel });
  assert.equal(uses.get("F:1")!.length, 1, "the requester fallback does not duplicate a known submission");
  assert.deepEqual(uses.get("F:1")![0], { agentId: "retained-seat", agentLabel: "Seat 1 · Physics / Mechanics", role: "brain", seatId: "retained-seat", seatLabel: "Seat 1 · Physics / Mechanics", taskId: "think", kind: "submitted", step: 2, purpose: "Establish the boundary condition before deriving the update.", at: 10 });
  assert.equal(uses.get("F:2")![0]!.kind, "recorded"); assert.equal(uses.get("F:2")![0]!.purpose, undefined);
  assert.equal(uses.get("F:3"), undefined, "a search or status match does not establish use");
  assert.equal(uses.get("F:4"), undefined, "the opposing incumbent was not the submitted claim");
});

test("historical output citations retain actual authors, target seats and step indices without traversing input metadata", () => {
  const first = output("root/first-pass/member[0]/develop-idea/develop-idea-execute", { cot: ["A setup.", "Use the sign condition [F:1]."] });
  const critic = output(criticPath, { q: 0.9, justification: "The comparison violates the recorded boundary [F:1]." });
  const repairPath = `${prefix}/game-redevelop-idea-execute`;
  const repair = output(repairPath, { steps: [{ index: 4, part1: "Use the corrected boundary [F:2].", part2: "A derivation.", part3: "Its result.", part4: "Its limit." }] });
  const chair = output(chairPath, { reason: "The disputed premise [F:3] needs checking." });
  const judge = output(`${prefix}/judge-step-execute`, { reason: "This report mentions the disputed premise [F:3]." });
  const withMetadata: JournalEntry = { ...first, value: { ...(first.value as Record<string, JsonValue>), metadata: { input: "An input already cited [F:99]." } } };
  const uses = factUsageViews([], shared("F:1", "F:2", "F:3", "F:99"), {
    panel, journal: [withMetadata, critic, repair, chair, judge],
    artifacts: [{ ref: { metadata: { nodeId: "game-redevelop-idea", schema: "brainIdeaParts", path: "ideas.retained-seat" } }, value: { cot: ["A merged copy still mentions [F:99]."] } }],
  });
  assert.deepEqual(uses.get("F:1")!.map((use) => [use.agentId, use.role, use.seatId, use.step]), [
    ["retained-seat", "brain", "retained-seat", 2], ["custom-seat", "game-commentor", "retained-seat", 2],
  ]);
  assert.deepEqual(uses.get("F:2")!.map((use) => [use.agentId, use.role, use.step]), [["retained-seat", "game-redeveloper", 4]]);
  assert.deepEqual(uses.get("F:3")!.map((use) => [use.agentId, use.role, use.seatId]), [["committee-chair", "committee-chair", "retained-seat"], ["judge", "judge", "retained-seat"]]);
  assert.equal(uses.get("F:99"), undefined, "input metadata and merged artifact copies are not newly authored citations");
});

test("Supreme approvals identify the actual critic report and distinguish approved from denied use", () => {
  const report = { q: 0.9, justification: "The fixed boundary invalidates the proposed update [F:1]." };
  const receipt = { requesterTaskId: `run:${chairPath}`, criticId: "custom-seat", reportHash: factReportHash(report), citedBadgeId: "F:1", targetBadgeId: "F:2", approved: true };
  const uses = factUsageViews([
    { type: "approval", at: 20, approval: receipt },
    { type: "approval", at: 21, approval: { ...receipt, targetBadgeId: "", approved: false } },
    { type: "approval", at: 22, approval: { ...receipt, requesterTaskId: `run:${chairPath.replace("iter[0]", "iter[1]")}`, targetBadgeId: "", reportHash: "another-report", approved: false } },
  ], shared("F:1", "F:2"), { panel, journal: [output(criticPath, report)] });
  const approved = uses.get("F:2")![0]!;
  assert.deepEqual([approved.agentId, approved.role, approved.seatId, approved.step, approved.kind, approved.approved], ["custom-seat", "game-commentor", "retained-seat", 2, "approval", true]);
  assert.equal(approved.purpose, report.justification);
  const decisions = uses.get("F:1")!.filter((use) => use.kind === "approval");
  assert.deepEqual(decisions.map((use) => use.approved), [true, false, false]);
  assert.equal(decisions[2]!.purpose, undefined, "a different report or round cannot borrow another critic's explanation");
});

test("artifact-only runs retain citations with unknown coordinates and long citations show bounded exact context", () => {
  const passage = `${"Introductory words. ".repeat(80)}The actual support is cited here [F:1]. ${"Later discussion. ".repeat(80)}`;
  const uses = factUsageViews([], shared("F:1", "F:9"), { panel, artifacts: [
    { ref: { metadata: { nodeId: "game-comment-step", schema: "gameCritique", path: "reviews.retained-seat.current.gameCritiques.custom-seat" } }, value: { q: 0.1, justification: passage } },
    { ref: { metadata: { nodeId: "chair-step", schema: "gameCommitteeDecision", path: "reviews.retained-seat.current.gameChair" } }, value: { reason: "The premise [F:1] has been discussed." } },
    { ref: { metadata: { nodeId: "redevelop-idea", schema: "brainIdeaParts", path: "ideas.retained-seat" } }, value: { cot: ["An unchanged original passage cites [F:9]."] } },
  ] });
  const critic = uses.get("F:1")![0]!;
  assert.equal(critic.agentId, "custom-seat"); assert.equal(critic.seatId, "retained-seat"); assert.equal(critic.step, undefined);
  assert.ok(critic.purpose!.length <= 602); assert.match(critic.purpose!, /^….*\[F:1\].*…$/);
  assert.ok(passage.includes(critic.purpose!.slice(1, -1)), "the visible excerpt contains exact recorded words");
  assert.equal(uses.get("F:1")![1]!.agentId, "committee-chair");
  assert.equal(uses.get("F:9"), undefined, "merged idea artifacts do not attribute unchanged original text to the reviser");
});
