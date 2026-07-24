import { fileURLToPath } from "node:url";

import { readContentBundle, validateBundle } from "../src/index.js";
import type {
  ActivityNode,
  AgentNode,
  ContentBundle,
  IssueCode,
  ValidationIssue,
  WorkflowNode,
} from "../src/index.js";

let cached: ContentBundle | undefined;

/** Authoritative static bundle owned by Brain Registry. */
export function registryContentDir(): string {
  return (
    process.env.BRAIN_TEST_CONTENT_DIR ??
    fileURLToPath(
      new URL(
        "../../../../../brain/content/bundles/brainstorm/0.1.0/",
        import.meta.url,
      ),
    )
  );
}

/** The registry bundle, parsed once; every test mutates its own deep clone. */
export function freshBundle(): ContentBundle {
  cached ??= readContentBundle(registryContentDir());
  return structuredClone(cached);
}

export function issueCodes(issues: ValidationIssue[]): Set<IssueCode> {
  return new Set(issues.map((i) => i.code));
}

export function expectIssue(bundle: ContentBundle, code: IssueCode): ValidationIssue[] {
  const issues = validateBundle(bundle);
  if (!issues.some((i) => i.code === code)) {
    throw new Error(
      `expected an issue with code ${code}, got: ${JSON.stringify(issues.map((i) => i.code))}`,
    );
  }
  return issues;
}

export function findNode(root: WorkflowNode, id: string): WorkflowNode {
  let found: WorkflowNode | undefined;
  const walk = (node: WorkflowNode): void => {
    if (node.id === id) found = node;
    switch (node.kind) {
      case "sequence":
        node.steps.forEach(walk);
        break;
      case "forEach":
      case "repeatUntil":
        walk(node.body);
        break;
      case "condition":
        walk(node.then);
        if (node.else) walk(node.else);
        break;
      default:
        break;
    }
  };
  walk(root);
  if (!found) throw new Error(`node "${id}" not found`);
  return found;
}

export function findAgent(root: WorkflowNode, id: string): AgentNode {
  const node = findNode(root, id);
  if (node.kind !== "agent") throw new Error(`node "${id}" is a ${node.kind}, expected agent`);
  return node;
}

export function findActivity(root: WorkflowNode, id: string): ActivityNode {
  const node = findNode(root, id);
  if (node.kind !== "activity") throw new Error(`node "${id}" is a ${node.kind}, expected activity`);
  return node;
}
