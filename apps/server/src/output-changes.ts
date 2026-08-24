/**
 * The downloadable change document of one seat's MAIN output section: the
 * first version in full, then one section per review moment (step · round)
 * documenting exactly what that redevelopment changed — additions in bold,
 * removals struck through, both from the same word alignment the web's
 * Changes tab renders (protocol's diffInline).
 *
 * Markdown, because the content is prose with emphasis, and every viewer a
 * reader is likely to open a .md with renders bold and strikethrough. Marks
 * wrap line by line (a mark spanning a paragraph break does not render), and
 * the text itself is emitted verbatim — this document is for reading, not
 * for round-tripping.
 */
import {
  diffInline,
  hasInlineChanges,
  type InlineDiffSegment,
  type OutputSectionView,
  type OutputVersionView,
} from "@brainstorm-agentic/protocol";

/** Wraps every non-empty line of `text` in `mark`, leaving newlines outside. */
function markLines(text: string, mark: string): string {
  return text
    .split("\n")
    .map((line) => {
      const lead = /^\s*/.exec(line)![0];
      const trail = /\s*$/.exec(line)![0];
      const core = line.slice(lead.length, line.length - trail.length);
      return core.length === 0 ? line : `${lead}${mark}${core}${mark}${trail}`;
    })
    .join("\n");
}

function renderSegments(segments: readonly InlineDiffSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === "added") return markLines(segment.text, "**");
      if (segment.kind === "removed") return markLines(segment.text, "~~");
      return segment.text;
    })
    .join("");
}

/** One version's sections keyed by label, order preserved. */
function byLabel(
  sections: readonly OutputSectionView[],
): Map<string, string> {
  return new Map(sections.map((section) => [section.label, section.text]));
}

/**
 * The diff of one version against the one before it, section by section:
 * changed sections carry their inline diff, brand-new sections arrive whole
 * in bold, dropped sections stay whole and struck. Untouched sections are
 * omitted — the change is the document's subject, not the text around it.
 */
function versionBody(
  before: readonly OutputSectionView[],
  after: readonly OutputSectionView[],
): string {
  const previous = byLabel(before);
  const parts: string[] = [];
  for (const section of after) {
    const earlier = previous.get(section.label);
    if (earlier === section.text) continue;
    if (earlier === undefined) {
      parts.push(`### ${section.label} (new)\n\n${markLines(section.text, "**")}`);
      continue;
    }
    const segments = diffInline(earlier, section.text);
    if (!hasInlineChanges(segments)) continue;
    parts.push(`### ${section.label}\n\n${renderSegments(segments)}`);
  }
  const labels = new Set(after.map((section) => section.label));
  for (const section of before) {
    if (labels.has(section.label)) continue;
    parts.push(`### ${section.label} (removed)\n\n${markLines(section.text, "~~")}`);
  }
  return parts.length === 0
    ? "_No change to the main section in this round._"
    : parts.join("\n\n");
}

export function outputChangesMarkdown(input: {
  /** Seat name as the dashboard shows it ("Seat 3"). */
  readonly seat: string;
  /** "Department / Umbrella", when known. */
  readonly expertise?: string;
  readonly topic?: string;
  /** First pass first (step/round 0), then every revision in walk order. */
  readonly versions: readonly OutputVersionView[];
}): string {
  const lines: string[] = [
    `# ${input.seat} — final output, tracked changes`,
    "",
    ...(input.expertise !== undefined && input.expertise.length > 0
      ? [input.expertise, ""]
      : []),
    ...(input.topic !== undefined && input.topic.length > 0
      ? [`Topic: ${input.topic}`, ""]
      : []),
    "Every change the review made to the output's MAIN section, in the",
    "order it happened. **Bold** marks added words, ~~struck~~ marks removed",
    "words; each entry is compared against the version before it. The chain,",
    "the novelty claim, and the papers have their own records and are not",
    "tracked here.",
  ];
  const [first, ...revisions] = input.versions;
  if (first !== undefined) {
    lines.push("", "## First version — first pass");
    if (first.sections.length === 0) {
      lines.push("", "_The first pass recorded no main section._");
    }
    for (const section of first.sections) {
      lines.push("", `### ${section.label}`, "", section.text);
    }
  }
  let previous = first?.sections ?? [];
  for (const version of revisions) {
    lines.push(
      "",
      `## Step ${version.step} · round ${version.round}`,
      "",
      versionBody(previous, version.sections),
    );
    previous = version.sections;
  }
  return lines.join("\n") + "\n";
}
