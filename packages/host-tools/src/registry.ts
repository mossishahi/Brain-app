/**
 * Host tool catalog: collects all installed tool manifests (whether
 * executable or not) and provides a unified registry for the broker.
 */
import type { HostToolManifest, Tool } from "@brainstorm-agentic/core";
import { InMemoryToolRegistry } from "@brainstorm-agentic/core";

import { ATTACHMENT_MANIFESTS, attachmentTools, ATTACHMENT_TOOL_NAMES } from "./attachment-tools.js";
import {
  WEB_FETCH_TOOL_NAMES,
  WEB_SEARCH_MANIFESTS,
  webFetchTools,
} from "./web-search.js";
import {
  CODE_EXECUTION_MANIFESTS,
  CODE_EXECUTION_TOOL_NAMES,
  codeExecutionTools,
  type CodeRuntimeEnvironment,
} from "./code-execution.js";
import {
  GPU_RUN_MANIFESTS,
  GPU_RUN_TOOL_NAMES,
  gpuRunTools,
  type GpuRunConfig,
} from "./gpu-run.js";
import { TAXONOMY_MANIFESTS, TAXONOMY_TOOL_NAMES, taxonomyTools } from "./taxonomy-tools.js";
import type { TaxonomyAccess } from "@brainstorm-agentic/core";

// ---------------------------------------------------------------------------
// Complete manifest catalog
// ---------------------------------------------------------------------------

/**
 * All host tool manifests known to the system (both implemented and future).
 * The broker uses these to determine what CAN be offered; user settings
 * determine what IS enabled.
 */
export const ALL_HOST_TOOL_MANIFESTS: readonly HostToolManifest[] = [
  ...ATTACHMENT_MANIFESTS,
  ...WEB_SEARCH_MANIFESTS,
  ...CODE_EXECUTION_MANIFESTS,
  ...GPU_RUN_MANIFESTS,
  ...TAXONOMY_MANIFESTS,
];

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export interface HostToolRegistryConfig {
  /** Attachment store roots. Required for attachment tools to be functional. */
  readonly attachmentRoots?: readonly string[];
  /** Shared-taxonomy access. Required for taxonomy tools to be functional. */
  readonly taxonomy?: TaxonomyAccess;
  /** Prepared code scratch workspace. Required for the code_execute tool. */
  readonly codeEnvironment?: CodeRuntimeEnvironment;
  /** GPU submission config (user-completed template). Required for gpu_run. */
  readonly gpuRun?: GpuRunConfig;
  /** User-enabled tool IDs. Only these are registered on the runtime registry. */
  readonly enabledToolIds: ReadonlySet<string>;
}

/**
 * Creates a tool registry containing only the enabled, executable host tools.
 * Tools that are listed in manifests but have no runtime implementation
 * (web_search, until its first backend lands) are silently skipped.
 */
export function createHostToolRegistry(
  config: HostToolRegistryConfig,
): { registry: InMemoryToolRegistry; registeredToolNames: readonly string[] } {
  const registry = new InMemoryToolRegistry();
  const registeredNames: string[] = [];

  // Attachment tools: only register when roots are available and tools are enabled
  if (config.attachmentRoots && config.attachmentRoots.length > 0) {
    const tools = attachmentTools(config.attachmentRoots);
    for (const tool of tools) {
      if (config.enabledToolIds.has(tool.definition.name)) {
        registry.register(tool);
        registeredNames.push(tool.definition.name);
      }
    }
  }

  // Taxonomy read tools: only register when a shared-taxonomy access is wired
  if (config.taxonomy) {
    for (const tool of taxonomyTools(config.taxonomy)) {
      if (config.enabledToolIds.has(tool.definition.name)) {
        registry.register(tool);
        registeredNames.push(tool.definition.name);
      }
    }
  }

  // Host code execution: only register over a prepared scratch workspace
  if (config.codeEnvironment) {
    for (const tool of codeExecutionTools(config.codeEnvironment)) {
      if (config.enabledToolIds.has(tool.definition.name)) {
        registry.register(tool);
        registeredNames.push(tool.definition.name);
      }
    }
  }

  // GPU runs: only register when the deployment configured a template.
  if (config.gpuRun) {
    for (const tool of gpuRunTools(config.gpuRun)) {
      if (config.enabledToolIds.has(tool.definition.name)) {
        registry.register(tool);
        registeredNames.push(tool.definition.name);
      }
    }
  }

  // Web fetch needs no backing configuration (outbound reachability is the
  // readiness check's concern); web_search still waits on its first backend.
  for (const tool of webFetchTools()) {
    if (config.enabledToolIds.has(tool.definition.name)) {
      registry.register(tool);
      registeredNames.push(tool.definition.name);
    }
  }

  return { registry, registeredToolNames: registeredNames };
}

/**
 * Returns the set of host tool IDs that have executable implementations
 * (i.e., we can actually create runtime Tool objects for them).
 */
export function executableHostToolIds(config: {
  attachmentRoots?: readonly string[];
  taxonomy?: TaxonomyAccess;
  codeEnvironment?: CodeRuntimeEnvironment;
  gpuRun?: GpuRunConfig;
}): ReadonlySet<string> {
  const ids = new Set<string>();
  if (config.attachmentRoots && config.attachmentRoots.length > 0) {
    for (const name of ATTACHMENT_TOOL_NAMES) {
      ids.add(name);
    }
  }
  if (config.taxonomy) {
    for (const name of TAXONOMY_TOOL_NAMES) {
      ids.add(name);
    }
  }
  if (config.codeEnvironment) {
    for (const name of CODE_EXECUTION_TOOL_NAMES) {
      ids.add(name);
    }
  }
  // gpu_run exists only after the deployment owner completes the template.
  if (config.gpuRun) {
    for (const name of GPU_RUN_TOOL_NAMES) {
      ids.add(name);
    }
  }
  // web_fetch runs over ambient outbound HTTP; nothing to configure.
  for (const name of WEB_FETCH_TOOL_NAMES) {
    ids.add(name);
  }
  return ids;
}

/**
 * Returns all manifests for tools that have runtime implementations
 * available given the current configuration.
 */
export function availableHostToolManifests(config: {
  attachmentRoots?: readonly string[];
  taxonomy?: TaxonomyAccess;
  codeEnvironment?: CodeRuntimeEnvironment;
}): readonly HostToolManifest[] {
  const available: HostToolManifest[] = [];
  if (config.attachmentRoots && config.attachmentRoots.length > 0) {
    available.push(...ATTACHMENT_MANIFESTS);
  }
  if (config.taxonomy) {
    available.push(...TAXONOMY_MANIFESTS);
  }
  // Web search, code execution, and GPU run manifests are always listed
  // (for the settings UI); code execution is executable only when a
  // prepared workspace backs it, gpu_run only when the deployment owner
  // completed the GPU template (see executableHostToolIds).
  available.push(...WEB_SEARCH_MANIFESTS);
  available.push(...CODE_EXECUTION_MANIFESTS);
  available.push(...GPU_RUN_MANIFESTS);
  return available;
}
