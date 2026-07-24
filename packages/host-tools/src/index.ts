/**
 * @brainstorm-agentic/host-tools
 *
 * Provider-neutral host-side tools satisfying brainstorm capability contracts.
 * This package owns:
 * - Tool manifests (static metadata for the capability broker)
 * - Runtime tool implementations (currently attachment tools only)
 * - Extension interfaces for future backends (web-search, code-execution)
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

// Code execution (manifests and interfaces only)
export {
  CODE_EXECUTE_MANIFEST,
  CODE_EXECUTION_MANIFESTS,
} from "./code-execution.js";
export type { ExecutionResult, CodeSandbox } from "./code-execution.js";

// Registry
export {
  ALL_HOST_TOOL_MANIFESTS,
  createHostToolRegistry,
  executableHostToolIds,
  availableHostToolManifests,
} from "./registry.js";
export type { HostToolRegistryConfig } from "./registry.js";
