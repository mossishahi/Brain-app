/**
 * "Tools and providers": the server's availability table (availability spec
 * Section 6). Full form in the settings drawer — one row per tool with state
 * icon, latency, last check, a probe button and a copy-log button; SearXNG
 * expands to its engines; below, the effective priority order per purpose
 * over the configured order; "re-check all" and the degraded-demotion toggle.
 * Compact form on the dashboard: one icon summarising the table, with the
 * rows in a popover.
 *
 * The table arrives from GET /api/availability, follows the dashboard
 * stream's "availability" announcements, and is refreshed after every probe,
 * every 30 s while the view is open, and every 3 s while the server reports
 * a probe in flight.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import type {
  AvailabilityReport,
  ServerSettings,
  ServerSettingsUpdate,
  ToolAvailability,
  ToolState,
} from "@brainstorm-agentic/protocol";
import { errorMessage, getAvailability, onAvailability, probeAvailability } from "../../api";
import { useNavigationDismiss } from "../../shell/useNavigationDismiss";
import { ButtonSpinner, CopyIcon } from "../Icons";
import { SettingsToggle } from "./SettingsToggle";
import {
  checkedLabel,
  chipTitle,
  formatLog,
  latencyLabel,
  orderChips,
  purposeLabel,
  relativeTime,
  stateIcon,
  summarizeAvailability,
  toolLabel,
} from "./availability-model";
import "./tools-and-providers.css";

const REFRESH_MS = 30_000;
const PROBING_REFRESH_MS = 3_000;
const COPIED_MS = 2_000;

/** Green check / amber check / red cross / grey dash. */
export function StateGlyph({ state, size = 14 }: { state: ToolState; size?: number }) {
  const icon = stateIcon(state);
  const frame = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  return (
    <span className={`tp-glyph tp-tone-${icon.tone}`} title={icon.label} data-kind={icon.kind}>
      {icon.kind === "check" && (
        <svg {...frame}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {icon.kind === "cross" && (
        <svg {...frame}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )}
      {icon.kind === "dash" && (
        <svg {...frame}>
          <path d="M6 12h12" />
        </svg>
      )}
    </span>
  );
}

function ToolsGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

interface AvailabilityState {
  readonly report: AvailabilityReport | null;
  readonly error: string | null;
  readonly now: number;
  /** Tool ids whose probe button was pressed and has not answered yet; "*" for re-check all. */
  readonly pending: ReadonlySet<string>;
  /** Tool ids whose probe button already answered once (it then shows the result icon). */
  readonly probed: ReadonlySet<string>;
  readonly rowErrors: Readonly<Record<string, string>>;
  readonly reload: () => void;
  readonly probe: (ids?: readonly string[]) => Promise<void>;
}

function useAvailability(): AvailabilityState {
  const [report, setReport] = useState<AvailabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [probed, setProbed] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    getAvailability().then(
      (next) => {
        if (!alive.current) return;
        setReport(next);
        setError(null);
        setNow(Date.now());
      },
      (failure: unknown) => {
        if (alive.current) setError(errorMessage(failure));
      },
    );
  }, []);

  useEffect(() => reload(), [reload]);

  // The dashboard stream announces every table change; polling below covers the rest.
  useEffect(
    () =>
      onAvailability((next) => {
        setReport(next);
        setError(null);
        setNow(Date.now());
      }),
    [],
  );

  const probing = report !== null && summarizeAvailability(report.tools).probing;
  useEffect(() => {
    const timer = window.setInterval(reload, probing ? PROBING_REFRESH_MS : REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload, probing]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(tick);
  }, []);

  const probe = useCallback(async (ids?: readonly string[]) => {
    const keys = ids ?? ["*"];
    setPending((current) => new Set([...current, ...keys]));
    setRowErrors((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
    try {
      const next = await probeAvailability(ids);
      if (!alive.current) return;
      setReport(next);
      setError(null);
      setNow(Date.now());
    } catch (failure: unknown) {
      if (!alive.current) return;
      const message = errorMessage(failure);
      setRowErrors((current) => {
        const next = { ...current };
        for (const key of keys) next[key] = message;
        return next;
      });
    } finally {
      if (alive.current) {
        setPending((current) => {
          const next = new Set(current);
          for (const key of keys) next.delete(key);
          return next;
        });
        setProbed((current) => new Set([...current, ...keys]));
      }
    }
  }, []);

  return { report, error, now, pending, probed, rowErrors, reload, probe };
}

function CopyLogButton({ tool, onFallback }: { tool: ToolAvailability; onFallback: (text: string | null) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const text = formatLog(tool.log);
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(text);
        onFallback(null);
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
        return;
      } catch {
        // Permission or insecure-context failures fall through to the text block.
      }
    }
    onFallback(text);
  };
  return (
    <button
      type="button"
      className="btn btn-small tp-copy"
      disabled={tool.log.length === 0}
      aria-label={`Copy the probe log of ${tool.label}`}
      title={tool.log.length === 0 ? "no probe log yet" : "copy the probe log"}
      onClick={() => void copy()}
    >
      {copied ? "copied" : <CopyIcon size={13} />}
    </button>
  );
}

function ToolRow({
  tool,
  depth,
  state,
}: {
  tool: ToolAvailability;
  depth: number;
  state: AvailabilityState;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const busy = state.pending.has(tool.id) || state.pending.has("*") || tool.probing === true;
  const answered = state.probed.has(tool.id) || state.probed.has("*");
  const icon = stateIcon(tool.state);
  const rowError = state.rowErrors[tool.id];
  const children = tool.children ?? [];
  const tooltip = [icon.label, tool.detail].filter((part): part is string => part !== undefined && part !== "").join(" — ");
  return (
    <li className={`tp-row${depth > 0 ? " tp-row-child" : ""}`} data-tool={tool.id} data-state={tool.state}>
      <div className="tp-row-main">
        <StateGlyph state={tool.state} />
        <span className="tp-label" title={tooltip}>
          {tool.label}
          {tool.keyPresent === false && tool.state === "needs-key" && <span className="tp-badge">no key</span>}
        </span>
        <span className="tp-latency">{latencyLabel(tool.latencyMs)}</span>
        <span className="tp-checked">{checkedLabel(tool.checkedAt, state.now)}</span>
        <button
          type="button"
          className={`btn btn-small tp-probe${answered && !busy ? ` tp-tone-${icon.tone}` : ""}`}
          disabled={busy}
          aria-label={`Probe ${tool.label}`}
          title={busy ? "probing…" : answered ? icon.label : "run the probe"}
          onClick={() => void state.probe([tool.id])}
        >
          {busy ? <ButtonSpinner size={12} /> : answered ? <StateGlyph state={tool.state} size={13} /> : "probe"}
        </button>
        <CopyLogButton tool={tool} onFallback={setFallback} />
        {children.length > 0 && (
          <button
            type="button"
            className="btn btn-small tp-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "▾" : "▸"} {children.length} engine{children.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {tool.detail && depth === 0 && <span className="tp-detail small dim">{tool.detail}</span>}
      {rowError && <span className="error-text small">{rowError}</span>}
      {fallback !== null && (
        <div className="tp-fallback">
          <span className="small dim">Clipboard unavailable here — select and copy the log:</span>
          <textarea
            className="tp-fallback-text"
            readOnly
            value={fallback}
            rows={Math.min(8, Math.max(2, tool.log.length))}
            aria-label={`Probe log of ${tool.label}`}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="btn btn-small tp-fallback-hide" onClick={() => setFallback(null)}>
            Hide
          </button>
        </div>
      )}
      {expanded && children.length > 0 && (
        <ul className="tp-rows tp-rows-children">
          {children.map((child) => (
            <ToolRow key={child.id} tool={child} depth={depth + 1} state={state} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ToolRows({ state, report }: { state: AvailabilityState; report: AvailabilityReport }) {
  if (report.tools.length === 0) return <p className="dim small">no tools to check</p>;
  return (
    <ul className="tp-rows">
      {report.tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} depth={0} state={state} />
      ))}
    </ul>
  );
}

function RecheckAll({ state }: { state: AvailabilityState }) {
  const busy = state.pending.has("*");
  return (
    <button
      type="button"
      className="btn btn-small"
      disabled={busy}
      onClick={() => void state.probe()}
    >
      {busy ? <ButtonSpinner size={12} /> : null}
      {busy ? " Re-checking…" : "Re-check all"}
    </button>
  );
}

function PurposeOrders({ report }: { report: AvailabilityReport }) {
  if (report.purposes.length === 0) return null;
  return (
    <div className="tp-purposes">
      <h4 className="settings-subheading">Priority order per purpose</h4>
      <span className="field-note">
        What a NEW run receives: the effective order (moved tools in amber, dropped tools struck
        through — hover for the reason) over the configured order in grey.
      </span>
      {report.purposes.map((order) => {
        const chips = orderChips(order);
        return (
          <div className="tp-purpose" key={order.purpose} data-purpose={order.purpose}>
            <span className="tp-purpose-name">{purposeLabel(order.purpose)}</span>
            <div className="tp-purpose-orders">
              <div className="tp-chips" aria-label={`${purposeLabel(order.purpose)}: effective order`}>
                {chips.length === 0 && <span className="dim small">no tool configured</span>}
                {chips.map((chip) => (
                  <span
                    key={`${chip.action}:${chip.id}`}
                    className={`tp-chip tp-chip-${chip.action}`}
                    title={chipTitle(chip)}
                    data-action={chip.action}
                  >
                    {toolLabel(chip.id, report.tools)}
                  </span>
                ))}
              </div>
              <div className="tp-chips tp-chips-configured" aria-label={`${purposeLabel(order.purpose)}: configured order`}>
                {order.configured.length === 0 && <span className="dim small">—</span>}
                {order.configured.map((id, index) => (
                  <span key={`${index}:${id}`} className="tp-chip tp-chip-configured" title="configured order">
                    {toolLabel(id, report.tools)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolsAndProvidersFull({
  onSave,
}: {
  onSave?: (patch: ServerSettingsUpdate) => Promise<ServerSettings | undefined>;
}) {
  const state = useAvailability();
  const [saving, setSaving] = useState(false);
  const { report } = state;
  if (report === null) {
    return state.error ? <p className="error-text">{state.error}</p> : <p className="dim small">loading the tool availability table…</p>;
  }
  const summary = summarizeAvailability(report.tools);
  return (
    <div className="tools-and-providers">
      <span className="field-note">
        Whether every search provider, paper index, model endpoint and host tool answers from this
        machine. The server checks them at start, after a key or toggle changes, and every 30
        minutes; new runs receive the resulting per-purpose order. Nothing here blocks a submission.
      </span>
      <div className="fact-row tp-toolbar">
        <span className="small">
          {summary.available} of {summary.total} available · table updated {relativeTime(report.updatedAt, state.now)}
          {summary.probing ? " · probing…" : ""}
        </span>
        <RecheckAll state={state} />
      </div>
      {state.error && <p className="error-text small">{state.error}</p>}
      {state.rowErrors["*"] && <p className="error-text small">{state.rowErrors["*"]}</p>}
      <ToolRows state={state} report={report} />
      {onSave !== undefined && (
        <SettingsToggle
          label="Move degraded tools behind the available ones"
          description="On: a tool that answered partially or with 429/503 is used after every available tool of the same purpose. Off: it keeps its configured place and is only flagged."
          checked={report.demoteDegraded}
          disabled={saving}
          onCheckedChange={(next) => {
            setSaving(true);
            const patch: ServerSettingsUpdate = { availability: { demoteDegraded: next } };
            void onSave(patch).finally(() => {
              setSaving(false);
              state.reload();
            });
          }}
        />
      )}
      <PurposeOrders report={report} />
    </div>
  );
}

function ToolsAndProvidersStrip() {
  const state = useAvailability();
  const [open, setOpen] = useState(false);
  useNavigationDismiss(() => setOpen(false));
  const { report } = state;
  if (report === null) return null;
  const summary = summarizeAvailability(report.tools);
  const toneClass =
    summary.probing || state.pending.size > 0
      ? "state-checking"
      : summary.tone === "ok"
        ? "state-ok"
        : summary.tone === "bad"
          ? "state-failed"
          : summary.tone === "warn"
            ? "state-warn"
            : "state-unknown";
  const text = `Tools and providers · ${summary.available} of ${summary.total} available`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        className={`env-icon tp-strip-icon ${toneClass}${open ? " env-icon-open" : ""}`}
        aria-label={text}
        data-tooltip={text}
      >
        <ToolsGlyph />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={10} collisionPadding={12} className="canvas-env-positioner">
          <Popover.Popup className="env-popover canvas-env-popover tp-popover" aria-label="Tools and providers">
            <div className="env-popover-head">
              <span className={`env-state-dot ${toneClass}`} aria-hidden />
              <span className="env-popover-title">Tools and providers</span>
              <span className="env-popover-state">
                {summary.available}/{summary.total} · {relativeTime(report.updatedAt, state.now)}
              </span>
              <Popover.Close className="canvas-env-close" aria-label="Close tools and providers">×</Popover.Close>
            </div>
            {state.error && <p className="error-text small">{state.error}</p>}
            {state.rowErrors["*"] && <p className="error-text small">{state.rowErrors["*"]}</p>}
            <div className="tp-strip-rows">
              <ToolRows state={state} report={report} />
            </div>
            <div className="env-popover-actions">
              <RecheckAll state={state} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The view. `compact` renders the dashboard strip (one icon with a popover);
 * otherwise the full settings section. `onSave` persists the demoteDegraded
 * toggle through PUT /api/settings and is only used by the full form.
 */
export function ToolsAndProviders({
  compact = false,
  onSave,
}: {
  compact?: boolean;
  onSave?: (patch: ServerSettingsUpdate) => Promise<ServerSettings | undefined>;
}): ReactNode {
  if (compact) return <ToolsAndProvidersStrip />;
  return <ToolsAndProvidersFull onSave={onSave} />;
}
