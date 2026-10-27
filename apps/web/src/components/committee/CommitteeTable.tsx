import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  FirstPassMemberView,
  ReviewMemberView,
} from "@brainstorm-agentic/protocol";
import { SettingsToggle } from "../settings/SettingsToggle";
import { useRunLive } from "../run-liveness";
import {
  buildCommittee,
  layoutCommittee,
  type CommitteeEdge,
} from "./round-table-model";
import {
  useCommitteePalette,
  CommitteeColorControls,
  stepColor,
  agentColor,
} from "./committee-palette";
import "./committee-table.css";

const EMPTY_FIRST_PASS: readonly FirstPassMemberView[] = [];
const VERDICTS = ["Pass", "Interrupt", "Build", "Reported", "Admitted", "Rejected"] as const;
type Verdict = (typeof VERDICTS)[number];

/** A native multi-select control with an explicit mixed state for All members. */
function MemberCheckbox({ label, checked, mixed = false, onChange }: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="committee-member-option" data-checked={checked || mixed ? "true" : undefined}>
      <input
        ref={input}
        className="committee-member-input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="committee-checkmark" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          {mixed ? <path d="M4 8h8" /> : checked ? <path d="m3.5 8 3 3 6-6" /> : null}
        </svg>
      </span>
      <span>{label}</span>
    </label>
  );
}

function statusLabel(status: string): string {
  return status === "force-passed"
    ? "passed at review limit"
    : status.replaceAll("-", " ");
}

function activate(event: KeyboardEvent<SVGGElement>, action: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function Bulb({
  x,
  y,
  color,
  symbolColor,
}: {
  x: number;
  y: number;
  color: string;
  symbolColor: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <circle r="13" fill={color} />
      <path
        d="M-3 3C-3 0-5-1-5-4a5 5 0 0 1 10 0c0 3-2 4-2 7M-3 5h6M-2 8h4"
        fill="none"
        stroke={symbolColor}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </g>
  );
}

type EdgeDrawing = {
  edge: CommitteeEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  color: string;
};

/** Small graphs use SVG; dense histories share one canvas instead of thousands of DOM paths. */
const Connections = memo(function Connections({
  drawings,
  width,
  height,
}: {
  drawings: readonly EdgeDrawing[];
  width: number;
  height: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dense = drawings.length > 600;
  useEffect(() => {
    if (!dense || !canvas.current) return;
    const node = canvas.current;
    const draw = () => {
      const bounds = node.getBoundingClientRect();
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        4096 / Math.max(bounds.width, bounds.height, 1),
      );
      node.width = Math.max(1, Math.ceil(bounds.width * ratio));
      node.height = Math.max(1, Math.ceil(bounds.height * ratio));
      const ctx = node.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(node.width / width, 0, 0, node.height / height, 0, 0);
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.45;
      for (const item of drawings) {
        ctx.strokeStyle = item.color;
        ctx.setLineDash(
          item.edge.verdict === "Interrupt"
            ? [5, 5]
            : item.edge.verdict === "Build"
              ? [2, 4]
              : [],
        );
        ctx.beginPath();
        ctx.moveTo(item.x1, item.y1);
        ctx.quadraticCurveTo(item.cx, item.cy, item.x2, item.y2);
        ctx.stroke();
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    draw();
    return () => observer.disconnect();
  }, [dense, drawings, width, height]);
  return dense ? (
    <foreignObject
      x="0"
      y="0"
      width={width}
      height={height}
      className="committee-dense-edges"
      pointerEvents="none"
    >
      <canvas
        ref={canvas}
        style={{ width: "100%", height: "100%" }}
        aria-hidden="true"
      />
    </foreignObject>
  ) : (
    <g
      className="committee-connections"
      aria-hidden="true"
      pointerEvents="none"
    >
      {drawings.map(({ edge, x1, y1, x2, y2, cx, cy, color }) => (
        <path
          key={edge.id}
          data-verdict={edge.verdict}
          data-source={edge.sourceId}
          data-target={edge.targetId}
          data-target-step={edge.stepIndex}
          d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`}
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeDasharray={
            edge.verdict === "Interrupt"
              ? "5 5"
              : edge.verdict === "Build"
                ? "2 4"
                : undefined
          }
        />
      ))}
    </g>
  );
});

export function CommitteeTable({
  firstPass = EMPTY_FIRST_PASS,
  review,
  plannedStepCount,
  selectedMemberId,
  onSelectStep,
  onSelectMember,
}: {
  firstPass?: readonly FirstPassMemberView[];
  review?: readonly ReviewMemberView[];
  plannedStepCount?: number;
  selectedMemberId?: string;
  onSelectStep?: (memberId: string, stepIndex: number) => void;
  onSelectMember?: (memberId: string) => void;
}) {
  const model = useMemo(
    () => buildCommittee(firstPass, review, plannedStepCount),
    [firstPass, review, plannedStepCount],
  );
  const layout = useMemo(() => layoutCommittee(model.members), [model.members]);
  const byId = useMemo(
    () => new Map(layout.seats.map((seat) => [seat.memberId, seat])),
    [layout],
  );
  const { palette, setColor, reset } = useCommitteePalette();
  const [filters, setFilters] = useState<Record<Verdict, boolean>>({
    Pass: true,
    Reported: true,
    Admitted: true,
    Rejected: true,
    Interrupt: true,
    Build: true,
  });
  // null means All, while an empty set explicitly means None. This preserves
  // the reader's selection when new seats arrive in a live roster.
  const [memberSelection, setMemberSelection] = useState<ReadonlySet<string> | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [cardWidth, setCardWidth] = useState(0);
  // Keep expertise readable as committees grow, even on a desktop. The
  // compact composition moves the same permanent labels below the diagram.
  const compact = cardWidth > 0 &&
    (cardWidth < 700 || Math.min(cardWidth, 1440) / layout.width < 11 / 13);
  const card = useRef<HTMLElement>(null);
  const live = useRunLive();
  useLayoutEffect(() => {
    const node = card.current;
    if (!node) return;
    const update = () => {
      const style = getComputedStyle(node);
      setCardWidth(node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [model.members.length > 0]);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        VERDICTS.map((verdict) => [
          verdict,
          model.edges.filter((edge) => edge.verdict === verdict).length,
        ]),
      ) as Record<Verdict, number>,
    [model.edges],
  );
  const includedCount = model.members.filter((member) => memberSelection === null || memberSelection.has(member.id)).length;
  const allMembersIncluded = includedCount === model.members.length;
  const someMembersIncluded = includedCount > 0 && !allMembersIncluded;
  const edgeColors = {
    Pass: palette.edgePass,
    Reported: palette.edgeBuild,
    Admitted: palette.edgePass,
    Rejected: palette.edgeInterrupt,
    Interrupt: palette.edgeInterrupt,
    Build: palette.edgeBuild,
  };
  const drawings = useMemo(
    () =>
      model.edges.flatMap((edge): EdgeDrawing[] => {
        if (
          !filters[edge.verdict] ||
          (memberSelection !== null && !memberSelection.has(edge.sourceId))
        )
          return [];
        const source = byId.get(edge.sourceId)?.agentNode;
        const target = byId
          .get(edge.targetId)
          ?.leds.find((led) => led.index === edge.stepIndex);
        if (!source || !target) return [];
        // A gentle inward bend leaves endpoints unambiguous without an edge bundle in the centre.
        const mx = (source.x + target.x) / 2,
          my = (source.y + target.y) / 2;
        const distance = Math.max(
          1,
          Math.hypot(target.x - source.x, target.y - source.y),
        );
        const offset =
          edge.verdict === "Interrupt"
            ? 18
            : edge.verdict === "Build"
              ? -18
              : 0;
        return [
          {
            edge,
            x1: source.x,
            y1: source.y,
            x2: target.x,
            y2: target.y,
            cx:
              mx * 0.65 +
              layout.center.x * 0.35 -
              ((target.y - source.y) / distance) * offset,
            cy:
              my * 0.65 +
              layout.center.y * 0.35 +
              ((target.x - source.x) / distance) * offset,
            color: edgeColors[edge.verdict],
          },
        ];
      }),
    [
      model.edges,
      filters,
      memberSelection,
      byId,
      layout.center,
      palette.edgePass,
      palette.edgeInterrupt,
      palette.edgeBuild,
    ],
  );

  if (!model.members.length) return null;

  return (
    <section ref={card} className="stage committee-table" aria-label="Committee round table">
      <div className="committee-drawing">
            <svg
              className="committee-svg"
              viewBox={compact
                ? `${layout.compactBounds.x} ${layout.compactBounds.y} ${layout.compactBounds.width} ${layout.compactBounds.height}`
                : `0 0 ${layout.width} ${layout.height}`}
              width={compact ? layout.compactBounds.width : layout.width}
              height={compact ? layout.compactBounds.height : layout.height}
              role="group"
              aria-label="Members and thinking steps"
            >
              <circle
                className="committee-surface"
                data-shape="table"
                cx={layout.center.x}
                cy={layout.center.y}
                r={layout.tableRadius}
                fill={palette.table}
              />
              <Connections
                drawings={drawings}
                width={layout.width}
                height={layout.height}
              />
              {layout.seats.map((seat) => {
                const member = model.members.find(
                  (item) => item.id === seat.memberId,
                )!;
                const thinking =
                  member.status === "thinking" && live && visible;
                const selected = selectedMemberId === member.id;
                return (
                  <g
                    key={member.id}
                    className="committee-seat"
                    data-selected={selected ? "true" : undefined}
                  >
                    <g
                      className="committee-person"
                      data-member-id={member.id}
                      data-thinking={thinking ? "true" : undefined}
                      role="button"
                      tabIndex={0}
                      aria-label={`${member.label} — ${member.status}`}
                      aria-description={member.expertise}
                      aria-pressed={selected}
                      onClick={() => onSelectMember?.(member.id)}
                      onKeyDown={(event) =>
                        activate(event, () => onSelectMember?.(member.id))
                      }
                    >
                      <rect
                        className="committee-person-hit"
                        x={seat.personBounds.x}
                        y={seat.personBounds.y}
                        width={seat.personBounds.width}
                        height={seat.personBounds.height}
                        rx="22"
                        fill="transparent"
                      />
                      <circle
                        className="committee-head"
                        cx={seat.head.x}
                        cy={seat.head.y}
                        r={seat.head.radius}
                        fill={palette.head}
                      />
                      <rect
                        className="committee-body"
                        x={seat.body.x}
                        y={seat.body.y}
                        width={seat.body.width}
                        height={seat.body.height}
                        rx="13"
                        fill={palette.body}
                      />
                      <text
                        className="committee-seat-label"
                        x={seat.seatLabel.x}
                        y={seat.seatLabel.y}
                        textAnchor="middle"
                      >
                        {member.label}
                      </text>
                    </g>
                    {!compact && (
                      <foreignObject
                        x={seat.expertise.anchor === "end" ? seat.expertise.x - seat.expertise.width : seat.expertise.x}
                        y={seat.expertise.y}
                        width={seat.expertise.width}
                        height={seat.expertise.height}
                        className="committee-expertise-object"
                      >
                        <div
                          className="committee-expertise"
                          data-member-expertise={member.id}
                          data-anchor={seat.expertise.anchor}
                        >
                          {member.expertiseLines.map((line, index) => (
                            <div key={index} data-expertise-line={index} title={line}>{line || "—"}</div>
                          ))}
                        </div>
                      </foreignObject>
                    )}
                    <g
                      className="committee-agent-node"
                      data-agent-node={member.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${member.label} status — ${member.status}`}
                      aria-pressed={selected}
                      onClick={() => onSelectMember?.(member.id)}
                      onKeyDown={(event) =>
                        activate(event, () => onSelectMember?.(member.id))
                      }
                    >
                      <circle
                        className="committee-node-hit"
                        cx={seat.agentNode.x}
                        cy={seat.agentNode.y}
                        r="20"
                        fill="transparent"
                      />
                      <Bulb
                        x={seat.agentNode.x}
                        y={seat.agentNode.y}
                        color={agentColor(member.status, palette, !!review)}
                        symbolColor={palette.bulb}
                      />
                    </g>
                    {seat.leds.map((led) => {
                      const step = member.steps.find(
                        (item) => item.index === led.index,
                      )!;
                      const interactive = !!onSelectStep && step.reviewable;
                      return (
                        <g
                          className="committee-led"
                          key={led.index}
                          data-member-id={member.id}
                          data-step-index={led.index}
                          data-status={step.status}
                          role="button"
                          tabIndex={interactive ? 0 : -1}
                          aria-disabled={!interactive}
                          aria-label={`${member.label}, step ${step.index}: ${statusLabel(step.status)}`}
                          onClick={() => {
                            if (interactive)
                              onSelectStep(member.id, step.index);
                          }}
                          onKeyDown={(event) =>
                            activate(event, () => {
                              if (interactive)
                                onSelectStep(member.id, step.index);
                            })
                          }
                        >
                          <title>
                            {member.label}, step {step.index}:{" "}
                            {statusLabel(step.status)}
                          </title>
                          <circle
                            className="committee-led-hit"
                            cx={led.x}
                            cy={led.y}
                            r="15"
                            fill="transparent"
                          />
                          <circle
                            className="committee-led-light"
                            cx={led.x}
                            cy={led.y}
                            r="8"
                            fill={stepColor(step.status, palette)}
                          />
                          <circle
                            cx={led.x - 2}
                            cy={led.y - 2}
                            r="2"
                            fill={palette.glint}
                            opacity=".5"
                            pointerEvents="none"
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
      </div>
      {compact && (
        <div className="committee-expertise-list" aria-label="Member expertise">
          {model.members.map((member) => (
            <button
              key={member.id}
              type="button"
              className="committee-expertise-item"
              aria-label={`${member.label} — ${member.expertise}`}
              aria-pressed={selectedMemberId === member.id}
              onClick={() => onSelectMember?.(member.id)}
            >
              <span className="committee-expertise-person" aria-hidden="true">
                <svg viewBox="0 0 44 66" width="28" height="42">
                  <circle cx="22" cy="16" r="14" fill={palette.head} />
                  <rect x="0" y="34" width="44" height="28" rx="13" fill={palette.body} />
                </svg>
                <span>{member.label}</span>
              </span>
              <span className="committee-expertise" data-member-expertise={member.id}>
                {member.expertiseLines.map((line, index) => (
                  <span key={index} data-expertise-line={index} title={line}>{line || "—"}</span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
      <footer className="committee-controls" aria-label="Round table controls">
        <div className="committee-toolbar">
          <div className="committee-heading">
            <strong>Round table</strong>
            <span>
              {model.members.length}{" "}
              {model.members.length === 1 ? "member" : "members"}
            </span>
          </div>
          <div className="committee-view-controls">
            <CommitteeColorControls
              palette={palette}
              onColorChange={setColor}
              onReset={reset}
            />
          </div>
        </div>
        {review && (
          <div
            className="committee-filter-bar"
            role="group"
            aria-label="Review connections"
          >
            {VERDICTS.filter(
              (verdict) => (verdict === "Pass" || verdict === "Interrupt") ? !model.edges.some((edge) => ["Reported", "Admitted", "Rejected"].includes(edge.verdict)) : counts[verdict] > 0,
            ).map((verdict) => (
              <SettingsToggle
                key={verdict}
                className="committee-filter"
                label={
                  <>
                    <span
                      className="committee-verdict-dot"
                      style={{ background: edgeColors[verdict] }}
                    />
                    {verdict}
                    <span className="committee-filter-count" aria-hidden="true">
                      {counts[verdict]}
                    </span>
                    <span className="sr-only"> connections</span>
                  </>
                }
                checked={filters[verdict]}
                onCheckedChange={(checked) =>
                  setFilters((current) => ({ ...current, [verdict]: checked }))
                }
              />
            ))}
          </div>
        )}
        {review && (
          <div className="committee-members" role="group" aria-label="Reviewing members">
            <span className="committee-members-label">Reviews by</span>
            <MemberCheckbox
              label="All members"
              checked={allMembersIncluded}
              mixed={someMembersIncluded}
              onChange={(checked) => setMemberSelection(checked ? null : new Set())}
            />
            {model.members.map((member) => (
              <MemberCheckbox
                key={member.id}
                label={member.label}
                checked={memberSelection === null || memberSelection.has(member.id)}
                onChange={(checked) => setMemberSelection((current) => {
                  const next = new Set(model.members.filter((item) => current === null || current.has(item.id)).map((item) => item.id));
                  if (checked) next.add(member.id);
                  else next.delete(member.id);
                  return next.size === model.members.length ? null : next;
                })}
              />
            ))}
          </div>
        )}
        <div className="committee-key">
          <span>
            <i style={{ background: palette.stepIdle }} />
            Waiting
          </span>
          <span>
            <i style={{ background: palette.stepReview }} />
            Thinking / review
          </span>
          <span>
            <i style={{ background: palette.stepReady }} />
            Ready
          </span>
          <span>
            <i style={{ background: palette.stepPassed }} />
            Passed
          </span>
          <span>
            <i style={{ background: palette.stepCapped }} />
            At limit
          </span>
        </div>
        <p className="committee-caption">
          {review
            ? `${drawings.length} review connections. Select an LED to read its step.`
            : "One LED per thinking step. Select a member to read their work."}
          {model.omittedContributions > 0 &&
            ` ${model.omittedContributions} recorded targets cannot be shown as cross-member links.`}
        </p>
      </footer>
    </section>
  );
}
