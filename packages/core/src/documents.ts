/** Host-owned immutable source snapshots. Reading receipts attest delivery, never truth or comprehension. */
export interface DocumentQuery {
  readonly operation: "open" | "read" | "search" | "page_image";
  readonly source?: string;
  readonly documentId?: string;
  readonly cursor?: string;
  readonly sectionId?: string;
  /** PDF physical page, 1-based (printed labels are returned separately). */
  readonly page?: number;
  readonly query?: string;
  readonly maxChars?: number;
  readonly maxResults?: number;
}
export interface DocumentLocator {
  readonly segmentId: string;
  readonly page?: number;
  readonly pageLabel?: string;
  readonly sectionId?: string;
  readonly heading?: string;
  readonly paragraph?: number;
  readonly start: number;
  readonly end: number;
}
export interface DocumentPassage {
  readonly locator: DocumentLocator;
  readonly text: string;
}
export interface DocumentDescriptor {
  readonly documentId: string;
  readonly sha256: string;
  readonly representationHash: string;
  readonly source: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly title?: string;
  readonly fetchedAt: string;
  readonly access: "retrieved";
  readonly extraction: "text" | "partial" | "no-text";
  readonly contentScope?: "abstract-or-landing";
  readonly warnings: readonly string[];
  readonly pageCount?: number;
  readonly segmentCount: number;
  readonly outline: readonly { readonly sectionId: string; readonly heading: string; readonly page?: number }[];
}
export interface DocumentReceipt {
  readonly receiptId: string;
  readonly documentId: string;
  readonly sha256: string;
  readonly representationHash: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly nodePath?: string;
  readonly at: string;
  readonly source: string;
  readonly finalUrl: string;
  readonly segmentCount: number;
  readonly operation: "read" | "search" | "page_image";
  readonly access: "retrieved";
  readonly extraction: DocumentDescriptor["extraction"];
  readonly segmentIds: readonly string[];
  readonly locators: readonly DocumentLocator[];
  /** Hash of the exact delivered text or image bytes. */
  readonly deliveredHash: string;
}
export interface DocumentAnswer {
  readonly operation: DocumentQuery["operation"];
  readonly document: DocumentDescriptor;
  readonly passages?: readonly DocumentPassage[];
  readonly nextCursor?: string;
  readonly receipt?: DocumentReceipt;
  /** Image bytes are delivered by provider adapters as actual image content blocks. */
  readonly image?: { readonly mimeType: "image/png"; readonly data: string; readonly page: number };
  readonly note: string;
}

export interface DocumentCoverage {
  readonly document: DocumentDescriptor;
  /** All segments of this saved rendition were delivered, not proof of understanding or full publisher access. */
  readonly fullyDelivered: boolean;
  readonly deliveredSegmentIds: readonly string[];
}
