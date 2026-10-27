export interface PrefillRequest {
  readonly topic: string;
  readonly attachmentPaths: readonly string[];
  readonly nonce: number;
}

export type LibrarySection = "history" | "trash";
