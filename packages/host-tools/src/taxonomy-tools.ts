/**
 * Provider-neutral taxonomy tools satisfying the `taxonomy-access` capability.
 *
 * Both are READS of the shared live taxonomy (the Brain Registry's single
 * revision-counted store): the whole latest tree as a names-only outline, and
 * exact resolution of one name. Recording decisions is deliberately NOT a
 * tool — the deterministic taxonomy.suggest activity submits them, so an
 * agent can never write to the shared reference.
 */
import type { JsonValue, TaxonomyAccess, Tool } from "@brainstorm-agentic/core";
import type { HostToolManifest } from "@brainstorm-agentic/core";

const TAXONOMY_TREE_DEFINITION = {
  name: "taxonomy_tree",
  description:
    "Fetch the complete CURRENT shared scientific taxonomy as a names-only indented outline " +
    "(no indent = domain, one = field, two = subfield, three = topic), stamped with the live " +
    "revision it was read at. Optionally pass `root` (an exact node name) to fetch one branch. " +
    "Read it in full before deciding any placement.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description: "Exact node name (or id) to export the subtree of; omit for the whole tree.",
      },
    },
    additionalProperties: false,
  },
} as const;

const TAXONOMY_RESOLVE_DEFINITION = {
  name: "taxonomy_resolve",
  description:
    "Resolve one field name against the shared taxonomy at its latest revision. Returns the " +
    "exact position when the name (or a curated alias) exists, otherwise NA with candidate " +
    "node names. Use it to check whether a field you are about to place already exists under " +
    "another spelling.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The field name to resolve." },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export const TAXONOMY_TREE_MANIFEST: HostToolManifest = {
  toolId: "taxonomy_tree",
  displayName: "Taxonomy Tree",
  operations: ["taxonomy.tree"],
  risk: "low",
  defaultEnabled: true,
  definition: TAXONOMY_TREE_DEFINITION,
};

export const TAXONOMY_RESOLVE_MANIFEST: HostToolManifest = {
  toolId: "taxonomy_resolve",
  displayName: "Taxonomy Resolve",
  operations: ["taxonomy.resolve"],
  risk: "low",
  defaultEnabled: true,
  definition: TAXONOMY_RESOLVE_DEFINITION,
};

export const TAXONOMY_MANIFESTS: readonly HostToolManifest[] = [
  TAXONOMY_TREE_MANIFEST,
  TAXONOMY_RESOLVE_MANIFEST,
];

export const TAXONOMY_TOOL_NAMES = ["taxonomy_tree", "taxonomy_resolve"] as const;

/** Create executable taxonomy read tools over the given shared-taxonomy access. */
export function taxonomyTools(taxonomy: TaxonomyAccess): readonly Tool[] {
  const treeTool: Tool = {
    definition: TAXONOMY_TREE_DEFINITION,
    async execute(input) {
      const root =
        typeof input === "object" && input !== null && !Array.isArray(input) &&
        typeof (input as { root?: JsonValue }).root === "string" &&
        ((input as { root: string }).root.trim() !== "")
          ? (input as { root: string }).root
          : undefined;
      try {
        const result = await taxonomy.tree(root);
        return {
          output:
            `taxonomy revision ${result.revision} — ${result.nodeCount} nodes` +
            `\n${result.outline}`,
        };
      } catch (error) {
        return {
          output: `The shared taxonomy could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true as const,
        };
      }
    },
  };

  const resolveTool: Tool = {
    definition: TAXONOMY_RESOLVE_DEFINITION,
    async execute(input) {
      const query =
        typeof input === "object" && input !== null && !Array.isArray(input) &&
        typeof (input as { query?: JsonValue }).query === "string"
          ? (input as { query: string }).query
          : undefined;
      if (!query || query.trim() === "") {
        return { output: "taxonomy_resolve requires a non-empty `query`.", isError: true as const };
      }
      try {
        const result = await taxonomy.resolve(query);
        return { output: JSON.stringify(result) as unknown as JsonValue };
      } catch (error) {
        return {
          output: `The shared taxonomy could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true as const,
        };
      }
    },
  };

  return [treeTool, resolveTool];
}
