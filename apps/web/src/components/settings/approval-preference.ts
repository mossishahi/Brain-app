import type { ServerSettings } from '@brainstorm-agentic/protocol';

export const askBeforeApprovalLabel = 'Ask me before approval';

/** Describe the saved preference and the separate live countdown override together. */
export function approvalPreferenceDescription(
  confirmation: ServerSettings['panelConfirmation'],
  countdown = true,
): string {
  if (confirmation === 'auto') {
    return countdown
      ? 'New research approves the proposed steps automatically.'
      : 'Automatic approval is paused. Enable “Continue after countdown” to use it for new research.';
  }
  return countdown
    ? 'Ask at approval steps, then continue after the countdown if unanswered.'
    : 'Each approval step waits for your answer.';
}
