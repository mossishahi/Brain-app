import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { LuPalette, LuRotateCcw } from "react-icons/lu";

const GROUPS = {
  Shapes: {
    table: "Table",
    head: "Head",
    body: "Body",
    bulb: "Bulb symbol",
    glint: "LED glint",
  },
  Agents: {
    agentIdle: "Agent waiting",
    agentThinking: "Agent working",
    agentReady: "Agent draft ready",
    agentCompleted: "Agent completed",
    agentPaused: "Agent paused",
    agentFailed: "Agent failed",
    agentDismissed: "Agent dismissed",
  },
  Steps: {
    stepIdle: "Step waiting",
    stepReady: "Step ready",
    stepReview: "Step under review",
    stepPassed: "Step passed",
    stepCapped: "Step passed at limit",
    stepStopped: "Step stopped",
  },
  Links: {
    edgePass: "Pass connections",
    edgeInterrupt: "Interrupt connections",
    edgeBuild: "Build connections",
  },
} as const;
type ColorGroup = keyof typeof GROUPS;
const LABELS = {
  ...GROUPS.Shapes,
  ...GROUPS.Agents,
  ...GROUPS.Steps,
  ...GROUPS.Links,
};
export type CommitteeColor = keyof typeof LABELS;
export type CommitteePalette = Record<CommitteeColor, string>;
const DARK: CommitteePalette = {
  table: "#172334",
  head: "#a6b2d4",
  body: "#a6b2d4",
  bulb: "#ffffff",
  glint: "#ffffff",
  agentIdle: "#67738c",
  agentThinking: "#a5b4fc",
  agentReady: "#66b8cf",
  agentCompleted: "#4aad8b",
  agentPaused: "#77798a",
  agentFailed: "#e77c88",
  agentDismissed: "#77798a",
  stepIdle: "#67738c",
  stepReady: "#66b8cf",
  stepReview: "#a5b4fc",
  stepPassed: "#4aad8b",
  stepCapped: "#d5ac62",
  stepStopped: "#77798a",
  edgePass: "#4aad8b",
  edgeInterrupt: "#e77c88",
  edgeBuild: "#819fea",
};
const LIGHT: CommitteePalette = {
  table: "#edf1f8",
  head: "#687899",
  body: "#687899",
  bulb: "#ffffff",
  glint: "#ffffff",
  agentIdle: "#8591a6",
  agentThinking: "#6359bc",
  agentReady: "#357f9d",
  agentCompleted: "#268162",
  agentPaused: "#868391",
  agentFailed: "#bd4d60",
  agentDismissed: "#868391",
  stepIdle: "#8591a6",
  stepReady: "#357f9d",
  stepReview: "#6359bc",
  stepPassed: "#268162",
  stepCapped: "#a97726",
  stepStopped: "#868391",
  edgePass: "#268162",
  edgeInterrupt: "#bd4d60",
  edgeBuild: "#516fc0",
};
const STORAGE = "co-inference.committee-colors.v2";
const LEGACY = "co-inference.committee-colors.v1";
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

/** Preserve existing custom colors while making formerly coupled shapes independent. */
function readColors(): Partial<CommitteePalette> {
  try {
    const current = localStorage.getItem(STORAGE);
    const raw: unknown = JSON.parse(
      current ?? localStorage.getItem(LEGACY) ?? "{}",
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const values = raw as Record<string, unknown>;
    const migrated: Partial<CommitteePalette> = {};
    const legacyKeys: Partial<Record<CommitteeColor, string>> = {
      agentIdle: "idle",
      agentThinking: "thinking",
      agentReady: "ready",
      agentCompleted: "pass",
      agentPaused: "stopped",
      agentFailed: "interrupt",
      agentDismissed: "stopped",
      stepIdle: "idle",
      stepReady: "ready",
      stepReview: "thinking",
      stepPassed: "pass",
      stepCapped: "capped",
      stepStopped: "stopped",
      edgePass: "pass",
      edgeInterrupt: "interrupt",
      edgeBuild: "build",
    };
    for (const key of Object.keys(LABELS) as CommitteeColor[]) {
      const value =
        values[key] ??
        (current === null ? values[legacyKeys[key] ?? key] : undefined);
      if (hex(value)) migrated[key] = value;
    }
    return migrated;
  } catch {
    return {};
  }
}

export function useCommitteePalette() {
  const [overrides, setOverrides] = useState(readColors);
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === "dark",
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.dataset.theme === "dark"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  const update = (next: Partial<CommitteePalette>) => {
    setOverrides(next);
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next));
    } catch {
      /* Storage is optional. */
    }
  };
  return {
    palette: { ...(dark ? DARK : LIGHT), ...overrides },
    setColor: (key: CommitteeColor, value: string) => {
      if (hex(value)) update({ ...overrides, [key]: value });
    },
    reset: () => update({}),
  };
}

export function stepColor(status: string, palette: CommitteePalette): string {
  switch (status) {
    case "thinking":
    case "under-review":
      return palette.stepReview;
    case "ready":
      return palette.stepReady;
    case "passed":
      return palette.stepPassed;
    case "unresolved":
    case "force-passed":
      return palette.stepCapped;
    case "dismissed":
      return palette.stepStopped;
    default:
      return palette.stepIdle;
  }
}

export function agentColor(
  status: string,
  palette: CommitteePalette,
  reviewing: boolean,
): string {
  switch (status) {
    case "thinking":
    case "reviewing":
      return palette.agentThinking;
    case "completed":
      return reviewing ? palette.agentCompleted : palette.agentReady;
    case "paused":
      return palette.agentPaused;
    case "failed":
      return palette.agentFailed;
    case "dismissed":
      return palette.agentDismissed;
    default:
      return palette.agentIdle;
  }
}

export function CommitteeColorControls({
  palette,
  onColorChange,
  onReset,
}: {
  palette: CommitteePalette;
  onColorChange: (key: CommitteeColor, value: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [group, setGroup] = useState<ColorGroup>("Shapes");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) setPreview(details.reason === "trigger-hover");
        setOpen(next);
      }}
    >
      <Popover.Trigger
        openOnHover
        delay={160}
        closeDelay={240}
        type="button"
        aria-label="Table colors"
        onPointerDown={() => setPreview(false)}
        onKeyDown={() => setPreview(false)}
      >
        <LuPalette />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="committee-palette-positioner"
        >
          <Popover.Popup
            className="committee-palette-popup"
            aria-label="Table colors"
            initialFocus={preview ? false : undefined}
            finalFocus={preview ? false : undefined}
            onPointerDown={() => setPreview(false)}
            onKeyDown={() => setPreview(false)}
          >
            <strong>Table colors</strong>
            <div
              className="committee-color-groups"
              role="group"
              aria-label="Color categories"
            >
              {(Object.keys(GROUPS) as ColorGroup[]).map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={group === item}
                  onClick={() => setGroup(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="committee-color-grid">
              {(
                Object.entries(GROUPS[group]) as [CommitteeColor, string][]
              ).map(([key, label]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="color"
                    aria-label={`${label} color`}
                    value={palette[key]}
                    onChange={(event) => onColorChange(key, event.target.value)}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="committee-reset-colors"
              onClick={onReset}
            >
              <LuRotateCcw />
              Reset all colors
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
