import {
  lazy,
  Suspense,
  useEffect,
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
  type ServerSettings,
  type ValidatedAttachment,
} from "@brainstorm-agentic/protocol";
import {
  errorMessage,
  getHealth,
  getSettings,
  validateAttachments,
} from "../api";
import { SendIcon } from "./Icons";

// Ant Design's directory tree is substantial; load it only when the user
// opens the server picker so the normal landing page stays small.
const ServerFileExplorer = lazy(() =>
  import("./ServerFileExplorer").then((module) => ({
    default: module.ServerFileExplorer,
  })),
);

const LINE_HEIGHT = 22;
const MAX_LINES = 6;

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
}: {
  readonly onSubmit: (
    topic: string,
    attachmentPaths: readonly string[],
  ) => Promise<void>;
  readonly onOpenSettings: () => void;
}) {
  const [value, setValue] = useState("");
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
  const [registryConnected, setRegistryConnected] = useState(false);
  const [registryTarget, setRegistryTarget] = useState("Brain Registry");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, LINE_HEIGHT * MAX_LINES)}px`;
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
        setRegistryConnected(health.contentRegistry.running);
        setRegistryTarget(
          registryHost(
            health.contentRegistry.url ?? settings?.contentRegistry.url,
          ),
        );
      } catch {
        if (!live) return;
        setRegistryConnected(false);
        setRegistryTarget(registryHost(settings?.contentRegistry.url));
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

  const send = async (): Promise<void> => {
    const topic = value.trim();
    if (
      !topic ||
      submitting ||
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
      setSubmitPhase("Starting pipeline…");
      await onSubmit(
        topic,
        checked.map((attachment) => attachment.path),
      );
      setValue("");
      setAttachments([]);
      setUrlDraft("");
      setUrlOpen(false);
    } catch {
      // The parent owns the server error; retain selections for retry.
    } finally {
      setSubmitting(false);
      setSubmitPhase("");
    }
  };

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
          disabled={submitting}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
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
              <button
                type="button"
                className="composer-model"
                title="Open model settings"
                aria-label={`Model settings: ${display.model}${display.profile ? `, ${display.profile} effort` : ""}`}
                onClick={onOpenSettings}
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
              <span
                className={`registry-indicator ${
                  registryConnected ? "connected" : "disconnected"
                }`}
                data-tooltip={
                  registryConnected
                    ? `connected to ${registryTarget}`
                    : `could not connect to ${registryTarget}`
                }
                aria-label={
                  registryConnected
                    ? `Connected to Brain Registry at ${registryTarget}`
                    : `Could not connect to Brain Registry at ${registryTarget}`
                }
                role="status"
                tabIndex={0}
              >
                <LuBrain aria-hidden />
              </span>
              <button
                type="button"
                className="send-btn"
                aria-label="send"
                disabled={
                  value.trim().length === 0 ||
                  submitting ||
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
