# Brainstorm App — Worker

The isolated process that executes one pipeline job. The host server launches it locally or
through the user's SLURM template; therefore a long run survives host restarts and one failed job
cannot take down the HTTP server or other jobs.

The worker receives:

- `run` or `resume`, plus the stable run id;
- a cache `--content-dir` and Brain Registry MCP URL;
- session/checkpoint, artifact, attachment, and event-log paths;
- provider configuration through its environment.

It resolves and checkpoints one immutable registry version, fetches the workflow/control files,
and then retrieves each role and technique only when that workflow node is reached. Every file is
SHA-256 verified and cached atomically; resume reuses cached resources and never switches
versions. The worker also wires the model backend and host tools, executes the checkpoint-aware
workflow, and writes canonical state.

## The attachment store is a resource of the job, not an input of one launch

`--attachments-manifest` names the ROOT the attachment tools read through. A worker that comes up
without it has no roots, so it deletes the attachment host tools and the provider's file offers are
withdrawn — and the capability broker then tells every agent, truthfully, that the submitted files
are unavailable and to reason from metadata instead. Agents obey: they say they have no file access
and go to the web instead. Nothing else surfaces it, which is how one run spent seventeen hours and
442 consecutive review tasks reasoning blind about a codebase that was on disk the whole time.

The server names the manifest on every submission it builds. The worker no longer depends on being
told: when the flag is absent it looks for the store in its own job directory — a fixed place, one
`dirname` from the `--events-file` the same command line names — and uses it, **printing an
`[attachments]` line that says the launcher forgot**. The recovery is deliberately loud: a run
reading its files because of a fallback is a launcher bug survived, not a thing to pass over. What
the launcher DOES name always wins, and a run with no store recovers nothing (inventing a path
would make the broker lie in the other direction).

The same distinction is what the worker now asserts for every capability it can speak for. It
tells the broker which capabilities are legitimately empty and why — `--attachments none` means the
submission declared it carries no files, an unconfigured GPU template means this deployment has no
GPU, `--offline` means no network and no interpreter by choice — and nothing else may claim it. An
absence nobody vouches for is `unwired`, which a role's `requiredCapabilities` refuses to run
through. That is what makes the declaration safe to add: a topic-only run passes, and a run whose
store this host cannot open stops at the first task that needed it. Taxonomy is deliberately not
vouchable — it is deployment infrastructure the placer hard-requires, so its absence stays loud.

Related, in the broker: a capability that lost only SOME of its operations is no longer announced
as gone. The catalog's `whenUnavailable` prose is written for total loss ("state explicitly that
attachment access was unavailable"), so injecting it when only deterministic search is missing told
an agent holding a working file read to stop reading files and report itself blind. A partial
outage now names the operations that are actually missing.

## Staggered agent launches

Agent tasks START one at a time, spaced 10 seconds apart, so a parallel wave (the first-pass
fan-out, a review round's commentors) ramps up gradually instead of hitting the provider and the
node in one aligned burst (Anthropic 429s sharp usage jumps as "acceleration limits" even below
the account's ceilings). Tasks still run fully in parallel — only their start moments are spaced,
and a lone task between waves never waits. Offline runs skip the stagger entirely.
`BRAINSTORM_AGENTIC_AGENT_LAUNCH_INTERVAL_MS` overrides the spacing for a deployment
(`0` disables it); it is not a user setting.

From the app root:

```bash
npm run build -w brainstorm-agentic-worker
npm run test  -w brainstorm-agentic-worker
```

`brain-worker` is the primary binary name. `brainstorm-agentic` remains as a compatibility alias.
