import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileZipOutlined,
  FolderOutlined,
  LinkOutlined,
  VideoCameraOutlined,
  DownOutlined,
} from "@ant-design/icons";
import { LuBrain } from "react-icons/lu";
import {
  ATTACHMENT_LIMITS,
  type AttachmentSelectionKind,
  type ModelOptionsResponse,
  type ReadinessCheckId,
  type ReadinessReport,
  type ServerSettings,
  type ValidatedAttachment,
} from "@brainstorm-agentic/protocol";
import {
  blockedReadiness,
  errorMessage,
  getHealth,
  getModelOptions,
  getSettings,
  putModelsByRoute,
  validateAttachments,
} from "../api";
import { EnvironmentStatus } from "./EnvironmentStatus";
import { SendIcon } from "./Icons";

// Ant Design's directory tree is substantial; load it only when the user
// opens the server picker so the normal landing page stays small.
const ServerFileExplorer = lazy(() =>
  import("./ServerFileExplorer").then((module) => ({
    default: module.ServerFileExplorer,
  })),
);

// Fallback matching the `.chatbox textarea` max-height in theme.css.
const MAX_HEIGHT_FALLBACK = 446;

const PICKER_OPTIONS: readonly {
  readonly kind: AttachmentSelectionKind;
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
}[] = [
  {
    kind: "file",
    label: "Files",
    hint: "Browse server files",
    icon: <FileOutlined />,
  },
  {
    kind: "folder",
    label: "Folder",
    hint: "Browse server folders",
    icon: <FolderOutlined />,
  },
  {
    kind: "zip",
    label: "ZIP archives",
    hint: "Validated before extraction",
    icon: <FileZipOutlined />,
  },
  {
    kind: "image",
    label: "Images",
    hint: "PNG, JPEG, WebP, …",
    icon: <FileImageOutlined />,
  },
  {
    kind: "video",
    label: "Videos",
    hint: "MP4, MOV, WebM, …",
    icon: <VideoCameraOutlined />,
  },
  {
    kind: "pdf",
    label: "PDF files",
    hint: "Header checked on server",
    icon: <FilePdfOutlined />,
  },
  {
    kind: "web",
    label: "Web URL",
    hint: "Checked from server host",
    icon: <LinkOutlined />,
  },
];

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentMeta(attachment: ValidatedAttachment): string {
  return [
    attachment.files !== undefined
      ? `${attachment.files} file${attachment.files === 1 ? "" : "s"}`
      : undefined,
    attachment.bytes !== undefined
      ? formatBytes(attachment.bytes)
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatModelName(value: string): string {
  return titleCase(
    value
      .replace(/^claude[-_]/i, "")
      .replace(/[-_](\d+)[-_](\d+)(?:[-_]\d{8})?$/i, " $1.$2"),
  );
}

function registryHost(url: string | undefined): string {
  if (!url) return "Brain Registry";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function registryPageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/, "/");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function providerLabel(
  provider: ServerSettings["llm"]["provider"] | undefined,
): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic API";
    case "claude-agent":
      return "Claude Agent SDK";
    case "offline":
      return "Offline (deterministic)";
    default:
      return "Provider";
  }
}

function modelDisplay(settings: ServerSettings | null): {
  model: string;
  profile?: string;
} {
  if (!settings) return { model: "Model" };
  if (settings.llm.provider === "offline") {
    return { model: "Offline" };
  }
  const configured = settings.llm.model?.trim();
  const model =
    configured && configured.length > 0
      ? formatModelName(configured)
      : settings.llm.provider === "claude-agent"
        ? "Claude default"
        : "Anthropic";
  const effort = settings.llm.agentSdk?.effort;
  return {
    model,
    ...(effort ? { profile: titleCase(effort) } : {}),
  };
}

/**
 * The attachment picker: a small trigger that fans its options out to the right.
 *
 * Hand-rolled rather than MUI's SpeedDial. That component brought
 * @mui/material and both emotion packages into the bundle for this one widget,
 * and most of its configuration here was spent overriding MUI's own defaults
 * (its 64px FAB assumption, its shadows, its colours) back to this app's
 * tokens. Plain buttons and a flex row express the same thing, react to the
 * theme through the same CSS variables as everything else, and cost nothing.
 *
 * What SpeedDial did give away for free, and is therefore written out here, is
 * the keyboard contract that role="menu" promises: arrow keys move between
 * options, Home/End jump to the ends, only the active option is a tab stop
 * (a roving tabindex — seven tab stops for one control is worse than none),
 * opening moves focus into the menu, and closing puts it back on the trigger.
 * Declaring the role without the behaviour is the worse of the two failures:
 * it tells a screen reader to expect a menu and then hands it a row of buttons.
 */
function AttachmentPicker({
  disabled,
  onSelect,
}: {
  readonly disabled: boolean;
  readonly onSelect: (kind: AttachmentSelectionKind) => void;
}) {
  const [open, setOpen] = useState(false);
  /** Which option is the single tab stop, and what focus follows on open. */
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set when the fan closes, so focus returns only for a real close. */
  const restoreFocus = useRef(false);

  const close = useCallback((returnFocus: boolean) => {
    restoreFocus.current = returnFocus;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // A pointer close must NOT pull focus back to the trigger: the user is
      // already on their way somewhere else.
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // A disabled trigger cannot be re-opened, so a fan left open when the box
  // becomes disabled would be unclosable. No focus return: nothing to focus.
  useEffect(() => {
    if (disabled) close(false);
  }, [disabled, close]);

  // Focus follows the fan in both directions. Closing returns it to the trigger
  // rather than dropping it on <body>, which is what strands a keyboard user —
  // and it must happen before the fan is hidden, or the browser blurs the
  // element out from under them.
  useEffect(() => {
    if (open) {
      options.current[active]?.focus();
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
    // `active` deliberately excluded: re-running on every arrow key would fight
    // the roving focus below, which already moves focus itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (to: number) => {
    const wrapped = (to + PICKER_OPTIONS.length) % PICKER_OPTIONS.length;
    setActive(wrapped);
    options.current[wrapped]?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(active + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(active - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(PICKER_OPTIONS.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        // Tabbing away is a legitimate exit, but it must not leave an expanded
        // menu behind claiming to own the focus that just left.
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="attach-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="attach-trigger"
        aria-label="Attach from server"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="attach-fan"
        disabled={disabled}
        onClick={() => {
          setActive(0);
          setOpen((previous) => !previous);
        }}
      >
        <span aria-hidden>+</span>
      </button>
      <div
        id="attach-fan"
        className={`attach-fan${open ? " attach-fan-open" : ""}`}
        role="menu"
        aria-label="Attach from server"
        // Only hidden while closed. Marking a subtree aria-hidden while it holds
        // focus is its own serious bug, which is why the close path moves focus
        // out first.
        aria-hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        {PICKER_OPTIONS.map((option, index) => (
          <button
            key={option.kind}
            type="button"
            role="menuitem"
            ref={(node) => {
              options.current[index] = node;
            }}
            className="attach-option"
            // The hint reaches keyboard and touch users through the app's own
            // tooltip (shown on :hover AND :focus-visible); `title` alone is
            // mouse-hover only, so it read as decoration to everyone else.
            data-tooltip={`${option.label} — ${option.hint}`}
            aria-label={`${option.label} — ${option.hint}`}
            // A roving tabindex: the fan is one tab stop, not seven, and while
            // it is closed it is none.
            tabIndex={open && index === active ? 0 : -1}
            onClick={() => {
              onSelect(option.kind);
              close(true);
            }}
          >
            {option.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SubmissionBox({
  onSubmit,
  onOpenSettings,
  readiness,
  onRecheckReadiness,
  onDiagnoseReadiness,
}: {
  readonly onSubmit: (
    topic: string,
    attachmentPaths: readonly string[],
  ) => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly readiness: ReadinessReport | null;
  readonly onRecheckReadiness: (checks?: readonly ReadinessCheckId[]) => void;
  readonly onDiagnoseReadiness: (check: ReadinessCheckId) => void;
}) {
  const [value, setValue] = useState("");
  /** A submission held until every required environment check is green. */
  const [heldSubmission, setHeldSubmission] = useState<{
    readonly topic: string;
    readonly attachmentPaths: readonly string[];
  } | null>(null);
  const [attachments, setAttachments] = useState<
    readonly ValidatedAttachment[]
  >([]);
  const [pickerKind, setPickerKind] = useState<
    Exclude<AttachmentSelectionKind, "web"> | null
  >(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [checkingUrl, setCheckingUrl] = useState(false);
  const [selectionError, setSelectionError] =
    useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState("");
  const [settings, setSettings] = useState<ServerSettings | null>(
    null,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] =
    useState<ModelOptionsResponse | null>(null);
  const [modelDraft, setModelDraft] = useState<Record<string, string>>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);
  const [registryConnected, setRegistryConnected] = useState(false);
  const [registryTarget, setRegistryTarget] = useState("Brain Registry");
  const [registryPage, setRegistryPage] = useState<string | undefined>();
  /** "brainstorm v0.11.0 (latest) · registry v0.1.0 · app v0.1.0" */
  const [registryVersionLine, setRegistryVersionLine] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const pastedRef = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The CSS max-height is authoritative (it also covers mobile styles);
    // the constant only guards against a missing computed value.
    const maxHeight =
      Number.parseFloat(window.getComputedStyle(element).maxHeight) ||
      MAX_HEIGHT_FALLBACK;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    if (pastedRef.current) {
      // A paste longer than the cap would leave the view scrolled to the
      // caret at the end, cutting the text off from the top. Anchor the view
      // to the FIRST line instead — the caret stays after the last word, and
      // the browser scrolls it back into view as soon as the user types.
      pastedRef.current = false;
      const anchorToStart = () => {
        if (ref.current === element) element.scrollTop = 0;
      };
      anchorToStart();
      // React restores the controlled textarea's selection during commit and
      // some browsers then scroll that end-caret into view after layout. Pin
      // the viewport again on the next two frames, after both operations.
      let secondFrame: number | undefined;
      const firstFrame = window.requestAnimationFrame(() => {
        anchorToStart();
        secondFrame = window.requestAnimationFrame(anchorToStart);
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        if (secondFrame !== undefined) {
          window.cancelAnimationFrame(secondFrame);
        }
      };
    } else if (element.scrollHeight <= maxHeight) {
      // The box grows downward and the beginning of the prompt stays in view;
      // the browser still scrolls the caret into view when typing past the cap.
      element.scrollTop = 0;
    }
  }, [value]);

  useEffect(() => {
    let live = true;
    const onSettingsUpdated = (event: Event): void => {
      const detail = (event as CustomEvent<ServerSettings>).detail;
      if (detail) setSettings(detail);
    };
    window.addEventListener(
      "brain-settings-updated",
      onSettingsUpdated,
    );
    void getSettings()
      .then((current) => {
        if (live) setSettings(current);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      window.removeEventListener(
        "brain-settings-updated",
        onSettingsUpdated,
      );
    };
  }, []);

  useEffect(() => {
    let live = true;
    const refresh = async (): Promise<void> => {
      try {
        const health = await getHealth();
        if (!live) return;
        const endpoint =
          health.contentRegistry.url ?? settings?.contentRegistry.url;
        const registry = health.contentRegistry;
        // Connected is strict: the server verified the registry live AND
        // resolved the bundle version new runs would use right now. A
        // reachable-but-unresolvable registry shows as disconnected — never
        // as a connection to an unknown or old version.
        const verified =
          registry.running && registry.effectiveVersion !== undefined;
        setRegistryConnected(verified);
        setRegistryTarget(registryHost(endpoint));
        setRegistryPage(registryPageUrl(endpoint));
        // Exactly what runs where, unambiguously labeled: the SKILLS bundle
        // version new runs use, the registry server's own software version,
        // and this app's own software version (the latter two are program
        // versions, not content versions).
        const parts = verified
          ? [
              `skills ${registry.bundle ?? "brainstorm"} v${registry.effectiveVersion}` +
                (registry.pinnedVersion ? " (pinned)" : " (latest)"),
              registry.serverVersion
                ? `registry server v${registry.serverVersion}`
                : undefined,
              `brain app v${health.version}`,
            ].filter((part): part is string => Boolean(part))
          : [];
        setRegistryVersionLine(parts.length > 0 ? parts.join(" · ") : undefined);
      } catch {
        if (!live) return;
        setRegistryConnected(false);
        setRegistryTarget(registryHost(settings?.contentRegistry.url));
        setRegistryPage(registryPageUrl(settings?.contentRegistry.url));
        setRegistryVersionLine(undefined);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [settings?.contentRegistry.url]);

  const addValidated = (
    items: readonly ValidatedAttachment[],
  ): void => {
    setAttachments((current) => {
      const byPath = new Map(
        current.map((item) => [item.path, item]),
      );
      for (const item of items) byPath.set(item.path, item);
      return [...byPath.values()];
    });
    setSelectionError(null);
  };

  const openPicker = (kind: AttachmentSelectionKind): void => {
    if (kind === "web") setUrlOpen(true);
    else setPickerKind(kind);
  };

  const addUrl = async (): Promise<void> => {
    const candidate = urlDraft.trim();
    if (!candidate || checkingUrl) return;
    if (attachments.length >= ATTACHMENT_LIMITS.maxReferences) {
      setSelectionError(
        `A job may contain at most ${ATTACHMENT_LIMITS.maxReferences} attachments.`,
      );
      return;
    }
    setCheckingUrl(true);
    setSelectionError(null);
    try {
      const response = await validateAttachments("web", [
        candidate,
      ]);
      const result = response.attachments[0];
      if (!result?.valid) {
        setSelectionError(
          result?.reason ?? "The URL is not available.",
        );
        return;
      }
      addValidated([result]);
      setUrlDraft("");
      setUrlOpen(false);
    } catch (error) {
      setSelectionError(errorMessage(error));
    } finally {
      setCheckingUrl(false);
    }
  };

  const revalidateAll = async (): Promise<
    readonly ValidatedAttachment[] | undefined
  > => {
    const grouped = new Map<AttachmentSelectionKind, string[]>();
    for (const attachment of attachments) {
      const paths = grouped.get(attachment.kind) ?? [];
      paths.push(attachment.path);
      grouped.set(attachment.kind, paths);
    }
    const checked = (
      await Promise.all(
        [...grouped.entries()].map(([kind, paths]) =>
          validateAttachments(kind, paths).then(
            (response) => response.attachments,
          ),
        ),
      )
    ).flat();
    setAttachments(checked);
    const failures = checked.filter((item) => !item.valid);
    if (failures.length > 0) {
      setSelectionError(
        `${failures.length} attachment${failures.length === 1 ? " is" : "s are"} no longer readable. Remove or reselect before launching.`,
      );
      return undefined;
    }
    return checked;
  };

  /** Fires the held/checked submission; clears the composer on success. */
  const launch = async (
    topic: string,
    attachmentPaths: readonly string[],
  ): Promise<void> => {
    setSubmitting(true);
    setSubmitPhase("Starting pipeline…");
    try {
      await onSubmit(topic, attachmentPaths);
      setValue("");
      setAttachments([]);
      setUrlDraft("");
      setUrlOpen(false);
      setHeldSubmission(null);
    } catch (error) {
      // A 409 with a readiness payload means the environment turned red
      // between our check and the server's: hold and wait it out.
      if (blockedReadiness(error) !== undefined) {
        setHeldSubmission({ topic, attachmentPaths });
      }
      // Any other server error is owned by the parent; retain selections.
    } finally {
      setSubmitting(false);
      setSubmitPhase("");
    }
  };

  const send = async (): Promise<void> => {
    const topic = value.trim();
    if (
      !topic ||
      submitting ||
      heldSubmission !== null ||
      attachments.some((item) => !item.valid)
    ) {
      return;
    }
    setSubmitting(true);
    setSubmitPhase("Rechecking server paths…");
    setSelectionError(null);
    try {
      const checked =
        attachments.length > 0
          ? await revalidateAll()
          : attachments;
      if (!checked) return;
      const attachmentPaths = checked.map((attachment) => attachment.path);
      // The environment gate: while any required check is not green, hold
      // the submission and show the waiting card; it fires automatically
      // the moment the report turns ready.
      if (readiness !== null && !readiness.ready) {
        setHeldSubmission({ topic, attachmentPaths });
        onRecheckReadiness();
        return;
      }
      await launch(topic, attachmentPaths);
      return;
    } catch {
      // The parent owns the server error; retain selections for retry.
    } finally {
      setSubmitting(false);
      setSubmitPhase("");
    }
  };

  // Auto-fire the held submission once every required check is green.
  useEffect(() => {
    if (heldSubmission === null || submitting) return;
    if (readiness === null || !readiness.ready) return;
    void launch(heldSubmission.topic, heldSubmission.attachmentPaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness?.ready, heldSubmission, submitting]);

  const onKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  const toggleModelMenu = async (): Promise<void> => {
    if (modelMenuOpen) {
      setModelMenuOpen(false);
      return;
    }
    setModelMenuOpen(true);
    setModelError(null);
    try {
      const options = await getModelOptions();
      setModelOptions(options);
      setModelDraft({ ...options.modelsByRoute });
    } catch (error) {
      setModelError(errorMessage(error));
    }
  };

  const saveModels = async (): Promise<void> => {
    if (savingModels) return;
    setSavingModels(true);
    setModelError(null);
    try {
      const updated = await putModelsByRoute({ modelsByRoute: modelDraft });
      setSettings(updated);
      window.dispatchEvent(
        new CustomEvent("brain-settings-updated", { detail: updated }),
      );
      setModelMenuOpen(false);
    } catch (error) {
      setModelError(errorMessage(error));
    } finally {
      setSavingModels(false);
    }
  };
  const display = modelDisplay(settings);

  return (
    <div className="chatbox-stack">
      <div className="chatbox composer">
        <textarea
          ref={ref}
          rows={1}
          placeholder="What do you want to think through?"
          aria-label="What do you want to think through?"
          value={value}
          disabled={submitting || heldSubmission !== null}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={() => {
            pastedRef.current = true;
          }}
        />

        <div className="attach-zone">
        {attachments.length > 0 && (
          <div className="attach-list">
            {attachments.map((attachment) => (
              <span
                key={attachment.path}
                className={`attach-chip ${attachment.valid ? "validated" : "invalid"}`}
                title={
                  attachment.valid
                    ? attachment.path
                    : attachment.reason
                }
              >
                <span className="attach-status">
                  {attachment.valid ? "validated" : "invalid"}
                </span>
                <span className="attach-kind">
                  {attachment.kind}
                </span>
                <span className="attach-chip-text">
                  {attachment.name}
                </span>
                <span className="attach-meta">
                  {attachmentMeta(attachment)}
                </span>
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`remove attachment ${attachment.path}`}
                  disabled={submitting}
                  onClick={() =>
                    setAttachments(
                      attachments.filter(
                        (item) =>
                          item.path !== attachment.path,
                      ),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {urlOpen && (
          <div className="attach-input-row">
            <input
              type="url"
              className="attach-input"
              placeholder="https://example.org/paper-or-page"
              aria-label="web URL attachment"
              value={urlDraft}
              disabled={submitting || checkingUrl}
              onChange={(event) =>
                setUrlDraft(event.target.value)
              }
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void addUrl();
                }
                if (event.key === "Escape") {
                  setUrlOpen(false);
                  setUrlDraft("");
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={
                urlDraft.trim().length === 0 ||
                submitting ||
                checkingUrl
              }
              onClick={() => void addUrl()}
            >
              {checkingUrl ? "Checking…" : "Check & attach"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={submitting || checkingUrl}
              onClick={() => {
                setUrlOpen(false);
                setUrlDraft("");
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {selectionError && (
          <p className="error-text attach-error">
            {selectionError}
          </p>
        )}
        {submitting && (
          <p
            className="attachment-submit-status"
            aria-live="polite"
          >
            {submitPhase}
          </p>
        )}

          <div className="composer-footer">
            <div className="composer-footer-left">
              <AttachmentPicker
                disabled={
                  submitting ||
                  attachments.length >=
                    ATTACHMENT_LIMITS.maxReferences
                }
                onSelect={openPicker}
              />
              {attachments.length > 0 && (
                <span className="attach-summary">
                  {attachments.length} attached
                </span>
              )}
            </div>
            <div className="composer-footer-right">
              <div className="model-picker">
                <button
                  type="button"
                  className="composer-model"
                  title="Choose the model per task type"
                  aria-haspopup="dialog"
                  aria-expanded={modelMenuOpen}
                  aria-label={`Models by task type: ${display.model}${display.profile ? `, ${display.profile} effort` : ""}`}
                  onClick={() => void toggleModelMenu()}
                >
                  <span className="composer-model-name">
                    {display.model}
                  </span>
                  {display.profile && (
                    <span className="composer-model-profile">
                      {display.profile}
                    </span>
                  )}
                  <DownOutlined aria-hidden />
                </button>
                {modelMenuOpen && (
                  <div
                    className="model-popover"
                    role="dialog"
                    aria-label="Models by task type"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setModelMenuOpen(false);
                    }}
                  >
                    <div className="model-popover-header">
                      <span className="model-popover-title">
                        Models by task type
                      </span>
                      <span className="model-popover-provider">
                        {providerLabel(
                          modelOptions?.provider ?? settings?.llm.provider,
                        )}
                      </span>
                    </div>
                    {modelError && (
                      <p className="error-text">{modelError}</p>
                    )}
                    {!modelOptions && !modelError && (
                      <p className="model-popover-hint">Loading…</p>
                    )}
                    {modelOptions?.provider === "offline" && (
                      <p className="model-popover-hint">
                        The offline provider is deterministic; model
                        selection does not apply.
                      </p>
                    )}
                    {modelOptions &&
                      modelOptions.provider !== "offline" &&
                      modelOptions.taskTypes.map((taskType) => {
                        const selected = modelDraft[taskType.id] ?? "";
                        const known =
                          selected.length === 0 ||
                          modelOptions.models.some(
                            (model) => model.id === selected,
                          );
                        return (
                          <label
                            key={taskType.id}
                            className="model-popover-row"
                            title={taskType.description}
                          >
                            <span className="model-popover-type">
                              {titleCase(taskType.id)}
                            </span>
                            <select
                              value={selected}
                              disabled={savingModels}
                              onChange={(event) =>
                                setModelDraft((current) => ({
                                  ...current,
                                  [taskType.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">
                                Default
                                {modelOptions.defaultModel
                                  ? ` (${formatModelName(modelOptions.defaultModel)})`
                                  : ""}
                              </option>
                              {!known && (
                                <option value={selected}>
                                  {formatModelName(selected)}
                                </option>
                              )}
                              {modelOptions.models.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                    <div className="model-popover-footer">
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setModelMenuOpen(false);
                          onOpenSettings();
                        }}
                      >
                        Provider settings…
                      </button>
                      <span className="model-popover-actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={savingModels}
                          onClick={() => setModelMenuOpen(false)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={
                            savingModels ||
                            !modelOptions ||
                            modelOptions.provider === "offline"
                          }
                          onClick={() => void saveModels()}
                        >
                          {savingModels ? "Saving…" : "Save"}
                        </button>
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <a
                className={`registry-indicator ${
                  registryConnected ? "connected" : "disconnected"
                }`}
                href={registryPage}
                target="_blank"
                rel="noreferrer"
                data-tooltip={
                  registryConnected
                    ? `connected to ${registryTarget}` +
                      (registryVersionLine ? ` — ${registryVersionLine}` : "")
                    : `not connected to ${registryTarget} — the registry could not be verified just now (no stale connection is shown)`
                }
                aria-label={
                  registryConnected
                    ? `Connected to Brain Registry at ${registryTarget}` +
                      (registryVersionLine ? ` (${registryVersionLine})` : "")
                    : `Not connected to Brain Registry at ${registryTarget}: the registry could not be verified just now`
                }
                onClick={(event) => {
                  if (!registryPage) event.preventDefault();
                }}
              >
                <LuBrain aria-hidden />
              </a>
              <EnvironmentStatus
                readiness={readiness}
                onRecheck={onRecheckReadiness}
                onDiagnose={onDiagnoseReadiness}
                onOpenSettings={onOpenSettings}
              />
              <button
                type="button"
                className="send-btn"
                aria-label="send"
                disabled={
                  value.trim().length === 0 ||
                  submitting ||
                  heldSubmission !== null ||
                  attachments.some((item) => !item.valid)
                }
                onClick={() => void send()}
              >
                <SendIcon size={18} />
              </button>
            </div>
          </div>
      </div>
      </div>

      {heldSubmission && (
        <div className="waiting-card" role="status" aria-live="polite">
          <div className="waiting-head">
            <span className="dot dot-warn pulse" aria-hidden />
            <span className="waiting-title">Preparing the environment</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => onRecheckReadiness()}
            >
              Run checks again
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setHeldSubmission(null)}
            >
              Cancel
            </button>
          </div>
          <p className="waiting-lead">
            Your run starts automatically when every check below is green.
          </p>
          <ul className="waiting-checks">
            {(readiness?.checks ?? [])
              .filter((check) => check.required && check.state !== "skipped")
              .map((check) => (
                <li
                  key={check.id}
                  className={`waiting-check waiting-${check.state}`}
                >
                  <span
                    className={`dot ${
                      check.state === "ok"
                        ? "dot-ok"
                        : check.state === "failed"
                          ? "dot-bad"
                          : check.state === "checking"
                            ? "dot-warn pulse"
                            : "dot-dim"
                    }`}
                    aria-hidden
                  />
                  <span className="waiting-check-label">{check.label}</span>
                  <span className="waiting-check-message">
                    {check.message ??
                      (check.state === "unknown" ? "not checked yet" : "")}
                  </span>
                  {check.state === "failed" && check.advice && (
                    <span className="waiting-check-advice">{check.advice}</span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {pickerKind && (
        <Suspense fallback={null}>
          <ServerFileExplorer
            key={pickerKind}
            kind={pickerKind}
            onClose={() => setPickerKind(null)}
            onAttach={(items) => {
              if (
                attachments.length + items.length >
                ATTACHMENT_LIMITS.maxReferences
              ) {
                setSelectionError(
                  `A job may contain at most ${ATTACHMENT_LIMITS.maxReferences} attachments.`,
                );
                return;
              }
              addValidated(items);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
