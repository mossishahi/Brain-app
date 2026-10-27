import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { GpuRunSettings } from "@brainstorm-agentic/protocol";
import { atomicWriteJson, readJsonFile } from "./files.js";

export function gpuProfileDigest(gpu: GpuRunSettings): string {
  return createHash("sha256").update(JSON.stringify([gpu.template, gpu.timeLimitMinutes])).digest("hex");
}

const proofPath = (workspace: string): string => join(workspace, "gpu-setup", "verified.json");

/** Server-owned proof; the settings API never accepts a verification flag. */
export function gpuProfileVerified(workspace: string, gpu: GpuRunSettings | undefined): boolean {
  if (!gpu?.template.trim()) return false;
  try {
    const proof = readJsonFile<{ digest: string; host: string }>(proofPath(workspace));
    return proof?.digest === gpuProfileDigest(gpu) && proof.host === hostname();
  } catch { return false; }
}

export function verifyGpuProfile(workspace: string, gpu: GpuRunSettings, jobId: string): void {
  atomicWriteJson(proofPath(workspace), {
    digest: gpuProfileDigest(gpu), host: hostname(), jobId, verifiedAt: new Date().toISOString(),
  });
}

export function revokeGpuProfile(workspace: string): void {
  rmSync(proofPath(workspace), { force: true });
}
