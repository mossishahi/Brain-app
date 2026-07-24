/** Stage 7 — Proposal: the synthesis, with Copy JSON / Download .md actions. */
import { useEffect, useRef, useState } from "react";
import type { ProposalView } from "@brainstorm-agentic/protocol";
import { proposalToMarkdown, slugify } from "../../format";

export function ProposalActions({ proposal }: { proposal: ProposalView }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(proposal, null, 2));
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; leave the label as-is
    }
  };

  const download = () => {
    const blob = new Blob([proposalToMarkdown(proposal)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(proposal.title)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()}>
        {copied ? "copied" : "Copy JSON"}
      </button>
      <button type="button" className="btn btn-ghost btn-small" onClick={download}>
        Download .md
      </button>
    </>
  );
}

function BandColumn({
  title,
  tone,
  items,
}: {
  title: string;
  tone?: "warn" | "accent";
  items: readonly string[];
}) {
  return (
    <div className="band-col">
      <p className={`band-title${tone ? ` band-${tone}` : ""}`}>{title}</p>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="dim small">none</p>
      )}
    </div>
  );
}

export function ProposalBody({ proposal }: { proposal: ProposalView }) {
  const actionItems = [...proposal.actionItems].sort((a, b) => a.priority - b.priority);
  return (
    <div>
      <h2 className="proposal-title">{proposal.title}</h2>
      <p className="framing">{proposal.framing}</p>
      <div className="proposal-band">
        <BandColumn title="Consensus" items={proposal.consensus} />
        <BandColumn title="Tensions" tone="warn" items={proposal.tensions} />
        <BandColumn title="Novel directions" tone="accent" items={proposal.novelDirections} />
      </div>
      <p className="section-label">Action items</p>
      {actionItems.length > 0 ? (
        <table className="action-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Action</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {actionItems.map((item, i) => (
              <tr key={`${item.priority}-${i}`}>
                <td>{item.priority}</td>
                <td>{item.action}</td>
                <td>{item.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dim small">none</p>
      )}
      {proposal.applications.length > 0 && (
        <>
          <p className="section-label">Applications</p>
          <div className="tag-row apps-row">
            {proposal.applications.map((app) => (
              <span key={app} className="tag">
                {app}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
