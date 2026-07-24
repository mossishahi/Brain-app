# Brainstorm Agentic — Brain Server

The host server of the brainstorm system. `brain launch` starts an HTTP + SSE server that:

- serves the webapp build and exposes the REST/SSE API defined in
  `@brainstorm-agentic/protocol` (jobs, per-stage detail, settings, gates, streams);
- submits and tracks orchestration jobs — each job is one `apps/worker run` process, launched
  through the user-editable SLURM template (`{{BRAIN_COMMAND}}` tag) or as a detached local
  process; closing the server never cancels jobs;
- reconstructs all job state purely from workspace files (checkpoint journal, artifact index,
  `events.jsonl`), so a restart reloads running, finished, and cancelled jobs;
- verifies and stores provider credentials (Anthropic API key, Claude Agent SDK setup token,
  OpenRouter parser key) in an owner-only credentials file, never returning them to the browser
  or embedding them in jobs, scripts, sessions, or artifacts;
- exposes the server-side attachment picker (root-confined browsing, safety checks, immutable
  job-store snapshots);
- auto-resumes credit-blocked jobs once their provider reset time (plus safety buffer) passes;
- configures the Brain Registry endpoint and passes it to each isolated worker. The worker owns
  version pinning, incremental MCP reads, hash verification, lazy validation, and caching.

## Development

This module lives inside the Brainstorm app workspace. From `app/`:

```bash
npm install
npm run build                                # builds worker, server, web, and libraries
npm run test -w brainstorm-agentic-server
npm run launch -- --content-registry-url https://brain.example
```

Runtime layout inside the app: the frontend build is `apps/web/dist/` and the worker entry is
`apps/worker/dist/src/main.js`.

When `--content-registry-url` (or `BRAIN_CONTENT_REGISTRY_URL`) is present, the server does not
spawn a local registry. The host records the resolved bundle id, concrete version, and manifest
SHA-256 in every job. A registry failure or invalid bundle rejects submission; it never silently falls back to a
different local version.

Without a remote URL, `--content-registry-main` must explicitly identify a local Brain Registry
executable. The app never assumes that it exists in a sibling directory.
