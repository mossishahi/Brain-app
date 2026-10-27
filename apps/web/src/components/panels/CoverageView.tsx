/**
 * The confirm-panel gate's coverage view (contract K; spec v2 Step 11): the
 * needs x seats matrix with a(seat, need) in every cell and the coverage the
 * confirmed panel would carry, the greedy coverage curve with k* and k_cov,
 * the evidence flags, each seat's exemplar papers, and "add next seat", which
 * seats the greedy order's next candidate through the gate's existing
 * custom-seat edit path.
 *
 * Rendered only when the run has a panelEvidence artifact; older runs show
 * the gate card exactly as before.
 */
import type { CustomSeatRequest, PanelMemberView } from "@brainstorm-agentic/protocol";
import {
  activeSeats,
  affinity,
  cellText,
  coverageOf,
  curveGeometry,
  nextGreedySeat,
  objective,
  seatRequest,
  seatStanding,
  uncoveredCritical,
  type CoverageSeat,
  type PanelEvidenceView,
} from "./coverage-model";
import "./coverage.css";

const CURVE_W = 260;
const CURVE_H = 90;

function seatLabel(seat: CoverageSeat): string {
  const focus = seat.subfields[0] ?? seat.name ?? seat.umbrella;
  return `${seat.department} · ${seat.umbrella} — ${focus}`;
}

function CoverageCurve({ view }: { view: PanelEvidenceView }) {
  const points = curveGeometry(view.curve, CURVE_W, CURVE_H);
  if (points.length === 0) return null;
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const barWidth = Math.max(4, Math.min(18, CURVE_W / Math.max(1, points.length) / 2));
  const markerX = (k: number | null) => points.find((point) => point.k === k)?.x;
  const kStarX = markerX(view.kStar);
  const kCovX = markerX(view.kCov);
  return (
    <figure className="cov-curve">
      <svg
        viewBox={`-12 -8 ${CURVE_W + 24} ${CURVE_H + 26}`}
        role="img"
        aria-label={`coverage curve: F/W by seat count; k* = ${view.kStar}, k_cov = ${view.kCov ?? "not reached"}`}
      >
        <line className="cov-axis" x1={0} y1={CURVE_H} x2={CURVE_W} y2={CURVE_H} />
        {points.map((point) => (
          <rect
            key={`gain-${point.k}`}
            className="cov-gain"
            x={point.x - barWidth / 2}
            y={CURVE_H - point.gainHeight}
            width={barWidth}
            height={point.gainHeight}
          >
            <title>{`k=${point.k}: gain ${point.gain.toFixed(3)}`}</title>
          </rect>
        ))}
        <polyline className="cov-line" points={line} />
        {points.map((point) => (
          <circle key={`f-${point.k}`} className="cov-dot" cx={point.x} cy={point.y} r={3}>
            <title>{`k=${point.k}: F/W ${point.Fnorm.toFixed(3)}`}</title>
          </circle>
        ))}
        {kStarX !== undefined && (
          <line className="cov-kstar" x1={kStarX} y1={-4} x2={kStarX} y2={CURVE_H} />
        )}
        {kCovX !== undefined && (
          <line className="cov-kcov" x1={kCovX} y1={-4} x2={kCovX} y2={CURVE_H} />
        )}
        {points.map((point) => (
          <text key={`k-${point.k}`} className="cov-tick" x={point.x} y={CURVE_H + 12}>
            {point.k}
          </text>
        ))}
      </svg>
      <figcaption className="dim small">
        line: F/W (normalised coverage) after k seats · bars: gain of seat k · solid: k* = {view.kStar}
        {view.kCov !== null ? ` · dashed: k_cov = ${view.kCov}` : " · k_cov not reached"}
      </figcaption>
      <table className="cov-curve-table">
        <thead>
          <tr>
            <th scope="col">k</th>
            <th scope="col">seat</th>
            <th scope="col">F/W</th>
            <th scope="col">gain</th>
            <th scope="col">runner-up</th>
          </tr>
        </thead>
        <tbody>
          {view.curve.map((point) => {
            const seat = view.seats.find((entry) => entry.order === point.k);
            return (
              <tr key={point.k} className={point.k === view.kStar ? "cov-row-kstar" : undefined}>
                <td>
                  {point.k}
                  {point.k === view.kStar ? " (k*)" : ""}
                  {point.k === view.kCov ? " (k_cov)" : ""}
                </td>
                <td>{seat ? seatLabel(seat) : point.cand}</td>
                <td>{point.Fnorm.toFixed(3)}</td>
                <td>{point.gain.toFixed(3)}</td>
                <td className="dim">
                  {point.runnerUp !== undefined
                    ? `${point.runnerUp}${point.runnerUpGain !== undefined ? ` (${point.runnerUpGain.toFixed(3)})` : ""}`
                    : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}

function CoverageFlags({ view }: { view: PanelEvidenceView }) {
  const flags = view.flags;
  const shares = Object.entries(flags.sourceShare).sort((left, right) => right[1] - left[1]);
  const offline = flags.sources.filter((source) => source.state !== "available");
  const items: { key: string; warn: boolean; text: string }[] = [];
  if (shares.length > 0) {
    items.push({
      key: "share",
      warn: flags.sourceAlarm.length > 0,
      text: `evidence by source: ${shares.map(([source, share]) => `${source} ${(share * 100).toFixed(0)}%`).join(", ")}${
        flags.sourceAlarm.length > 0 ? ` (one source dominates: ${flags.sourceAlarm.join(", ")})` : ""
      }`,
    });
  }
  if (flags.thinNeeds.length > 0) {
    items.push({ key: "thin", warn: true, text: `thin evidence for: ${flags.thinNeeds.join(", ")}` });
  }
  if (flags.anchoredSeats.length > 0) {
    items.push({ key: "anchored", warn: false, text: `facet-anchored seats: ${flags.anchoredSeats.join(", ")}` });
  }
  if (view.rescued.length > 0) {
    items.push({ key: "rescued", warn: false, text: `rescued for an uncovered critical need: ${view.rescued.join(", ")}` });
  }
  if (flags.failedSources.length > 0) {
    items.push({ key: "failed", warn: true, text: `sources that failed: ${flags.failedSources.join(", ")}` });
  }
  for (const source of offline) {
    items.push({
      key: `source-${source.id}`,
      warn: source.state === "unavailable",
      text: `${source.id}: ${source.state}${source.detail ? ` (${source.detail})` : ""}`,
    });
  }
  if (view.droppedByCap.length > 0) {
    items.push({
      key: "caps",
      warn: false,
      text: `dropped by a cap: ${view.droppedByCap
        .map((entry) => `${entry.name ?? entry.cand} (${entry.why} at k=${entry.atK}, gain ${entry.gain.toFixed(3)})`)
        .join("; ")}`,
    });
  }
  if (flags.screenedOut > 0) {
    items.push({ key: "screen", warn: false, text: `${flags.screenedOut} papers judged off-topic by the relevance screen` });
  }
  if (flags.weakPlacements > 0) {
    items.push({ key: "weak", warn: false, text: `${flags.weakPlacements} weak placements` });
  }
  for (const hub of flags.hubs) {
    items.push({ key: `hub-${hub.topic}`, warn: true, text: `hub topic ${hub.topic} (${(hub.share * 100).toFixed(0)}% of papers)` });
  }
  if (flags.budgetExhausted) {
    items.push({ key: "budget", warn: true, text: "the retrieval call budget ran out" });
  }
  for (const [index, note] of flags.notes.entries()) {
    items.push({ key: `note-${index}`, warn: false, text: note });
  }
  if (items.length === 0) return null;
  return (
    <ul className="cov-flags">
      {items.map((item) => (
        <li key={item.key} className={item.warn ? "cov-flag cov-flag-warn" : "cov-flag"}>
          {item.text}
        </li>
      ))}
    </ul>
  );
}

function SeatExemplars({ view }: { view: PanelEvidenceView }) {
  const seats = view.seats.filter((seat) => seat.exemplars.length > 0);
  if (seats.length === 0) return null;
  return (
    <div className="cov-exemplars">
      {seats.map((seat) => (
        <div className="cov-exemplar-seat" key={seat.id}>
          <span className="cov-exemplar-head">
            {seat.order}. {seatLabel(seat)}
            {seat.kind === "anchor" ? " (anchored)" : ""}
          </span>
          <ol className="cov-exemplar-list">
            {seat.exemplars.map((paper) => (
              <li key={paper.pid}>
                {paper.url ? (
                  <a href={paper.url} target="_blank" rel="noopener noreferrer">
                    {paper.title ?? paper.pid}
                  </a>
                ) : (
                  <span>{paper.title ?? paper.pid}</span>
                )}
                {paper.year !== undefined && <span className="dim"> ({paper.year})</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

export function CoverageView({
  view,
  members,
  checked,
  added,
  canAdd,
  onAddSeat,
}: {
  view: PanelEvidenceView;
  members: readonly PanelMemberView[];
  checked: ReadonlySet<string>;
  added: readonly CustomSeatRequest[];
  canAdd: boolean;
  onAddSeat: (seat: CustomSeatRequest) => void;
}) {
  const panelIds = new Set(members.map((member) => member.id));
  const active = activeSeats(view, panelIds, checked, added);
  const coverage = coverageOf(active, view.needs.length);
  const { Fnorm } = objective(coverage, view.needs, view.W);
  const uncovered = uncoveredCritical(view, coverage);
  const next = nextGreedySeat(view, panelIds, added);
  const nextRequest = next ? seatRequest(next) : undefined;
  return (
    <section className="cov" aria-label="panel coverage">
      <div className="cov-head">
        <span className="cov-title">How well the panel covers the needs</span>
        <span className="dim small">
          F/W {Fnorm.toFixed(3)} with {active.length} seat{active.length === 1 ? "" : "s"} · k* ={" "}
          {view.kStar} · k_cov = {view.kCov ?? "not reached"}
          {view.panelSizeMode ? ` · size mode ${view.panelSizeMode}` : ""}
        </span>
      </div>
      <div className="cov-matrix-wrap">
        <table className="cov-matrix">
          <thead>
            <tr>
              <th scope="col" className="cov-need-col">need</th>
              <th scope="col">w</th>
              {view.seats.map((seat) => {
                const standing = seatStanding(seat, panelIds, checked, added);
                const marks = [
                  seat.order === view.kStar ? "k*" : "",
                  seat.order === view.kCov ? "k_cov" : "",
                  next?.id === seat.id ? "next" : "",
                ].filter((mark) => mark !== "");
                return (
                  <th
                    scope="col"
                    key={seat.id}
                    className={`cov-seat cov-${standing}${seat.order === view.kStar ? " cov-at-kstar" : ""}`}
                    title={`${seat.order}. ${seatLabel(seat)} (${standing.replace("-", " ")})`}
                  >
                    <span className="cov-seat-no">{seat.order}</span>
                    <span className="cov-seat-name">{seat.subfields[0] ?? seat.name ?? seat.umbrella}</span>
                    {marks.length > 0 && <span className="cov-seat-mark">{marks.join(" ")}</span>}
                  </th>
                );
              })}
              <th scope="col" className="cov-total-col">coverage</th>
            </tr>
          </thead>
          <tbody>
            {view.needs.map((need) => {
              const value = coverage[need.index] ?? 0;
              const below = need.critical && value < view.criticalCoverage;
              return (
                <tr key={need.index} className={need.critical ? "cov-critical" : undefined}>
                  <th scope="row" className="cov-need" title={`${need.kind}${need.critical ? ", critical" : ""}`}>
                    {need.name}
                    {need.thin && <span className="chip chip-dim">thin</span>}
                  </th>
                  <td className="cov-weight">{need.weight.toFixed(2)}</td>
                  {view.seats.map((seat) => {
                    const a = affinity(seat, need.index);
                    const standing = seatStanding(seat, panelIds, checked, added);
                    return (
                      <td
                        key={seat.id}
                        className={`cov-cell cov-${standing}${seat.order === view.kStar ? " cov-at-kstar" : ""}`}
                        style={{ backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(Math.min(1, a) * 55)}%, transparent)` }}
                      >
                        {cellText(a)}
                      </td>
                    );
                  })}
                  <td className={`cov-total${below ? " cov-below" : ""}`}>{value.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim small cov-legend">
        Columns follow the greedy order; cells are a(seat, need); the last column is the coverage
        of the seats you are about to confirm (kept + added), 1 − Π(1 − a). Critical needs (w ≥{" "}
        {view.criticalWeight}) target {view.criticalCoverage}.
        {uncovered.length > 0 ? ` Below target: ${uncovered.map((need) => need.name).join(", ")}.` : ""}
      </p>
      <div className="cov-add">
        {next && nextRequest ? (
          <span className="small">
            Next in the greedy order: {next.order}. {seatLabel(next)}
          </span>
        ) : (
          <span className="dim small">The greedy order has no further seat.</span>
        )}
        <button
          type="button"
          className="btn btn-small"
          disabled={!next || !nextRequest || nextRequest.subfields.length === 0 || !canAdd}
          onClick={() => {
            if (nextRequest) onAddSeat(nextRequest);
          }}
        >
          Add next seat
        </button>
      </div>
      <CoverageCurve view={view} />
      <CoverageFlags view={view} />
      <SeatExemplars view={view} />
    </section>
  );
}
