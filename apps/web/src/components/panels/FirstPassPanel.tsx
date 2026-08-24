/**
 * Stage 5 — First pass: the parallel member grid. Each member card's primary
 * tab follows the member output SHAPE (Paper, Verdict, Assessment, …) while the
 * submission-type chip shows the catalog label the run was classified as,
 * followed by the shared Chain / Novelty / Papers tabs where applicable.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { diffInline, outputSections } from "@brainstorm-agentic/protocol";
import type { InlineDiffSegment } from "@brainstorm-agentic/protocol";
import { EditIcon } from "../Icons";
import type {
  AssessFeasibilityOutputView,
  BrainIdeaView,
  CritiqueOutputView,
  OutputShape,
  ExplainOutputView,
  FirstPassMemberView,
  IdeaOutputView,
  InterpretOutputView,
  PaperView,
  ResolveOutputView,
  SolutionOutputView,
  SurveyOutputView,
  VerifyOutputView,
} from "@brainstorm-agentic/protocol";
import type { DotState } from "../../format";
import {
  Clamp,
  Dot,
  EvidenceBlock,
  LiveThread,
  StepBlocks,
  ThoughtsButton,
  TokenChip,
  textStepBlocks,
} from "../common";

type TabId = "primary" | "requested" | "chain" | "novelty" | "papers" | "changes";

/** The primary tab label for each output shape. */
const PRIMARY_TAB: Record<OutputShape, string> = {
  paper: "Paper",
  resolution: "Resolution",
  verification: "Verdict",
  feasibility: "Assessment",
  critique: "Review",
  interpretation: "Interpretation",
  survey: "Landscape",
  explanation: "Explanation",
  solution: "Solution",
};

type ChipTone = "ok" | "warn" | "bad" | "dim" | "accent";

function ToneChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** Enum values read better without their hyphens ("feasible-as-is" → "feasible as is"). */
function words(value: string): string {
  return value.replace(/-/g, " ");
}

function LabeledText({ label, text }: { label: string; text: string }) {
  return (
    <div className="paper-section">
      <p className="section-label">{label}</p>
      <Clamp text={text} />
    </div>
  );
}

function LabeledList({ label, items }: { label: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="paper-section">
      <p className="section-label">{label}</p>
      <ul className="assumptions">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function PaperTable({ papers }: { papers: readonly PaperView[] }) {
  return (
    <table className="paper-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Year</th>
          <th>Venue</th>
          <th>Relation</th>
        </tr>
      </thead>
      <tbody>
        {papers.map((paper, i) => (
          <tr key={paper.id ?? `${paper.title}-${i}`}>
            <td>
              {paper.url ? (
                <a href={paper.url} target="_blank" rel="noreferrer">
                  {paper.title}
                </a>
              ) : (
                paper.title
              )}
            </td>
            <td>{paper.year ?? "—"}</td>
            <td>{paper.venue ?? "—"}</td>
            <td>{paper.relation ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ----------------------------------------------------- per-type primary tabs */

function ResearchIdeaBody({ paper }: { paper: IdeaOutputView }) {
  const sections: readonly [string, string][] = [
    ["Abstract", paper.abstract],
    ["Introduction", paper.introduction],
    ["Method", paper.method],
    ["Discussion", paper.discussion],
    ["Conclusion", paper.conclusion],
  ];
  return (
    <div>
      {sections.map(([label, text]) => (
        <LabeledText key={label} label={label} text={text} />
      ))}
    </div>
  );
}

const STATUS_TONE: Record<ResolveOutputView["status"], ChipTone> = {
  resolved: "ok",
  refuted: "ok", // a disproof is a decisive resolution too
  partial: "warn",
  "still-open": "dim",
};

function OpenProblemBody({ resolution }: { resolution: ResolveOutputView }) {
  return (
    <div>
      <div className="fact-row">
        <ToneChip tone={STATUS_TONE[resolution.status]}>{words(resolution.status)}</ToneChip>
      </div>
      <LabeledText label="Problem" text={resolution.problemStatement} />
      <LabeledText label="Approach" text={resolution.approach} />
      <div className="paper-section">
        <p className="section-label">Derivation</p>
        <ol className="chain-list">
          {resolution.derivation.map((step, i) => (
            <li key={i}>
              <Clamp text={step} />
            </li>
          ))}
        </ol>
      </div>
      <div className="paper-section">
        <p className="section-label">Verification</p>
        {resolution.verification ? (
          <EvidenceBlock evidence={resolution.verification} />
        ) : (
          <p className="dim small">no self-check was possible</p>
        )}
      </div>
      <LabeledList label="Remaining gaps" items={resolution.remainingGaps} />
      <LabeledText label="Significance" text={resolution.significance} />
      {resolution.knownResults.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Known results</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th>Result</th>
                <th>Kind</th>
                <th>Relation</th>
              </tr>
            </thead>
            <tbody>
              {resolution.knownResults.map((known, i) => (
                <tr key={`${known.result}-${i}`}>
                  <td>{known.result}</td>
                  <td>
                    <span className="tag">{words(known.sourceType)}</span>
                  </td>
                  <td>{known.relation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const VERDICT_TONE: Record<VerifyOutputView["verdict"], ChipTone> = {
  confirmed: "ok",
  refuted: "bad",
  "partially-correct": "warn",
  indeterminate: "dim",
};

const LEVEL_TONE: Record<"high" | "medium" | "low", ChipTone> = {
  high: "ok",
  medium: "warn",
  low: "dim",
};

function UnverifiedClaimBody({ verification }: { verification: VerifyOutputView }) {
  return (
    <div>
      <div className="fact-row">
        <ToneChip tone={VERDICT_TONE[verification.verdict]}>{words(verification.verdict)}</ToneChip>
        <ToneChip tone={LEVEL_TONE[verification.confidence.level]}>
          {verification.confidence.level} confidence
        </ToneChip>
      </div>
      <p className="section-label">Claim</p>
      <blockquote className="question">{verification.claim}</blockquote>
      <p className="dim small">source: {verification.claimSource}</p>
      <div className="paper-section">
        <p className="section-label">Evidence</p>
        {verification.evidence ? (
          <EvidenceBlock evidence={verification.evidence} />
        ) : (
          <p className="dim small">no evidence could be obtained — the verdict is indeterminate</p>
        )}
      </div>
      <LabeledText label="Reasoning" text={verification.reasoning} />
      <p className="dim small">confidence: {verification.confidence.rationale}</p>
    </div>
  );
}

const FEASIBILITY_TONE: Record<AssessFeasibilityOutputView["feasibilityVerdict"], ChipTone> = {
  "feasible-as-is": "ok",
  "feasible-with-changes": "warn",
  "not-feasible": "bad",
};

const ASSESSMENT_TONE: Record<"sound" | "concern" | "flaw", ChipTone> = {
  sound: "ok",
  concern: "warn",
  flaw: "bad",
};

function ResearchProposalBody({ feasibility }: { feasibility: AssessFeasibilityOutputView }) {
  return (
    <div>
      <div className="fact-row">
        <ToneChip tone={FEASIBILITY_TONE[feasibility.feasibilityVerdict]}>
          {words(feasibility.feasibilityVerdict)}
        </ToneChip>
      </div>
      <LabeledText label="Design" text={feasibility.designSummary} />
      <LabeledText label="Importance" text={feasibility.importance} />
      <LabeledText label="Hypothesis logic" text={feasibility.hypothesisLogic} />
      {feasibility.methodologySoundness.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Methodology soundness</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th>Aspect</th>
                <th>Assessment</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {feasibility.methodologySoundness.map((aspect, i) => (
                <tr key={`${aspect.aspect}-${i}`}>
                  <td>{aspect.aspect}</td>
                  <td>
                    <ToneChip tone={ASSESSMENT_TONE[aspect.assessment]}>{aspect.assessment}</ToneChip>
                  </td>
                  <td>{aspect.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LabeledText label="Replicability" text={feasibility.replicability} />
      <LabeledList label="Required changes" items={feasibility.requiredChanges} />
      <LabeledList label="Alternative designs" items={feasibility.alternativeDesigns} />
    </div>
  );
}

const RECOMMENDATION_TONE: Record<CritiqueOutputView["recommendation"], ChipTone> = {
  sound: "ok",
  "sound-with-revisions": "warn",
  "not-sound": "bad",
};

const SEVERITY_TONE: Record<"minor" | "major" | "critical", ChipTone> = {
  minor: "dim",
  major: "warn",
  critical: "bad",
};

function CompletedWorkBody({ critique }: { critique: CritiqueOutputView }) {
  const nextSteps = [...critique.prioritizedNextSteps].sort((a, b) => a.priority - b.priority);
  return (
    <div>
      <div className="fact-row">
        <ToneChip tone={RECOMMENDATION_TONE[critique.recommendation]}>
          {words(critique.recommendation)}
        </ToneChip>
      </div>
      <LabeledText label="Artifact" text={critique.artifactSummary} />
      <LabeledList label="Strengths" items={critique.strengths} />
      {critique.issues.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Issues</p>
          <ul className="issue-list">
            {critique.issues.map((issue, i) => (
              <li key={i} className="issue-item">
                <div className="fact-row">
                  <ToneChip tone={SEVERITY_TONE[issue.severity]}>{issue.severity}</ToneChip>
                </div>
                <Clamp text={issue.description} />
                {issue.suggestion && <p className="dim small">suggestion: {issue.suggestion}</p>}
                {issue.evidence && <EvidenceBlock evidence={issue.evidence} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      <LabeledList label="Missing considerations" items={critique.missingConsiderations} />
      {nextSteps.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Next steps</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {nextSteps.map((step) => (
                <tr key={`${step.priority}-${step.action}`}>
                  <td>{step.priority}</td>
                  <td>{step.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmpiricalResultBody({ interpretation }: { interpretation: InterpretOutputView }) {
  return (
    <div>
      <div className="fact-row">
        <ToneChip tone={LEVEL_TONE[interpretation.confidence.level]}>
          {interpretation.confidence.level} confidence
        </ToneChip>
      </div>
      <LabeledText label="Observation" text={interpretation.observationSummary} />
      {interpretation.candidateInterpretations.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Candidate interpretations</p>
          <ul className="issue-list">
            {interpretation.candidateInterpretations.map((candidate, i) => (
              <li key={i} className="issue-item">
                <div className="fact-row">
                  <ToneChip tone={LEVEL_TONE[candidate.plausibility]}>
                    {candidate.plausibility} plausibility
                  </ToneChip>
                </div>
                <Clamp text={candidate.interpretation} />
                {candidate.supportingEvidence && (
                  <p className="dim small">for: {candidate.supportingEvidence}</p>
                )}
                {candidate.contradictingEvidence && (
                  <p className="dim small">against: {candidate.contradictingEvidence}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="paper-section">
        <p className="section-label">Most likely reading</p>
        <div className="callout">{interpretation.mostLikelyInterpretation}</div>
        <p className="dim small">confidence: {interpretation.confidence.rationale}</p>
      </div>
      <LabeledList label="Threats to validity" items={interpretation.threatsToValidity} />
      {interpretation.implications && (
        <LabeledText label="Implications" text={interpretation.implications} />
      )}
    </div>
  );
}

function ResearchAreaBody({ survey }: { survey: SurveyOutputView }) {
  return (
    <div>
      {survey.landscapeMap.map((group) => (
        <div key={group.name} className="paper-section">
          <p className="section-label">{group.name}</p>
          <Clamp text={group.characterization} />
          {group.works.length > 0 && <PaperTable papers={group.works} />}
        </div>
      ))}
      {survey.comparisonTable.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Comparison</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>How the approaches differ</th>
              </tr>
            </thead>
            <tbody>
              {survey.comparisonTable.map((row) => (
                <tr key={row.dimension}>
                  <td>{row.dimension}</td>
                  <td>{row.comparison}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LabeledText label="Consensus & frontier" text={survey.consensusAndFrontier} />
      <LabeledList label="Open gaps" items={survey.openGaps} />
      {survey.recommendation && (
        <div className="paper-section">
          <p className="section-label">Recommendation</p>
          <div className="callout">{survey.recommendation}</div>
        </div>
      )}
    </div>
  );
}

function EstablishedConceptBody({ explanation }: { explanation: ExplainOutputView }) {
  return (
    <div>
      <LabeledText label="Why it matters" text={explanation.motivatingQuestion} />
      <div className="paper-section">
        <p className="section-label">Core intuition</p>
        <div className="callout">{explanation.coreIntuition}</div>
      </div>
      <LabeledText label="Formal treatment" text={explanation.formalTreatment} />
      <LabeledText label="Worked example" text={explanation.workedExample} />
      {explanation.commonMisconceptions.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Common misconceptions</p>
          <ul className="issue-list">
            {explanation.commonMisconceptions.map((entry, i) => (
              <li key={i} className="issue-item">
                <Clamp text={entry.misconception} lines={2} />
                <p className="dim small">correction: {entry.correction}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {explanation.connections.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Connections</p>
          <div className="tag-row">
            {explanation.connections.map((connection) => (
              <span key={connection} className="tag">
                {connection}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResearchObstacleBody({ solution }: { solution: SolutionOutputView }) {
  return (
    <div>
      <LabeledText label="Problem framing" text={solution.problemFraming} />
      <div className="paper-section">
        <p className="section-label">Diagnosis (most likely first)</p>
        <ol className="chain-list">
          {solution.diagnosis.map((entry, i) => (
            <li key={i}>
              <Clamp text={entry.cause} lines={2} />
              <p className="dim small">{entry.rationale}</p>
            </li>
          ))}
        </ol>
      </div>
      {solution.priorAttempts.length > 0 && (
        <div className="paper-section">
          <p className="section-label">Already tried</p>
          <table className="paper-table">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {solution.priorAttempts.map((entry, i) => (
                <tr key={i}>
                  <td>{entry.attempt}</td>
                  <td>{entry.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="paper-section">
        <p className="section-label">Candidate solutions</p>
        <ul className="issue-list">
          {solution.candidateSolutions.map((candidate, i) => (
            <li key={i} className="issue-item">
              <p className="section-label">{candidate.approach}</p>
              <Clamp text={candidate.mechanism} />
              <p className="dim small">expected: {candidate.expectedEffect}</p>
              <p className="dim small">risk: {candidate.risk}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="paper-section">
        <p className="section-label">Recommendation</p>
        <div className="callout">{solution.recommendation}</div>
      </div>
      <LabeledList label="Validation plan" items={solution.validationPlan} />
      <LabeledList label="Residual risks" items={solution.residualRisks} />
    </div>
  );
}

function PrimaryBody({ idea }: { idea: BrainIdeaView }) {
  if (idea.paper) return <ResearchIdeaBody paper={idea.paper} />;
  if (idea.resolution) return <OpenProblemBody resolution={idea.resolution} />;
  if (idea.verification) return <UnverifiedClaimBody verification={idea.verification} />;
  if (idea.feasibility) return <ResearchProposalBody feasibility={idea.feasibility} />;
  if (idea.critique) return <CompletedWorkBody critique={idea.critique} />;
  if (idea.interpretation) return <EmpiricalResultBody interpretation={idea.interpretation} />;
  if (idea.survey) return <ResearchAreaBody survey={idea.survey} />;
  if (idea.explanation) return <EstablishedConceptBody explanation={idea.explanation} />;
  if (idea.solution) return <ResearchObstacleBody solution={idea.solution} />;
  return null;
}

/* ---------------------------------------------------------------- the card */

function memberStatus(status: FirstPassMemberView["status"]): { text: string; dot: DotState } {
  switch (status) {
    case "thinking":
      return { text: "thinking…", dot: { tone: "accent", pulse: true } };
    case "paused":
      return { text: "paused…", dot: { tone: "warn", pulse: false } };
    case "completed":
      return { text: "done", dot: { tone: "ok", pulse: false } };
    case "failed":
      return { text: "failed", dot: { tone: "bad", pulse: false } };
    case "pending":
      return { text: "pending", dot: { tone: "dim", pulse: false } };
  }
}

/**
 * The latest main section against the FIRST, section by section: kept words
 * dimmed exactly like a round card's carried text, additions at full accent
 * weight, and — unlike the chain deck, whose paging implies them — deletions
 * shown in place, struck through in red.
 */
function outputChangesOf(
  idea: BrainIdeaView,
  original: BrainIdeaView | undefined,
):
  | {
      readonly sections: readonly {
        readonly label: string;
        readonly segments: readonly InlineDiffSegment[];
      }[];
      readonly changed: boolean;
    }
  | undefined {
  if (original === undefined) return undefined;
  const before = outputSections(original);
  const after = outputSections(idea);
  if (before.length === 0 && after.length === 0) return undefined;
  const earlier = new Map(before.map((section) => [section.label, section.text]));
  const sections = after.map((section) => {
    const base = earlier.get(section.label);
    return {
      label: section.label,
      segments:
        base === undefined
          ? ([{ kind: "added", text: section.text }] as const)
          : base === section.text
            ? ([{ kind: "kept", text: section.text }] as const)
            : diffInline(base, section.text),
    };
  });
  const labels = new Set(after.map((section) => section.label));
  const dropped = before
    .filter((section) => !labels.has(section.label))
    .map((section) => ({
      label: section.label,
      segments: [{ kind: "removed", text: section.text }] as const,
    }));
  const all = [...sections, ...dropped];
  return {
    sections: all,
    changed: all.some((section) =>
      section.segments.some((segment) => segment.kind !== "kept"),
    ),
  };
}

/** Shared idea renderer: the shape tab plus Requested/Chain/Novelty/Papers.
 * Also used by the review stage to show each member's final version, where
 * it additionally tracks the main section's changes against the first pass. */
export function IdeaTabs({
  idea,
  original,
  changesUrl,
}: {
  idea: BrainIdeaView;
  /** The seat's FIRST version; present enables the Changes tab. */
  original?: BrainIdeaView;
  /** The tracked-changes document; present enables the edit-icon download. */
  changesUrl?: string;
}) {
  const [tab, setTab] = useState<TabId>("primary");
  const literature = idea.literature ?? [];
  const requested = idea.requested ?? [];
  const hasPapers = literature.length > 0;
  const hasNovelty = idea.novelty !== undefined;
  const hasRequested = requested.length > 0;
  // Diffing the whole body is real work; do it once per version pair, and
  // only when a Changes tab could exist at all.
  const changes = useMemo(
    () => outputChangesOf(idea, original),
    [idea, original],
  );
  const hasChanges = changes?.changed === true;
  const active: TabId =
    (tab === "papers" && !hasPapers) ||
    (tab === "novelty" && !hasNovelty) ||
    (tab === "requested" && !hasRequested) ||
    (tab === "changes" && !hasChanges)
      ? "primary"
      : tab;

  const tabs: readonly { id: TabId; label: string }[] = [
    { id: "primary", label: PRIMARY_TAB[idea.shape] },
    // The member's direct responses to the submitter's explicit asks.
    ...(hasRequested ? [{ id: "requested" as const, label: "Requested" }] : []),
    { id: "chain", label: "Chain" },
    ...(hasNovelty ? [{ id: "novelty" as const, label: "Novelty" }] : []),
    ...(hasPapers ? [{ id: "papers" as const, label: "Papers" }] : []),
    ...(hasChanges ? [{ id: "changes" as const, label: "Changes" }] : []),
  ];

  return (
    <div className="idea-tabs">
      <div className="tab-row" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            className={`tab${active === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {/* The whole change history as a file: every step, every round,
            additions and removals marked — the tab beside it shows only the
            end-to-end comparison. */}
        {changesUrl !== undefined && (
          <a
            className="ghost-btn idea-changes-download"
            href={changesUrl}
            download
            title="download the main section's tracked changes — every step, every round"
            aria-label="download the main section's tracked changes as a document"
          >
            <EditIcon />
          </a>
        )}
      </div>
      <div className="idea-tab-content">
        {active === "primary" && <PrimaryBody idea={idea} />}
        {active === "requested" && (
          <div>
            {requested.map((section) => (
              <div key={section.title} className="paper-section">
                <p className="section-label">{section.title}</p>
                <Clamp text={section.response} />
              </div>
            ))}
          </div>
        )}
        {active === "chain" && (
          <ol className="chain-list">
            {idea.cot.map((step, i) => (
              <li key={i}>
                {/* A step recorded in parts renders as its four labelled
                    blocks; one written as a single string keeps the single
                    block it always had. Each block clamps on its own, so a
                    long part folds without hiding the parts after it. */}
                <StepBlocks blocks={textStepBlocks(step, (part) => <Clamp text={part} />)} />
              </li>
            ))}
          </ol>
        )}
        {active === "novelty" && <div className="callout">{idea.novelty}</div>}
        {active === "papers" && <PaperTable papers={literature} />}
        {active === "changes" && changes && (
          <div>
            <p className="dim small odiff-legend">
              the latest main section against the first pass — carried words
              dimmed, additions in blue, removals struck through
            </p>
            {changes.sections.map((section) => (
              <div key={section.label} className="paper-section">
                <p className="section-label">{section.label}</p>
                <div className="odiff-text">
                  {section.segments.map((segment, index) => (
                    <span
                      key={index}
                      className={
                        segment.kind === "added"
                          ? "odiff-added"
                          : segment.kind === "removed"
                            ? "odiff-removed"
                            : "diff-keep"
                      }
                    >
                      {segment.text}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemberCard({
  member,
  live,
  jobId,
}: {
  member: FirstPassMemberView;
  /** What this seat is saying while it thinks; absent once its idea exists. */
  live?: string;
  /** The run the card belongs to; addresses the thoughts preview/download. */
  jobId: string;
}) {
  const status = memberStatus(member.status);
  return (
    <div className={`member-card${member.dismissed ? " member-dismissed" : ""}`}>
      <div className="member-head">
        <span className="member-umbrella">{member.umbrella}</span>
        <span className="member-dept">{member.department}</span>
        {member.usage && <TokenChip usage={member.usage} />}
        {/* The thinking recorded while this seat wrote its first version:
            hover previews, click downloads the whole trace. */}
        {member.thoughts !== undefined && (
          <ThoughtsButton jobId={jobId} refId={member.thoughts} />
        )}
        <span className="member-status">
          <Dot state={status.dot} />
          {status.text}
        </span>
      </div>
      {member.idea ? (
        <IdeaTabs idea={member.idea} />
      ) : (
        live !== undefined && <LiveThread text={live} />
      )}
    </div>
  );
}

export function FirstPassBody({
  members,
  live,
  jobId,
}: {
  members: readonly FirstPassMemberView[];
  /** Live text per seat id, for the seats still thinking. */
  live?: ReadonlyMap<string, string>;
  /** The run the cards belong to; addresses each card's thoughts handle. */
  jobId: string;
}) {
  return (
    <div className="member-grid">
      {members.map((m) => (
        <MemberCard
          key={m.memberId}
          member={m}
          jobId={jobId}
          {...(live?.get(m.memberId) !== undefined ? { live: live.get(m.memberId)! } : {})}
        />
      ))}
    </div>
  );
}
