/**
 * Typed fetch helpers for every brain endpoint plus the SSE hook used by the
 * landing page and the dashboard. All shapes come from the protocol package.
 */
import { useEffect, useRef, useState } from "react";
import { BoundedCache } from './data/bounded-cache';
import { SerializedResource } from './data/serialized-resource';
import { compactEvents, isServerEvent } from './data/event-batch';
import { API_BASE } from "./desktop/context";
import type {
  AttachmentSelectionKind,
  AvailabilityReport,
  AvailabilityServerEvent,
  BrowseServerFilesResponse,
  CancelJobResponse,
  CapabilityOptionsResponse,
  DiagnosticPreview,
  GateAnswerRequest,
  HealthResponse,
  GpuSetupReport,
  GpuDraftUpdate,
  GpuProbeApproval,
  JobDetail,
  JobSummary,
  ModelOptionsResponse,
  ModelsByRouteUpdate,
  ReadinessCheckId,
  ReadinessReport,
  ResumeInterruptedJobResponse,
  ResumeJobResponse,
  ServerEvent,
  ServerAttachmentRootsResponse,
  ServerSettings,
  ServerSettingsUpdate,
  SearchServerFilesResponse,
  SendDiagnosticsResponse,
  StageActivityPage,
  SubmitJobRequest,
  SubmitJobResponse,
  ThoughtsResponse,
  ToolUsageReport,
  TrashJobResponse,
  UpdateAppResponse,
  UpdateCheckResponse,
  ValidateAttachmentsResponse,
} from "@brainstorm-agentic/protocol";
import type { PanelEvidenceView } from "./components/panels/coverage-model";
import type { NeedsGateAnswer, NeedsGateView } from "./components/panels/needs-model";
import type {
  EncoderReadinessView,
  PanelCompositionView,
} from "./components/settings/panel-composition-model";

export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON body of the error response, when there was one. */
  readonly payload?: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** The readiness report of a 409 "environment not ready" submit response. */
export function blockedReadiness(error: unknown): ReadinessReport | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const payload = error.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const readiness = (payload as { readiness?: unknown }).readiness;
  if (typeof readiness !== "object" || readiness === null) return undefined;
  return readiness as ReadinessReport;
}

/** True for the error a fetch throws when its AbortSignal fired. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function request<T>(path: string, init?: RequestInit, measure?: (value: T, bytes: number) => void): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    // An abort is the CALLER's own decision (a newer search replaced this
    // one, a dialog closed) — rethrow it untouched so it is never shown as
    // a network problem.
    if (isAbortError(error)) throw error;
    throw new ApiError("network error — is the brain server running?", 0);
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    let payload: unknown;
    try {
      payload = await res.json();
      if (payload && typeof payload === "object") {
        const rec = payload as Record<string, unknown>;
        if (typeof rec.error === "string") message = rec.error;
        else if (typeof rec.message === "string") message = rec.message;
      }
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new ApiError(message, res.status, payload);
  }
  if (measure) {
    const text = await res.text();
    const value = JSON.parse(text) as T;
    measure(value, text.length * 2);
    return value;
  }
  return (await res.json()) as T;
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const getHealth = (): Promise<HealthResponse> => request("/health");

export const getGpuSetup = (): Promise<GpuSetupReport> => request("/gpu/setup");
export const discoverGpu = (): Promise<GpuSetupReport> => request("/gpu/discover", jsonInit("POST", {}));
export const saveGpuDraft = (draft: GpuDraftUpdate): Promise<GpuSetupReport> => request("/gpu/draft", jsonInit("PUT", draft));
export const approveGpuProbe = (approval: GpuProbeApproval): Promise<GpuSetupReport> => request("/gpu/probe", jsonInit("POST", approval));
export const cancelGpuProbe = (): Promise<GpuSetupReport> => request("/gpu/cancel", jsonInit("POST", {}));

const settingsResource = new SerializedResource<ServerSettings>();
function publishSettings(settings: ServerSettings): void {
  window.dispatchEvent(new CustomEvent('brain-settings-updated', { detail: settings }));
}
export const getSettings = (): Promise<ServerSettings> => settingsResource.read(() => request("/settings"));

export const putSettings = (settings: ServerSettingsUpdate): Promise<ServerSettings> =>
  settingsResource.mutate(() => request("/settings", jsonInit("PUT", settings)), publishSettings);

/** Build dependent field updates after earlier edits finish, against the current server state. */
export const updateSettings = (build: (current: ServerSettings) => ServerSettingsUpdate): Promise<ServerSettings> =>
  settingsResource.mutate(async () => {
    const current = await request<ServerSettings>("/settings");
    return request("/settings", jsonInit("PUT", build(current)));
  }, publishSettings);

export const getModelOptions = (): Promise<ModelOptionsResponse> =>
  request("/model-options");

export const putModelsByRoute = (
  update: ModelsByRouteUpdate,
): Promise<ServerSettings> =>
  settingsResource.mutate(() => request("/settings/models-by-route", jsonInit("PUT", update)), publishSettings);

/*
 * Module-level caches so navigating between the landing page and a dashboard
 * renders the last known snapshot immediately; SSE refreshes it right after.
 */
let jobsCache: readonly JobSummary[] | null = null;
// Bound both retained snapshots and decoded wire-text weight. A huge active job
// can still render, but it cannot evict the browser by lingering in a hover cache.
const jobDetailCache = new BoundedCache<string, JobDetail>(6, 16 * 1024 * 1024, 5 * 60_000);
const detailWeights = new WeakMap<JobDetail, number>();
const jobRequests = new Map<string, Promise<JobDetail>>();
let prefetchCount = 0;

export function cachedJobs(): readonly JobSummary[] | null {
  return jobsCache;
}

export function cacheJobs(jobs: readonly JobSummary[]): void {
  jobsCache = jobs;
}

export function cachedJobDetail(jobId: string): JobDetail | undefined {
  return jobDetailCache.get(jobId);
}

export function cacheJobDetail(detail: JobDetail): void {
  const previous = jobDetailCache.get(detail.jobId);
  if (previous && previous.updatedAt > detail.updatedAt) return;
  const weight = detailWeights.get(detail);
  if (weight !== undefined) jobDetailCache.set(detail.jobId, detail, weight);
}

/** Warm the detail cache (job-card hover/focus) so opening a job is instant. */
export function prefetchJobDetail(jobId: string): void {
  if (jobDetailCache.get(jobId) || jobRequests.has(jobId) || prefetchCount >= 2) return;
  prefetchCount += 1;
  void getJob(jobId).catch(() => undefined).finally(() => { prefetchCount -= 1; });
}

export const getJobs = async (): Promise<readonly JobSummary[]> => {
  const jobs = await request<readonly JobSummary[]>("/jobs");
  jobsCache = jobs;
  return jobs;
};

export const submitJob = (
  topic: string,
  attachments: readonly string[] = [],
  capabilityOverrides: Readonly<Record<string, boolean>> = {},
): Promise<SubmitJobResponse> =>
  request(
    "/jobs",
    jsonInit("POST", {
      topic,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(Object.keys(capabilityOverrides).length > 0
        ? { capabilityOverrides }
        : {}),
    } satisfies SubmitJobRequest),
  );

export const getCapabilityOptions = (): Promise<CapabilityOptionsResponse> =>
  request("/capabilities");

/** Starts the one-click self-update; the server exits right after answering. */
export const postUpdateCheck = (): Promise<UpdateCheckResponse> =>
  request("/update-check", jsonInit("POST", {}));

export const postUpdateApp = (): Promise<UpdateAppResponse> =>
  request("/update", jsonInit("POST", {}));

export const getAttachmentRoots = (): Promise<ServerAttachmentRootsResponse> =>
  request("/attachments/roots");

export const browseServerFiles = (
  kind: AttachmentSelectionKind,
  root?: string,
  path?: string,
  signal?: AbortSignal,
): Promise<BrowseServerFilesResponse> => {
  const query = new URLSearchParams({ kind });
  if (root) query.set("root", root);
  if (path) query.set("path", path);
  return request(
    `/attachments/browse?${query.toString()}`,
    signal ? { signal } : undefined,
  );
};

/**
 * The signal matters here more than anywhere: aborting the fetch also ends
 * the server-side walk (the server ties its walk to the request), so a
 * replaced or abandoned search stops costing filesystem work at once.
 */
export const searchServerFiles = (
  kind: AttachmentSelectionKind,
  queryText: string,
  root?: string,
  path?: string,
  signal?: AbortSignal,
): Promise<SearchServerFilesResponse> => {
  const query = new URLSearchParams({ kind, q: queryText });
  if (root) query.set("root", root);
  if (path) query.set("path", path);
  return request(
    `/attachments/search?${query.toString()}`,
    signal ? { signal } : undefined,
  );
};

export const validateAttachments = (
  kind: AttachmentSelectionKind,
  paths: readonly string[],
): Promise<ValidateAttachmentsResponse> =>
  request(
    "/attachments/validate",
    jsonInit("POST", { kind, paths }),
  );

export const getJob = (jobId: string): Promise<JobDetail> => {
  const pending = jobRequests.get(jobId); if (pending) return pending;
  const result = request<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`, undefined, (detail, bytes) => detailWeights.set(detail, bytes)).then((detail) => {
    cacheJobDetail(detail); return detail;
  });
  jobRequests.set(jobId, result);
  void result.finally(() => { if (jobRequests.get(jobId) === result) jobRequests.delete(jobId); }).catch(() => undefined);
  return result;
};

export const cancelJob = (jobId: string): Promise<CancelJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });

/**
 * Stops the run and keeps it: the worker ends, the checkpoint stands, and
 * nothing automatic resumes it until resumePausedJob is called.
 */
export const pauseJob = (jobId: string): Promise<CancelJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST" });

/** Continues a paused run from its last checkpoint. */
export const resumePausedJob = (jobId: string): Promise<CancelJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/resume-paused`, { method: "POST" });

/** Claims a credit-blocked job for resume (manual blocks, or an early claim). */
export const resumeJob = (jobId: string): Promise<ResumeJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST" });

/** Resubmits an interrupted (orphaned) job from its last checkpoint. */
export const resumeInterruptedJob = (
  jobId: string,
): Promise<ResumeInterruptedJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/resume-interrupted`, {
    method: "POST",
  });

/** Retries a failed job from its last checkpoint (re-runs only the failed task). */
export const retryFailedJob = (
  jobId: string,
): Promise<ResumeInterruptedJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });

/** What WOULD be sent. Reading this sends nothing. */
export const previewDiagnostics = (jobId: string): Promise<DiagnosticPreview> =>
  request(`/jobs/${encodeURIComponent(jobId)}/diagnostics`);

/** Sends the report. Only ever called from an explicit user action. */
export const sendDiagnostics = (jobId: string): Promise<SendDiagnosticsResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/diagnostics`, { method: "POST" });

export const getReadiness = (): Promise<ReadinessReport> =>
  request("/readiness");

/** Re-runs environment checks (all, or the listed ones). */
export const recheckReadiness = (
  checks?: readonly ReadinessCheckId[],
): Promise<ReadinessReport> =>
  request(
    "/readiness/check",
    jsonInit("POST", checks !== undefined ? { checks } : {}),
  );

/** Asks the LLM advisor to (re)diagnose a failed check. */
export const diagnoseReadiness = (
  check: ReadinessCheckId,
): Promise<ReadinessReport> =>
  request("/readiness/diagnose", jsonInit("POST", { check }));

export const getToolUsage = (jobId: string): Promise<ToolUsageReport> =>
  request(`/jobs/${encodeURIComponent(jobId)}/tool-usage`);

/**
 * The recorded thinking behind one version of one chain step, addressed by
 * the opaque handle a review view carries. Fetched on demand when the brain
 * icon's window opens — thoughts are large, so they never ride the job
 * snapshots.
 */
export const getThoughts = (jobId: string, ref: string): Promise<ThoughtsResponse> =>
  request(
    `/jobs/${encodeURIComponent(jobId)}/thoughts?ref=${encodeURIComponent(ref)}`,
  );

export const trashJob = (jobId: string): Promise<TrashJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/trash`, { method: "POST" });

export const getTrashedJobs = (): Promise<readonly JobSummary[]> =>
  request("/jobs/trash");

export const answerGate = (jobId: string, body: GateAnswerRequest): Promise<JobDetail> =>
  request(`/jobs/${encodeURIComponent(jobId)}/gate`, jsonInit("POST", body));

/** Permanently pauses the pending gate's auto-approve countdown. */
export const holdGateAutoApprove = (jobId: string): Promise<JobDetail> =>
  request(`/jobs/${encodeURIComponent(jobId)}/gate-hold`, { method: "POST" });

/**
 * The confirm-panel gate's coverage view, from the run's panelEvidence
 * artifact. Answers 404 for runs pinned to bundles without it.
 */
export const getPanelEvidence = (jobId: string): Promise<PanelEvidenceView> =>
  request(`/jobs/${encodeURIComponent(jobId)}/panel-evidence`);

/** The optional confirm-needs gate's needs and weights, while it is pending. */
export const getNeedsGate = (jobId: string): Promise<NeedsGateView> =>
  request(`/jobs/${encodeURIComponent(jobId)}/needs`);

/** Answers the confirm-needs gate: approve, or edit with the edited embeddingInput. */
export const answerNeedsGate = (jobId: string, body: NeedsGateAnswer): Promise<JobDetail> =>
  request(`/jobs/${encodeURIComponent(jobId)}/gate`, jsonInit("POST", body));

/** Every panel composition param with the pinned bundle's default and the stored overrides. */
export const getPanelComposition = (): Promise<PanelCompositionView> =>
  request("/panel-composition");

/** Which text encoders this host can run for the panel composition. */
export const getEncoderReadiness = (): Promise<EncoderReadinessView> =>
  request("/readiness/encoders");

/** The tool availability table and the derived per-purpose priority orders. */
export const getAvailability = (): Promise<AvailabilityReport> =>
  request("/availability");

/**
 * Probes the named tools (or all when omitted) and answers with the updated
 * table. Synchronous up to 20 s; longer probes keep running on the server and
 * the table shows them as probing.
 */
export const probeAvailability = (
  tools?: readonly string[],
): Promise<AvailabilityReport> =>
  request(
    "/availability/probe",
    jsonInit("POST", tools !== undefined ? { tools } : {}),
  );

/**
 * The dashboard stream's "availability" announcements. The event is declared
 * beside ServerEvent rather than in its union, so the stream hook hands it to
 * these listeners (the "Tools and providers" view) instead of the batch
 * handler. Returns the unsubscribe function.
 */
const availabilityListeners = new Set<(report: AvailabilityReport) => void>();
export function onAvailability(listener: (report: AvailabilityReport) => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

function isAvailabilityEvent(value: unknown): value is AvailabilityServerEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { readonly type?: unknown; readonly availability?: unknown };
  return event.type === "availability" && typeof event.availability === "object" && event.availability !== null;
}

/**
 * Dismisses one panel seat mid-run. The server stops the worker and resumes the
 * rest of the run from its last checkpoint, so this takes a moment and the job
 * comes back as "queued".
 */
export const dismissMember = (jobId: string, memberId: string): Promise<JobDetail> =>
  request(
    `/jobs/${encodeURIComponent(jobId)}/dismiss-member`,
    jsonInit("POST", { memberId }),
  );

export const jobsStreamUrl = `${API_BASE}/stream`;
export const jobStreamUrl = (jobId: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/stream`;

/**
 * Where the captured record behind one model call lives, as markdown.
 *
 * A URL rather than a fetch helper on purpose: the activity row LINKS at it and
 * the browser's own download does the rest, so a whole prompt never passes
 * through this page's state, never lands in a React tree, and never sits in
 * memory beside a job it does not belong to. The server names the file.
 */
export const promptRecordUrl = (jobId: string, promptId: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/prompt/${encodeURIComponent(promptId)}`;

/**
 * One page of a stage's activity scrollback: the `limit` rows immediately
 * before the `before` row id, or the newest rows when `before` is absent.
 */
export const getStageActivity = (
  jobId: string,
  stageId: string,
  options: { readonly before?: string; readonly limit?: number } = {},
): Promise<StageActivityPage> => {
  const params = new URLSearchParams();
  if (options.before !== undefined) params.set("before", options.before);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return request(
    `/jobs/${encodeURIComponent(jobId)}/stages/${encodeURIComponent(stageId)}/activity${query}`,
  );
};

/**
 * The whole activity log of one stage as CSV. A URL, not a fetch helper: the
 * feed's download arrow LINKS at it and the browser's own download does the
 * rest — the server names the file.
 */
export const stageActivityCsvUrl = (jobId: string, stageId: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/stages/${encodeURIComponent(stageId)}/activity.csv`;

/**
 * The run's whole record — journal, thinking, event/search logs, final
 * outputs — as one zip, packaged to fit the attachment rules so it can be
 * re-attached to a new run. A URL, not a fetch helper: the job card's export
 * control LINKS at it, the browser downloads, and the server names the file.
 */
export const jobTraceUrl = (jobId: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/trace.zip`;

/**
 * The FULL text behind a thoughts handle, as a file. The popover previews
 * the journal's capped slice; this serves the untruncated trace (re-cut from
 * the task's thinking artifact). A URL for the same reason as above: the
 * brain icon and the popover's tail LINK at it, the browser downloads, and
 * the server names the file.
 */
export const thoughtsFileUrl = (jobId: string, ref: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/thoughts.txt?ref=${encodeURIComponent(ref)}`;

/**
 * One seat's tracked output changes as a markdown document: the first
 * version whole, then what each review round changed in the MAIN section.
 * A URL for the usual reason: the edit icon LINKS at it, the browser
 * downloads, the server names the file.
 */
export const outputChangesUrl = (jobId: string, memberId: string): string =>
  `${API_BASE}/jobs/${encodeURIComponent(jobId)}/members/${encodeURIComponent(memberId)}/output-changes.md`;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to a server event stream. Auto-reconnects with capped exponential
 * backoff and returns the connection state for the "reconnecting…" line.
 */
export function useServerEvents(url: string, onEvent: (ev: ServerEvent) => void, enabled = true): boolean {
  // Optimistic so the reconnect line never flashes during the initial connect.
  const [connected, setConnected] = useState(true);
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let disposed = false;
    let delivery: number | undefined;
    let pending: ServerEvent[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (delivery !== undefined) window.clearTimeout(delivery);
      delivery = undefined;
      const batch = compactEvents(pending); pending = []; pendingBytes = 0;
      if (!disposed) for (const event of batch) handlerRef.current(event);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(url);
      source.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        attempt = 0;
        let event: unknown;
        try {
          event = JSON.parse(msg.data);
        } catch {
          // malformed frame; ignore
          return;
        }
        if (isAvailabilityEvent(event)) {
          for (const listener of availabilityListeners) listener(event.availability);
          return;
        }
        if (!isServerEvent(event)) return;
        if (event.type === 'job' && event.job) detailWeights.set(event.job, msg.data.length * 2);
        pending.push(event); pendingBytes += msg.data.length * 2;
        // Cap latency and queued memory even when background timers are throttled.
        if (pending.length >= 64 || pendingBytes >= 2 * 1024 * 1024) flush();
        else if (delivery === undefined) delivery = window.setTimeout(flush, 50);
      };
      source.onerror = () => {
        flush();
        setConnected(false);
        source?.close();
        const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (timer !== undefined) window.clearTimeout(timer);
      if (delivery !== undefined) window.clearTimeout(delivery);
      pending = [];
    };
  }, [url, enabled]);

  return connected;
}
