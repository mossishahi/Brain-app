/** The horizontal SVG pipeline minimap: eight nodes joined by 1px connectors. */
import type { KeyboardEvent } from "react";
import { STAGE_IDS } from "@brainstorm-agentic/protocol";
import type {
  ReviewCursorView,
  StageId,
  StageStatus,
  StageView,
} from "@brainstorm-agentic/protocol";
import { STAGE_GRAPH_LABELS } from "../format";

const NODE_H = 44;
const TOP = 14;
const GAP = 24;
const PAD = 4;
const LABEL_Y = TOP + NODE_H + 18;
const VIEW_H = LABEL_Y + 10;

interface NodePos {
  readonly id: StageId;
  readonly x: number;
  readonly w: number;
}

const LAYOUT: { nodes: readonly NodePos[]; width: number } = (() => {
  let x = PAD;
  const nodes = STAGE_IDS.map((id) => {
    const w = id === "review-members" ? 140 : 96;
    const node = { id, x, w };
    x += w + GAP;
    return node;
  });
  return { nodes, width: x - GAP + PAD };
})();

function statusClass(status: StageStatus): string {
  switch (status) {
    case "active":
      return "node-active";
    case "suspended":
    case "credit_blocked":
      return "node-suspended";
    case "failed":
      return "node-failed";
    case "completed":
      return "node-completed";
    default:
      return "";
  }
}

export function PipelineGraph({
  stages,
  selected,
  cursor,
  onSelect,
}: {
  stages: ReadonlyMap<StageId, StageView>;
  selected: StageId;
  cursor?: ReviewCursorView;
  onSelect: (id: StageId) => void;
}) {
  return (
    <div className="graph-wrap">
      <svg
        className="graph"
        viewBox={`0 0 ${LAYOUT.width} ${VIEW_H}`}
        role="group"
        aria-label="pipeline stages"
      >
        {LAYOUT.nodes.slice(0, -1).map((node, index) => {
          const next = LAYOUT.nodes[index + 1]!;
          const done =
            stages.get(node.id)?.status === "completed" &&
            stages.get(next.id)?.status === "completed";
          return (
            <line
              key={node.id}
              className={`connector${done ? " connector-done" : ""}`}
              x1={node.x + node.w}
              y1={TOP + NODE_H / 2}
              x2={next.x}
              y2={TOP + NODE_H / 2}
            />
          );
        })}
        {LAYOUT.nodes.map((node) => {
          const id = node.id;
          const status: StageStatus = stages.get(id)?.status ?? "pending";
          const label = STAGE_GRAPH_LABELS[id];
          const isReview = id === "review-members";
          const showCursor =
            isReview && status === "active" && cursor !== undefined;
          const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(id);
            }
          };
          return (
            <g
              key={id}
              className={`graph-node ${statusClass(status)}${selected === id ? " node-selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${label} stage: ${status}${selected === id ? ", selected" : ""}`}
              onClick={() => onSelect(id)}
              onKeyDown={onKeyDown}
            >
              <rect
                className="node-rect"
                x={node.x}
                y={TOP}
                width={node.w}
                height={NODE_H}
                rx={8}
              />
              {status === "active" && (
                <rect
                  className="node-pulse"
                  x={node.x}
                  y={TOP}
                  width={node.w}
                  height={NODE_H}
                  rx={8}
                />
              )}
              {showCursor && cursor && (
                <text
                  className="node-sub"
                  x={node.x + node.w / 2}
                  y={TOP + NODE_H / 2 + 4}
                  textAnchor="middle"
                >
                  {`${cursor.member}/${cursor.memberCount} · ${cursor.step}/${cursor.stepCount} · r${cursor.round}`}
                </text>
              )}
              <text
                className="node-label"
                x={node.x + node.w / 2}
                y={LABEL_Y}
                textAnchor="middle"
              >
                {label}
              </text>
              {status === "completed" && (
                <g transform={`translate(${node.x + node.w - 7}, ${TOP + 1})`}>
                  <circle className="node-check-circle" r={7} />
                  <path
                    className="node-check-mark"
                    d="M-2.8 0 L-0.8 2.1 L2.9 -2.3"
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
