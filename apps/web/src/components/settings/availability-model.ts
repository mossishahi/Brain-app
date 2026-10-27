/**
 * Pure helpers of the "Tools and providers" view: the state → icon mapping,
 * "checked <relative time>" labels, the probe-log text a copy button writes,
 * the per-purpose order chips and the compact strip's summary. No DOM, no
 * React: `node --test` runs these through tsconfig.test.json.
 */
import type {
  PurposeOrder,
  PurposeOrderEntry,
  ToolAvailability,
  ToolProbeLogLine,
  ToolPurpose,
  ToolState,
} from "@brainstorm-agentic/protocol";

/** What the state icon draws and in which colour. */
export type StateIconKind = "check" | "cross" | "dash";
export type StateIconTone = "ok" | "warn" | "bad" | "muted";
export interface StateIcon {
  readonly kind: StateIconKind;
  readonly tone: StateIconTone;
  /** The state as a tooltip word. */
  readonly label: string;
}

/** The wording of each state where the UI shows it as text. */
export const STATE_WORDS: Readonly<Record<ToolState, string>> = {
  available: "available",
  degraded: "degraded",
  unreachable: "unreachable",
  blocked: "blocked",
  "needs-key": "needs key",
  disabled: "disabled",
  unchecked: "not checked yet",
};

/**
 * Green check for available, amber check for degraded, grey dash for
 * unchecked/disabled, red cross for every other state.
 */
export function stateIcon(state: ToolState): StateIcon {
  switch (state) {
    case "available":
      return { kind: "check", tone: "ok", label: STATE_WORDS.available };
    case "degraded":
      return { kind: "check", tone: "warn", label: STATE_WORDS.degraded };
    case "unchecked":
    case "disabled":
      return { kind: "dash", tone: "muted", label: STATE_WORDS[state] };
    default:
      return { kind: "cross", tone: "bad", label: STATE_WORDS[state] };
  }
}

/** "just now", "3 min ago", "2 h ago", "5 d ago"; never negative. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** "checked <relative time>", or "never" when the tool was not probed yet. */
export function checkedLabel(checkedAt: number | undefined, now: number): string {
  if (checkedAt === undefined) return "never";
  return `checked ${relativeTime(checkedAt, now)}`;
}

/** Local wall-clock HH:MM:SS of a timestamp. */
export function clockTime(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** One probe log line as the copy button writes it: "HH:MM:SS level text". */
export function formatLogLine(line: ToolProbeLogLine, clock: (at: number) => string = clockTime): string {
  return `${clock(line.at)} ${line.level} ${line.text}`;
}

/** The whole probe log as plain text, one line per entry. */
export function formatLog(log: readonly ToolProbeLogLine[], clock: (at: number) => string = clockTime): string {
  return log.map((line) => formatLogLine(line, clock)).join("\n");
}

/** "<latency> ms" or an empty string when the probe recorded no latency. */
export function latencyLabel(latencyMs: number | undefined): string {
  if (latencyMs === undefined || !Number.isFinite(latencyMs)) return "";
  return `${Math.round(latencyMs)} ms`;
}

export interface OrderChip {
  readonly id: string;
  readonly action: PurposeOrderEntry["action"];
  readonly reason?: string;
}

/**
 * The effective order as chips, in effective order (kept plain, moved amber),
 * followed by the dropped tools (struck through) in the order the entries
 * list them. A tool in the effective list without an entry counts as kept.
 */
export function orderChips(order: PurposeOrder): OrderChip[] {
  const byId = new Map(order.entries.map((entry) => [entry.id, entry] as const));
  const chips: OrderChip[] = order.effective.map((id) => {
    const entry = byId.get(id);
    const action = entry !== undefined && entry.action !== "dropped" ? entry.action : "kept";
    return entry?.reason !== undefined ? { id, action, reason: entry.reason } : { id, action };
  });
  for (const entry of order.entries) {
    if (entry.action !== "dropped" || order.effective.includes(entry.id)) continue;
    chips.push(entry.reason !== undefined ? { id: entry.id, action: "dropped", reason: entry.reason } : { id: entry.id, action: "dropped" });
  }
  return chips;
}

/** The chip's hover text: the action word plus the recorded reason. */
export function chipTitle(chip: OrderChip): string {
  const word = chip.action === "moved" ? "moved behind the available tools" : chip.action;
  return chip.reason !== undefined && chip.reason !== "" ? `${word}: ${chip.reason}` : word;
}

export const PURPOSE_LABELS: Readonly<Record<ToolPurpose, string>> = {
  web: "Web",
  news: "News",
  "paper-lookup": "Paper lookup",
  "paper-topic": "Paper topic search",
  "paper-details": "Paper details",
  "citation-hop": "Citation hop",
  embedding: "Embedding",
};

export function purposeLabel(purpose: ToolPurpose | string): string {
  return (PURPOSE_LABELS as Readonly<Record<string, string>>)[purpose] ?? purpose;
}

/** Tools and their children (SearXNG engines) as one flat list. */
export function flattenTools(tools: readonly ToolAvailability[]): ToolAvailability[] {
  const out: ToolAvailability[] = [];
  for (const tool of tools) {
    out.push(tool);
    if (tool.children) out.push(...flattenTools(tool.children));
  }
  return out;
}

/** The label of a tool id (children included); the id itself when unknown. */
export function toolLabel(id: string, tools: readonly ToolAvailability[]): string {
  return flattenTools(tools).find((tool) => tool.id === id)?.label ?? id;
}

export interface AvailabilitySummary {
  /** Top-level tools in state available. */
  readonly available: number;
  /** Top-level tools that are not disabled. */
  readonly total: number;
  /** The worst tone across top-level tools; what the compact strip's icon shows. */
  readonly tone: StateIconTone;
  /** Whether any tool (children included) is being probed by the server. */
  readonly probing: boolean;
}

/** bad if any tool is unreachable/blocked/needs-key, warn if any is degraded, ok when every enabled tool answered, muted otherwise. */
export function summarizeAvailability(tools: readonly ToolAvailability[]): AvailabilitySummary {
  const enabled = tools.filter((tool) => tool.state !== "disabled");
  const tones = enabled.map((tool) => stateIcon(tool.state).tone);
  const available = enabled.filter((tool) => tool.state === "available").length;
  const probing = flattenTools(tools).some((tool) => tool.probing === true);
  let tone: StateIconTone = "muted";
  if (tones.includes("bad")) tone = "bad";
  else if (tones.includes("warn")) tone = "warn";
  else if (enabled.length > 0 && tones.every((candidate) => candidate === "ok")) tone = "ok";
  return { available, total: enabled.length, tone, probing };
}
