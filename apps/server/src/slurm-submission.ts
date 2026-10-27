/** A confirmed scheduler receipt, independent of sbatch's display format. */
export interface SlurmSubmissionReceipt {
  readonly jobId: string;
  readonly cluster?: string;
}

/**
 * Request --parsable, but retain compatibility with site wrappers that print
 * the human-readable receipt (sometimes on stderr). Never mistake a warning's
 * embedded number for a job ID, or choose between conflicting receipts.
 */
export function slurmSubmissionReceipt(
  stdout: string,
  stderr = "",
): SlurmSubmissionReceipt | undefined {
  const receipts: SlurmSubmissionReceipt[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)(?:;([A-Za-z0-9_.-]+))?$/.exec(line.trim());
    if (match) receipts.push({ jobId: match[1]!, ...(match[2] ? { cluster: match[2] } : {}) });
  }
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const match = /^Submitted batch job\s+(\d+)(?:\s+on cluster\s+([A-Za-z0-9_.-]+))?\s*$/.exec(line.trim());
    if (match) receipts.push({ jobId: match[1]!, ...(match[2] ? { cluster: match[2] } : {}) });
  }
  const first = receipts[0];
  if (!first || receipts.some((receipt) => receipt.jobId !== first.jobId || receipt.cluster !== first.cluster)) {
    return undefined;
  }
  return first;
}

/** Preserve useful scheduler diagnostics even when a wrapper exits zero. */
export function slurmSubmissionDiagnostic(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 4096)
    || "no output on stdout or stderr";
}
