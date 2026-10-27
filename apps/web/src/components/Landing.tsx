/** Persistent home composer. The shell owns history, trash, and their live feed. */
import { useCallback, useEffect, useState } from "react";
import type { ServerSettings } from "@brainstorm-agentic/protocol";
import { blockedReadiness, errorMessage, getSettings, submitJob } from "../api";
import { diagnoseOverviewReadiness, publishOverviewReadiness, recheckOverviewReadiness, refreshOverviewJobs, refreshOverviewReadiness, useOverviewReadiness } from "../features/library/WorkspaceOverview";
import type { PrefillRequest } from "../features/library/types";
import { ResearchHeadline } from "../features/composer/ResearchHeadline";
import "../features/composer/canvas-composer.css";
import { ProviderOnboarding, onboardingDismissed, onboardingNeeded } from "./ProviderOnboarding";
import { SubmissionBox } from "./SubmissionBox";

export function Landing({ onOpenSettings, onSubmitted, active = true, onIntroComplete, prefillRequest }: {
  readonly onOpenSettings: () => void;
  readonly onSubmitted: (jobId: string) => void;
  readonly active?: boolean;
  readonly onIntroComplete?: () => void;
  readonly prefillRequest?: PrefillRequest;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [onboardingHidden, setOnboardingHidden] = useState(onboardingDismissed);
  const readiness = useOverviewReadiness(active);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void getSettings().then((current) => { if (live) setSettings(current); }).catch(() => undefined);
    const onSettingsUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ServerSettings>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener("brain-settings-updated", onSettingsUpdated);
    return () => { live = false; window.removeEventListener("brain-settings-updated", onSettingsUpdated); };
  }, [active]);

  const submit = useCallback(async (topic: string, attachmentPaths: readonly string[], capabilityOverrides: Readonly<Record<string, boolean>>): Promise<void> => {
    setSubmitError(null);
    try {
      const submitted = await submitJob(topic, attachmentPaths, capabilityOverrides);
      // Acceptance is authoritative even if a subsequent list refresh fails.
      void refreshOverviewJobs();
      onSubmitted(submitted.jobId);
    } catch (error) {
      const blocked = blockedReadiness(error);
      if (blocked) publishOverviewReadiness(blocked);
      else setSubmitError(errorMessage(error));
      throw error;
    }
  }, [onSubmitted]);

  return <section className="landing canvas-landing canvas-landing-home" aria-label="New research">
    <div className="landing-column canvas-home">
      <div className="canvas-home-intro"><ResearchHeadline active={active} onIntroComplete={onIntroComplete} /></div>
      <SubmissionBox active={active} onSubmit={submit} onOpenSettings={onOpenSettings} readiness={readiness.data} onRecheckReadiness={recheckOverviewReadiness} onDiagnoseReadiness={diagnoseOverviewReadiness} {...(prefillRequest ? { prefill: prefillRequest } : {})} />
      {submitError && <p className="error-text submit-error" role="alert">{submitError}</p>}
      {readiness.error && <div className="canvas-readiness-error" role="status"><span>Environment checks could not be refreshed. {readiness.error}</span><button type="button" className="btn btn-small" onClick={() => void refreshOverviewReadiness()}>Retry checks</button></div>}
    </div>
    {!onboardingHidden && settings !== null && onboardingNeeded(settings) && active && <ProviderOnboarding settings={settings} onSaved={(updated) => { setSettings(updated); recheckOverviewReadiness(); }} onDismiss={() => setOnboardingHidden(true)} />}
  </section>;
}
