/**
 * Ordering for the plain `major.minor.patch` versions this app compares:
 * the Node floor every process checks at launch, and the app floor a content
 * bundle may declare for itself. Both ask the same question — is what is
 * running at least what is required — so both ask it of one implementation.
 *
 * Deliberately not a semver library: the versions involved are release tags
 * and runtime versions, never ranges or prereleases, and a missing or
 * malformed part reads as 0 so a comparison never throws in a launch path.
 */
function parts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** True when `version` is the same as, or newer than, `minimum`. */
export function atLeastVersion(version: string, minimum: string): boolean {
  const [candidate, floor] = [parts(version), parts(minimum)];
  for (let index = 0; index < 3; index += 1) {
    const a = candidate[index] ?? 0;
    const b = floor[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
