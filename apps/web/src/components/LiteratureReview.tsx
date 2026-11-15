import type { LiteratureReviewView, LiteratureWorkView } from "@brainstorm-agentic/protocol";
import { downloadTextFile } from "../latex";
import "./literature-review.css";

function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

function List({ label, items }: { label: string; items: readonly string[] }) {
  return items.length === 0 ? null : <div><strong>{label}</strong><ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul></div>;
}

function Work({ work, requirements }: { work: LiteratureWorkView; requirements: ReadonlyMap<string, string> }) {
  const href = sourceUrl(work.source.url);
  return <li className="literature-work">
    <p><strong>{href ? <a href={href} target="_blank" rel="noreferrer">{work.source.title}</a> : work.source.title}</strong></p>
    <p className="dim small">{[work.source.authors.join(", "), work.source.year, work.source.venue, work.source.version].filter(Boolean).join(" · ")}</p>
    <p><span className="badge">Inspected: {work.inspected.level === "full-text" ? "Entire retrieved document" : work.inspected.level.replaceAll("-", " ")}</span></p>
    <p><strong>Method:</strong> {work.method}</p>
    <p><strong>Results:</strong> {work.results}</p>
    <List label="Conditions" items={work.conditions} />
    <List label="Limitations" items={work.limitations} />
    <div><strong>Relation to your input</strong><ul>{work.relevance.map((relation, index) => <li key={index}>
      <strong>{requirements.get(relation.requirementId) ?? relation.requirementId}</strong> — {relation.relationship.replaceAll("-", " ")}: {relation.justification}
    </li>)}</ul></div>
    <List label="Use in this agent's output" items={work.intendedUse} />
    <List label="Uncertainties" items={work.uncertainties} />
    <List label="Access limitations" items={work.inspected.accessLimitations} />
    {work.inspected.evidence.length > 0 && <details><summary>Source locations ({work.inspected.evidence.length})</summary>
      <ul>{work.inspected.evidence.map((evidence, index) => <li key={index}>{evidence.locator}<br /><span className="dim small">Document {evidence.documentId} · Segment {evidence.segmentId} · Receipt {evidence.receiptId}</span></li>)}</ul>
    </details>}
  </li>;
}

/** Each record stays inside its author's output and retains its own interpretation. */
export function LiteratureReviews({ reviews, label = "Literature review and sources" }: {
  reviews?: readonly LiteratureReviewView[];
  label?: string;
}) {
  if (!reviews?.length) return null;
  return <section className="literature-reviews" aria-label={label}>
    <p className="section-label">{label}</p>
    {reviews.map((record) => {
      const { review, owner } = record;
      const requirements = new Map(record.inputRequirements.map((item) => [item.id, item.text]));
      return <details className="literature-review" key={record.reviewId}>
        <summary>{owner.role}{owner.agentId ? ` · ${owner.agentId}` : ""} · {review.scope.vantage} · {review.works.length} sources · {review.status.replaceAll("-", " ")}</summary>
        <div className="literature-review-body">
          <p><strong>Question:</strong> {review.scope.question}</p>
          <p>{review.statusReason}</p>
          <p className="dim small">Task: {owner.taskId} · Review revision {record.revision}</p>
          <p><strong>Assessment:</strong> {review.synthesis.assessment.replaceAll("-", " ")}. {review.synthesis.findings}</p>
          <List label="Remaining gaps" items={review.synthesis.gaps} />
          <List label="Comparisons" items={review.synthesis.comparisons} />
          <p><strong>Coverage:</strong> {review.search.coverage}</p>
          <List label="Search limitations" items={review.search.limitations} />
          <ol>{review.works.map((work) => <Work key={work.id} work={work} requirements={requirements} />)}</ol>
          <details><summary>Search record ({review.search.queries.length})</summary><ul>{review.search.queries.map((query, index) => <li key={index}>{query.query} · {query.source}</li>)}</ul></details>
          <button className="ghost-btn" type="button" onClick={() => downloadTextFile(`literature-${record.reviewId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`, JSON.stringify(record, null, 2), "application/json")}>Download this agent's review</button>
        </div>
      </details>;
    })}
  </section>;
}
