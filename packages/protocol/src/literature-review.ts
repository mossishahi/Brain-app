/** A submitted, attributable literature deliverable. Not a shared fact table. */
export interface LiteratureReviewBodyView {
  readonly schemaVersion: "literature-review/v1";
  readonly scope: {
    readonly question: string;
    readonly inputRequirements: readonly { readonly id: string; readonly text: string }[];
    readonly vantage: string;
  };
  readonly search: {
    readonly queries: readonly { readonly query: string; readonly source: string; readonly evidenceRefIds: readonly string[] }[];
    readonly coverage: string;
    readonly limitations: readonly string[];
  };
  readonly works: readonly LiteratureWorkView[];
  readonly synthesis: {
    readonly closestWorkIds: readonly string[];
    readonly assessment: "solved" | "partially-solved" | "open" | "undetermined";
    readonly findings: string;
    readonly gaps: readonly string[];
    readonly comparisons: readonly string[];
  };
  readonly status: "complete" | "incomplete" | "no-relevant-works";
  readonly statusReason: string;
}

export interface LiteratureWorkView {
  readonly id: string;
  readonly source: {
    readonly title: string;
    readonly authors: readonly string[];
    readonly year: number | null;
    readonly venue: string | null;
    readonly url: string;
    readonly doi: string | null;
    readonly version: string | null;
  };
  readonly inspected: {
    readonly level: "metadata" | "abstract" | "sections" | "full-text";
    readonly evidence: readonly { readonly documentId: string; readonly receiptId: string; readonly segmentId: string; readonly locator: string }[];
    readonly accessLimitations: readonly string[];
  };
  readonly method: string;
  readonly results: string;
  readonly conditions: readonly string[];
  readonly limitations: readonly string[];
  readonly relevance: readonly {
    readonly requirementId: string;
    readonly relationship: "solves" | "partially-addresses" | "supports" | "contradicts" | "background" | "not-applicable";
    readonly justification: string;
  }[];
  readonly intendedUse: readonly string[];
  readonly uncertainties: readonly string[];
}

export interface LiteratureReviewView {
  readonly reviewId: string;
  readonly revision: number;
  readonly state: "submitted";
  readonly owner: {
    readonly runId: string;
    readonly taskId: string;
    readonly agentId?: string;
    readonly nodePath: string;
    readonly role: string;
  };
  readonly inputRevision: string;
  readonly inputRequirements: readonly { readonly id: string; readonly text: string }[];
  readonly review: LiteratureReviewBodyView;
  readonly createdAt: number;
  readonly updatedAt: number;
}
