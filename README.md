# Brainstorm App

The complete user-facing Brainstorm product in one repository and one release unit. Frontend and
backend remain separate internal applications, but they are built, tested, versioned, and
deployed together because the host serves the compiled frontend and both share one API contract.

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
worker connects over MCP, pins an immutable version, and retrieves only the current role and its
declared techniques. Files are hash-verified and cached for resume.

## Install, build, and test

```bash
npm install
npm run build
npm test
```

Node.js **22.13 or newer** is required (the Cursor SDK's floor; `deploy/` scripts install
v22.13.0). The floor is enforced: `engine-strict` fails installs on an older Node, and the
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
has one.

## Launch

Cloning and installing is all a user needs — the shared Brain Registry endpoint is baked into
the app, and every new run automatically fetches the latest published skills:

```bash
npm install && npm run build
npm run launch
```

The host defaults to `127.0.0.1:8787` and `~/.brainstorm-agentic`. Use
`--attachment-roots`, `--workspace`, `--ip`, and `--port` to override deployment settings.

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
repository root). A detached relauncher would die with the job's cgroup, so
under SLURM the in-app updater only stashes + checks out the new release and
hands rebuild + relaunch to the wrapper's loop — one-click updates work
exactly like on a workstation, including the tab reloading itself. The
wrapper follows the release-tag channel (never `main`), builds with `npm ci`
(never `npm install` — it rewrites the lockfile and dirties the checkout),
requests an early TERM before walltime for a clean shutdown, and uses
`--dependency=singleton` so two instances never fight over the port.
Resubmitting after walltime adopts all jobs and state from the workspace.

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
