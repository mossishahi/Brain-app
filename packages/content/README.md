# @brainstorm-agentic/content

Host-side parsers, Zod schemas, and cross-document validators for a static brainstorm content
bundle. This package contains **no production skills, workflows, catalogs, routes, or capability
files**: those are versioned static assets owned by Brain Registry. The host downloads and
hash-verifies one registry version, materializes it locally, then invokes this package to reject any
structurally or semantically inconsistent bundle before execution.

## Layout

```text
src/
  schemas/artifacts.ts                 Zod schemas for every structured artifact
  schemas/workflow.ts                  Zod schemas for workflow/activities/routes/capabilities/skills
  frontmatter.ts                       minimal front matter parser for skill files
  loader.ts                            readContentBundle / loadContent
  validate.ts                          cross-validation (validateBundle) + prompt hygiene
test/                                  loader, validator, and schema tests against the registry bundle
```

The corresponding static layout is documented in the Brain Registry repository.

## Concepts

**Workflow** (`brainstorm.workflow.json`, `apiVersion: brainstorm.workflow/v1`): a tree of
composable constructs — `sequence`, `agent`, `forEach` (parallel or sequential, with optional
`exclude`), `repeatUntil` (always bounded by `maxIterations`), `condition`, `humanGate`, and
`terminal`, plus `activity` for a registered deterministic runtime transform. The brainstorm
instance expresses: processor → decomposer (three-level experts tree only) → deterministic
`panel.select` activity → optional shrink-only panel confirmation → parallel first-pass brains →
per-member, per-step review rounds (all other members comment in parallel, one judge decides, a
failing step is conditionally redeveloped, at most 3 redevelopments before a forced pass) → chair
synthesis → terminal.

Agent and activity nodes bind inputs to **data references** (`input.cotSteps`,
`ideas[member.id].cot`, `params.panelSize`, …) with two declarative projections: `through` slices
a chain to steps 1..i (commentors never see later steps), and `pick` keeps only named fields (the
chair receives each idea's paper and novelty but never its chain of thought). `review.round` and
`review.allowedVerdicts` are runtime builtins available inside review rounds; allowed verdicts are
derived from `catalog/verdicts.json` `sequencing` (a Build may not immediately follow a Build).

**Activities** (`catalog/activity-handlers.json`): workflow JSON identifies runtime transforms
only by namespaced logical keys. `panel.select` consumes the validated `experts` tree plus
`panelSize` and `moduleSize`; the registered runtime implementation performs stable chunked
round-robin selection (up to `moduleSize` umbrella leaves per department per pass) and emits the
seated `panel`. Its registration is explicitly deterministic and declares a typed finite-output
bound: `panel.members` contains at most `panelSize` items. The workflow stores no implementation
code, callbacks, scripts, or arbitrary expression language. Validation requires an exact match
between every activity node and its registration (input names, output schema, determinism, and
bound).

**Model routes** (`model-routes.json`): agent nodes name logical routes (`reasoning`, `writing`,
`balanced`) described by neutral traits. A provider adapter maps routes to concrete models;
provider model ids never appear in this package.

**Skills vs. capabilities**: skills are *prompt content only*. `kind: role` skills are the main
instruction of one agent node and declare the artifact schema of their structured output;
`kind: technique` skills are reusable fragments folded into roles (`techniques:` in front matter).
Anything *executable* — web search, sandboxed code execution, attachment access — is not prompt
text but a **capability requirement** (`capabilities:` in front matter) resolved against the
registry's `capabilities.json`, whose `contract` states what the host runtime must provide.

**Load-bearing capabilities** (`requiredCapabilities:` in front matter, a subset of
`capabilities:`): the task fails loudly, before any model call, rather than running without the
ability. Safe to declare on ANY capability, because the runtime distinguishes an absence somebody
vouched for from one nobody will: a submission that declares it carries no files, a deployment that
configured no GPU template, and `--offline` each ASSERT their emptiness, and the guard passes. An
absence nobody claims is a wiring defect and the guard fails on it — as is a capability the
submitter switched off, which is a request the run cannot honour. Only roles may declare it: a
technique's list would be silently ignored (the guard reads the role's), so the schema rejects it.

**Artifact schemas** (`src/schemas/artifacts.ts`): `processorOutput`, `experts`, `panel`,
`brainIdea`, `comment`, `judgeDecision`, `redevelopment`, `finalProposal`. Every agent node names
the schema its output must satisfy; activity outputs are validated the same way. `experts` is the
decomposer's bare three-level tree; `panel` is a separate seated-members artifact produced only by
`panel.select`.

## Usage

```ts
import { loadContent, artifactSchemas } from "@brainstorm-agentic/content";

// The host has already downloaded and SHA-256-verified this pinned registry version.
const bundle = loadContent(jobContentDir); // throws ContentValidationError
const workflow = bundle.workflows["brainstorm"];
const brainSchema = artifactSchemas[bundle.skills["brain"].meta.output as "brainIdea"];
```

Both loaders require an explicit directory; there is intentionally no built-in/default content.
`readContentBundle(dir)` performs structural validation only; `validateBundle(bundle)`
returns the cross-validation issues for a bundle you already hold in memory. Validation rejects,
among other things: missing skills/routes/schemas/techniques/capabilities, unbound or undeclared
skill variables, missing or mismatched activity handlers, non-deterministic or unbounded
activities, unresolvable data references, unbounded or over-long loops, and prompt bodies that
mention transport mechanics (MCP, submit calls), spawning of subagents, or reading/writing
filesystem paths — skills must only ever return semantic structured output.

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — type-check without emitting
- `npm run test` — build, then run the node test suite against the authoritative registry fixture
