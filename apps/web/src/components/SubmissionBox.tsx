import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useHoverMenuFocus } from "../shell/useHoverMenuFocus";
import { hostStorageKey } from "../desktop/context";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import {
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileZipOutlined,
  FolderOutlined,
  LinkOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { LuPlus, LuX } from "react-icons/lu";
import { useCapabilityDraft } from "../features/composer/capability-draft";
import { RegistryIndicator } from "../features/composer/RegistryIndicator";
import { useNavigationDismiss } from "../shell/useNavigationDismiss";
import {
  ATTACHMENT_LIMITS,
  type AttachmentSelectionKind,
  type ReadinessCheckId,
  type ReadinessReport,
  type ServerSettings,
  type ValidatedAttachment,
} from "@brainstorm-agentic/protocol";
import {
  blockedReadiness,
  errorMessage,
  getHealth,
  getSettings,
  validateAttachments,
} from "../api";
import { EnvironmentStatus } from "./EnvironmentStatus";
import { PaperclipIcon, SendIcon } from "./Icons";

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

/** Shared menu primitives own focus, keyboard navigation and viewport collision. */
function AttachmentPicker({ disabled, onSelect, triggerRef }: {
  readonly disabled: boolean;
  readonly onSelect: (kind: AttachmentSelectionKind) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const hoverFocus = useHoverMenuFocus();
  useNavigationDismiss(() => setOpen(false));
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <Menu.Root {...hoverFocus.rootProps} open={open} onOpenChange={(next, details) => { hoverFocus.onOpenChange(next, details); setOpen(next); }} modal={false}>
    <Menu.Trigger {...hoverFocus.triggerProps} openOnHover delay={160} closeDelay={240} ref={triggerRef} className="attach-trigger canvas-attach-trigger" aria-label="Attach from server" disabled={disabled}><LuPlus aria-hidden="true" /></Menu.Trigger>
    <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={10} collisionPadding={12} className="canvas-composer-positioner">
      <Menu.Popup {...hoverFocus.popupProps} className="canvas-attachment-menu" aria-label="Attach from server">
        <div className="canvas-menu-caption">Add research material</div>
        {PICKER_OPTIONS.map((option) => <Menu.Item key={option.kind} className="canvas-attachment-option" onClick={() => onSelect(option.kind)}><span className="canvas-attachment-icon">{option.icon}</span><span><strong>{option.label}</strong><small>{option.hint}</small></span></Menu.Item>)}
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

/**
 * The composer's draft, kept in sessionStorage: navigating into a run and
 * back unmounts this component, and a long prompt with attachments used to
 * vanish with it. Per tab, cleared on successful launch; a restored
 * attachment is still revalidated at submit like any other.
 */
const DRAFT_KEY = hostStorageKey("brainstorm-composer-draft");

interface ComposerDraft {
  readonly topic: string;
  readonly attachments: readonly ValidatedAttachment[];
}

function readDraft(): ComposerDraft | undefined {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as ComposerDraft;
    if (typeof parsed.topic !== "string" || !Array.isArray(parsed.attachments)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeDraft(draft: ComposerDraft): void {
  try {
    if (draft.topic.length === 0 && draft.attachments.length === 0) {
      sessionStorage.removeItem(DRAFT_KEY);
    } else {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }
  } catch {
    // Storage full or unavailable: the draft just does not survive.
  }
}

/**
 * The kind a bare path most plausibly is, for replaying a job's original
 * attachments (the record keeps paths only). Folders cannot be told from
 * files by name, so the caller probes "folder" first; a wrong guess here
 * simply comes back invalid and shows red for the user to fix.
 */
function guessAttachmentKind(path: string): AttachmentSelectionKind {
  if (/^https?:\/\//i.test(path)) return "web";
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".zip") return "zip";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  return "file";
}

export function SubmissionBox({
  active = true,
  onSubmit,
  onOpenSettings,
  readiness,
  onRecheckReadiness,
  onDiagnoseReadiness,
  prefill,
}: {
  readonly active?: boolean;
  readonly onSubmit: (
    topic: string,
    attachmentPaths: readonly string[],
    capabilityOverrides: Readonly<Record<string, boolean>>,
  ) => Promise<void>;
  readonly onOpenSettings: () => void;
  readonly readiness: ReadinessReport | null;
  readonly onRecheckReadiness: (checks?: readonly ReadinessCheckId[]) => void;
  readonly onDiagnoseReadiness: (check: ReadinessCheckId) => void;
  /**
   * A redo request: put this topic in the box and replay these attachment
   * paths (revalidated). The nonce distinguishes two redos of the same job.
   */
  readonly prefill?: {
    readonly topic: string;
    readonly attachmentPaths: readonly string[];
    readonly nonce: number;
  };
}) {
  const [value, setValue] = useState(() => readDraft()?.topic ?? "");
  /** A submission held until every required environment check is green. */
  const [heldSubmission, setHeldSubmission] = useState<{
    readonly topic: string;
    readonly attachmentPaths: readonly string[];
    readonly capabilityOverrides: Readonly<Record<string, boolean>>;
  } | null>(null);
  const [attachments, setAttachments] = useState<
    readonly ValidatedAttachment[]
  >(() => readDraft()?.attachments ?? []);
  // Attachment review shares managed positioning and keyboard behavior with
  // the other composer popovers; opening it never changes the draft.
  const [trayOpen, setTrayOpen] = useState(false);
  // Every keystroke and attachment change lands in the tab's draft, so
  // opening a run and coming back does not eat the composition. A successful
  // launch clears both states, which clears the draft with them.
  useEffect(() => {
    writeDraft({ topic: value, attachments });
  }, [value, attachments]);
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
  const capabilityDraft = useCapabilityDraft();
  const [registryConnected, setRegistryConnected] = useState(false);
  const [registryTarget, setRegistryTarget] = useState("Brain Registry");
  const [registryPage, setRegistryPage] = useState<string | undefined>();
  /** "brainstorm v0.11.0 (latest) · registry v0.1.0 · app v0.1.0" */
  const [registryVersionLine, setRegistryVersionLine] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const pastedRef = useRef(false);
  useNavigationDismiss(() => { setTrayOpen(false); });
  useEffect(() => {
    if (!active) { setTrayOpen(false); }
  }, [active]);
  useEffect(() => { if (attachments.length === 0) setTrayOpen(false); }, [attachments.length]);

  // A redo request from a job card: the topic lands in the box, the job's
  // original attachments are revalidated and re-attached — folders probed
  // first, since only the server can tell a folder from a file by path —
  // and the composer takes focus, ready to edit or launch. Keyed by the
  // nonce so redoing the same job twice replays twice.
  useEffect(() => {
    if (prefill === undefined) return;
    setValue(prefill.topic);
    setSelectionError(null);
    setAttachments([]);
    if (active) { ref.current?.focus(); ref.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }
    if (prefill.attachmentPaths.length === 0) return;
    let live = true;
    void (async () => {
      try {
        const paths = prefill.attachmentPaths.slice(
          0,
          ATTACHMENT_LIMITS.maxReferences,
        );
        const resolved = new Map<string, ValidatedAttachment>();
        const disk = paths.filter((path) => guessAttachmentKind(path) !== "web");
        const urls = paths.filter((path) => guessAttachmentKind(path) === "web");
        if (disk.length > 0) {
          const folders = await validateAttachments("folder", disk);
          for (const entry of folders.attachments) {
            if (entry.valid) resolved.set(entry.path, entry);
          }
          const rest = disk.filter((path) => !resolved.has(path));
          const byKind = new Map<AttachmentSelectionKind, string[]>();
          for (const path of rest) {
            const kind = guessAttachmentKind(path);
            byKind.set(kind, [...(byKind.get(kind) ?? []), path]);
          }
          for (const [kind, kindPaths] of byKind) {
            const result = await validateAttachments(kind, kindPaths);
            for (const entry of result.attachments) {
              resolved.set(entry.path, entry);
            }
          }
        }
        if (urls.length > 0) {
          const result = await validateAttachments("web", urls);
          for (const entry of result.attachments) {
            resolved.set(entry.path, entry);
          }
        }
        if (!live) return;
        // Original submission order, whatever order the probes resolved in.
        setAttachments(
          paths.flatMap((path) => {
            const entry = resolved.get(path);
            return entry !== undefined ? [entry] : [];
          }),
        );
      } catch (error) {
        if (live) setSelectionError(errorMessage(error));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  useLayoutEffect(() => {
    if (!active) return;
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
  }, [value, active]);

  useLayoutEffect(() => {
    if (!active) return;
    const element = ref.current;
    if (!element) return;
    let width = element.clientWidth;
    let heightLimit = Number.parseFloat(window.getComputedStyle(element).maxHeight) || MAX_HEIGHT_FALLBACK;
    const resize = () => {
      const nextWidth = element.clientWidth;
      const nextLimit = Number.parseFloat(window.getComputedStyle(element).maxHeight) || MAX_HEIGHT_FALLBACK;
      if (nextWidth === 0 || (nextWidth === width && nextLimit === heightLimit)) return;
      width = nextWidth;
      heightLimit = nextLimit;
      // Viewport changes can wrap an unchanged draft onto additional lines.
      // Measure only when available dimensions change; observing our own height
      // update must not loop or move the user's reading position or focus.
      const scrollTop = element.scrollTop;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, heightLimit)}px`;
      element.scrollTop = scrollTop;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [active]);

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
    if (!active) return;
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
  }, [settings?.contentRegistry.url, active]);

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
    capabilityOverrides: Readonly<Record<string, boolean>>,
  ): Promise<void> => {
    setSubmitting(true);
    setSubmitPhase("Starting pipeline…");
    try {
      await onSubmit(topic, attachmentPaths, capabilityOverrides);
      setValue("");
      setAttachments([]);
      setUrlDraft("");
      setUrlOpen(false);
      setHeldSubmission(null);
    } catch (error) {
      // A 409 with a readiness payload means the environment turned red
      // between our check and the server's: hold and wait it out.
      if (blockedReadiness(error) !== undefined) {
        setHeldSubmission({ topic, attachmentPaths, capabilityOverrides });
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
      const capabilityOverrides = { ...capabilityDraft };
      // The environment gate: while any required check is not green, hold
      // the submission and show the waiting card; it fires automatically
      // the moment the report turns ready.
      if (readiness !== null && !readiness.ready) {
        setHeldSubmission({ topic, attachmentPaths, capabilityOverrides });
        onRecheckReadiness();
        return;
      }
      await launch(topic, attachmentPaths, capabilityOverrides);
      return;
    } catch (error) {
      // Path validation happens here, before the parent receives a submit.
      // Keep the draft and show the failure so the user can retry deliberately.
      setSelectionError(errorMessage(error));
    } finally {
      setSubmitting(false);
      setSubmitPhase("");
    }
  };

  // Auto-fire the held submission once every required check is green.
  useEffect(() => {
    if (!active || heldSubmission === null || submitting) return;
    if (readiness === null || !readiness.ready) return;
    void launch(
      heldSubmission.topic,
      heldSubmission.attachmentPaths,
      heldSubmission.capabilityOverrides,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness?.ready, heldSubmission, submitting, active]);

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

  return (
    <div className="chatbox-stack canvas-composer-stack">
      <div className={`chatbox composer canvas-composer${value.length > 90 || value.includes("\n") ? " canvas-composer-expanded" : ""}`}>
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
              autoFocus={active}
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
                triggerRef={attachmentTriggerRef}
                disabled={
                  !active || submitting || heldSubmission !== null ||
                  attachments.length >=
                    ATTACHMENT_LIMITS.maxReferences
                }
                onSelect={openPicker}
              />
              {/* Hover previews the list; touch and keyboard retain explicit access. */}
              {attachments.length > 0 && (
                <Popover.Root open={trayOpen} onOpenChange={setTrayOpen}>
                  <Popover.Trigger
                    openOnHover delay={160} closeDelay={240}
                    type="button"
                    className={`ghost-btn attach-tray-btn${
                      attachments.some((item) => !item.valid) ? " has-invalid" : ""
                    }`}
                    aria-label={`${attachments.length} attachment${
                      attachments.length === 1 ? "" : "s"
                    } — review or remove`}
                    aria-expanded={trayOpen}
                  >
                    <PaperclipIcon />
                    <span className="attach-tray-count">{attachments.length}</span>
                  </Popover.Trigger>
                  <Popover.Portal><Popover.Positioner side="bottom" align="start" sideOffset={10} collisionPadding={12} className="canvas-composer-positioner"><Popover.Popup
                      className="canvas-attachments-popover"
                      role="dialog"
                      aria-label="attachments for the next run"
                    >
                      {attachments.map((attachment) => (
                        <div
                          key={attachment.path}
                          className={`attach-tray-row${attachment.valid ? "" : " invalid"}`}
                          title={attachment.valid ? attachment.path : attachment.reason}
                        >
                          <span className="attach-kind">{attachment.kind}</span>
                          <span className="attach-tray-name">{attachment.name}</span>
                          <span className="attach-meta">
                            {attachmentMeta(attachment)}
                          </span>
                          {!attachment.valid && (
                            <span className="attach-tray-invalid">invalid</span>
                          )}
                          <button
                            type="button"
                            className="attach-remove"
                            aria-label={`remove attachment ${attachment.path}`}
                            disabled={submitting || heldSubmission !== null}
                            onClick={() =>
                              setAttachments(
                                attachments.filter(
                                  (item) => item.path !== attachment.path,
                                ),
                              )
                            }
                          >
                            <LuX aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </Popover.Popup></Popover.Positioner></Popover.Portal>
                </Popover.Root>
              )}
            </div>
            <div className="composer-footer-right">
              <div className="canvas-composer-health">
                {active && <>
                  <RegistryIndicator connected={registryConnected} page={registryPage} target={registryTarget} versionLine={registryVersionLine} />
                  <EnvironmentStatus
                    showToolChecks={false}
                    readiness={readiness}
                    onRecheck={onRecheckReadiness}
                    onDiagnose={onDiagnoseReadiness}
                    onOpenSettings={onOpenSettings}
                  />
                </>}
              </div>
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
                <SendIcon size={16} />
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

      {active && pickerKind && (
        <Suspense fallback={<p className="canvas-composer-loading" role="status">Opening server files…</p>}>
          <ServerFileExplorer
            key={pickerKind}
            returnFocusRef={attachmentTriggerRef}
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
