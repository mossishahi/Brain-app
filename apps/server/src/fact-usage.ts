import { factIdsIn, factReportHash, type JournalEntry, type RunEvent } from "@brainstorm-agentic/core";
import type { FactUsageView, PanelMemberView } from "@brainstorm-agentic/protocol";

export interface FactUsageContext {
  readonly panel?: readonly PanelMemberView[];
  readonly journal?: readonly JournalEntry[];
  readonly events?: readonly RunEvent[];
  readonly artifacts?: readonly {
    readonly ref: { readonly metadata?: { readonly nodeId?: string; readonly schema?: string; readonly path?: string; readonly kind?: string } };
    readonly value: unknown;
  }[];
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const atTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nodeRoles: Readonly<Record<string, string>> = {
  "develop-idea": "brain", "redevelop-idea": "redeveloper", "game-redevelop-idea": "game-redeveloper",
  "comment-step": "commentor", "comment-step-bridge": "interdisciplinary-commentor",
  "game-comment-step": "game-commentor", "game-comment-step-bridge": "game-interdisciplinary-commentor",
  "judge-step": "judge", "chair-step": "committee-chair", "bridge-audit": "integrator",
  "synthesize-proposal": "chair", "process-input": "processor", "classify-input": "classifier",
  "build-pool": "pool-builder", "place-fields": "placer", "annotate-code": "code-annotator",
};
type Actor = Omit<FactUsageView, "kind" | "purpose" | "approved">;
interface Report { actor: Actor; hash: string; justification: string; round?: number }
const thinkerRole = (role: string): boolean => ["brain", "redeveloper", "game-redeveloper"].includes(role);

function citationContext(text: string, id: string): string {
  const paragraph = text.split(/\n\s*\n/).find((part) => factIdsIn(part).includes(id)) ?? text;
  if (paragraph.length <= 600) return paragraph;
  const citation = [...paragraph.matchAll(/\[[^\]]+\]/g)].find((match) => factIdsIn(match[0]).includes(id));
  const start = Math.max(0, (citation?.index ?? 0) - 200);
  const end = Math.min(paragraph.length, start + 600);
  return `${start > 0 ? "…" : ""}${paragraph.slice(start, end)}${end < paragraph.length ? "…" : ""}`;
}

/** Only actual output text counts as a citation; input bindings and search
 * responses are deliberately never traversed. Keep the cited passage verbatim. */
function citations(value: unknown, step?: number): { id: string; step?: number; purpose: string }[] {
  const groups = new Map<string, { id: string; step?: number; texts: Set<string> }>();
  const visit = (raw: unknown, position?: number): void => {
    if (typeof raw === "string") {
      for (const id of factIdsIn(raw)) {
        const key = `${id}:${position ?? ""}`;
        const group = groups.get(key) ?? { id, ...(position !== undefined ? { step: position } : {}), texts: new Set<string>() };
        group.texts.add(citationContext(raw, id)); groups.set(key, group);
      }
    } else if (Array.isArray(raw)) raw.forEach((child) => visit(child, position));
    else if (object(raw)) {
      const ownStep = positive(raw.index) ? raw.index : positive(raw.step) ? raw.step : position;
      for (const [key, child] of Object.entries(raw)) {
        if ((key === "cot" || key === "steps") && Array.isArray(child)) {
          child.forEach((part, index) => visit(part, object(part) && positive(part.index) ? part.index : index + 1));
        } else visit(child, ownStep);
      }
    }
  };
  visit(value, step);
  return [...groups.values()].map(({ texts, ...entry }) => {
    const purpose = [...texts].join("\n\n");
    return { ...entry, purpose: purpose.length <= 1200 ? purpose : `${purpose.slice(0, 1200)}…` };
  });
}

/** Durable shared facts and explicit agent outputs provide human attribution.
 * Search matches are discovery, not use. Private table files are never read. */
export function factUsageViews(records: readonly Record<string, unknown>[], shared: ReadonlyMap<string, Record<string, unknown>>, context: FactUsageContext): ReadonlyMap<string, readonly FactUsageView[]> {
  const panel = context.panel ?? [];
  const labels = new Map(panel.map((member, index) => [member.id, `Seat ${index + 1} · ${[member.department, member.umbrella].filter(Boolean).join(" / ")}`]));
  const label = (actor: Actor): Actor => ({ ...actor,
    ...(labels.has(actor.agentId) ? { agentLabel: labels.get(actor.agentId)! } : {}),
    ...(actor.seatId !== undefined && labels.has(actor.seatId) ? { seatLabel: labels.get(actor.seatId)! } : {}),
  });
  const requester = (raw: unknown): Actor | undefined => {
    if (!object(raw) || !nonempty(raw.agent)) return undefined;
    return label({ agentId: raw.agent, role: nonempty(raw.role) ? raw.role : "unknown",
      ...(nonempty(raw.taskId) ? { taskId: raw.taskId } : {}), ...(nonempty(raw.seat) ? { seatId: raw.seat } : {}),
      ...(positive(raw.step) ? { step: raw.step } : {}),
    });
  };
  const requesters = new Map<string, Actor>();
  for (const entry of shared.values()) for (const raw of Array.isArray(entry.requesters) ? entry.requesters : []) {
    const actor = requester(raw); if (actor?.taskId) requesters.set(actor.taskId, actor);
  }
  for (const record of records) {
    const actor = requester(record.requester); if (actor?.taskId) requesters.set(actor.taskId, actor);
  }
  const eventRoles = new Map<string, string>();
  const times = new Map<string, number>();
  for (const event of context.events ?? []) {
    if (event.type !== "agent:started" && event.type !== "agent:completed") continue;
    eventRoles.set(event.taskId, event.taskKind.replace(/^brainstorm\./, ""));
    if (atTime(event.at)) times.set(event.taskId, event.at);
  }
  const nodeOf = (path: string): string => (path.split("/").at(-1) ?? "").replace(/::result$/, "").replace(/-execute$/, "");
  const indexOf = (path: string, name: string): number | undefined => {
    const match = new RegExp(`(?:^|/)${name}\\[(\\d+)\\]`).exec(path);
    return match ? Number(match[1]) : undefined;
  };
  const actorFor = (path: string, taskId?: string): Actor => {
    const recorded = taskId === undefined ? undefined : requesters.get(taskId);
    const member = indexOf(path, "member");
    const critic = indexOf(path, "commentor");
    const seat = member === undefined ? undefined : panel[member];
    const role = (taskId === undefined ? undefined : eventRoles.get(taskId)) ?? nodeRoles[nodeOf(path)] ?? (nodeOf(path) || "unknown");
    const author = critic !== undefined ? (seat === undefined ? undefined : panel.filter((entry) => entry.id !== seat.id)[critic]) : thinkerRole(role) ? seat : undefined;
    const step = indexOf(path, "cotStep");
    return label({ agentId: author?.id ?? role, role,
      ...(seat ? { seatId: seat.id } : {}), ...(step !== undefined ? { step: step + 1 } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskId !== undefined && times.has(taskId) ? { at: times.get(taskId)! } : {}),
      ...recorded,
    });
  };
  const uses = new Map<string, FactUsageView[]>();
  const keys = new Map<string, Set<string>>();
  const add = (id: unknown, use: FactUsageView): void => {
    if (typeof id !== "string" || !shared.has(id)) return;
    const key = JSON.stringify([use.kind, use.agentId, use.role, use.seatId, use.step, use.taskId, use.purpose, use.approved]);
    const seen = keys.get(id) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key); keys.set(id, seen);
    const rows = uses.get(id) ?? []; rows.push(use); uses.set(id, rows);
  };
  for (const record of records) {
    if (record.type !== "submission") continue;
    const actor = requester(record.requester);
    if (!actor) continue;
    const submission = object(record.submission) ? record.submission : {};
    const use: FactUsageView = { ...actor, kind: "submitted",
      ...(actor.step === undefined && positive(submission.step) ? { step: submission.step } : {}),
      ...(nonempty(submission.purpose) ? { purpose: submission.purpose } : {}), ...(atTime(record.at) ? { at: record.at } : {}),
    };
    add(record.badge, use); add(record.recorded, use);
  }
  const reports: Report[] = [];
  const journalAuthors = new Set<string>();
  for (const entry of context.journal ?? []) {
    if (entry.kind !== "agent" || !object(entry.value) || entry.value.status !== "ok") continue;
    const taskId = nonempty(entry.value.taskId) ? entry.value.taskId : undefined;
    const actor = actorFor(entry.key, taskId);
    journalAuthors.add(`${nodeOf(entry.key)}:${actor.agentId}`);
    for (const cite of citations(entry.value.output, actor.step)) add(cite.id, { ...actor, kind: "cited", ...(cite.step !== undefined ? { step: cite.step } : {}), purpose: cite.purpose });
    const output = entry.value.output;
    if (object(output) && typeof output.q === "number" && Number.isFinite(output.q) && typeof output.justification === "string") {
      reports.push({ actor, hash: factReportHash({ q: output.q, justification: output.justification }), justification: output.justification,
        ...(indexOf(entry.key, "iter") !== undefined ? { round: indexOf(entry.key, "iter") } : {}),
      });
    }
  }
  // Artifact-only older runs still expose citations. When journal outputs are
  // available, prefer those exact historical messages over merged state copies.
  for (const artifact of context.artifacts ?? []) {
    const meta = artifact.ref.metadata;
    if (meta?.kind === "thinking" || !meta?.nodeId || !meta.path || meta.schema === "gameSettlement") continue;
    // The runtime also persists the merged idea after applying a repair. Its
    // unchanged passages remain the original author's work; only the repair's
    // own patch/redevelopment artifact establishes newly authored citations.
    if (["redevelop-idea", "game-redevelop-idea"].includes(meta.nodeId) && ["brainIdea", "brainIdeaParts"].includes(meta.schema ?? "")) continue;
    const seat = panel.find((member) => ["ideas", "reviews"].some((root) => meta.path === `${root}.${member.id}` || meta.path!.startsWith(`${root}.${member.id}.`)));
    const critic = panel.find((member) => meta.path!.endsWith(`.gameCritiques.${member.id}`) || meta.path!.endsWith(`.comments.${member.id}`));
    const role = nodeRoles[meta.nodeId] ?? meta.nodeId;
    const actor = label({ agentId: critic?.id ?? (thinkerRole(role) ? seat?.id : undefined) ?? role, role, ...(seat ? { seatId: seat.id } : {}) });
    if (journalAuthors.has(`${meta.nodeId}:${actor.agentId}`)) continue;
    for (const cite of citations(artifact.value)) add(cite.id, { ...actor, kind: "cited", ...(cite.step !== undefined ? { step: cite.step } : {}), purpose: cite.purpose });
  }
  for (const record of records) {
    if (record.type !== "approval" || !object(record.approval)) continue;
    const receipt = record.approval;
    if (!nonempty(receipt.criticId) || !nonempty(receipt.requesterTaskId) || typeof receipt.approved !== "boolean") continue;
    const chair = actorFor(receipt.requesterTaskId, receipt.requesterTaskId);
    const report = reports.find((candidate) => candidate.actor.agentId === receipt.criticId && candidate.hash === receipt.reportHash &&
      (chair.seatId === undefined || candidate.actor.seatId === chair.seatId) && (chair.step === undefined || candidate.actor.step === chair.step) &&
      (indexOf(receipt.requesterTaskId as string, "iter") === undefined || candidate.round === indexOf(receipt.requesterTaskId as string, "iter")));
    const use: FactUsageView = { ...label({ agentId: receipt.criticId, role: report?.actor.role ?? "critic",
      ...(chair.seatId !== undefined ? { seatId: chair.seatId } : {}), ...(chair.step !== undefined ? { step: chair.step } : {}), taskId: receipt.requesterTaskId }),
      kind: "approval", approved: receipt.approved, ...(report ? { purpose: citationContext(report.justification, String(receipt.citedBadgeId)) } : {}), ...(atTime(record.at) ? { at: record.at } : {}),
    };
    add(receipt.citedBadgeId, use); add(receipt.targetBadgeId, use);
  }
  for (const [id, entry] of shared) for (const raw of Array.isArray(entry.requesters) ? entry.requesters : []) {
    const actor = requester(raw);
    if (!actor || uses.get(id)?.some((use) => use.agentId === actor.agentId && use.role === actor.role && use.taskId === actor.taskId)) continue;
    add(id, { ...actor, kind: "recorded" });
  }
  return uses;
}
