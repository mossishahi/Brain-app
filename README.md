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
worker connects over MCP, pins an immutable version, and fetches the whole skill set up front —
hash-verified, held in memory only — so a run never depends on the registry connection staying
alive into its later stages. A resume re-fetches the same immutable version and re-verifies it.

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
