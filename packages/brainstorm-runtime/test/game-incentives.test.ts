import assert from "node:assert/strict";
import test from "node:test";
import { artifactSchemas } from "@brainstorm-agentic/content";
import type { JournalEntry, JsonObject } from "@brainstorm-agentic/core";
import { GameReviewLedger } from "../src/game-ledger.js";

/**
 * Incentive harness for scoring v3 (spec/scoring-v3.md section 9). Synthetic
 * critics are fed through the real settle() under the three configurations:
 *   legacy  = committee-mean, leaveOneOut=false (the v2 rule, kept for contrast)
 *   loo     = committee-mean, leaveOneOut=true
 *   chair   = chair-decisive (leaveOneOut is ignored)
 * No fact badges are cited, so every report is direct reasoning that the chair
 * admits; the chair's label is what the harness varies.
 */
type Rule = "committee-mean" | "chair-decisive";
type Label = "decisive" | "not-decisive" | "invalid";
interface Config { readonly name: string; readonly decisionRule: Rule; readonly leaveOneOut: boolean }
const CONFIGS: readonly Config[] = [
  { name: "legacy", decisionRule: "committee-mean", leaveOneOut: false },
  { name: "loo", decisionRule: "committee-mean", leaveOneOut: true },
  { name: "chair", decisionRule: "chair-decisive", leaveOneOut: true },
];
const chain = [{ part1: "Claim", part2: "Ground", part3: "Consequence", part4: "Limit" }];
const panelOf = (ids: readonly string[]) => ({ members: ids.map((id) => ({ id })) });
const rows = (settlement: JsonObject) => settlement.rows as JsonObject[];
const row = (settlement: JsonObject, id: string) => rows(settlement).find((entry) => entry.criticId === id)!;

interface Report { readonly q: number; readonly label: Label; readonly admissible?: boolean }
function settlementInput(reports: Record<string, Report>, config: Config, threshold = 0.5, initialPoints = 0): JsonObject {
  return {
    critiques: Object.fromEntries(Object.entries(reports).map(([id, report]) => [id, { q: report.q, justification: `A direct argument from the displayed derivation; probability of a major flaw ${report.q}.` }])),
    chain, panel: panelOf(Object.keys(reports)), initialPoints, threshold, decisionRule: config.decisionRule, leaveOneOut: config.leaveOneOut,
    chair: {
      reports: Object.fromEntries(Object.entries(reports).map(([id, report]) => [id, { admissible: report.admissible ?? true, reason: "The argument is directly inspectable reasoning with no separate factual premise.", label: report.label, factChecks: [] }])),
      reason: "The committee chair checked each argument's inference against the displayed derivation.",
    },
  };
}
function settle(reports: Record<string, Report>, config: Config, threshold = 0.5): JsonObject {
  const settled = new GameReviewLedger().settle("harness", "harness:1", settlementInput(reports, config, threshold), []);
  assert.equal(artifactSchemas.gameSettlement.safeParse(settled).success, true, `${config.name}: the settlement validates`);
  return settled;
}

test("(a) a specialist minority blocks under chair-decisive with a positive peer-adjusted score; the mean rule overrules it", () => {
  const reports: Record<string, Report> = {
    specialist: { q: 0.95, label: "decisive" },
    "generalist-1": { q: 0.1, label: "not-decisive" }, "generalist-2": { q: 0.1, label: "not-decisive" }, "generalist-3": { q: 0.1, label: "not-decisive" },
  };
  const chair = settle(reports, CONFIGS[2]!);
  assert.equal(chair.y, 1); assert.equal((chair.decision as JsonObject).verdict, "Interrupt");
  assert.ok(Math.abs(Number(chair.meanQ) - 0.3125) < 1e-9, "the mean is recorded but does not decide");
  assert.ok(Number(row(chair, "specialist").score) > 0, `specialist R=${String(row(chair, "specialist").score)}`);
  assert.ok(Math.abs(Number(row(chair, "specialist").score) - 105.5) < 1e-9);
  assert.ok(Object.keys(reports).filter((id) => id !== "specialist").every((id) => Number(row(chair, id).score) < 0));
  assert.deepEqual(chair.repairArguments, ["A direct argument from the displayed derivation; probability of a major flaw 0.95."]);
  for (const config of [CONFIGS[0]!, CONFIGS[1]!]) {
    const mean = settle(reports, config);
    assert.equal(mean.y, 0, `${config.name}: the arithmetic mean 0.3125 passes the step`);
    assert.ok(Number(row(mean, "specialist").score) < 0, `${config.name}: the specialist is punished for being right`);
  }
});

test("(b) a lone admitted critic is unscored under committee-mean with leave-one-out and scored under chair-decisive", () => {
  for (const q of [0, 0.7, 1]) {
    const reports: Record<string, Report> = { lone: { q, label: q >= 0.5 ? "decisive" : "not-decisive" }, rejected: { q: 0.5, label: "invalid", admissible: false } };
    const loo = settle(reports, CONFIGS[1]!);
    const own = row(loo, "lone");
    assert.equal(loo.status, "settled"); assert.equal(loo.y, q >= 0.5 ? 1 : 0); assert.equal(own.admissible, true);
    assert.deepEqual([own.scoringLabel, own.brierLoss, own.baseScore, own.peerMeanBaseScore, own.score], [null, null, null, null, null]);
    assert.equal(own.balanceAfter, own.balanceBefore); assert.equal(own.excluded, false);
    const chair = settle(reports, CONFIGS[2]!);
    assert.equal(row(chair, "lone").scoringLabel, chair.y);
    assert.ok(Math.abs(Number(row(chair, "lone").score) - (25 - 100 * (q - Number(chair.y)) ** 2)) < 1e-9);
    assert.ok(Math.abs(Number(row(settle(reports, CONFIGS[0]!), "lone").score) - (25 - 100 * (q - (q >= 0.5 ? 1 : 0)) ** 2)) < 1e-9, "the legacy rule scores a lone critic against its own label");
  }
});

test("(c) a two-critic contrarian at q=0 against a decisive q=0.9 loses under both new configurations and profits only under the legacy rule", () => {
  const reports: Record<string, Report> = { honest: { q: 0.9, label: "decisive" }, contrarian: { q: 0, label: "not-decisive" } };
  const chair = settle(reports, CONFIGS[2]!);
  assert.equal(chair.y, 1); assert.ok(Math.abs(Number(row(chair, "contrarian").score) - -174) < 1e-9); assert.ok(Math.abs(Number(row(chair, "honest").score) - 123) < 1e-9);
  const loo = settle(reports, CONFIGS[1]!);
  assert.equal(loo.y, 0, "the admitted mean 0.45 stays below the threshold");
  assert.deepEqual([row(loo, "contrarian").scoringLabel, row(loo, "honest").scoringLabel], [1, 0]);
  assert.ok(Math.abs(Number(row(loo, "contrarian").score) - -94) < 1e-9); assert.ok(Math.abs(Number(row(loo, "honest").score) - -37) < 1e-9);
  const legacy = settle(reports, CONFIGS[0]!);
  assert.equal(legacy.y, 0); assert.ok(Math.abs(Number(row(legacy, "contrarian").score) - 106) < 1e-9, "flipping the mean paid the contrarian under v2");
});

/** Deterministic xorshift32 so the tournament replays identically on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
}

/**
 * One review step per trial. A major flaw exists with probability 0.3. Honest
 * and extremizer critics receive independent noisy signals (detection 0.7,
 * false alarm 0.1) and the honest critic reports the exact posterior
 * P(flaw | signal) = 0.75 or 0.125; the extremizer rounds that posterior to
 * 1 or 0. The specialist sees the truth inside its own domain (one step in
 * five) and reports 0.95 / 0.05 there, and an uninformed 0.1 elsewhere.
 * always-0 and always-1 ignore the step. The chair labels an argument
 * decisive only when a real flaw was actually identified (a true detection),
 * invalid when a flaw is claimed without one, not-decisive otherwise.
 */
const STRATEGIES = ["honest", "extremizer", "always-0", "always-1", "specialist"] as const;
function trial(next: () => number): Record<string, Report> {
  const flaw = next() < 0.3;
  const signal = () => (flaw ? next() < 0.7 : next() < 0.1);
  const inDomain = next() < 0.2;
  const honestSignal = signal(); const extremizerSignal = signal();
  const posterior = (seen: boolean) => (seen ? 0.75 : 0.125);
  const labelOf = (q: number, identified: boolean): Label => (identified ? "decisive" : q >= 0.5 ? "invalid" : "not-decisive");
  const honestQ = posterior(honestSignal); const extremizerQ = posterior(extremizerSignal) >= 0.5 ? 1 : 0;
  const specialistQ = inDomain ? (flaw ? 0.95 : 0.05) : 0.1;
  return {
    honest: { q: honestQ, label: labelOf(honestQ, flaw && honestSignal) },
    extremizer: { q: extremizerQ, label: labelOf(extremizerQ, flaw && extremizerSignal) },
    "always-0": { q: 0, label: "not-decisive" },
    "always-1": { q: 1, label: "invalid" },
    specialist: { q: specialistQ, label: labelOf(specialistQ, flaw && inDomain) },
  };
}

test("(d) 2000-trial tournament: honest reporting has the highest mean balance under both new configurations", (t) => {
  const trials = 2000;
  const outcome: Record<string, Record<string, number>> = {};
  for (const config of CONFIGS) {
    const next = random(20261009);
    const ledger = new GameReviewLedger();
    const runId = `tournament-${config.name}`;
    for (let index = 1; index <= trials; index += 1) {
      const settled = ledger.settle(runId, `${runId}:${index}`, settlementInput(trial(next), config, 0.5, 0), []);
      ledger.commit(runId, settled);
    }
    const balances = Object.fromEntries(STRATEGIES.map((id) => [id, Number(ledger.dispatch(runId, `${runId}:final`, id, panelOf(STRATEGIES), 0).balance) / trials]));
    outcome[config.name] = balances;
  }
  t.diagnostic(`mean balance per trial: ${JSON.stringify(outcome)}`);
  for (const name of ["loo", "chair"]) {
    const balances = outcome[name]!;
    const best = STRATEGIES.reduce((top, id) => (balances[id]! > balances[top]! ? id : top), STRATEGIES[0]);
    assert.equal(best, "honest", `${name}: ${JSON.stringify(balances)}`);
    assert.ok(balances.honest! - Math.max(...STRATEGIES.filter((id) => id !== "honest").map((id) => balances[id]!)) > 1, `${name}: honest leads by more than one point per trial: ${JSON.stringify(balances)}`);
    assert.ok(balances["always-1"]! < balances["always-0"]! && balances["always-0"]! < balances.honest!, `${name}: ${JSON.stringify(balances)}`);
  }
  // The legacy configuration is settled for the record only; its ranking is
  // not asserted here because the v2 exploits are the two-critic flip of (c)
  // and the lone-critic certainty of (b), not this five-seat tournament.
  assert.ok(Object.keys(outcome.legacy!).length === STRATEGIES.length);
});

test("(e) a recorded v2 settlement replays into a v3 ledger without re-scoring and the run continues under v3", () => {
  const v2: JsonObject = {
    ruleVersion: "brier-peer/v2", version: "chain-version", settlementId: "r:settle-1", ledgerSequence: 1,
    criticIds: ["a", "b"], initialPoints: 100, meanQ: 0.5, threshold: 0.5, y: 1, status: "settled", admittedCount: 2,
    rows: [
      { criticId: "a", q: 0.9, admissible: true, reason: "The checked premise supports a major flaw.", brierLoss: 0.01, baseScore: 24, peerMeanBaseScore: -56, score: 104, balanceBefore: 100, balanceAfter: 204, excluded: false },
      { criticId: "b", q: 0.1, admissible: true, reason: "The checked premise supports a low probability.", brierLoss: 0.81, baseScore: -56, peerMeanBaseScore: 24, score: -136, balanceBefore: 100, balanceAfter: -36, excluded: true },
    ],
    repairArguments: ["The denominator becomes zero under the stated assumption [F:1]."],
    decision: { verdict: "Interrupt", reason: "Mean 0.5 reaches the threshold 0.5.", suggestion: "", evidence: { kind: "none", code: "", result: "", derivation: "", citation: "", locator: "", shows: "" }, issues: [] },
  };
  assert.equal(artifactSchemas.gameSettlement.safeParse(v2).success, true);
  const journal = (value: JsonObject): JournalEntry => ({ key: `${value.settlementId}::result`, kind: "activity", value });
  const ledger = new GameReviewLedger();
  ledger.hydrate("r", [journal(v2)]);
  const after = ledger.dispatch("r", "r:dispatch", "a", panelOf(["a", "b"]), 100);
  assert.equal(after.ruleVersion, "brier-peer/v3"); assert.equal(after.balance, 204); assert.equal(after.ledgerSequence, 1);
  assert.deepEqual(after.history, [{ settlementId: "r:settle-1", version: "chain-version", q: 0.9, y: 1, admissible: true, reason: "The checked premise supports a major flaw.", label: null, scoringLabel: null, score: 104, balanceAfter: 204, excluded: false }]);
  assert.equal(ledger.dispatch("r", "r:dispatch", "b", panelOf(["a", "b"]), 100).eligible, false);
  // The recorded round is returned verbatim, never re-scored under a new rule.
  const replayed = ledger.settle("r", "r:settle-1", settlementInput({ a: { q: 0.2, label: "invalid" }, b: { q: 0.2, label: "invalid" } }, CONFIGS[2]!, 0.5, 100), []);
  assert.deepEqual(replayed, v2);
  ledger.commit("r", v2);
  assert.equal(ledger.dispatch("r", "r:dispatch", "a", panelOf(["a", "b"]), 100).balance, 204);
  // The next round settles under v3 with the next sequence number and both records hydrate together.
  const next = ledger.settle("r", "r:settle-2", settlementInput({ a: { q: 0.2, label: "not-decisive" }, b: { q: 0.9, label: "decisive" } }, CONFIGS[2]!, 0.5, 100), []);
  assert.equal(next.ruleVersion, "brier-peer/v3"); assert.equal(next.ledgerSequence, 2); assert.equal(next.y, 1);
  assert.equal(row(next, "a").balanceBefore, 204); assert.equal(row(next, "b").balanceBefore, -36); assert.equal(row(next, "b").excluded, true);
  ledger.commit("r", next);
  const restored = new GameReviewLedger(); restored.hydrate("r", [journal(next), journal(v2)]);
  assert.deepEqual(restored.dispatch("r", "r:final", "a", panelOf(["a", "b"]), 100), ledger.dispatch("r", "r:final", "a", panelOf(["a", "b"]), 100));
  assert.throws(() => { const stale = new GameReviewLedger(); stale.hydrate("r", [journal({ ...v2, rows: [{ ...(v2.rows as JsonObject[])[0]!, score: 103, balanceAfter: 203 }, (v2.rows as JsonObject[])[1]!] })]); }, /INVALID_GAME_LEDGER|inconsistent|incorrect/);
});
