/**
 * @brainstorm-agentic/host-tools
 *
 * Provider-neutral host-side tools satisfying brainstorm capability contracts.
 * This package owns:
 * - Tool manifests (static metadata for the capability broker)
 * - Runtime tool implementations (attachment, taxonomy, code execution, and
 *   the web tools: web_search, news_search, paper_search, paper_details,
 *   web_fetch)
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

// Web tools: manifests, the ONE hardened fetch, and the unified layer
export {
  WEB_SEARCH_MANIFEST,
  WEB_FETCH_MANIFEST,
  NEWS_SEARCH_MANIFEST,
  PAPER_SEARCH_MANIFEST,
  PAPER_DETAILS_MANIFEST,
  WEB_SEARCH_MANIFESTS,
  WEB_FETCH_TOOL_NAMES,
  FIELDS_OF_STUDY,
  performWebFetch,
  webFetchTools,
  htmlToText,
  isPublicAddress,
} from "./web-search.js";
export type {
  SearchHit,
  SearchBackend,
  WebFetchOptions,
  WebFetchOutcome,
} from "./web-search.js";

// Unified web layer: one manager per run routes, paces, coalesces, caches,
// and logs every agent's web calls, whichever backend executes the agent.
export {
  DEFAULT_PAPER_ROUTES,
  WebAccessManager,
  WebAccessError,
  searchCacheKey,
} from "./web/manager.js";
export type { WebAccessManagerOptions } from "./web/manager.js";
export {
  LOCAL_SEARXNG_ENGINES,
  buildWebAccessManager,
  localSearxngEngineNames,
  presetRoutes,
  resolveGeneralProvider,
} from "./web/config.js";
export type {
  BuildWebAccessManagerOptions,
  GeneralSearchProviderId,
  WebSearchRuntimeConfig,
  WebSearchSecrets,
} from "./web/config.js";
// Tool availability: the per-purpose order derived from probed states, and
// the probes the server runs outside a run.
export { deriveEffectiveOrder } from "./web/availability.js";
export type { EffectiveOrder, EffectiveOrderEntry, ToolAvailabilityState } from "./web/availability.js";
export {
  ARXIV_PROBE_TIMEOUT_MS,
  KNOWN_WEB_ANSWER,
  PROBE_TIMEOUT_MS,
  ProbeLog,
  loggingFetch,
  probeStateFromError,
  redactSecrets,
  redactUrl,
  runProbe,
  withProbeLog,
  withSearchProbe,
} from "./web/probe.js";
export type { ProbeFinding, ProbeLogLine, ProbeOptions, WebSourceStatusWithLog } from "./web/probe.js";
export { OPENROUTER_EMBEDDINGS_URL, probeOpenRouterEmbeddings } from "./web/embeddings-probe.js";
export {
  arxivProvider,
  BRAVE_COST_PER_REQUEST_USD,
  braveProvider,
  crossrefProvider,
  neutralizeSearxngTokens,
  offlineSearchProvider,
  openAlexProvider,
  ProviderRequestError,
  searxngProvider,
  semanticScholarProvider,
  tavilyProvider,
} from "./web/providers.js";
export {
  arxivBackend,
  crossrefBackend,
  openAlexBackend,
  parsePaperIdentifier,
  semanticScholarBackend,
} from "./web/scholarly.js";
export type {
  PaperBackend,
  PaperBackendAnswer,
  PaperBackendId,
  PaperIdentifier,
} from "./web/scholarly.js";
export { coreBackend, europePmcBackend, openCitationsBackend } from "./web/scholarly-extra.js";
export { Breaker, FairGate, SYSTEM_CLOCK, TokenBucket } from "./web/scheduler.js";
export type { BreakerOptions, BreakerState, SchedulerClock, TokenBucketOptions } from "./web/scheduler.js";
export { DEFAULT_ENGINE_CANARIES, EnginePool } from "./web/engines.js";
export {
  notePaidRequest,
  paidRequestsInMonth,
  paidRequestsOfRun,
  usageFile,
  usageMonth,
} from "./web/usage.js";
export type { EngineCanary, EngineOutcome, EnginePoolOptions, EngineRoute } from "./web/engines.js";
export type {
  ProviderAnswer,
  ProviderFetch,
  ProviderSearchRequest,
  WebSearchProvider,
} from "./web/providers.js";
export {
  FsCache,
  FsWebSearchCache,
  LayeredCache,
  LayeredWebSearchCache,
  MemoryCache,
  MemoryWebSearchCache,
} from "./web/cache.js";
export type { WebSearchCache } from "./web/cache.js";
export {
  WEB_ACCESS_TOOL_NAMES,
  parsePaperDetailsInput,
  parsePaperSearchInput,
  parseWebFetchInput,
  parseWebSearchInput,
  webAccessTools,
  webToolNames,
  webToolSpecs,
} from "./web/tools.js";
export type { WebAccessToolName, WebToolSpec } from "./web/tools.js";

// Code execution (workspace preparation + executable tool)
export {
  CODE_EXECUTE_MANIFEST,
  CODE_EXECUTION_MANIFESTS,
  CODE_EXECUTION_TOOL_NAMES,
  codeExecutionTools,
  prepareCodeWorkspace,
  runProcess,
  scrubbedEnvironment,
} from "./code-execution.js";

// GPU runs (agent script spliced into the deployment's submission template)
export {
  AGENT_COMMAND_TAG,
  GPU_RUN_MANIFEST,
  GPU_RUN_MANIFESTS,
  GPU_RUN_TOOL_NAMES,
  gpuRunTools,
  gpuSubmissionJobIds,
  renderGpuTemplate,
  slurmClusterArgs,
  slurmClusterFrom,
  stripSlurmClusterBanners,
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

// Thinker notes search (one seat's recorded thinking, scoped per review task)
export {
  NOTES_MANIFESTS,
  NOTES_SEARCH_DEFINITION,
  NOTES_SEARCH_MANIFEST,
  NOTES_TOOL_NAMES,
  notesTools,
  runNotesSearch,
} from "./notes-tools.js";
export type { NotesScopeResolver } from "./notes-tools.js";
export { buildNotesIndex, paragraphsOf, splitSentences } from "./notes/index-notes.js";
export type { NoteParagraph, NotesIndex } from "./notes/index-notes.js";
export {
  NOTES_MATCHES,
  NOTES_MODES,
  NOTES_SOURCES,
  NOTES_UNITS,
  NotesQueryError,
  parseNotesInput,
  searchNotes,
} from "./notes/search.js";
export type { NotesMode, NotesQuery } from "./notes/search.js";

// Fact table (the board's justified facts; the supreme judge verifies submissions)
export {
  FACT_MANIFESTS,
  FACT_TABLE_DEFINITION,
  FACT_TABLE_MANIFEST,
  FACT_TABLE_MODES,
  FACT_TOOL_NAMES,
  FactQueryError,
  describeFactTableCall,
  factEntryView,
  factTools,
  formatFactOutcome,
  parseFactInput,
  runFactTable,
} from "./fact-tools.js";
export type { FactBindingResolver, FactTableMode, FactTableQuery } from "./fact-tools.js";
export { factTokens, normalizeFactText, rankFacts } from "./facts/rank.js";
export type { RankedFact } from "./facts/rank.js";

// Registry
export {
  ALL_HOST_TOOL_MANIFESTS,
  createHostToolRegistry,
  executableHostToolIds,
  availableHostToolManifests,
} from "./registry.js";
export type { HostToolRegistryConfig } from "./registry.js";
