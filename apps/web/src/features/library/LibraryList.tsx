import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { Menu } from "@base-ui/react/menu";
import { useHoverMenuFocus } from "../../shell/useHoverMenuFocus";
import type { JobSummary } from "@brainstorm-agentic/protocol";
import { LuArrowLeft, LuArrowRight, LuCopy, LuDownload, LuEllipsis, LuPause, LuPlay, LuRotateCcw, LuSearch, LuSquare, LuTrash2, LuX } from "react-icons/lu";
import { cancelJob, errorMessage, getTrashedJobs, jobTraceUrl, pauseJob, resumeInterruptedJob, resumeJob, resumePausedJob, retryFailedJob, trashJob } from "../../api";
import { copyText } from "../../clipboard";
import { jobDot, jobStatusLine } from "../../format";
import { Dot } from "../../components/common";
import { RunScope } from "../../components/run-liveness";
import { historyMatches, historyPage, sameJobSummary } from "../composer/history";
import { refreshOverviewJobs, useOverviewConnection, useOverviewJobs } from "./WorkspaceOverview";
import type { LoadState } from "./overview-state";
import { libraryActions } from "./library-actions";
import type { LibrarySection } from "./types";
import "./library-content.css";

interface Props {
  readonly section: LibrarySection;
  readonly active: boolean;
  readonly focusSearch: boolean;
  readonly selectedJobId?: string;
  readonly onSelect: (jobId: string) => void;
  readonly onRedo: (job: JobSummary) => void;
}

const LibraryRow = memo(function LibraryRow({ job, selected, readOnly, menuOpen, setMenu, onSelect, onRedo }: {
  readonly job: JobSummary;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly menuOpen: boolean;
  readonly setMenu: (id: string | null) => void;
  readonly onSelect: Props["onSelect"];
  readonly onRedo: Props["onRedo"];
}) {
  const [confirming, setConfirming] = useState<"stop" | "trash" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const statusId = useId();
  const hoverFocus = useHoverMenuFocus();
  const title = job.title ?? job.topic;
  const allowed = libraryActions(job, readOnly);
  const canEdit = !readOnly && job.trashedAt === undefined;

  async function perform(label: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(label); setActionError(null); setNotice(null);
    try {
      await action();
      setConfirming(null);
      await refreshOverviewJobs();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally { setBusy(null); }
  }

  function select(event: MouseEvent<HTMLAnchorElement>) {
    // Preserve native links for modified clicks, the context menu and new tabs.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onSelect(job.jobId);
  }

  async function copyPrompt() {
    const copied = await copyText(job.topic);
    if (copied) { setNotice("Original prompt copied."); setActionError(null); }
    else setActionError("Your browser could not copy the prompt. Open the research to select its text.");
  }

  return <RunScope as="li" status={job.status} className="library-row">
    <div className="library-row-main">
      <a className="library-row-link" href={`#/jobs/${encodeURIComponent(job.jobId)}`} title={title} aria-label={`Open research: ${title}`} aria-current={selected ? "page" : undefined} aria-describedby={statusId} onClick={select}>
        <span className="library-row-title">{title}</span>
        <span className="library-row-meta" id={statusId}><Dot state={jobDot(job.status)} /><span className="library-row-status" title={jobStatusLine(job)}>{jobStatusLine(job)}</span><time dateTime={new Date(job.trashedAt ?? job.createdAt).toISOString()}>{new Date(job.trashedAt ?? job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></span>
      </a>
      {canEdit && <Menu.Root {...hoverFocus.rootProps} open={menuOpen} onOpenChange={(open, details) => { hoverFocus.onOpenChange(open, details); setMenu(open ? job.jobId : null); }} modal={false}>
        <Menu.Trigger {...hoverFocus.triggerProps} openOnHover delay={160} closeDelay={240} className="library-more" aria-label={`Actions for ${title}`} disabled={busy !== null}><LuEllipsis aria-hidden="true" /></Menu.Trigger>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="library-menu-positioner"><Menu.Popup {...hoverFocus.popupProps} className="library-action-menu" aria-label={`Actions for ${title}`}>
          {allowed.pause && <Menu.Item className="library-menu-item" onClick={() => void perform("Pausing…", () => pauseJob(job.jobId))}><LuPause />Pause run</Menu.Item>}
          {allowed.resume && <Menu.Item className="library-menu-item" onClick={() => void perform("Resuming…", () => job.status === "paused" ? resumePausedJob(job.jobId) : job.status === "credit-blocked" ? resumeJob(job.jobId) : resumeInterruptedJob(job.jobId))}><LuPlay />Resume run</Menu.Item>}
          {allowed.retry && <Menu.Item className="library-menu-item" onClick={() => void perform("Retrying…", () => retryFailedJob(job.jobId))}><LuRotateCcw />Retry failed run</Menu.Item>}
          <Menu.Item className="library-menu-item" onClick={() => onRedo(job)}><LuRotateCcw />Redo as new research</Menu.Item>
          <Menu.Item className="library-menu-item" onClick={() => void copyPrompt()}><LuCopy />Copy original prompt</Menu.Item>
          {allowed.download && <Menu.Item className="library-menu-item" nativeButton={false} render={<a href={jobTraceUrl(job.jobId)} download />}><LuDownload />Download run record</Menu.Item>}
          {(allowed.stop || allowed.trash) && <Menu.Separator className="library-menu-separator" />}
          {allowed.stop && <Menu.Item className="library-menu-item library-menu-danger" onClick={() => { setConfirming("stop"); setActionError(null); }}><LuSquare />Stop run</Menu.Item>}
          {allowed.trash && <Menu.Item className="library-menu-item" onClick={() => { setConfirming("trash"); setActionError(null); }}><LuTrash2 />Move to trash</Menu.Item>}
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root>}
    </div>
    {confirming && <div className="library-confirmation" role="group" aria-label={confirming === "stop" ? "Stop run confirmation" : "Move to trash confirmation"}>
      <p>{confirming === "stop" ? "Stop this run? It cannot continue afterwards." : "Move this run to trash? Its record stays readable."}</p>
      <div><button type="button" className="library-action-button" disabled={busy !== null} onClick={() => setConfirming(null)}>Keep run</button><button type="button" className={`library-action-button${confirming === "stop" ? " library-action-danger" : ""}`} disabled={busy !== null} onClick={() => void perform(confirming === "stop" ? "Stopping…" : "Moving…", () => confirming === "stop" ? cancelJob(job.jobId) : trashJob(job.jobId))}>{confirming === "stop" ? "Confirm stop" : "Confirm move"}</button></div>
    </div>}
    {busy && <p className="library-row-notice" role="status">{busy}</p>}
    {notice && !busy && <p className="library-row-notice" role="status">{notice}</p>}
    {actionError && <p className="library-row-error" role="alert">{actionError}</p>}
  </RunScope>;
}, (previous, next) => previous.selected === next.selected && previous.readOnly === next.readOnly && previous.menuOpen === next.menuOpen && previous.setMenu === next.setMenu && previous.onSelect === next.onSelect && previous.onRedo === next.onRedo && sameJobSummary(previous.job, next.job));

export function LibraryList({ section, active, focusSearch, selectedJobId, onSelect, onRedo }: Props) {
  const overview = useOverviewJobs(active && section === "history");
  const connected = useOverviewConnection(active && section === "history");
  const [trash, setTrash] = useState<LoadState<readonly JobSummary[]>>({ data: null, loading: false, error: null });
  const [queries, setQueries] = useState<Record<LibrarySection, string>>({ history: "", trash: "" });
  const [pages, setPages] = useState<Record<LibrarySection, number>>({ history: 0, trash: 0 });
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const firstOpen = useRef(true);
  const query = queries[section];
  const deferredQuery = useDeferredValue(query);
  const state = section === "history" ? overview : trash;

  const loadTrash = useCallback(async () => {
    const version = ++requestVersion.current;
    setTrash((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const jobs = await getTrashedJobs();
      if (version === requestVersion.current) setTrash({ data: jobs, loading: false, error: null });
    } catch (error) {
      if (version === requestVersion.current) setTrash((previous) => ({ ...previous, loading: false, error: errorMessage(error) }));
    }
  }, []);

  useEffect(() => {
    if (active && section === "trash") void loadTrash();
    return () => { requestVersion.current += 1; };
  }, [active, section, loadTrash]);
  useEffect(() => { setOpenMenu(null); }, [active, section]);
  useEffect(() => {
    if (!active || !firstOpen.current) return;
    if (!focusSearch) { firstOpen.current = false; return; }
    const frame = window.requestAnimationFrame(() => {
      firstOpen.current = false;
      const search = searchRef.current;
      if (!search) return;
      const focused = document.activeElement;
      const popup = search.closest("#research-sidebar");
      const trigger = document.getElementById(`sidebar-${section}-trigger`);
      // Lazy loading can finish after the user has returned to the workspace.
      // Complete the shell's initial focus only while that original target
      // still owns focus; never redirect typing from another input or control.
      if (focused === document.body || focused === document.documentElement || focused === popup || focused === trigger) {
        search.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, section, focusSearch]);

  const sorted = useMemo(() => [...(state.data ?? [])].sort((left, right) => section === "trash" ? (right.trashedAt ?? right.createdAt) - (left.trashedAt ?? left.createdAt) : right.createdAt - left.createdAt), [state.data, section]);
  const matches = useMemo(() => historyMatches(sorted, deferredQuery), [sorted, deferredQuery]);
  const page = historyPage(matches, pages[section]);
  const refresh = () => { if (section === "history") void refreshOverviewJobs(); else void loadTrash(); };
  const sectionTitle = section === "history" ? "history" : "trash";

  return <div className="library-content" data-section={section}>
    <div className="library-list-header">
      <div className="library-search"><LuSearch aria-hidden="true" /><input ref={searchRef} aria-label={section === "history" ? "Search research history" : "Search trash"} placeholder={section === "history" ? "Search your research…" : "Search trash…"} value={query} onChange={(event) => { setQueries((current) => ({ ...current, [section]: event.target.value })); setPages((current) => ({ ...current, [section]: 0 })); }} />{query && <button type="button" aria-label="Clear search" onClick={() => { setQueries((current) => ({ ...current, [section]: "" })); setPages((current) => ({ ...current, [section]: 0 })); }}><LuX aria-hidden="true" /></button>}</div>
      <div className="library-list-count" aria-live="polite"><span>{state.data === null ? (state.error ? "Not loaded" : "Loading…") : query ? `${matches.length.toLocaleString()} of ${state.data.length.toLocaleString()} runs` : `${state.data.length.toLocaleString()} ${state.data.length === 1 ? "run" : "runs"}`}</span><span>{section === "trash" ? "Read only" : state.loading ? "Refreshing…" : connected ? "Live" : "Reconnecting…"}</span></div>
      {state.error && <div className="library-load-error" role="alert"><p>Could not load {sectionTitle}. {state.error}</p><button type="button" className="library-action-button" disabled={state.loading} onClick={refresh} aria-label={`Retry loading ${sectionTitle}`}>Retry</button></div>}
    </div>
    <div className="library-scroll" aria-busy={state.loading || query !== deferredQuery}>
      {state.data === null && !state.error ? <p className="library-empty" role="status">Loading your {sectionTitle}…</p> : page.items.length > 0 ? <ul className="library-list" aria-label={section === "history" ? "Research history" : "Trashed research"}>{page.items.map((job) => <LibraryRow key={job.jobId} job={job} selected={job.jobId === selectedJobId} readOnly={section === "trash"} menuOpen={active && openMenu === job.jobId} setMenu={setOpenMenu} onSelect={onSelect} onRedo={onRedo} />)}</ul> : !state.error && <div className="library-empty"><p>{query ? "No matching research." : section === "trash" ? "Your trash is empty." : "Your research will appear here."}</p><span>{query ? "Try another word or clear your search." : section === "trash" ? "Moved runs stay readable here." : "Start with a question in the workspace."}</span></div>}
    </div>
    {page.pages > 1 && <nav className="library-pagination" aria-label={section === "history" ? "History pages" : "Trash pages"}><button type="button" aria-label="Previous" disabled={page.page === 0} onClick={() => setPages((current) => ({ ...current, [section]: page.page - 1 }))}><LuArrowLeft aria-hidden="true" /></button><span aria-live="polite">{page.start.toLocaleString()}–{page.end.toLocaleString()} of {matches.length.toLocaleString()}</span><button type="button" aria-label="Next" disabled={page.page >= page.pages - 1} onClick={() => setPages((current) => ({ ...current, [section]: page.page + 1 }))}><LuArrowRight aria-hidden="true" /></button></nav>}
  </div>;
}
