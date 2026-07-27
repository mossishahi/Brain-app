/** Stage 7 — Integration audit: novelty verdicts, contradictions, and seams between the seats. */
import type { BridgeAuditStage, NoveltyAuditView } from "@brainstorm-agentic/protocol";
import { EvidenceBlock } from "../common";

function AuditRow({ audit }: { audit: NoveltyAuditView }) {
  return (
    <div className="judge-card">
      <div className="judge-head">
        <strong>{audit.memberId}</strong>
        <span className={`badge${audit.status === "clear" ? " badge-accent" : ""}`}>
          {audit.status}
        </span>
      </div>
      <div>
        <span className="detail-label">claim</span>
        <div>{audit.claim}</div>
      </div>
      <div>
        <span className="detail-label">audit</span>
        <div>{audit.note}</div>
      </div>
      {audit.evidence && <EvidenceBlock evidence={audit.evidence} />}
    </div>
  );
}

export function BridgeAuditBody({ stage }: { stage: BridgeAuditStage }) {
  const bridge = stage.bridge;
  if (!bridge) return null;
  return (
    <div>
      <div>
        <span className="detail-label">novelty audit</span>
        {bridge.noveltyAudit.length === 0 ? (
          <p className="dim small">no member carried a novelty claim</p>
        ) : (
          bridge.noveltyAudit.map((audit) => <AuditRow key={audit.memberId} audit={audit} />)
        )}
      </div>
      <div>
        <span className="detail-label">contradictions</span>
        {bridge.contradictions.length === 0 ? (
          <p className="dim small">none found</p>
        ) : (
          bridge.contradictions.map((entry, index) => (
            <div key={index} className="comment-detail">
              <div className="assessment-row">
                {entry.members.map((member) => (
                  <span key={member} className="badge">
                    {member}
                  </span>
                ))}
              </div>
              <div>{entry.description}</div>
            </div>
          ))
        )}
      </div>
      <div>
        <span className="detail-label">seams</span>
        {bridge.seams.length === 0 ? (
          <p className="dim small">no unexplored seams recorded</p>
        ) : (
          bridge.seams.map((seam, index) => (
            <div key={index} className="comment-detail">
              <div className="assessment-row">
                {seam.between.map((name) => (
                  <span key={name} className="badge badge-accent">
                    {name}
                  </span>
                ))}
              </div>
              <div>
                <span className="detail-label">gap</span>
                <div>{seam.gap}</div>
              </div>
              <div>
                <span className="detail-label">opportunity</span>
                <div>{seam.opportunity}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
