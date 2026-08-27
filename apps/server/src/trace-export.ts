/**
 * The run-trace export: one job's whole record, repackaged as a small set of
 * meaningfully named files that fit the attachment rules (400 files, 25 MB
 * per file) — so a finished run can be re-attached to a NEW run and its board
 * can trace everything that happened.
 *
 * The `journal/` part is the checkpoint's content, byte for byte, dealt into
 * named pieces: the run's frame (identity, status, the original submission),
 * the setup stages, the first pass, one file per seat's whole review walk,
 * and the closing stages. The rest is record material the checkpoint never
 * held: the FULL thinking traces from the session's artifacts (the journal
 * carries only the capped per-step slices), the operational event log, the
 * verbatim search log, and the readable final outputs.
 *
 * Everything is a read-only copy — the session and job directories are never
 * touched — and every read is asynchronous, because this runs on the server's
 * event loop against possibly slow shared storage. Files are split into
 * `-partN` pieces before they reach the attachment picker's per-file cap, so
 * a trace of any size stays attachable whole.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TraceFile {
  /** Forward-slash relative path inside the trace. */
  readonly path: string;
  readonly data: string;
}

/** Stay well under the 25 MB per-file attachment cap. */
const SPLIT_BYTES = 20 * 1024 * 1024;

interface JournalEntryLike {
  readonly key?: unknown;
  readonly kind?: unknown;
  readonly value?: unknown;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Renders pretty-printed JSON entries as one array, split into parts near the
 * cap. Pretty-printed on purpose: the board reads these through
 * attachment-access, and a search hit should land on a meaningful line.
 */
function jsonArrayParts(
  path: string,
  entries: readonly unknown[],
  splitBytes: number,
): TraceFile[] {
  const rendered = entries.map((entry) => JSON.stringify(entry, null, 2));
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const text of rendered) {
    const bytes = Buffer.byteLength(text) + 2;
    if (current.length > 0 && currentBytes + bytes > splitBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(text);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  const stem = path.replace(/\.json$/, "");
  return chunks.map((chunk, index) => ({
    path: chunks.length === 1 ? path : `${stem}-part${index + 1}.json`,
    data: `[\n${chunk.join(",\n")}\n]\n`,
  }));
}

/** Splits a line-record file (jsonl) into parts near the cap. */
function lineParts(path: string, text: string, splitBytes: number): TraceFile[] {
  if (Buffer.byteLength(text) <= splitBytes) return [{ path, data: text }];
  const stem = path.replace(/\.jsonl$/, "");
  const files: TraceFile[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const line of text.split("\n")) {
    const bytes = Buffer.byteLength(line) + 1;
    if (current.length > 0 && currentBytes + bytes > splitBytes) {
      files.push({ path: `${stem}-part${files.length + 1}.jsonl`, data: current.join("\n") + "\n" });
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    files.push({ path: `${stem}-part${files.length + 1}.jsonl`, data: current.join("\n") + "\n" });
  }
  return files;
}

/** Splits markdown sections into parts near the cap. */
function markdownParts(
  path: string,
  sections: readonly string[],
  splitBytes: number,
): TraceFile[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const section of sections) {
    const bytes = Buffer.byteLength(section) + 1;
    if (current.length > 0 && currentBytes + bytes > splitBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(section);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  const stem = path.replace(/\.md$/, "");
  return chunks.map((chunk, index) => ({
    path: chunks.length === 1 ? path : `${stem}-part${index + 1}.md`,
    data: chunk.join("\n") + "\n",
  }));
}

/**
 * A pre-fold (format-1) state copy: a whole run state journaled by a fold
 * activity. Format-2 journals never carry these, so the filter is inert
 * there; on old runs the copies are nearly the whole checkpoint, all but the
 * last are strictly earlier versions of it, and the trace keeps that last
 * one under its own name instead of burying every copy in the stage files.
 */
function isStateCopy(entry: JournalEntryLike): boolean {
  const value = entry.value;
  return (
    entry.kind === "activity" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "ideas" in value &&
    "reviews" in value
  );
}

/** The trace file a journal entry belongs to, from its execution-path key. */
function journalBucket(key: string): string {
  const path = key.startsWith("brainstorm-root/") ? key.slice("brainstorm-root/".length) : key;
  const stage = path.split("/")[0] ?? "";
  if (stage === "first-pass") return "journal/02-first-pass.json";
  if (stage === "review-members") {
    const seat = /member\[(\d+)\]/.exec(path);
    // Seats are named as the dashboard names them: member[i] is seat i+1.
    return seat ? `journal/03-review-seat-${Number(seat[1]) + 1}.json` : "journal/03-review.json";
  }
  if (stage === "bridge-audit" || stage === "synthesize-proposal" || stage === "done") {
    return "journal/04-closing.json";
  }
  return "journal/01-setup.json";
}

/** The thinking artifacts' shape, as ThinkingArtifactAgentExecutor writes them. */
interface ThinkingRecord {
  readonly nodePath?: unknown;
  readonly segments?: unknown;
}

async function thinkingSections(
  sessionDir: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const indexText = await readIfExists(join(sessionDir, "artifacts", "index.json"));
  if (indexText === undefined) return new Map();
  let refs: readonly { id?: unknown; metadata?: { kind?: unknown; nodePath?: unknown } }[];
  try {
    const parsed = JSON.parse(indexText) as { refs?: unknown };
    refs = Array.isArray(parsed.refs) ? parsed.refs : [];
  } catch {
    return new Map();
  }
  const sections = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref?.metadata?.kind !== "thinking" || typeof ref.id !== "string") continue;
    const text = await readIfExists(join(sessionDir, "artifacts", ref.id));
    if (text === undefined) continue;
    let record: ThinkingRecord;
    try {
      record = JSON.parse(text) as ThinkingRecord;
    } catch {
      continue; // a torn artifact is not worth losing the export over
    }
    const nodePath = String(record.nodePath ?? ref.metadata.nodePath ?? ref.id);
    const seat = /member\[(\d+)\]/.exec(nodePath);
    const file = seat ? `thinking-seat-${Number(seat[1]) + 1}.md` : "thinking-run.md";
    const segments = Array.isArray(record.segments) ? record.segments : [];
    const prose = segments
      .map((segment) =>
        typeof segment === "string"
          ? segment
          : String((segment as { text?: unknown })?.text ?? ""),
      )
      .filter((piece) => piece.length > 0)
      .join("\n\n");
    if (prose.length === 0) continue;
    if (!sections.has(file)) sections.set(file, []);
    sections.get(file)!.push(`## ${nodePath}\n\n${prose}\n`);
  }
  return sections;
}

function readme(runId: string, status: string, workflow: string): string {
  return `# Run trace: ${runId}

This folder is the exported record of one full Brainstorm run, prepared for
re-submission as an attachment. Nothing here was rewritten or summarized.

- \`journal/\` — every recorded output of the run, in execution order, as the
  checkpoint journal stored it. \`00-run\` is the run's frame: its identity,
  status, and the original submission as it was handed to the pipeline.
  \`01-setup\` covers everything before the first pass (processing,
  classification, literature pool, taxonomy, panel seating);
  \`02-first-pass\` holds each seat's first output and chain;
  \`03-review-seat-N\` holds seat N's whole review walk (every comment, every
  judge decision, every revision patch, round by round); \`04-closing\` holds
  the integration audit and the final proposal. Keys are execution paths;
  \`member[i]\` is seat i+1.
- \`thinking-*.md\` — the captured thinking streams behind the tasks, as
  prose: one file per seat, plus one for the run-level tasks.
- \`events.jsonl\` — the operational event log (task starts and ends, tool
  calls, retries), one JSON record per line.
- \`searches.jsonl\` — every web search and fetch of the run, verbatim (when
  the run recorded one).
- \`final/\` — the readable end results: one JSON per seat plus the proposal
  (when the run reached them).
- \`raw_expertise.json\` / \`mul_expertise.json\` — the expertise tree and its
  seating scores. \`job.json\` — the job record (status, bundle version pin).

Status of the exported run: ${status}.
Workflow: ${workflow}.
`;
}

/**
 * Builds the trace, or answers undefined when the run has no checkpoint yet —
 * a job that has recorded nothing has nothing to export, and the route turns
 * that into its own honest status rather than an empty archive.
 */
export async function buildRunTrace(options: {
  readonly runId: string;
  readonly sessionDir: string;
  readonly jobDir: string;
  /** Test override; production keeps the 20 MB default. */
  readonly splitBytes?: number;
}): Promise<readonly TraceFile[] | undefined> {
  const splitBytes = options.splitBytes ?? SPLIT_BYTES;
  const checkpointText = await readIfExists(join(options.sessionDir, "checkpoint.json"));
  if (checkpointText === undefined) return undefined;
  let checkpoint: { journal?: unknown; status?: unknown; workflowId?: unknown; workflowVersion?: unknown };
  try {
    checkpoint = JSON.parse(checkpointText) as typeof checkpoint;
  } catch {
    return undefined; // a checkpoint mid-write; the next click gets it whole
  }
  const files: TraceFile[] = [];

  // The checkpoint minus its journal: the run's identity, its status, and the
  // ORIGINAL submission. With this file the trace holds everything the
  // checkpoint holds.
  const { journal: journalValue, ...envelope } = checkpoint;
  files.push({
    path: "journal/00-run.json",
    data: JSON.stringify(envelope, null, 2) + "\n",
  });

  const journal = (Array.isArray(journalValue) ? journalValue : []) as JournalEntryLike[];
  const stateCopies = journal.filter(isStateCopy);
  const buckets = new Map<string, JournalEntryLike[]>();
  for (const entry of journal) {
    if (isStateCopy(entry)) continue;
    const bucket = journalBucket(String(entry.key ?? ""));
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(entry);
  }
  for (const [name, entries] of buckets) {
    files.push(...jsonArrayParts(name, entries, splitBytes));
  }
  if (stateCopies.length > 0) {
    files.push(
      ...jsonArrayParts(
        "journal/state-final.json",
        [stateCopies[stateCopies.length - 1]],
        splitBytes,
      ),
    );
  }

  for (const [name, sections] of await thinkingSections(options.sessionDir)) {
    files.push(...markdownParts(name, sections, splitBytes));
  }

  const events = await readIfExists(join(options.jobDir, "events.jsonl"));
  if (events !== undefined) files.push(...lineParts("events.jsonl", events, splitBytes));
  const searches = await readIfExists(join(options.sessionDir, "searches.jsonl"));
  if (searches !== undefined) files.push(...lineParts("searches.jsonl", searches, splitBytes));

  for (const small of ["raw_expertise.json", "mul_expertise.json"]) {
    const text = await readIfExists(join(options.sessionDir, small));
    if (text !== undefined) files.push({ path: small, data: text });
  }
  const jobRecord = await readIfExists(join(options.jobDir, "job.json"));
  if (jobRecord !== undefined) files.push({ path: "job.json", data: jobRecord });

  try {
    for (const name of await readdir(join(options.sessionDir, "final"))) {
      const text = await readIfExists(join(options.sessionDir, "final", name));
      if (text !== undefined) files.push({ path: `final/${name}`, data: text });
    }
  } catch {
    // No final/ directory: the run has not produced readable outputs yet.
  }

  files.push({
    path: "README.md",
    data: readme(
      options.runId,
      String(checkpoint.status ?? "unknown"),
      `${String(checkpoint.workflowId ?? "?")} ${String(checkpoint.workflowVersion ?? "")}`.trim(),
    ),
  });
  return files;
}
