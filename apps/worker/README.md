# Brainstorm App — Worker

The isolated process that executes one pipeline job. The host server launches it locally or
through the user's SLURM template; therefore a long run survives host restarts and one failed job
cannot take down the HTTP server or other jobs.

The worker receives:

- `run` or `resume`, plus the stable run id;
- a host-materialized, version-pinned `--content-dir`;
- session/checkpoint, artifact, attachment, and event-log paths;
- provider configuration through its environment.

It loads and validates the pinned content, wires the configured model backend and host tools,
executes the checkpoint-aware workflow, and writes canonical state. It never contacts the skill
registry directly—the host owns that trust boundary.

From the app root:

```bash
npm run build -w brainstorm-agentic-worker
npm run test  -w brainstorm-agentic-worker
```

`brain-worker` is the primary binary name. `brainstorm-agentic` remains as a compatibility alias.
