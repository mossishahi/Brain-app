# @brainstorm-agentic/host-tools

Provider-neutral host-side tools satisfying brainstorm capability contracts,
plus the manifests the capability broker resolves against.

## How a capability becomes tools

1. **Catalog** (registry content, `brain/content-src/brainstorm/capabilities/capabilities.json`):
   declares the capability id, its `operations` (e.g. `attachment.search`),
   the behavioral `contract`, and the `whenUnavailable` honesty rule injected
   into prompts when it cannot be satisfied.
2. **Skills** declare `capabilities: [...]` in frontmatter; the compiler turns
   the declared set + the catalog into a `BrokerInput`.
3. **Broker** (`@brainstorm-agentic/core`, `resolveCapabilityPlan`) resolves
   each operation: provider-native offer first, then an enabled host tool,
   else `unavailable`. Per-run user disables (`disabledCapabilityIds`)
   short-circuit to `unavailable` with a "the user disabled this" prompt note.
4. **Executors**: the tool-loop path exposes the plan's host tools from the
   registry; the Claude Agent SDK path maps capabilities to Claude Code
   built-ins (`CAPABILITY_TOOLS` in `executor-claude-agent`) and mounts
   in-process MCP servers for tools the SDK lacks (taxonomy reads,
   deterministic attachment list/search).

## Adding a new host tool (checklist)

Deterministic work must run host-side — never spend model turns on something
a tool can answer in one call. To add a tool:

- `src/<area>-tools.ts`: `ToolDefinition`, `HostToolManifest` (operations,
  risk, `defaultEnabled`), and the runtime `Tool` implementation.
- `src/registry.ts`: manifests reach `ALL_HOST_TOOL_MANIFESTS`;
  `createHostToolRegistry` / `executableHostToolIds` register the runtime.
- Catalog: add the operation to the owning capability in the registry
  content (new bundle version).
- Worker wiring (`apps/worker/src/wiring.ts`): registered automatically when
  its factory already runs; check the enabled-ids defaulting and gating.
- SDK path (`packages/executor-claude-agent`): expose through an in-process
  MCP server if Claude Code has no equivalent built-in; add progress labels.
- Server: default `hostTools.enabledToolIds` (`apps/server/src/settings.ts`),
  the readiness capability probe (`apps/server/src/readiness.ts`), the
  dashboard tool→capability icon map (`apps/server/src/stage-mapper.ts`),
  and the settings drawer checkbox group (webapp).
- Migration: if the tool joins an existing capability, extend the
  `validateHostTools` migration so persisted enabled-lists gain it —
  otherwise the whole capability degrades to "unavailable" for existing
  deployments when the new operation resolves nowhere.

## Per-run capability toggles

`SubmitJobRequest.capabilityOverrides` (`{ "web-search": false }`) rides the
job's execution-settings snapshot, becomes
`BRAINSTORM_AGENTIC_DISABLED_CAPABILITIES` in the run environment, and reaches
the broker as `disabledCapabilityIds` — disabling the capability's host tools
AND provider-native equivalents, with an explicit prompt note. Locked
capabilities (`taxonomy-access`) ignore overrides; the composer renders them
always-on. `GET /api/capabilities` enumerates the catalog for the UI.
