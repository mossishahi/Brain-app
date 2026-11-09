# Shared facts and Revoker

App 0.2.90 implements the `supreme-dialogue/v2` protocol declared by the
brainstorm 0.31.0 content candidate. A run pins its content bundle. Existing runs
keep their original protocol; upgrading the app does not reinterpret their
fact journals or change completed work.

## Fact ownership and dialogue

Supreme is the only scientific authority that can accept or withdraw facts.
The host validates and persists its rulings. Every role uses the same committed
table through Supreme's tool channel. Independent consultations can run in
parallel. Mutations are serialized, and their supporting fact revisions are
checked again before commit.

1. The requester uses `fact_table` with `mode: "lookup"` and the claim text.
   This first message needs no justification and creates no fact.
2. Supreme searches the shared table conceptually and returns the applicable
   facts, their conditions, verified evidence and a conversation identifier.
3. The requester uses `mode: "reply"` in that conversation. It may clarify,
   request an existing badge, justify a new claim, challenge an incumbent, or
   close. Justifications and challenges provide structured claim, conditions,
   evidence and kind. The requester cannot insert a fact directly.
4. Only a justified ruling produces an active fact. An unresolved or failed
   submission stays outside the table. Closing a conversation deletes its
   saved dialogue state; another conversation can be started later.

There is no archive of closed conversations in the dialogue store. Accepted
facts, their evidence, and mutation/recovery receipts remain necessary durable
records. Rejected checks that change no facts retain only usage metadata and
submission numbering after closure. General run diagnostics and provider traces are separate from this
conversation store and retain their existing behavior.

## Conditions are part of identity

Equivalent propositions under equivalent conditions may share a badge.
Genuinely different conditions require a different record. Supreme may justify
a more restricted result by checking an implication from an accepted result;
the new record identifies its supporting facts and exact badge hashes. An
experiment need not be repeated when that implication is sufficient.

An accepted proposition or its conditions cannot be silently edited. Correcting
an overbroad fact withdraws that record and creates a new one. When two claims
hold in different regimes, Supreme can issue two separately justified records.
An unresolved contradiction does not justify inventing a winner. Dependencies
on withdrawn premises cause derived facts to be withdrawn as well.

## Recovery authority

A durable withdrawal initializes Revoker. Supreme decides factual standing;
Revoker makes the final decision about affected reasoning. It reads authored
arguments and deliverables, not private thinking transcripts, and chooses:

- substitution of a verified badge when the actual inference still holds;
- redevelopment of specified steps and output sections;
- restart of the affected argument when its foundations fail.

The host checks the plan against the supplied artifact revision and enforces
its authorized edit scope. The original roles carry out repairs. Repaired
arguments receive fresh critic/chair review, including arguments whose earlier
reviews were already closed. The author does not review their own repair.
This recovery review does not award points or rewrite historical scores.
A rejected repair returns to Revoker with the candidate and actual review
feedback for a new attempt. An unresolved review prevents final use.

Recovery decisions and successful task outputs are journaled for restart.
Concurrent author revisions or further withdrawals invalidate stale recovery
certificates. Finalization waits for repairs and renewed reviews. If evidence
changes during integration or synthesis, those outputs are regenerated against
the repaired arguments before the run completes.

The stage-model settings expose Revoker, Recovery review and Recovery review
chair separately, alongside Supreme consultation and verification.

## Compatibility and validation

The older `supreme-mediated/v1` and unmediated protocols remain available for
pinned bundles and checkpoints. The candidate content explicitly selects v2;
changing the application alone does not activate it for an older bundle.

Automated validation covers dialogue ownership and closure, persistence and
restart, scoped facts and implication dependencies, replacement and transitive
withdrawal, repair plans and renewed review, and final output invalidation.
These deterministic checks do not establish the scientific quality of a live
model's judgment; that requires a separate end-to-end model run.
