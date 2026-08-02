/**
 * @brainstorm-agentic/host-tools
 *
 * Provider-neutral host-side tools satisfying brainstorm capability contracts.
 * This package owns:
 * - Tool manifests (static metadata for the capability broker)
 * - Runtime tool implementations (attachment, taxonomy, code execution)
 * - Extension interfaces for future backends (web-search)
 * - A registry factory that creates tool registries from user settings
 */

// Attachment tools (fully implemented)
export {
  attachmentTools,
  insideRoots,
  ATTACHMENT_TOOL_NAMES,
  ATTACHMENT_LIST_MANIFEST,
  ATTACHMENT_READ_MANIFEST,
  ATTACHMENT_MANIFESTS,
} from "./attachment-tools.js";

// Web search (manifests and interfaces only)
export {
  WEB_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
  WEB_SEARCH_MANIFESTS,
} from "./web-search.js";
export type { SearchHit, SearchBackend } from "./web-search.js";

// Code execution (workspace preparation + executable tool)
export {
  CODE_EXECUTE_MANIFEST,
  CODE_EXECUTION_MANIFESTS,
  CODE_EXECUTION_TOOL_NAMES,
  codeExecutionTools,
  prepareCodeWorkspace,
  runProcess,
} from "./code-execution.js";
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
