import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

interface RegistryIndexBundle {
  readonly id: string;
  readonly latest: string;
  readonly versions: readonly string[];
}

const brainRepoRoot = fileURLToPath(new URL("../../../../../brain/", import.meta.url));
let storeMaterialized = false;

/**
 * The registry's serving store, materialized from the brain repo's release
 * tags (the repo itself carries only the editable source tree). Idempotent
 * and append-only, so sharing the store across suites is safe.
 */
function registryRoot(): string {
  if (!storeMaterialized) {
    execFileSync(
      process.execPath,
      [join(brainRepoRoot, "scripts", "materialize-store.mjs"), "--quiet"],
      { stdio: "inherit" },
    );
    storeMaterialized = true;
  }
  return join(brainRepoRoot, ".registry-store");
}

function brainstormIndexEntry(): RegistryIndexBundle {
  const index = JSON.parse(
    readFileSync(join(registryRoot(), "index.json"), "utf8"),
  ) as { readonly bundles: readonly RegistryIndexBundle[] };
  const entry = index.bundles.find((bundle) => bundle.id === "brainstorm");
  if (!entry) throw new Error("the registry index does not publish a brainstorm bundle");
  return entry;
}

function versionDir(version: string): string {
  return `${join(registryRoot(), "bundles", "brainstorm", version)}/`;
}

/**
 * The single version this suite executes, from the repo-root pin.
 *
 * Deliberately NOT the index's `latest`: that made a registry publish rewrite
 * the inputs of app tags that had already shipped, so content alone could turn
 * a released commit red. `BRAIN_TEST_BUNDLE_VERSION` overrides the pin for one
 * run, and its literal value "latest" asks for the old floating resolution —
 * the CI canary lane, which reports the cost of the next bump but does not get
 * to fail the workflow.
 */
function pinnedBundleVersion(): string {
  const override = process.env.BRAIN_TEST_BUNDLE_VERSION;
  if (override === "latest") return brainstormIndexEntry().latest;
  if (override) return override;
  return (
    JSON.parse(
      readFileSync(new URL("../../../../test-bundle.json", import.meta.url), "utf8"),
    ) as { readonly version: string }
  ).version;
}

/** Every version the registry index publishes; all of them must stay valid. */
export function publishedContentDirs(): readonly { version: string; dir: string }[] {
  return brainstormIndexEntry().versions.map((version) => ({
    version,
    dir: versionDir(version),
  }));
}

/** Authoritative static bundle owned by Brain Registry: the pinned version. */
export function registryContentDir(): string {
  return process.env.BRAIN_TEST_CONTENT_DIR ?? versionDir(pinnedBundleVersion());
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
