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
