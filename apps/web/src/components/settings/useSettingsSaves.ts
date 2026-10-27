import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerSettings, ServerSettingsUpdate } from "@brainstorm-agentic/protocol";
import { errorMessage, putSettings, updateSettings } from "../../api";
import type { SaveState, SettingsSectionId } from "./catalog";

type Builder = () => ServerSettingsUpdate | null;

/** Keep asynchronous saving separate from dialog navigation and form layout. */
export function useSettingsSaves(onSaved: (settings: ServerSettings, section: SettingsSectionId) => void) {
  const [saveState, setSaveState] = useState<Partial<Record<SettingsSectionId, SaveState>>>({});
  const [saveError, setSaveError] = useState<Partial<Record<SettingsSectionId, string>>>({});
  const errors = useRef<Partial<Record<SettingsSectionId, string>>>({});
  const sequence = useRef<Partial<Record<SettingsSectionId, number>>>({});
  const pending = useRef(new Map<SettingsSectionId, { timer: number; build: Builder }>());
  const inFlight = useRef(new Set<Promise<ServerSettings | undefined>>());
  const savedTimers = useRef(new Set<number>());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // Debounced builders are refreshed each render so typing saves the latest value.
  const builders = useRef<Partial<Record<SettingsSectionId, Builder>>>({});

  /** Forget feedback for an obsolete draft without undoing an authorized write. */
  const reset = useCallback((section: SettingsSectionId) => {
    sequence.current[section] = (sequence.current[section] ?? 0) + 1;
    const slot = pending.current.get(section);
    if (slot) window.clearTimeout(slot.timer);
    pending.current.delete(section);
    delete errors.current[section];
    setSaveState(current => ({ ...current, [section]: "idle" }));
    setSaveError(current => ({ ...current, [section]: undefined }));
  }, []);

  const reject = useCallback((section: SettingsSectionId, message: string) => {
    sequence.current[section] = (sequence.current[section] ?? 0) + 1;
    errors.current[section] = message;
    setSaveError((current) => ({ ...current, [section]: message }));
    setSaveState((current) => ({ ...current, [section]: "error" }));
  }, []);

  const save = useCallback((section: SettingsSectionId, patch: ServerSettingsUpdate | ((current: ServerSettings) => ServerSettingsUpdate)): Promise<ServerSettings | undefined> => {
    const mine = (sequence.current[section] ?? 0) + 1;
    sequence.current[section] = mine;
    delete errors.current[section];
    setSaveState((current) => ({ ...current, [section]: "saving" }));
    setSaveError((current) => ({ ...current, [section]: undefined }));
    const request = (typeof patch === "function" ? updateSettings(patch) : putSettings(patch)).then((saved) => {
      // Persisted settings remain authoritative even when its draft feedback
      // was invalidated by an edit or provider switch during verification.
      onSavedRef.current(saved, section);
      if (sequence.current[section] !== mine) return saved;
      setSaveState((current) => ({ ...current, [section]: "saved" }));
      const timer = window.setTimeout(() => {
        savedTimers.current.delete(timer);
        setSaveState((current) => sequence.current[section] === mine ? { ...current, [section]: "idle" } : current);
      }, 2000);
      savedTimers.current.add(timer);
      return saved;
    }, (error: unknown) => {
      if (sequence.current[section] === mine) {
        const message = errorMessage(error);
        errors.current[section] = message;
        setSaveError((current) => ({ ...current, [section]: message }));
        setSaveState((current) => ({ ...current, [section]: "error" }));
      }
      return undefined;
    });
    inFlight.current.add(request);
    void request.finally(() => inFlight.current.delete(request));
    return request;
  }, []);

  const saveSoon = useCallback((section: SettingsSectionId) => {
    const previous = pending.current.get(section);
    if (previous) window.clearTimeout(previous.timer);
    const build = () => builders.current[section]?.() ?? null;
    const timer = window.setTimeout(() => {
      pending.current.delete(section);
      const patch = build();
      if (patch) void save(section, patch);
    }, 700);
    pending.current.set(section, { timer, build });
  }, [save]);

  const flushPending = useCallback(async () => {
    do {
      const edits = [...pending.current];
      pending.current.clear();
      for (const [section, slot] of edits) {
        window.clearTimeout(slot.timer);
        const patch = slot.build();
        if (patch) void save(section, patch);
      }
      await Promise.all([...inFlight.current]);
    } while (pending.current.size || inFlight.current.size);
    return Object.keys(errors.current).length === 0;
  }, [save]);

  useEffect(() => () => {
    for (const timer of savedTimers.current) window.clearTimeout(timer);
    // A route replacement must not silently drop an already-authorized autosave.
    void flushPending();
  }, [flushPending]);

  return { save, reject, reset, saveSoon, flushPending, saveState, saveError, builders, errors };
}
