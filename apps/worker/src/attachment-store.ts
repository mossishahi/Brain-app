/**
 * Where this run's attachment store is — including when nobody said.
 *
 * The manifest names the ROOT the attachment tools read through. Without it
 * the worker has no roots, deletes the attachment tools, withdraws the
 * provider's file offers, and the capability broker truthfully reports the
 * submitted files as unavailable — which reaches every agent as an
 * instruction to say so and reason from metadata instead. On one real run that
 * cost 442 consecutive tasks their files for seventeen hours: every commenter,
 * judge and redeveloper, each faithfully writing that it had no file access,
 * while the store sat on disk the whole time.
 *
 * The server names the manifest on every submission it builds. This is the
 * belt to that braces, for the launches it does not build: a resume script
 * written by an older version (a long run can carry thousands of them), a
 * hand-run command, a future path that forgets. The store's location is not a
 * secret the launcher holds — it is a fixed place inside the job directory,
 * and the events file the same command line names sits at that directory's
 * root.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ManifestChoice {
  readonly path: string;
  /**
   * True when nobody passed the manifest and it was found anyway. The caller
   * says so out loud: a run reading its files because of a fallback is a
   * launcher bug that has been survived, not a thing to pass over in silence.
   */
  readonly recovered: boolean;
}

export function manifestPathFor(
  flag: string | undefined,
  eventsFile: string | undefined,
  exists: (path: string) => boolean = existsSync,
): ManifestChoice | undefined {
  // What the launcher said always wins: it may point at a store that is NOT
  // beside the events file (a relocated workspace, a test), and second-guessing
  // it would be the same silent substitution this exists to prevent.
  if (flag !== undefined) return { path: flag, recovered: false };
  if (eventsFile === undefined) return undefined;
  const conventional = join(dirname(eventsFile), "attachments", "manifest.json");
  if (!exists(conventional)) return undefined;
  return { path: conventional, recovered: true };
}
