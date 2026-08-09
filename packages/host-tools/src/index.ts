/**
 * @brainstorm-agentic/host-tools
 *
 * Provider-neutral host-side tools satisfying brainstorm capability contracts.
 * This package owns:
 * - Tool manifests (static metadata for the capability broker)
 * - Runtime tool implementations (attachment, taxonomy, code execution, web fetch)
 * - Extension interfaces for future backends (web search)
 * - A registry factory that creates tool registries from user settings
 */

// Attachment tools (fully implemented)
export {
  attachmentTools,
  insideRoots,
  ATTACHMENT_TOOL_NAMES,
  ATTACHMENT_LIST_MANIFEST,
  ATTACHMENT_READ_MANIFEST,
  ATTACHMENT_SEARCH_MANIFEST,
  ATTACHMENT_MANIFESTS,
} from "./attachment-tools.js";

// Web tools (web_fetch fully implemented; web_search awaits its first backend)
export {
  WEB_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
  WEB_SEARCH_MANIFESTS,
  WEB_FETCH_TOOL_NAMES,
  webFetchTools,
  htmlToText,
  isPublicAddress,
} from "./web-search.js";
export type { SearchHit, SearchBackend, WebFetchOptions } from "./web-search.js";

// Code execution (workspace preparation + executable tool)
export {
  CODE_EXECUTE_MANIFEST,
  CODE_EXECUTION_MANIFESTS,
  CODE_EXECUTION_TOOL_NAMES,
  codeExecutionTools,
  prepareCodeWorkspace,
  runProcess,
} from "./code-execution.js";

// GPU runs (agent script spliced into the deployment's submission template)
export {
  AGENT_COMMAND_TAG,
  GPU_RUN_MANIFEST,
  GPU_RUN_MANIFESTS,
  GPU_RUN_TOOL_NAMES,
  gpuRunTools,
  renderGpuTemplate,
} from "./gpu-run.js";
export type { GpuRunConfig, RunSchedulerCommand } from "./gpu-run.js";
export type {
  CodeRuntime,
  CodeRuntimeEnvironment,
  ExecutionResult,
  PrepareCodeWorkspaceOptions,
  RunProcessOptions,
} from "./code-execution.js";

// Taxonomy read tools (fully implemented over an injected TaxonomyAccess)
export {
  taxonomyTools,
  TAXONOMY_TOOL_NAMES,
  TAXONOMY_TREE_MANIFEST,
  TAXONOMY_RESOLVE_MANIFEST,
  TAXONOMY_MANIFESTS,
} from "./taxonomy-tools.js";

// Registry
export {
  ALL_HOST_TOOL_MANIFESTS,
  createHostToolRegistry,
  executableHostToolIds,
  availableHostToolManifests,
} from "./registry.js";
export type { HostToolRegistryConfig } from "./registry.js";
