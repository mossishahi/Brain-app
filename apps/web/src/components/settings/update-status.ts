import type { UpdateCheckResponse } from '@brainstorm-agentic/protocol';

/** A failed or disabled server release probe must never claim the app is current. */
export function updateCheckMessage(result: UpdateCheckResponse): string {
  if (result.selfUpdateEnabled === false) return `This research service is managed by its installation; browser updates are unavailable here. Running v${result.version}.`;
  if (result.appUpdate) return `Release v${result.appUpdate.version} was reported. Use the update notification to install it.`;
  return `No newer release was reported. Running v${result.version}.`;
}
