/**
 * Extension interfaces for future code-execution host tools.
 * These are NOT implemented in this package yet — they define the contract
 * for sandbox backends that can be plugged in later.
 */
import type { HostToolManifest } from "@brainstorm-agentic/core";

// ---------------------------------------------------------------------------
// Sandbox backend interface
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface CodeSandbox {
  execute(input: {
    language: "python";
    code: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Manifest (static; tool is not yet executable)
// ---------------------------------------------------------------------------

export const CODE_EXECUTE_MANIFEST: HostToolManifest = {
  toolId: "code_execute",
  displayName: "Code Execute",
  operations: ["code.execute"],
  risk: "high",
  defaultEnabled: false,
  definition: {
    name: "code_execute",
    description:
      "Run a short, self-contained Python script in an isolated environment. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python"],
          description: "Script language (currently only python).",
        },
        code: {
          type: "string",
          description: "Self-contained script source code.",
        },
        timeout_ms: {
          type: "integer",
          description: "Maximum execution time in milliseconds.",
          minimum: 1000,
          maximum: 30000,
          default: 10000,
        },
      },
      required: ["language", "code"],
      additionalProperties: false,
    },
  },
};

export const CODE_EXECUTION_MANIFESTS: readonly HostToolManifest[] = [
  CODE_EXECUTE_MANIFEST,
];
