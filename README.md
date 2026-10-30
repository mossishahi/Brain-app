# Brainstorm App

The Brainstorm research application: browser interface, host server, and isolated research
worker. These components share one API contract and release together. The separate
[co-inference launcher](https://github.com/mossishahi/co-inference) packages a pinned version for
laptop use and SSH connections; the host-served deployment remains available.

```text
apps/
  web/       React + Vite frontend
  server/    HTTP/SSE host, settings, attachments, scheduling, job state
  worker/    isolated process that executes or resumes one pipeline job
packages/
  protocol/              web ↔ server API types
  core/                  workflow contracts and checkpoint-aware execution
  content/               host-side registry parsers and validators
  registry-client/       incremental MCP client, version pin, verified cache
  brainstorm-runtime/    content-to-executable-workflow compiler
  agent-runtime/         generic model/tool execution loop
  host-tools/            provider-neutral host tool implementations
  provider-anthropic/    Anthropic developer API adapter
  executor-claude-agent/ Claude Agent SDK backend
  credit-recovery/       provider reset-time resolution
```

The independently deployed Brain Registry is deliberately not part of this application. The
worker connects over MCP, pins an immutable version, and fetches the whole skill set up front —
hash-verified, held in memory only — so a run never depends on the registry connection staying
alive into its later stages. A resume re-fetches the same immutable version and re-verifies it.

## Desktop launcher

The laptop host chooser, SSH connection manager, and Mac application are maintained separately in
[co-inference](https://github.com/mossishahi/co-inference). That repository pins a compatible
Brain-app runtime and packages the research UI, server, and worker without requiring a sibling
checkout. Follow its README for desktop development and Mac distribution.

This repository owns the research UI and authenticated desktop backend protocol. Its existing
server and cluster launch commands below remain available.

## Quick start (no Node setup needed)

```bash
git clone https://github.com/mossishahi/Brain-app.git
cd Brain-app && ./setup.sh
```

`setup.sh` takes care of everything a fresh machine is missing: when no Node 22.13+ is on the
PATH it downloads the pinned Node v24.19.0 for this OS/CPU into `~/opt` (no root, no package
manager — the same convention the SLURM wrapper uses), then installs, builds, and launches.
Arguments pass through to the server (`./setup.sh --port 9000 --no-open`); `--build-only`
prepares the machine without launching. Linux and macOS; on Windows use WSL. Re-running it is
cheap — an already-built checkout skips straight to the launch.

## Install, build, and test (manual)

```bash
npm install
npm run build
npm test
```

### Models and reasoning by workflow stage

In **Settings → Stage models**, the panel lets each agent
stage use its own model, reasoning effort, and adaptive-thinking setting for the
selected provider. For example, input classification and proposal synthesis can
use different settings even though both use the same underlying reasoning route.
Choices are retained separately for each provider. An unset stage option inherits
the existing route or connection default, subject to the selected model's reported
capabilities.

The host discovers models and their capabilities through the selected provider,
loads the catalog at startup, and refreshes it before a new research run. The
browser keeps the loaded options so opening a panel or selector does not repeat
provider discovery. The panel only offers effort levels and thinking controls
reported for the selected model; missing capability information is shown as
unavailable. Models that require thinking cannot have it disabled.

New runs retain their stage settings and model catalog with the execution
snapshot. Later settings edits do not change an existing run or its retry.

### Claude output-limit recovery

If a Claude Code response reaches its output-token limit, the executor can retry
once in a fresh session, within the configured validation-attempt budget. The
retry asks for a concise, complete answer and keeps the output schema and
authoritative validator. It reduces `max`/`xhigh` effort to `high`, or `high` to
`medium`; `low` and `medium` stay unchanged. This applies only to recovery for
that task: saved settings, the model, thinking mode, and explicit token limits
remain unchanged. Progress and captured execution settings identify the retry.
The classifier's existing embedding-text length limits also appear in the JSON
schema sent to the model, as well as in post-generation validation.

The executor does not retry this failure after a tool that can change external
state has run. Authentication, credit, cancellation, and budget errors retain
their own handling. With an explicit dollar budget, recovery requires a reported
cost and uses only the remaining allowance. A second output-limit failure stops
with a clear error; partial output is never accepted as a completed artifact.

For a job that has already failed, **Retry** resumes its saved checkpoint. It
reuses completed tasks and reruns the failed task with the job's saved execution
settings. New workers must load the updated executor before the recovery is
available; updating a source checkout alone does not update an installed desktop
backend.

### Optional GPU execution (SLURM)

After the LLM connection is configured, the host discovers its architecture,
SLURM GPU partitions, account associations and permitted QOS choices using fixed,
read-only commands. One bounded planning-agent task prepares a draft from these
facts. If planning fails, the UI shows a deterministic draft and the failure;
discovery never submits a GPU job.

The GPU icon beside the LLM indicator shows discovery progress, pending approval,
probe queue/running status, and verification failures. Open it to select partition,
account, QOS, GPU type/count, CPU count, memory, runtime ceiling and nice value.
Reservation-dependent choices require a reservation name. The environment setup
field accepts commands such as module loading or conda activation, which run
before the probe and subsequent agent scripts.

Save edits, review the exact generated script, then choose **Approve and run
probe**. This submits a probe with a maximum two-minute runtime; queue waiting has
a separate fifteen-minute allowance. It uses `nvidia-smi`, Python 3 and the CUDA
driver to check device access and a small GPU memory transfer. It installs nothing
and does not certify PyTorch, other frameworks or a particular research program.
A successful probe enables the reviewed profile for optional `gpu-execution`
roles. Editing the profile invalidates verification; a raw template in settings
cannot bypass it. Ordinary research does not require GPU setup.

Setup state and verification live under `<workspace>/gpu-setup/`. Probe directories
retain scripts, merged logs and scheduler ownership records. Stale or repeated
approvals cannot submit a second job. Cancellation errors and lost submission
responses remain blocked until the specific owned job can be reconciled; they are
not interpreted as completed jobs. Host or renderer changes require a fresh
review. This initial implementation supports SLURM with NVIDIA CUDA GPUs;
unsupported schedulers are reported without attempting execution.

Research GPU jobs also retain run/task identities and have a durable default
budget of two attempts per task. A resumed task with an unresolved allocation
receives that job's identity and diagnostics instead of submitting a replacement.
Automatic reattachment to interrupted research computations is not implemented;
their records must be reconciled before another attempt. The setup probe has its
own ownership recovery and explicit approval flow.

Node.js **22.13 or newer** is required (the Cursor SDK's floor; `setup.sh` and the `deploy/`
scripts install v24.19.0 — the floor is a minimum, not what we install: on v22.13.0 the Cursor
SDK's use of Node's then-experimental SQLite segfaulted on linux-x64, taking the whole server
down while it merely verified an API key). The floor is enforced: `engine-strict` fails installs on an older Node, and the
server and worker entry points refuse to start on one with a clear message — a worker on a
cluster compute node checks its own Node too, so a wrong job environment fails loudly in the
job log instead of crashing mid-run.

While this directory is inside the umbrella, integration tests materialize `../brain`'s serving
store from its release tags, so they need that repository checked out with its tags. After the
repositories are split, point tests at a checked-out/pinned registry fixture with
`BRAIN_TEST_REGISTRY_DIR` and `BRAIN_TEST_CONTENT_DIR`.

`BRAIN_TEST_CONTENT_DIR` runs the content, runtime, and worker suites against an editable content
tree instead of a published version — the pre-release check in `ARCHITECTURE.md` uses it. The
registry-client suite ignores it: it verifies files against a manifest, and only a published version
has one. The server suite ignores it too, for a different reason: it drives a real registry, so it
needs a whole store with manifests and cannot be aimed at a bare content directory —
`BRAIN_TEST_REGISTRY_DIR` points it at a store instead. Know what that costs: a pre-release check
that only sets `BRAIN_TEST_CONTENT_DIR` leaves the server suite running the already-published
bundle, so it can pass while saying nothing at all about the candidate.

Which published version the suites run is declared once, in `test-bundle.json` at this directory's
root. It is pinned, and the pin is the point: the suites execute real published content, so
resolving whatever the registry index called `latest` meant a content release retroactively changed
the test inputs of app tags that had already shipped — an untouched, released commit could go red,
and no app commit could have caused it or fixed it. Bumping that version is a deliberate commit
that carries whatever test updates the new bundle needs, so the bump and its cost land together.

`BRAIN_TEST_BUNDLE_VERSION` overrides the pin for one run. Give it a version string to try another
published bundle, or the literal `latest` to restore the old floating behaviour. CI runs the whole
suite at `latest` in a `content-canary` job that is allowed to fail: it still catches content the
app cannot execute, which is exactly what the cross-repository checkout is for, but it reports that
rather than deciding whether a release is green.

Testing an UNPUBLISHED candidate bundle therefore takes all three variables, not two. The pin makes
`BRAIN_TEST_REGISTRY_DIR` insufficient on its own: a store whose `latest` is the candidate still
runs at the pinned version, which is the release the candidate is replacing, so the suite passes
without ever executing the new content. `brain/scripts/publish-bundle.mjs` sets all three, and any
check written by hand must do the same — store, content directory, and `BRAIN_TEST_BUNDLE_VERSION`
set to the candidate.

Setting those three is a request, though, and a caller outside the suite cannot see whether the
request landed: the wiring that set only `BRAIN_TEST_REGISTRY_DIR` looked exactly like working
wiring, and the gate passed while the suite quietly ran the release the candidate was replacing. So
the suite reports back. Every server-suite run writes `.test-bundle-used.json` at this directory's
root — bundle name, the version it RESOLVED, and the store root it read, taken from the values the
code produced rather than from the variables that asked for them, and written only once the test
registry has agreed to serve that version out of that store. It is a run artifact, so it is
gitignored, and writing it can never fail a run: a read-only checkout simply leaves no receipt.

`brain/scripts/publish-bundle.mjs` reads that file as its proof instead of trusting its own
environment, and treats a missing, stale, or wrong-version receipt the same way it treats a failing
test. A gate that only re-read the variables it had just exported would be verifying its own
intent, which is precisely the thing that was already wrong. Because the receipt survives a run,
check its `writtenAt` or delete it beforehand — a suite that dies before serving a bundle leaves
the previous run's file in place.

Note that the shipped-content suite is deliberately NOT pinned — it loads every version the index
publishes, because its subject is that everything still supported stays loadable, not which version
a simulated run picks.

## Launch

Cloning and running `./setup.sh` is all a user needs — the shared Brain Registry endpoint is
baked into the app, and every new run automatically fetches the latest published skills. The
manual equivalent:

```bash
npm install && npm run build
npm run launch
```

The host defaults to `127.0.0.1:8787` and `~/.brainstorm-agentic`. Use
`--attachment-roots`, `--workspace`, `--ip`, and `--port` to override deployment settings.

### Optional gamified review

Turn **Gamified review** on in Settings or the quick Research menu before starting a
run. It defaults to off. The setting selects the complete review strategy for that
run; changing it later affects new runs only. Resuming a run keeps its checkpointed
strategy and content version. With the switch off, the existing review workflow
and report formats remain in use.

With the switch on, each independent critic returns only `q` and `justification`.
`q` is the probability that the current reasoning step has a major flaw that could
prevent a correct final solution. Evidence is required at the level of substantive
claims, not sentences: an independently asserted result about data, code, the
literature, or mathematics needs verified support when the argument relies on it.
A claim's badge may be supported by the agent's own proof, calculation, experiment,
or code inspection, or by a checked source and its relevant passage. A citation
alone does not establish a stronger claim or its applicability to different conditions.

The **committee chair** identifies which explicit and implicit claims require
badges, checks their actual standing and conditions, then checks the inference.
Definitions, explanatory text, explicitly conditional reasoning, and directly
inspectable deductions from established premises need no separate badges. The
probability assessment itself needs a reasoned justification, not a badge. Calling
an unsupported substantive premise an assumption, common knowledge, or a derivation
does not exempt it from verification. The supreme judge can verify substantial
mathematical claims using their proofs as well as claims supported by citations.

A report with no badges can be admitted when the chair explains why its reasoning
needs no separately verified claim. This applies to both high and low probabilities.
A report with valid badges can still be rejected for another unsupported premise
or an inference outside the verified conditions. The host independently validates
every cited badge against a durable supreme-judge approval, including the exact
report, reviewed version, content hash and current standing; a model's claimed
badge status is not accepted as evidence. The
chair's per-report reason records its claim assessment and any specific gap.

The host averages `q` over the admitted critics, with equal weight. The step is
flawed (`y = 1`) when that mean is **at least** the configured threshold, otherwise
it passes (`y = 0`). The threshold defaults to **0.5**; lowering it makes review
stricter. An empty admitted set remains unresolved (`y = null`). The committee
chair assesses the submitted arguments rather than conducting a separate review.
When repair is needed, only anonymized admitted comments with `q >= threshold`
reach the game redeveloper. A passing decision advances to the next step.

In bundles declaring `supreme-mediated/v1`, the supreme judge is the sole agent
given direct table records. Other agents converse with it through `fact_table`:
`lookup`, `status`, `submit`, and the committee chair's `approve` request. Conceptual
search examines every record in the caller's authorized view in bounded batches;
it does not discard candidates based on words in common. The judge distinguishes
equivalent wording from different conditions, negation and stronger claims. Failed
or incomplete consultations cannot silently become a successful search or approval.

Badges retain their `[F:n]` citation and gain a `sha256:` content hash identifying
the verified claim, conditions, evidence and issuance justification. The hash is
not a measure of semantic similarity. The chair asks the supreme judge whether a
particular badge supports a particular critic's report, then cites the returned
approval receipt in its fact check. Host checks bind that receipt to the actual
chair task, critic report and reviewed version. Revocation or changed conditions
invalidate pending approvals; completed settlements remain idempotent on replay.

Each critic's consultations use the round's initial facts and its own verified
submissions, with private journals retained across a restart. New private findings
await verification against the combined evidence before becoming justified shared
badges. The supreme judge can reconcile differently worded verified facts when
answering the chair, without requiring identical claim text.
This isolation covers supplied prompts and the fact/notes tool channels.
Scientific code and GPU execution retain the host's existing filesystem permissions.

The host records the agreed scores before any repair:

```text
S_i = 25 - 100 * (q_i - y)^2
R_i = 2 * S_i - mean(S_j for the other admitted critics)
```

One admitted report receives `R_i = S_i`. Rejected reports have null scores and
are excluded from the peer mean, without an additional rejection penalty, with
one exception: when the bundle enables `gameInventedBadgePenalty` (the Brain
bundle does), a report that cites a badge `[F:n]` never issued in the run's fact
table, or one deleted from it before the report was requested, and not present
in the reviewed chain or the task input, is rejected and records **-175**, the
lowest score a round can produce (`2 × (-75) - 25`). That row enters neither the
decision, the repair, nor any other critic's peer mean. A report whose cited
badge is deleted after the report was requested is asked to reconsider, also
when the committee already has it; if the critic revises or withdraws it, the
committee assesses the round again, and a report left unchanged is rejected
without a score. A withdrawn report has no score.
Each agent starts with **100 × the actual confirmed panel size** points, unless
the user sets a custom starting balance in Settings. Each settled `R_i` is added
to that critic's balance exactly once. A balance **below zero** permanently stops
new critique assignments for that agent in this run; zero remains eligible.
Already dispatched reports can finish and settle. The agent's own thinking and
redevelopment continue, and no replacement seat is introduced.

Critics receive their own saved feedback and current total before a new review;
they receive no other critic's reports, scores, or history. The ledger is shared
across the run's parallel reviews and restored before replay, so retirement and
score updates survive a restart. Threshold and starting-point settings, like the
mode itself, are fixed for the run. No eligible or admissible critics leaves the
step unresolved; reaching the review cap also preserves an unresolved major flaw
instead of changing its label to pass. The review panel shows the reports,
committee decision, mean, threshold, score changes, balances, and eligibility,
and can export them together.

For direct worker use, include `"gamifiedReview": true` in the existing
`BRAINSTORM_AGENTIC_WORKFLOW_PARAMS` JSON object alongside other overrides. Set
`gameDecisionThreshold` to override 0.5, and `gameInitialPoints` to a nonnegative
starting balance; `-1` selects the automatic panel-size default. Both app 0.2.83
or newer and a Brain bundle declaring the committee decision parameters are required
for the current content. Older pinned bundles retain their declared fact-access protocol.
Enabling it with an older bundle stops with an explicit compatibility error; an
off setting remains compatible with older bundles. The edited content must be
released through the normal registry process before registry-backed production
runs can use it. Scores are durable journaled results tied to the exact reviewed
chain prefix; replay does not create an additional score for completed work.

### Fact table in Done

The **Done** stage includes the run's shared fact table, including justified and
disputed records (revoked and refuted ones in runs on older bundles) and the
deleted badges with their replacements. Search or filter the entries, expand a
badge to inspect its evidence, conditions, hash, and verification history, or
download the table as JSON. The usage column identifies the agent, role, step,
and recorded purpose, distinguishing citations from verification requests. These
details are searchable, and HTTP(S) references in the text are clickable.
The section is also available for interrupted runs.
Older runs without a fact journal show an explicit empty state. This is a
read-only view for the user; agents continue to consult the supreme judge.

### Fact updates

When the supreme judge, ruling against the shared fact table, finds that a
badge is wrong, the badge is deleted and the ruling's new badge replaces it. A
claim the judge refutes never enters the table, and a revocation found in a
critic's private review only marks the shared badge disputed until such a ruling.
Every agent whose work cites a deleted badge (the thinker whose chain or output
cites it, a critic whose report or comment has not been settled, and the agent
that submitted it) receives the judge's reason at once and is asked to
reconsider, all in parallel. A thinker's revision enters its chain at the start
of its next review round; a step the walk had already passed is marked "revised
after review" and is not reviewed again. A critic's revised report replaces the
original before the committee or judge reads it; if the committee or judge
already had it, a revised or withdrawn report makes it assess the round again.
Nothing else in the review changes. The Done stage lists the deleted badges with
their replacements and reconsiderations, without their claims, and the token
totals include the reconsiderations and the supreme judge's verifications.

## Updates

Users never run git or npm again after installing. Releases are annotated
`app/v<semver>` tags; the running server checks for them half-hourly and the
webapp surfaces a lower-left "Update now" card (also shown at launch). One
click hands the server to a detached updater that checks out the release,
reinstalls, rebuilds, and relaunches on the same port — the browser tab
reloads itself into the new version, and active runs (detached worker
processes over workspace files) keep going and are adopted by the new server.
A failed update rolls back to the previous checkout and relaunches it; local
modifications (e.g. a package-lock rewritten by a bootstrap `npm install`)
are set aside recoverably with `git stash`, never destroyed and never a
reason to fail; every step is logged under `<workspace>/self-update/`.
Skills-bundle updates need no action at all: new runs resolve the latest
published bundle automatically.

## Running under SLURM

Use [`deploy/slurm-launch.sh`](deploy/slurm-launch.sh) (submit it from the
repository root). To submit from another directory and keep logs in the
repository, set the job's working directory explicitly:

```bash
sbatch --chdir=/absolute/path/to/Brain-app /absolute/path/to/Brain-app/deploy/slurm-launch.sh
```

The launcher also detects the app root from SLURM's original script path or
the submission directory's ancestors; `BRAIN_APP_DIR` overrides that choice.
SLURM opens the relative `logs/` paths before the script runs, so the job's
working directory must already contain `logs/`.

A detached relauncher would die with the job's cgroup, so
under SLURM the in-app updater only stashes + checks out the new release and
hands rebuild + relaunch to the wrapper's loop — one-click updates work
exactly like on a workstation, including the tab reloading itself. The
wrapper follows the release-tag channel (never `main`), builds with `npm ci`
(never `npm install` — it rewrites the lockfile and dirties the checkout),
requests an early TERM before walltime for a clean shutdown, and uses
`--dependency=singleton` so two instances never fight over the port.
Resubmitting after walltime adopts all jobs and state from the workspace.

### Managed SearXNG

Selecting local SearXNG starts a supervised container. Apptainer/Singularity
launches explicitly set the application directory and Granian listener. When
the app listens on a wildcard address, search advertises the server hostname
and uses port **8080** by default. Workers on other nodes must be able to reach
that port; a successful local health check alone does not establish this.

Deployment overrides, set in the server's environment before launch:

- `BRAINSTORM_SEARXNG_ADVERTISE_HOST`: worker-reachable hostname or IP, without a scheme or port.
- `BRAINSTORM_SEARXNG_PORT`: a site-approved listening port, from 1 through 65535.
- `BRAINSTORM_SEARXNG_IMAGE`: a pinned container image reference or a local Apptainer SIF path.

Loopback deployments allocate a port and preserve it in the workspace across
restarts. A selected local service that is starting or failed blocks online
runs requiring web search; offline runs and explicit web-search opt-outs still
work. Container output and the underlying failure appear in the server log,
and the restart limit retains the original diagnostic. Managed worker traffic
bypasses the outbound proxy only for the configured search host and port.

The real-container smoke test is opt-in because it makes a public search query:

```bash
npm run build -w brainstorm-agentic-server
BRAINSTORM_SEARXNG_INTEGRATION=1 \
BRAINSTORM_SEARXNG_RUNTIME=apptainer \
BRAINSTORM_SEARXNG_ADVERTISE_HOST=server.internal \
BRAINSTORM_SEARXNG_PORT=8080 \
node --test apps/server/dist/test/searxng-integration.test.js
```

It checks startup, the advertised endpoint, worker configuration, JSON search
results, and cleanup using a temporary workspace. Set
`BRAINSTORM_SEARXNG_REMOTE_PROBE_HOST` to an SSH-accessible worker host to also
check cross-node reachability, or `BRAINSTORM_SEARXNG_HOLD_MS=60000` to leave
the test service available briefly for a separate-node probe.

### Developer-only registry overrides

The registry endpoint is deliberately NOT a user setting (the webapp shows it read-only and the
settings API ignores attempts to change it). Developers change deployments by editing
`DEFAULT_CONTENT_REGISTRY_URL` in `apps/server/src/settings.ts`, or override one launch:

```bash
# point at another registry
npm run launch -- --content-registry-url http://127.0.0.1:51011
# or spawn a local registry process (no implicit sibling lookup)
npm run launch -- --content-registry-main /absolute/path/to/brain/dist/src/main.js
```

`BRAIN_CONTENT_REGISTRY_URL` / `BRAIN_CONTENT_REGISTRY_MAIN` work as environment equivalents.
