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

While this directory is inside the umbrella, integration tests use `../brain/content`. After the
repositories are split, point tests at a checked-out/pinned registry fixture with
`BRAIN_TEST_REGISTRY_DIR` and `BRAIN_TEST_CONTENT_DIR`.

## Launch

Against the shared Brain Registry:

```bash
npm run launch -- --content-registry-url https://167.172.170.154/mcp
```

For local development, start Brain Registry separately and pass its URL:

```bash
# in the Brain repository
node dist/src/main.js --host 127.0.0.1 --port 51011

# in this repository
npm run launch -- --content-registry-url http://127.0.0.1:51011
```

Alternatively, `--content-registry-main /absolute/path/to/brain/dist/src/main.js` tells the host
to spawn that explicitly supplied local executable. There is intentionally no implicit sibling
directory lookup: the two repositories are independently deployable.

The host defaults to `127.0.0.1:8787` and `~/.brainstorm-agentic`. Use
`--attachment-roots`, `--workspace`, `--ip`, and `--port` to override deployment settings.
