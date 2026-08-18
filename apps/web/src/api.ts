/**
 * Typed fetch helpers for every brain endpoint plus the SSE hook used by the
 * landing page and the dashboard. All shapes come from the protocol package.
 */
import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@brainstorm-agentic/protocol";
import type {
  AttachmentSelectionKind,
  BrowseServerFilesResponse,
  CancelJobResponse,
  CapabilityOptionsResponse,
  DiagnosticPreview,
  GateAnswerRequest,
  HealthResponse,
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
  SubmitJobRequest,
  SubmitJobResponse,
  ToolUsageReport,
  TrashJobResponse,
  UpdateAppResponse,
  UpdateCheckResponse,
  ValidateAttachmentsResponse,
} from "@brainstorm-agentic/protocol";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
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
  return (await res.json()) as T;
}

function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const getHealth = (): Promise<HealthResponse> => request("/health");

export const getSettings = (): Promise<ServerSettings> => request("/settings");

export const putSettings = (settings: ServerSettingsUpdate): Promise<ServerSettings> =>
  request("/settings", jsonInit("PUT", settings));

export const getModelOptions = (): Promise<ModelOptionsResponse> =>
  request("/model-options");

export const putModelsByRoute = (
  update: ModelsByRouteUpdate,
): Promise<ServerSettings> =>
  request("/settings/models-by-route", jsonInit("PUT", update));

/*
 * Module-level caches so navigating between the landing page and a dashboard
 * renders the last known snapshot immediately; SSE refreshes it right after.
 */
let jobsCache: readonly JobSummary[] | null = null;
const jobDetailCache = new Map<string, JobDetail>();

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
  jobDetailCache.set(detail.jobId, detail);
}

/** Warm the detail cache (job-card hover/focus) so opening a job is instant. */
export function prefetchJobDetail(jobId: string): void {
  if (jobDetailCache.has(jobId)) return;
  void getJob(jobId).catch(() => undefined);
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
): Promise<BrowseServerFilesResponse> => {
  const query = new URLSearchParams({ kind });
  if (root) query.set("root", root);
  if (path) query.set("path", path);
  return request(`/attachments/browse?${query.toString()}`);
};

export const searchServerFiles = (
  kind: AttachmentSelectionKind,
  queryText: string,
  root?: string,
  path?: string,
): Promise<SearchServerFilesResponse> => {
  const query = new URLSearchParams({ kind, q: queryText });
  if (root) query.set("root", root);
  if (path) query.set("path", path);
  return request(`/attachments/search?${query.toString()}`);
};

export const validateAttachments = (
  kind: AttachmentSelectionKind,
  paths: readonly string[],
): Promise<ValidateAttachmentsResponse> =>
  request(
    "/attachments/validate",
    jsonInit("POST", { kind, paths }),
  );

export const getJob = async (jobId: string): Promise<JobDetail> => {
  const detail = await request<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`);
  jobDetailCache.set(detail.jobId, detail);
  return detail;
};

export const cancelJob = (jobId: string): Promise<CancelJobResponse> =>
  request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });

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

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to a server event stream. Auto-reconnects with capped exponential
 * backoff and returns the connection state for the "reconnecting…" line.
 */
export function useServerEvents(url: string, onEvent: (ev: ServerEvent) => void): boolean {
  // Optimistic so the reconnect line never flashes during the initial connect.
  const [connected, setConnected] = useState(true);
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource(url);
      source.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        attempt = 0;
        try {
          handlerRef.current(JSON.parse(msg.data) as ServerEvent);
        } catch {
          // malformed frame; ignore
        }
      };
      source.onerror = () => {
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
    };
  }, [url]);

  return connected;
}
