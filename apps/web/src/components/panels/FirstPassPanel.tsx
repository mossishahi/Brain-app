/** Stage 5 — First pass: the parallel member grid with Paper/Chain/Novelty/Papers tabs. */
import { useState } from "react";
import type { BrainIdeaView, FirstPassMemberView } from "@brainstorm-agentic/protocol";
import type { DotState } from "../../format";
import { Clamp, Dot } from "../common";

type TabId = "paper" | "chain" | "novelty" | "papers";

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

function IdeaTabs({ idea }: { idea: BrainIdeaView }) {
  const [tab, setTab] = useState<TabId>("paper");
  const literature = idea.literature ?? [];
  const hasPapers = literature.length > 0;
  const active: TabId = tab === "papers" && !hasPapers ? "paper" : tab;

  const tabs: readonly { id: TabId; label: string }[] = [
    { id: "paper", label: "Paper" },
    { id: "chain", label: "Chain" },
    { id: "novelty", label: "Novelty" },
    ...(hasPapers ? [{ id: "papers" as const, label: "Papers" }] : []),
  ];

  const sections: readonly [string, string][] = [
    ["Abstract", idea.output.abstract],
    ["Introduction", idea.output.introduction],
    ["Method", idea.output.method],
    ["Discussion", idea.output.discussion],
    ["Conclusion", idea.output.conclusion],
  ];

  return (
    <div>
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
      </div>
      {active === "paper" && (
        <div>
          {sections.map(([label, text]) => (
            <div key={label} className="paper-section">
              <p className="section-label">{label}</p>
              <Clamp text={text} />
            </div>
          ))}
        </div>
      )}
      {active === "chain" && (
        <ol className="chain-list">
          {idea.cot.map((step, i) => (
            <li key={i}>
              <Clamp text={step} />
            </li>
          ))}
        </ol>
      )}
      {active === "novelty" && <div className="callout">{idea.novelty}</div>}
      {active === "papers" && (
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
            {literature.map((paper, i) => (
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
      )}
    </div>
  );
}

function MemberCard({ member }: { member: FirstPassMemberView }) {
  const status = memberStatus(member.status);
  return (
    <div className="member-card">
      <div className="member-head">
        <span className="member-umbrella">{member.umbrella}</span>
        <span className="member-dept">{member.department}</span>
        <span className="member-status">
          <Dot state={status.dot} />
          {status.text}
        </span>
      </div>
      {member.idea && <IdeaTabs idea={member.idea} />}
    </div>
  );
}

export function FirstPassBody({ members }: { members: readonly FirstPassMemberView[] }) {
  return (
    <div className="member-grid">
      {members.map((m) => (
        <MemberCard key={m.memberId} member={m} />
      ))}
    </div>
  );
}
