/**
 * The reader's side of a captured PROMPT: what one `llm_call` row addresses.
 *
 * The worker appends one JSON record per hand-off to `prompts.jsonl` in the
 * run's job directory, exactly as it appends live text. Nothing here is
 * journaled, checkpointed or aggregated — a record is fetched only when a reader
 * clicks the row that names it, and is rendered as markdown so the file that
 * lands in their downloads is readable without this app.
 *
 * WHY the whole file is scanned per request rather than indexed: a run makes
 * tens to low hundreds of hand-offs, a reader opens one at a time, and an index
 * would have to be invalidated on every append by a process this one does not
 * own. The scan skips the JSON parse for any line that cannot contain the id.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PromptRecord } from "@brainstorm-agentic/core";
import type { JobDetail, StageActivityEntry } from "@brainstorm-agentic/protocol";

import { agentIdentity } from "./stage-mapper.js";

/** The worker's transport file, beside `live-text.jsonl` and `events.jsonl`. */
const PROMPT_FILE = "prompts.jsonl";

/**
 * Who made the call and where, on exactly the terms the activity feed uses.
 *
 * Same three answers as an activity row's what/who/where columns, and derived
 * through the same functions, so a downloaded file and the row it came from can
 * never name different agents.
 */
export interface PromptIdentity {
  readonly role?: string;
  readonly actor?: string;
  readonly where?: {
    readonly seat?: string;
    readonly step?: number;
    readonly round?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parsed line, accepted only when it carries every field the render needs. */
function asPromptRecord(value: unknown): PromptRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
  if (typeof value.taskId !== "string") return undefined;
  if (typeof value.kind !== "string") return undefined;
  if (typeof value.attempt !== "number") return undefined;
  if (typeof value.provider !== "string") return undefined;
  if (typeof value.complete !== "boolean") return undefined;
  if (!Array.isArray(value.sections)) return undefined;
  for (const section of value.sections) {
    if (!isRecord(section)) return undefined;
    if (typeof section.title !== "string" || typeof section.body !== "string") {
      return undefined;
    }
  }
  return value as unknown as PromptRecord;
}

/**
 * The record one row addresses, or undefined when the run never wrote it.
 *
 * Three facts about the file shape the loop. It may not exist at all (capture
 * off, or a worker launched without an events file), which is a 404 and not a
 * fault. It is APPEND-ONLY ACROSS RESUMES, so a resumed run's file carries
 * records from several worker processes — ids stay unique, and the LAST
 * occurrence wins if one ever repeats. And the writer flushes on a timer, so the
 * final line may be half-written while the run is live; a line that does not
 * parse is skipped rather than failing the request.
 */
export function readPromptRecord(
  jobDir: string,
  promptId: string,
): PromptRecord | undefined {
  const file = join(jobDir, PROMPT_FILE);
  if (!existsSync(file)) return undefined;
  let found: PromptRecord | undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    // Whole prompts are big; the substring test costs a fraction of the parse
    // and rejects every line that is not the one being asked for.
    if (line.length === 0 || !line.includes(promptId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asPromptRecord(parsed);
    if (record?.id === promptId) found = record;
  }
  return found;
}

/**
 * The role, seat and place of the agent that made the call.
 *
 * The activity row is preferred when the feed still holds it, because that row
 * IS what the reader clicked and its annotation already accounts for the edit
 * round a step is on. The feed is capped, though, so an older call's row may
 * have been evicted; then the same answers are derived from the task's own path
 * and kind through `agentIdentity`, which is where the row's came from too.
 */
export function promptIdentity(
  record: PromptRecord,
  detail: JobDetail,
): PromptIdentity {
  const row = activityRow(detail, record.id);
  if (row !== undefined) {
    return {
      ...(row.role !== undefined ? { role: row.role } : {}),
      ...(row.actor !== undefined ? { actor: row.actor } : {}),
      ...(row.where !== undefined ? { where: row.where } : {}),
    };
  }
  const panel =
    detail.stages.find(
      (stage): stage is Extract<JobDetail["stages"][number], { id: "select-panel" }> =>
        stage.id === "select-panel",
    )?.panel ?? [];
  // A task id is `${runId}:${nodePath}`, and every who/where answer is read out
  // of the node path — the same string the event log carries as `path`.
  const separator = record.taskId.indexOf(":");
  const path = separator === -1 ? record.taskId : record.taskId.slice(separator + 1);
  const { actorId: _actorId, seatId: _seatId, ...shown } = agentIdentity(
    path,
    record.kind,
    panel,
  );
  return shown;
}

function activityRow(
  detail: JobDetail,
  promptId: string,
): StageActivityEntry | undefined {
  for (const stage of detail.stages) {
    for (const entry of stage.activity ?? []) {
      if (entry.promptId === promptId) return entry;
    }
  }
  return undefined;
}

/**
 * The clock the activity row shows, formatted by the same call the feed makes
 * (apps/web/src/components/common.tsx). A reader matching a downloaded file
 * back to the row they clicked compares these two strings.
 */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/**
 * The name the file lands under: role, timestamp, id. The id is what makes it
 * unique — one agent can hand off twice in the same second — and the role and
 * time are what make a folder of them sortable and legible.
 */
export function promptFilename(
  record: PromptRecord,
  identity: PromptIdentity,
): string {
  const when = new Date(record.at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  // Local time, matching the clock in the header rather than UTC: the two
  // stamps in one file disagreeing by an hour reads as a bug.
  const stamp =
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const id = record.id.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "prompt";
  return `${slug(identity.role ?? record.kind)}-${stamp}-${id}.md`;
}

/** Titles whose body is machine material even when it is not parseable JSON. */
const FENCED_TITLE = /schema|tool|capability plan|execution settings/i;

/**
 * The fence a section's body needs, or undefined when it is prose.
 *
 * Decided from the BODY first: the executors pretty-print every JSON section
 * with a two-space indent, and a "Message N" body is JSON exactly when that
 * message carried tool_use or tool_result blocks — a fact no title states. The
 * title is the fallback for machine material that failed to parse, which is
 * worth showing fenced rather than reflowed as prose.
 */
function fenceLanguage(title: string, body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not JSON after all: fall through to the title rule.
    }
  }
  return FENCED_TITLE.test(title) ? "" : undefined;
}

/**
 * A fence long enough to contain the body. A system prompt or a tool
 * description may itself contain a ``` run, and a three-backtick fence around
 * it would close early and spill the rest of the record into the page as
 * markdown — which is exactly the "nothing elided" rule being broken by the
 * renderer rather than by the capture.
 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * One hand-off as a markdown file: a header saying who called and how complete
 * this is, then every section in order, verbatim.
 */
export function renderPromptMarkdown(
  record: PromptRecord,
  identity: PromptIdentity,
): string {
  const lines: string[] = [];
  const role = identity.role ?? record.kind;
  lines.push(`# Prompt · ${role} · ${clock(record.at)}`, "");

  const place: string[] = [];
  if (identity.where?.seat !== undefined) place.push(identity.where.seat);
  if (identity.where?.step !== undefined) place.push(`step ${identity.where.step}`);
  if (identity.where?.round !== undefined) place.push(`round ${identity.where.round}`);

  lines.push(`- **Time** — ${clock(record.at)} (${new Date(record.at).toISOString()})`);
  lines.push(`- **Role** — ${role}`);
  if (identity.actor !== undefined) lines.push(`- **Seat** — ${identity.actor}`);
  if (place.length > 0) lines.push(`- **Place** — ${place.join(" · ")}`);
  lines.push(`- **Provider** — ${record.provider}`);
  if (record.model !== undefined) lines.push(`- **Model** — ${record.model}`);
  if (record.logicalRoute !== undefined) {
    lines.push(`- **Route** — ${record.logicalRoute}`);
  }
  lines.push(`- **Attempt** — ${record.attempt}`);
  if (record.turn !== undefined) lines.push(`- **Turn** — ${record.turn}`);
  if (record.agentId !== undefined) lines.push(`- **Agent** — ${record.agentId}`);
  lines.push(`- **Task** — ${record.taskId}`);
  lines.push("");

  // Said in one plain sentence, never implied by the sections themselves: on the
  // agent-SDK paths the SDK composes the final request after we hand over, and a
  // reader who takes this file for the whole request would draw wrong
  // conclusions from what is missing.
  lines.push(
    record.complete
      ? "This is every byte the model received: the sections below are the whole request."
      : "This is only our half of the request. The " +
          `${record.provider} SDK composes the final request after we hand over, ` +
          "adding its own system prompt, built-in tools and harness scaffolding " +
          "that we never see.",
    "",
  );

  for (const section of record.sections) {
    lines.push(`## ${section.title}`, "");
    const language = fenceLanguage(section.title, section.body);
    if (language === undefined) {
      lines.push(section.body, "");
    } else {
      const fence = fenceFor(section.body);
      lines.push(`${fence}${language}`, section.body, fence, "");
    }
  }
  return lines.join("\n");
}
