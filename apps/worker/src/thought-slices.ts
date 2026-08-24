/**
 * Per-step thought slices — the algorithm lives in @brainstorm-agentic/core
 * now, because the server needs the SAME cut to serve untruncated downloads
 * from the full artifact trace. This module stays as the worker's import
 * path; see core's agent/thought-slices.ts for the contract.
 */
export {
  MAX_THOUGHT_SLICE_CHARS,
  sliceThoughtsBySteps,
  THOUGHT_TRUNCATION_MARK,
  wholeThinkingTrace,
  type ThoughtSlice,
} from "@brainstorm-agentic/core";
