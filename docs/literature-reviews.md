# Agent-owned literature reviews

The candidate Brain workflow 0.32.0 requires app 0.2.93. Older pinned bundles
keep their existing contracts; updating the executable does not rewrite an
already-running workflow or add requirements to its checkpoints.

The `literature-review` technique declares `literatureReviewV1`. A role can
require that deliverable before development; first-pass thinkers do so. Other
roles open a review when using the technique or a source tool. Each task owns
its reviews, including critics, redevelopers and Supreme. They are separate
from the shared fact table and never confer a fact badge.

## Source access

`paper_read` opens a public URL, DOI or arXiv identifier and persists an immutable
source snapshot in the job's `documents` directory. It supports paginated reads,
section and page selection, searches, and actual PDF page images. HTML and PDF
parsing run on the backend. Native provider search can coexist with this reader.

Opening a source does not produce a reading receipt. Reads, searches and images
produce receipts identifying the task, source hashes, delivered segments and
page/section/range locators. Reusing a cached file issues a new receipt for its
reader. One agent cannot borrow another agent's receipts.

A receipt proves delivery, not comprehension or truth. Complete range coverage
proves that the entire retrieved rendition was delivered; an abstract page or
partial manuscript is not thereby a complete scientific paper. Access limits,
version differences and extraction warnings remain part of the authored review.
The reader cannot bypass paywalls. Scanned pages can be inspected visually;
automatic OCR is not provided.

## Review lifecycle

The host creates an identity from the run, task, input revision and review key.
It supplies the original submission and requested outputs as stable requirement
references. Models cannot choose another task's ownership or replace this scope.

`literature_review` provides `begin`, `save`, `submit`, `list` and `read`:

- `begin` with the same key resumes the same review.
- `save` accepts partial progress; works are upserted by their stable IDs.
- `submit` validates the complete structured review, original-input references,
  source versions and the agent's actual delivery receipts. Display locators are
  canonicalized from the receipts rather than trusted from model text.
- `list` and `read` recover saved work after retries or process restarts.

Every paper records identity, inspected evidence, method, results, conditions,
limitations, intended use, uncertainty and a concrete justification of its
relationship to the original request. Search coverage and the synthesis explain
the closest existing work and unresolved comparisons. An honest incomplete or
no-relevant-works review is valid; it must not invent evidence or imply novelty.
There is no minimum paper count or new model/token budget.

Required reviews and any started conditional review must be submitted before
argument-step delivery or final completion. The provider-neutral tool loop,
Claude Agent SDK and Cursor SDK all use the same worker-owned lifecycle. Failed
validation is returned to the model for repair. Saved work is restored on retry
without copying the whole review into the main structured response.

## Output and persistence

Each saved revision is an independent `literature-review` artifact. A successful
agent result references its review IDs in metadata; its primary output schema
stays unchanged. The interface and LaTeX export append bibliography-style review
sections to the corresponding author's output. Roles without a dedicated output
panel remain separately attributed in their stage. Source files may be shared;
interpretations and evidence-use claims are not merged between authors.

Diagnostic exports include review artifacts, document snapshots and receipts.
They can be larger than an ordinary trace because exact PDFs and page images
are preserved. Explicit offline runs use an incomplete fixture review that
states that no search or scientific assessment occurred.
