import { Fragment, useId, useState } from "react";
import type { FactDeletionView, FactEntryView, FactTableView, FactUpdateSubscriberView, FactUpdateView, FactUsageView } from "@brainstorm-agentic/protocol";
import { downloadTextFile } from "../../latex";
import { referenceLinks } from "./reference-links";
import "./fact-table.css";

const statusLabels = { justified: "Justified", disputed: "Disputed", revoked: "Revoked", refuted: "Refuted" } as const;
const methodLabels: Record<string, string> = {
  "re-executed": "Computation checked",
  "source-quoted": "Source checked",
  "record-match": "Record checked",
  "judgement-only": "Reasoning checked",
  none: "No verification method recorded",
};

const roleLabels: Record<string, string> = {
  brain: "Thinker", thinker: "Thinker", commentor: "Critic", critic: "Critic",
  "game-commentor": "Critic", game_commentor: "Critic",
  "game-interdisciplinary-commentor": "Interdisciplinary critic", "interdisciplinary-commentor": "Interdisciplinary critic",
  judge: "Committee chair", chair: "Final chair", committee_chair: "Committee chair", "committee-chair": "Committee chair",
  redeveloper: "Redeveloper", "game-redeveloper": "Redeveloper", integrator: "Integrator", supreme_judge: "Supreme judge",
  supreme_judge_consult: "Supreme judge",
};
const roleLabel = (role: string) => roleLabels[role] ?? role.replace(/[_-]/g, " ");
const usageLabel = (use: FactUsageView) => ({
  submitted: "Submitted for verification", cited: "Cited", recorded: "Recorded interaction",
  approval: use.approved === true ? "Badge approved" : use.approved === false ? "Badge rejected" : "Badge approval requested",
})[use.kind];

function ReferenceText({ text }: { text: string }) {
  return <>{referenceLinks(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
    : <Fragment key={index}>{part.text}</Fragment>)}</>;
}

function FactUses({ uses }: { uses?: readonly FactUsageView[] }) {
  if (!uses?.length) return <span className="dim small">No usage recorded.</span>;
  return <ul className="fact-uses">{uses.map((use, index) => <li key={index}>
    <strong title={use.agentId}>{use.agentLabel || use.agentId}</strong>
    <span className="fact-use-context">{roleLabel(use.role)} · {use.step === undefined ? "Step not recorded" : `Step ${use.step}`}</span>
    {use.seatId && use.seatId !== use.agentId && <span className="fact-use-context dim">For {use.seatLabel || use.seatId}</span>}
    <span className="fact-use-kind">{usageLabel(use)}</span>
    <p className={use.purpose ? "" : "dim"}><ReferenceText text={use.purpose || "Purpose not recorded."} /></p>
  </li>)}</ul>;
}

function FactEvidence({ fact }: { fact: FactEntryView }) {
  return <div className="fact-evidence">
    <dl>
      <dt>Verification</dt><dd>{methodLabels[fact.method] ?? fact.method}</dd>
      <dt>Why this was recorded</dt><dd><ReferenceText text={fact.reason || "No explanation recorded."} /></dd>
      <dt>Evidence</dt><dd><ReferenceText text={fact.evidence || "No evidence recorded."} /></dd>
      <dt>Badge hash</dt><dd><code>{fact.badgeHash ?? "Not recorded for this badge."}</code></dd>
      {fact.supersededBy && <><dt>Superseded by</dt><dd>{fact.supersededBy}</dd></>}
    </dl>
    {fact.history.length > 0 && <details className="fact-history">
      <summary>Verification history ({fact.history.length})</summary>
      <ol>{fact.history.map((event, index) => <li key={index}>
        <strong>{event.event}</strong>{" · "}
        <time>{new Date(event.at).toLocaleString()}</time>
        {event.by && <> · {event.by}</>}
        {event.detail && <p><ReferenceText text={event.detail} /></p>}
      </li>)}</ol>
    </details>}
  </div>;
}

const updateStateLabels: Readonly<Record<FactUpdateSubscriberView["state"], string>> = {
  running: "Running", applied: "Revised", unchanged: "Unchanged", withdrawn: "Withdrawn",
  discarded: "Discarded", failed: "Failed", "no-task": "No revisable output",
};
const subscriberLabel = (subscriber: FactUpdateSubscriberView): string =>
  subscriber.kind === "chain" ? `Chain of ${subscriber.seatId ?? subscriber.agentId}`
    : subscriber.kind === "game-report" ? `Report by ${subscriber.agentId} on ${subscriber.seatId}, step ${subscriber.step}, round ${subscriber.round}`
    : subscriber.kind === "comment" ? `Comment by ${subscriber.agentId} on ${subscriber.seatId}, step ${subscriber.step}, round ${subscriber.round}`
    : subscriber.agentId;

/** Badges deleted from the shared table: id, time, replacement and each reconsideration's state; never their claims. */
function DeletedBadges({ deleted, updates }: { deleted: readonly FactDeletionView[]; updates: readonly FactUpdateView[] }) {
  const headingId = useId();
  return <section className="fact-deleted" aria-labelledby={headingId}>
    <h3 id={headingId}>Deleted badges</h3>
    <p className="dim small">Badges the supreme judge deleted after a later check showed them wrong. Their claims are not kept.</p>
    <div className="fact-table-scroll">
      <table className="fact-table" aria-labelledby={headingId}>
        <thead><tr><th scope="col">Badge</th><th scope="col">Deleted at</th><th scope="col">Replaced by</th><th scope="col">Reconsiderations</th></tr></thead>
        <tbody>{deleted.map(deletion => {
          const subscribers = updates.filter(update => update.deleted === deletion.id)
            .flatMap(update => update.subscribers.map(subscriber => ({ key: `${update.notice}:${subscriber.key}`, subscriber })));
          return <tr key={deletion.id}>
            <th scope="row"><code>{deletion.id}</code></th>
            <td><time>{new Date(deletion.at).toLocaleString()}</time></td>
            <td>{deletion.replacedBy ?? ""}</td>
            <td>{subscribers.length > 0 && <ul className="fact-uses">{subscribers.map(({ key, subscriber }) => <li key={key}>
              <strong title={subscriber.key}>{subscriberLabel(subscriber)}</strong>
              <span className="fact-use-kind">{updateStateLabels[subscriber.state]}</span>
            </li>)}</ul>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

/** A human-readable view of this run's durable shared facts; never an agent channel. */
export function FactTablePanel({ table }: { table?: FactTableView }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const detailPrefix = useId();
  const entries = table?.entries ?? [];
  const term = query.trim().toLocaleLowerCase();
  const visible = entries.filter(fact => (status === "all" || fact.status === status) &&
    (!term || [fact.id, fact.badgeHash, fact.claim, fact.conditions, fact.evidence, fact.reason,
      ...(fact.uses ?? []).flatMap(use => [use.agentId, use.agentLabel, roleLabel(use.role), use.role,
        use.seatId, use.seatLabel, use.purpose, usageLabel(use), use.step === undefined ? undefined : `Step ${use.step}`])]
      .some(value => value?.toLocaleLowerCase().includes(term))));
  const toggle = (id: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <section className="stage fact-table-panel" aria-label="Fact table">
    <header className="fact-table-heading">
      <h2 className="stage-title">Fact table</h2>
      {entries.length > 0 && <>
        <span className="dim small">{entries.length} recorded fact{entries.length === 1 ? "" : "s"}</span>
        <button type="button" className="btn btn-ghost btn-small fact-action" onClick={() => downloadTextFile("fact-table.json", JSON.stringify(table, null, 2), "application/json")}>Download fact table</button>
      </>}
    </header>
    {table?.error && <p className="callout callout-warn" role="status">{table.error}</p>}
    {entries.length === 0 ? (!table?.error && <p className="dim small">
      {table === undefined ? "No fact table was recorded for this run."
        : (table.deleted?.length ?? 0) > 0 ? "No badges remain in the fact table." : "No facts have been recorded yet."}
    </p>) : <>
      <p className="dim small">Only justified facts can support a claim, within their recorded conditions.</p>
      <div className="fact-table-filters">
        <label>Search facts<input type="search" aria-label="Search facts" value={query} onChange={event => setQuery(event.target.value)} placeholder="Badge, claim, evidence, agent or purpose" /></label>
        <label>Fact status<select aria-label="Fact status" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <span className="dim small" role="status">{visible.length} of {entries.length} facts</span>
      </div>
      {visible.length === 0 ? <p className="dim">No facts match these filters.</p> : <div className="fact-table-scroll" role="region" aria-label="Fact table entries" tabIndex={0}>
        <table className="fact-table" aria-label="Recorded facts">
          <thead><tr><th scope="col">Badge</th><th scope="col">Status</th><th scope="col">Claim</th><th scope="col">Conditions</th><th scope="col">Used by / purpose</th><th scope="col">Verification</th></tr></thead>
          <tbody>{visible.map(fact => {
            const open = expanded.has(fact.id);
            const detailId = `${detailPrefix}-${fact.id}`;
            return <Fragment key={fact.id}>
              <tr>
                <th scope="row"><code>{fact.id}</code><span className="fact-kind dim small">{fact.kind}</span></th>
                <td><span className={`fact-status fact-status-${fact.status}`}>{statusLabels[fact.status]}</span>{fact.supersededBy && <p className="small">Replaced by {fact.supersededBy}</p>}</td>
                <td className="fact-claim"><ReferenceText text={fact.claim} /></td><td><ReferenceText text={fact.conditions} /></td>
                <td><FactUses uses={fact.uses} /></td>
                <td><button type="button" className="btn btn-ghost btn-small fact-action" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? "Hide" : "Show"} evidence for ${fact.id}`} onClick={() => toggle(fact.id)}>{open ? "Hide evidence" : "View evidence"}</button></td>
              </tr>
              {open && <tr id={detailId}><td colSpan={6}><FactEvidence fact={fact} /></td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>}
    </>}
    {table?.deleted !== undefined && table.deleted.length > 0 && <DeletedBadges deleted={table.deleted} updates={table.updates ?? []} />}
  </section>;
}
