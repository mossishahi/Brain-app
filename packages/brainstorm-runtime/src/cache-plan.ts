/**
 * Which payload sections of a task turn are byte-stable across the calls one
 * run makes — the input to the task message's cache boundaries.
 *
 * A review walk re-sends the same structured input and the same attachment
 * map on every commentor, judge, and redevelopment call, so a provider that
 * caches prompt prefixes can serve that span at a fraction of the input
 * price. Declaring which span is stable must never become app-side knowledge
 * of what the content means ("input and files are stable"), or it silently
 * rots the first time a bundle rebinds a task. It is derived structurally
 * instead, from the workflow the run pinned:
 *
 * - every loop VARIABLE (`member`, `commentor`, `stepIndex`, …) marks the
 *   references that vary per iteration;
 * - every state root WRITTEN inside a loop (`ideas`, `reviews`) marks the
 *   values a later iteration can change.
 *
 * A bind that touches neither resolves to the same value for the whole run.
 * The rule is deliberately conservative: anything it cannot prove stable is
 * treated as volatile, which costs a cache read, never correctness.
 */
import type {
  BindValue,
  WorkflowDefinition as ContentWorkflowDefinition,
  WorkflowNode as ContentWorkflowNode,
} from "@brainstorm-agentic/content";

import { parseDataReference } from "./data-ref.js";

/** Stable payload variable names per agent node id. */
export type TaskCachePlan = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The root identifiers a reference reads: its own root plus the root of every
 * bracketed sub-reference (`ideas[member.id].cot` reads `ideas` AND `member`).
 * Dotted segments after the root are keys INSIDE the value, never roots — so
 * a payload field that happens to be called `member` cannot be mistaken for
 * the loop variable.
 */
function referenceRoots(ref: string): readonly string[] {
  let tokens;
  try {
    tokens = parseDataReference(ref);
  } catch {
    // An unparsable reference fails elsewhere with a real message; here it
    // only means "cannot prove stable".
    return ["\u0000unparsable"];
  }
  const roots: string[] = [];
  const first = tokens[0];
  if (first?.kind === "property") roots.push(first.key);
  for (const token of tokens) {
    if (token.kind === "dynamic") roots.push(...referenceRoots(token.ref));
  }
  return roots;
}

/** Every reference a bind reads, including its optional `through` slice. */
function bindReferences(bind: BindValue): readonly string[] {
  if (typeof bind === "string") return [bind];
  return bind.through === undefined ? [bind.ref] : [bind.ref, bind.through];
}

function isStableBind(bind: BindValue, volatileRoots: ReadonlySet<string>): boolean {
  return bindReferences(bind).every((ref) =>
    referenceRoots(ref).every((root) => !volatileRoots.has(root)),
  );
}

interface VolatileScan {
  readonly loopVars: Set<string>;
  readonly loopWritten: Set<string>;
}

function recordWrite(key: string, scan: VolatileScan): void {
  const [root] = referenceRoots(key);
  if (root !== undefined) scan.loopWritten.add(root);
}

function scanNode(
  node: ContentWorkflowNode,
  insideLoop: boolean,
  scan: VolatileScan,
): void {
  switch (node.kind) {
    case "sequence":
      for (const step of node.steps) scanNode(step, insideLoop, scan);
      return;
    case "condition":
      scanNode(node.then, insideLoop, scan);
      if (node.else) scanNode(node.else, insideLoop, scan);
      return;
    case "forEach":
      scan.loopVars.add(node.itemVar);
      if (node.indexVar !== undefined) scan.loopVars.add(node.indexVar);
      scanNode(node.body, true, scan);
      return;
    case "repeatUntil":
      scanNode(node.body, true, scan);
      return;
    case "agent":
    case "activity":
      if (insideLoop) recordWrite(node.output.key, scan);
      return;
    case "humanGate":
      if (insideLoop) {
        for (const action of node.gate.actions) {
          if (action.edits !== undefined) recordWrite(action.edits, scan);
        }
      }
      return;
    case "terminal":
      return;
  }
}

function collectAgents(
  node: ContentWorkflowNode,
  out: Array<{ id: string; bind: Readonly<Record<string, BindValue>> }>,
): void {
  switch (node.kind) {
    case "sequence":
      for (const step of node.steps) collectAgents(step, out);
      return;
    case "condition":
      collectAgents(node.then, out);
      if (node.else) collectAgents(node.else, out);
      return;
    case "forEach":
    case "repeatUntil":
      collectAgents(node.body, out);
      return;
    case "agent":
      out.push({ id: node.id, bind: node.bind ?? {} });
      return;
    default:
      return;
  }
}

/**
 * One pass over the pinned workflow: for every agent node, the bind names
 * whose value is identical in every call the run makes.
 */
export function planTaskCaches(content: ContentWorkflowDefinition): TaskCachePlan {
  const scan: VolatileScan = { loopVars: new Set(), loopWritten: new Set() };
  scanNode(content.root, false, scan);
  const volatileRoots = new Set([...scan.loopVars, ...scan.loopWritten]);

  const agents: Array<{ id: string; bind: Readonly<Record<string, BindValue>> }> = [];
  collectAgents(content.root, agents);
  const plan = new Map<string, ReadonlySet<string>>();
  for (const agent of agents) {
    const stable = new Set<string>();
    for (const [name, bind] of Object.entries(agent.bind)) {
      if (isStableBind(bind, volatileRoots)) stable.add(name);
    }
    plan.set(agent.id, stable);
  }
  return plan;
}
