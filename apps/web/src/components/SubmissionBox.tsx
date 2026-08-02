import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode } from "react";
import SpeedDial from "@mui/material/SpeedDial";
import SpeedDialAction from "@mui/material/SpeedDialAction";
import SpeedDialIcon from "@mui/material/SpeedDialIcon";
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

function AttachmentSpeedDial({
  disabled,
  onSelect,
}: {
  readonly disabled: boolean;
  readonly onSelect: (kind: AttachmentSelectionKind) => void;
}) {
  return (
    <SpeedDial
      ariaLabel="Attach from server"
      direction="right"
      icon={<SpeedDialIcon />}
      FabProps={{ size: "small", disabled }}
      sx={{
        position: "relative",
        display: "inline-flex",
        zIndex: 12,
        "& .MuiSpeedDial-fab": {
          width: 30,
          height: 30,
          minHeight: 30,
          color: "var(--text)",
          backgroundColor: "transparent",
          boxShadow: "none",
          "&:hover": {
            color: "var(--accent)",
            backgroundColor:
              "color-mix(in srgb, var(--text) 6%, transparent)",
            boxShadow: "none",
          },
        },
        "& .MuiSpeedDial-actions": {
          // MUI assumes a 64px default FAB and compensates with -32px.
          // Our 30px FAB needs no negative overlap compensation.
          marginLeft: 0,
          paddingLeft: "6px",
          gap: 0,
        },
      }}
    >
      {PICKER_OPTIONS.map((option) => (
        <SpeedDialAction
          key={option.kind}
          icon={option.icon}
          slotProps={{
            fab: {
              "aria-label": option.label,
              sx: {
                width: 28,
                height: 28,
                minHeight: 28,
                margin: "2px",
                color: "var(--text-dim)",
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "none",
                fontSize: 13,
                "&:hover": {
                  color: "var(--accent)",
                  backgroundColor: "var(--surface)",
                  borderColor: "var(--accent)",
                  boxShadow: "none",
                },
              },
            },
            tooltip: {
              title: `${option.label} — ${option.hint}`,
              placement: "top",
            },
          }}
          onClick={() => onSelect(option.kind)}
        />
      ))}
    </SpeedDial>
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
        setRegistryConnected(health.contentRegistry.running);
        setRegistryTarget(registryHost(endpoint));
        setRegistryPage(registryPageUrl(endpoint));
        // Exactly what runs where: the skills bundle version new runs use,
        // the registry server's own version, and this app's version.
        const registry = health.contentRegistry;
        const parts = [
          registry.effectiveVersion
            ? `${registry.bundle ?? "brainstorm"} v${registry.effectiveVersion}` +
              (registry.pinnedVersion ? " (pinned)" : " (latest)")
            : undefined,
          registry.serverVersion ? `registry v${registry.serverVersion}` : undefined,
          `app v${health.version}`,
        ].filter((part): part is string => Boolean(part));
        setRegistryVersionLine(parts.join(" · "));
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
              <AttachmentSpeedDial
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
                    : `could not connect to ${registryTarget}`
                }
                aria-label={
                  registryConnected
                    ? `Connected to Brain Registry at ${registryTarget}` +
                      (registryVersionLine ? ` (${registryVersionLine})` : "")
                    : `Could not connect to Brain Registry at ${registryTarget}`
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
