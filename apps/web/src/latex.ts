/**
 * Client-side LaTeX export of pipeline outputs.
 *
 * Every generated document is styled by the repo's shared style file
 * (app/latex_style.sty, the NeurIPS 2026 base): the style text is embedded
 * into the .tex through a filecontents* block, so ONE downloaded file
 * compiles anywhere with the exact style version this build shipped — no
 * separate style download, no drift between a document and its style.
 *
 * The renderer is pure and takes the style text as an argument (the bundled
 * copy lives in latex-style.ts), so it can also run outside the browser for
 * validation. Only type imports are allowed here.
 */
import type {
  AssessFeasibilityOutputView,
  BrainIdeaView,
  CritiqueOutputView,
  EvidenceView,
  ExplainOutputView,
  IdeaOutputView,
  InterpretOutputView,
  PaperView,
  ResolveOutputView,
  SolutionOutputView,
  SurveyOutputView,
  VerifyOutputView,
} from "@brainstorm-agentic/protocol";

/* --------------------------------------------------------------- escaping */

/** LaTeX special characters, escaped one by one outside math. */
const CHAR_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  "#": "\\#",
  "_": "\\_",
  $: "\\$",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Common typographic and scientific unicode the models write in prose,
 * mapped to LaTeX so pdfLaTeX compiles it. Applied outside math only; a
 * character not listed here passes through (UTF-8 input handles most
 * accented text).
 */
const UNICODE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\u2014": "---",
  "\u2013": "--",
  "\u2018": "`",
  "\u2019": "'",
  "\u201c": "``",
  "\u201d": "''",
  "\u2026": "\\ldots{}",
  "\u00a0": "~",
  "\u00d7": "$\\times$",
  "\u00b1": "$\\pm$",
  "\u2248": "$\\approx$",
  "\u2260": "$\\neq$",
  "\u2264": "$\\leq$",
  "\u2265": "$\\geq$",
  "\u2192": "$\\rightarrow$",
  "\u2190": "$\\leftarrow$",
  "\u221e": "$\\infty$",
  "\u00b0": "$^{\\circ}$",
  "\u00b5": "$\\mu$",
  "\u03b1": "$\\alpha$",
  "\u03b2": "$\\beta$",
  "\u03b3": "$\\gamma$",
  "\u03b4": "$\\delta$",
  "\u03b5": "$\\varepsilon$",
  "\u03b8": "$\\theta$",
  "\u03bb": "$\\lambda$",
  "\u03bc": "$\\mu$",
  "\u03c0": "$\\pi$",
  "\u03c3": "$\\sigma$",
  "\u03c4": "$\\tau$",
  "\u03c6": "$\\varphi$",
  "\u03c9": "$\\omega$",
  "\u0394": "$\\Delta$",
  "\u03a3": "$\\Sigma$",
  "\u03a9": "$\\Omega$",
};

function escapePlain(text: string): string {
  let out = "";
  for (const char of text) {
    out += CHAR_ESCAPES[char] ?? UNICODE_REPLACEMENTS[char] ?? char;
  }
  return out;
}

/**
 * Escapes prose for LaTeX while keeping the model's own inline math intact:
 * `$...$` segments pass through unescaped so formulas survive. When the
 * dollar signs do not pair up, everything is escaped instead (the lone `$`
 * becomes `\$`) — that costs rendering of one formula, never compilation.
 */
export function escapeLatex(text: string): string {
  const parts = text.split("$");
  if (parts.length % 2 === 0) return escapePlain(text);
  return parts
    .map((part, index) => (index % 2 === 1 ? `$${part}$` : escapePlain(part)))
    .join("");
}

/* ------------------------------------------------------------- primitives */

type Block = string;

function joinBlocks(blocks: readonly Block[]): string {
  return blocks.filter((block) => block.trim() !== "").join("\n\n");
}

function section(title: string, blocks: readonly Block[], starred = false): Block[] {
  const body = blocks.filter((block) => block.trim() !== "");
  if (body.length === 0) return [];
  return [`\\${starred ? "section*" : "section"}{${escapeLatex(title)}}`, ...body];
}

function textSection(title: string, text: string | undefined): Block[] {
  if (text === undefined || text.trim() === "") return [];
  return section(title, [escapeLatex(text.trim())]);
}

/** List of PRE-RENDERED LaTeX items. The empty group after \item keeps an
 * item that starts with "[" from being parsed as an optional argument. */
function list(items: readonly string[], ordered = false): Block {
  if (items.length === 0) return "";
  const env = ordered ? "enumerate" : "itemize";
  const lines = items.map((item) => `  \\item{} ${item}`);
  return `\\begin{${env}}\n${lines.join("\n")}\n\\end{${env}}`;
}

function plainListSection(title: string, items: readonly string[], ordered = false): Block[] {
  if (items.length === 0) return [];
  return section(title, [list(items.map((item) => escapeLatex(item)), ordered)]);
}

interface TableColumn {
  readonly header: string;
  /** Fraction of \linewidth. */
  readonly width: number;
}

/** booktabs table over PRE-RENDERED cells. */
function table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): Block {
  if (rows.length === 0) return "";
  const spec = columns.map((column) => `p{${column.width.toFixed(2)}\\linewidth}`).join(" ");
  const header = columns.map((column) => `\\textbf{${escapeLatex(column.header)}}`).join(" & ");
  const body = rows.map((row) => `${row.join(" & ")} \\\\`).join("\n");
  return [
    "\\begin{center}",
    `\\begin{tabular}{${spec}}`,
    "\\toprule",
    `${header} \\\\`,
    "\\midrule",
    body,
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{center}",
  ].join("\n");
}

/** One bold facts line, e.g. "Status: resolved  Confidence: high". */
function facts(entries: readonly (readonly [string, string])[]): Block {
  const parts = entries
    .filter(([, value]) => value.trim() !== "")
    .map(([label, value]) => `\\textbf{${escapeLatex(label)}:} ${escapeLatex(value)}`);
  return parts.length > 0 ? `\\noindent ${parts.join(" \\quad ")}\\par` : "";
}

/** Enum values read better without their hyphens ("feasible-as-is" → "feasible as is"). */
function words(value: string): string {
  return value.replace(/-/g, " ");
}

function verbatim(code: string): Block {
  // A payload containing the terminator would end the environment early.
  const safe = code.replace(/\\end\{verbatim\}/g, "\\end {verbatim}");
  return `\\begin{verbatim}\n${safe}\n\\end{verbatim}`;
}

/** encodeURI keeps %, #, & (fine inside \url) and encodes spaces/braces,
 * which are the characters that actually break the macro. */
function url(value: string): string {
  return `\\url{${encodeURI(value)}}`;
}

function evidenceBlocks(evidence: EvidenceView | undefined, absentNote?: string): Block[] {
  if (!evidence) {
    return absentNote !== undefined ? [`\\emph{${escapeLatex(absentNote)}}`] : [];
  }
  switch (evidence.kind) {
    case "script": {
      const blocks = [verbatim(evidence.code)];
      if (evidence.result !== undefined && evidence.result.trim() !== "") {
        blocks.push("\\noindent\\textbf{Result:}", verbatim(evidence.result));
      }
      return blocks;
    }
    case "math":
      return [escapeLatex(evidence.derivation)];
    case "reference": {
      const locator = /^https?:\/\//i.test(evidence.locator)
        ? url(evidence.locator)
        : escapeLatex(evidence.locator);
      return [
        `${escapeLatex(evidence.citation)} --- ${locator}. ` +
          `\\emph{Shows:} ${escapeLatex(evidence.shows)}`,
      ];
    }
  }
}

function literatureItems(papers: readonly PaperView[]): string[] {
  return papers.map((paper) => {
    const meta = [paper.venue, paper.year !== undefined ? String(paper.year) : undefined]
      .filter((part): part is string => Boolean(part))
      .join(", ");
    return [
      `\\textbf{${escapeLatex(paper.title)}}${meta !== "" ? ` (${escapeLatex(meta)})` : ""}.`,
      paper.relation !== undefined ? escapeLatex(paper.relation) : "",
      paper.url !== undefined ? url(paper.url) : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  });
}

/* ------------------------------------------------- per-shape body sections */

function paperBlocks(paper: IdeaOutputView): Block[] {
  return [
    "\\begin{abstract}",
    escapeLatex(paper.abstract.trim()),
    "\\end{abstract}",
    ...textSection("Introduction", paper.introduction),
    ...textSection("Method", paper.method),
    ...textSection("Discussion", paper.discussion),
    ...textSection("Conclusion", paper.conclusion),
  ];
}

function resolutionBlocks(resolution: ResolveOutputView): Block[] {
  return [
    facts([["Status", words(resolution.status)]]),
    ...textSection("Problem", resolution.problemStatement),
    ...textSection("Approach", resolution.approach),
    ...section("Derivation", [
      list(resolution.derivation.map((step) => escapeLatex(step)), true),
    ]),
    ...section("Verification", evidenceBlocks(resolution.verification, "no self-check was possible")),
    ...plainListSection("Remaining gaps", resolution.remainingGaps),
    ...textSection("Significance", resolution.significance),
    ...section("Known results", [
      table(
        [
          { header: "Result", width: 0.5 },
          { header: "Kind", width: 0.14 },
          { header: "Relation", width: 0.26 },
        ],
        resolution.knownResults.map((known) => [
          escapeLatex(known.result),
          escapeLatex(words(known.sourceType)),
          escapeLatex(known.relation),
        ]),
      ),
    ]),
  ];
}

function verificationBlocks(verification: VerifyOutputView): Block[] {
  return [
    facts([
      ["Verdict", words(verification.verdict)],
      ["Confidence", verification.confidence.level],
    ]),
    ...section("Claim", [
      `\\begin{quote}\n${escapeLatex(verification.claim.trim())}\n\\end{quote}`,
      `\\emph{Source: ${escapeLatex(verification.claimSource)}}`,
    ]),
    ...section(
      "Evidence",
      evidenceBlocks(
        verification.evidence,
        "no evidence could be obtained --- the verdict is indeterminate",
      ),
    ),
    ...textSection("Reasoning", verification.reasoning),
    ...section("Confidence", [escapeLatex(verification.confidence.rationale)]),
  ];
}

function feasibilityBlocks(feasibility: AssessFeasibilityOutputView): Block[] {
  return [
    facts([["Feasibility", words(feasibility.feasibilityVerdict)]]),
    ...textSection("Design", feasibility.designSummary),
    ...textSection("Importance", feasibility.importance),
    ...textSection("Hypothesis logic", feasibility.hypothesisLogic),
    ...section("Methodology soundness", [
      table(
        [
          { header: "Aspect", width: 0.26 },
          { header: "Assessment", width: 0.14 },
          { header: "Note", width: 0.5 },
        ],
        feasibility.methodologySoundness.map((aspect) => [
          escapeLatex(aspect.aspect),
          escapeLatex(aspect.assessment),
          escapeLatex(aspect.note),
        ]),
      ),
    ]),
    ...textSection("Replicability", feasibility.replicability),
    ...plainListSection("Required changes", feasibility.requiredChanges),
    ...plainListSection("Alternative designs", feasibility.alternativeDesigns),
  ];
}

function critiqueBlocks(critique: CritiqueOutputView): Block[] {
  const nextSteps = [...critique.prioritizedNextSteps].sort((a, b) => a.priority - b.priority);
  return [
    facts([["Recommendation", words(critique.recommendation)]]),
    ...textSection("Artifact", critique.artifactSummary),
    ...plainListSection("Strengths", critique.strengths),
    ...section("Issues", [
      list(
        critique.issues.map((issue) =>
          joinBlocks([
            `\\textbf{${escapeLatex(issue.severity)}} --- ${escapeLatex(issue.description)}`,
            issue.suggestion !== undefined
              ? `\\emph{Suggestion: ${escapeLatex(issue.suggestion)}}`
              : "",
            ...evidenceBlocks(issue.evidence),
          ]),
        ),
      ),
    ]),
    ...plainListSection("Missing considerations", critique.missingConsiderations),
    ...section("Next steps", [
      table(
        [
          { header: "#", width: 0.06 },
          { header: "Action", width: 0.84 },
        ],
        nextSteps.map((step) => [String(step.priority), escapeLatex(step.action)]),
      ),
    ]),
  ];
}

function interpretationBlocks(interpretation: InterpretOutputView): Block[] {
  return [
    facts([["Confidence", interpretation.confidence.level]]),
    ...textSection("Observation", interpretation.observationSummary),
    ...section("Candidate interpretations", [
      list(
        interpretation.candidateInterpretations.map((candidate) =>
          joinBlocks([
            `\\textbf{${escapeLatex(candidate.plausibility)} plausibility} --- ` +
              escapeLatex(candidate.interpretation),
            candidate.supportingEvidence !== undefined && candidate.supportingEvidence !== ""
              ? `\\emph{For: ${escapeLatex(candidate.supportingEvidence)}}`
              : "",
            candidate.contradictingEvidence !== undefined && candidate.contradictingEvidence !== ""
              ? `\\emph{Against: ${escapeLatex(candidate.contradictingEvidence)}}`
              : "",
          ]),
        ),
      ),
    ]),
    ...section("Most likely reading", [
      escapeLatex(interpretation.mostLikelyInterpretation),
      `\\emph{Confidence: ${escapeLatex(interpretation.confidence.rationale)}}`,
    ]),
    ...plainListSection("Threats to validity", interpretation.threatsToValidity),
    ...textSection("Implications", interpretation.implications),
  ];
}

function surveyBlocks(survey: SurveyOutputView): Block[] {
  const groups = survey.landscapeMap.flatMap((group) => [
    `\\subsection{${escapeLatex(group.name)}}`,
    escapeLatex(group.characterization),
    group.works.length > 0 ? list(literatureItems(group.works)) : "",
  ]);
  return [
    ...section("Landscape map", groups),
    ...section("Comparison", [
      table(
        [
          { header: "Dimension", width: 0.28 },
          { header: "How the approaches differ", width: 0.62 },
        ],
        survey.comparisonTable.map((row) => [
          escapeLatex(row.dimension),
          escapeLatex(row.comparison),
        ]),
      ),
    ]),
    ...textSection("Consensus and frontier", survey.consensusAndFrontier),
    ...plainListSection("Open gaps", survey.openGaps),
    ...textSection("Recommendation", survey.recommendation),
  ];
}

function explanationBlocks(explanation: ExplainOutputView): Block[] {
  return [
    ...textSection("Why it matters", explanation.motivatingQuestion),
    ...textSection("Core intuition", explanation.coreIntuition),
    ...textSection("Formal treatment", explanation.formalTreatment),
    ...textSection("Worked example", explanation.workedExample),
    ...section("Common misconceptions", [
      list(
        explanation.commonMisconceptions.map(
          (entry) =>
            `${escapeLatex(entry.misconception)} ` +
            `\\emph{Correction: ${escapeLatex(entry.correction)}}`,
        ),
      ),
    ]),
    ...(explanation.connections.length > 0
      ? section("Connections", [escapeLatex(explanation.connections.join(", "))])
      : []),
  ];
}

function solutionBlocks(solution: SolutionOutputView): Block[] {
  return [
    ...textSection("Problem framing", solution.problemFraming),
    ...section("Diagnosis (most likely first)", [
      list(
        solution.diagnosis.map(
          (entry) =>
            `${escapeLatex(entry.cause)} \\emph{(${escapeLatex(entry.rationale)})}`,
        ),
        true,
      ),
    ]),
    ...section("Already tried", [
      table(
        [
          { header: "Attempt", width: 0.5 },
          { header: "Outcome", width: 0.4 },
        ],
        solution.priorAttempts.map((entry) => [
          escapeLatex(entry.attempt),
          escapeLatex(entry.outcome),
        ]),
      ),
    ]),
    ...section("Candidate solutions", [
      list(
        solution.candidateSolutions.map((candidate) =>
          joinBlocks([
            `\\textbf{${escapeLatex(candidate.approach)}} --- ${escapeLatex(candidate.mechanism)}`,
            `\\emph{Expected: ${escapeLatex(candidate.expectedEffect)}}`,
            `\\emph{Risk: ${escapeLatex(candidate.risk)}}`,
          ]),
        ),
      ),
    ]),
    ...textSection("Recommendation", solution.recommendation),
    ...plainListSection("Validation plan", solution.validationPlan, true),
    ...plainListSection("Residual risks", solution.residualRisks),
  ];
}

function shapeBlocks(idea: BrainIdeaView): Block[] {
  if (idea.paper) return paperBlocks(idea.paper);
  if (idea.resolution) return resolutionBlocks(idea.resolution);
  if (idea.verification) return verificationBlocks(idea.verification);
  if (idea.feasibility) return feasibilityBlocks(idea.feasibility);
  if (idea.critique) return critiqueBlocks(idea.critique);
  if (idea.interpretation) return interpretationBlocks(idea.interpretation);
  if (idea.survey) return surveyBlocks(idea.survey);
  if (idea.explanation) return explanationBlocks(idea.explanation);
  if (idea.solution) return solutionBlocks(idea.solution);
  return [];
}

/* ------------------------------------------------------------ the document */

export interface SeatTexInput {
  readonly idea: BrainIdeaView;
  /** 1-based seat number; drives the file name and the author block. */
  readonly seatNumber: number;
  /** The run's submission topic; becomes the document title. */
  readonly topic: string;
  readonly department?: string;
  readonly umbrella?: string;
  readonly subfields?: readonly string[];
  readonly revisionCount?: number;
}

/** Title-length cap; a submission can be pages long, a \title cannot. */
const MAX_TITLE_CHARS = 180;

function titleOf(topic: string): string {
  const trimmed = topic.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_TITLE_CHARS) return escapeLatex(trimmed);
  return `${escapeLatex(trimmed.slice(0, MAX_TITLE_CHARS).trimEnd())}\\ldots{}`;
}

/**
 * The whole .tex document for one seat's final output: the style embedded
 * verbatim, the shape body as sections, then the requested outputs, the
 * novelty statement, the reviewed chain of thought, and the collected
 * literature.
 */
export function seatOutputToLatex(input: SeatTexInput, styleText: string): string {
  const { idea } = input;
  const requested = idea.requested ?? [];
  const literature = idea.literature ?? [];
  const authorLines = [
    `Seat ${input.seatNumber}`,
    [input.department, input.umbrella].filter(Boolean).join(" --- "),
    (input.subfields ?? []).join(", "),
  ].filter((line) => line.trim() !== "");

  const revisions = input.revisionCount ?? 0;
  const blocks: Block[] = [
    "\\maketitle",
    facts([
      ["Submission type", idea.type],
      ["Review", revisions > 0 ? `revised ${revisions}x during review` : "unchanged from the first pass"],
    ]),
    ...shapeBlocks(idea),
    ...(requested.length > 0
      ? [
          "\\section{Requested outputs}",
          ...requested.flatMap((entry) => [
            `\\subsection{${escapeLatex(entry.title)}}`,
            escapeLatex(entry.response),
          ]),
        ]
      : []),
    ...(idea.novelty !== undefined
      ? section("Novelty statement", [escapeLatex(idea.novelty)], true)
      : []),
    ...section(
      "Chain of thought",
      [list(idea.cot.map((step) => escapeLatex(step)), true)],
      true,
    ),
    ...(literature.length > 0
      ? section("Collected literature", [list(literatureItems(literature))], true)
      : []),
  ];

  return [
    "% Generated by the Brainstorm app: one panel seat's final reviewed output.",
    "% Self-contained: the repo's shared style (latex_style.sty) is embedded",
    "% below and written next to this file on the first compile.",
    "\\begin{filecontents*}[overwrite]{latex_style.sty}",
    styleText.trimEnd(),
    "\\end{filecontents*}",
    "",
    "\\documentclass{article}",
    "",
    "\\usepackage{latex_style}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{amsmath}",
    "\\usepackage{amssymb}",
    "\\usepackage{booktabs}",
    "\\usepackage{url}",
    "",
    `\\title{${titleOf(input.topic)}}`,
    `\\author{${authorLines.map((line) => escapeLatex(line)).join(" \\\\ ")}}`,
    "",
    "\\begin{document}",
    "",
    joinBlocks(blocks),
    "",
    "\\end{document}",
    "",
  ].join("\n");
}

/* ---------------------------------------------------------------- helpers */

/** The seat's 1-based number, parsed from its label ("Seat 3"). */
export function seatNumberOf(label: string, fallbackIndex: number): number {
  const match = /(\d+)/.exec(label);
  return match ? Number(match[1]) : fallbackIndex + 1;
}

export function seatTexFileName(seatNumber: number, draft = false): string {
  // A copy taken mid-review says so in its own name: the same seat's file will
  // be downloaded again when the review finishes, and two files called
  // seat_3.tex differing by hours of revision is a trap.
  return draft ? `seat_${seatNumber}_draft.tex` : `seat_${seatNumber}.tex`;
}

/** Browser download of a generated text file. */
export function downloadTextFile(
  name: string,
  text: string,
  mime = "application/x-tex",
): void {
  const blob = new Blob([text], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
