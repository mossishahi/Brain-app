/** Persistent canvas with a dismissible floating research library. */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import type { JobSummary, StageId } from '@brainstorm-agentic/protocol';
import { Landing } from './components/Landing';
import { UpdateToast } from './components/UpdateToast';
import { WorkspaceControls } from './components/quick-controls/WorkspaceControls';
import { BackgroundLayer, useAppearance } from './backgrounds';
import { WorkspaceOverview } from './features/library/WorkspaceOverview';
import type { PrefillRequest } from './features/library/types';
import { LibraryPanel } from './shell/LibraryPanel';
import { useLibraryHover } from './shell/useLibraryHover';
import { BrandWordmark } from './shell/BrandWordmark';
import { libraryNavigation } from './shell/navigation';
import { dismissTransientOnNavigation } from './shell/transient-navigation';
import { parseRoute, resolveRoute, routeHash, withPanel, selectJob, type LibrarySection, type Route } from './shell/routes';
import { ViewBoundary } from './shell/ViewBoundary';
import { LuSquarePen } from 'react-icons/lu';

const Dashboard = memo(lazy(() => import('./components/Dashboard').then(m => ({ default: m.Dashboard }))));
const SettingsDrawer = lazy(() => import('./components/SettingsDrawer').then(m => ({ default: m.SettingsDrawer })));
const PersistentLanding = memo(Landing);
const AmbientBackground = memo(BackgroundLayer);
function ViewLoading() { return <div className="canvas-loading" role="status"><span />Opening workspace…</div>; }

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const routeRef = useRef(route);
  const cancelLibraryHover = useRef<() => void>(() => {});
  routeRef.current = route;
  const isHome = route.view === 'home';
  const [landingVisited, setLandingVisited] = useState(isHome);
  const [headlineIntroComplete, setHeadlineIntroComplete] = useState(false);
  const finishHeadlineIntro = useCallback(() => setHeadlineIntroComplete(true), []);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefill, setPrefill] = useState<PrefillRequest>();
  const requestNumber = useRef(0);
  const lastPanel = useRef<LibrarySection>(route.panel ?? 'history');
  if (route.panel) lastPanel.current = route.panel;
  const [librarySearchFocus, setLibrarySearchFocus] = useState(() => !window.matchMedia('(pointer: coarse)').matches);
  const [libraryAutoFocus, setLibraryAutoFocus] = useState(true);
  const appearance = useAppearance();
  const theme = useMemo(() => ({
    algorithm: appearance.resolvedTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: { lineWidth: 0, lineWidthBold: 2, controlOutlineWidth: 0 },
  }), [appearance.resolvedTheme]);

  const navigate = useCallback((next: Route, { replace = false }: { replace?: boolean } = {}) => {
    if (!replace) cancelLibraryHover.current();
    routeRef.current = next;
    setRoute(next);
    const hash = routeHash(next);
    if (window.location.hash !== hash) {
      if (replace) history.replaceState(history.state, '', hash);
      else window.location.hash = hash;
    }
  }, []);
  useEffect(() => {
    const change = (event?: HashChangeEvent) => {
      cancelLibraryHover.current();
      const previous = event ? parseRoute(new URL(event.oldURL).hash) : routeRef.current;
      const next = resolveRoute(window.location.hash, routeRef.current);
      routeRef.current = next;
      setRoute(next);
      const canonical = routeHash(next);
      if (dismissTransientOnNavigation(previous, next)) setMenuOpen(false);
      if (canonical !== window.location.hash) history.replaceState(history.state, '', canonical);
    };
    change();
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => { if (isHome) setLandingVisited(true); }, [isHome]);
  const setPanel = useCallback((section: LibrarySection, focusSearch = !window.matchMedia('(pointer: coarse)').matches) => {
    setMenuOpen(false);
    setLibraryAutoFocus(true);
    setLibrarySearchFocus(focusSearch);
    navigate(withPanel(routeRef.current, section));
  }, [navigate]);
  const closePanel = useCallback(() => {
    cancelLibraryHover.current();
    navigate(withPanel(routeRef.current, undefined), { replace: !libraryAutoFocus });
  }, [navigate, libraryAutoFocus]);
  const closeHoveredPanel = useCallback(() => navigate(withPanel(routeRef.current, undefined), { replace: true }), [navigate]);
  const hoverPanel = useCallback((section: LibrarySection) => {
    setLibraryAutoFocus(false);
    setLibrarySearchFocus(false);
    // Previewing with the mouse must not add entries to the browser Back stack.
    navigate(withPanel(routeRef.current, section), { replace: true });
  }, [navigate]);
  const libraryHover = useLibraryHover({ section: route.panel, enabled: settingsSection === null, onOpen: hoverPanel, onClose: closeHoveredPanel });
  cancelLibraryHover.current = libraryHover.cancelPending;
  const togglePanel = useCallback((section: LibrarySection, focusSearch: boolean) => {
    const claimPreview = libraryHover.claimPreview(section);
    setMenuOpen(false);
    setLibraryAutoFocus(true);
    setLibrarySearchFocus(focusSearch);
    navigate(withPanel(routeRef.current, routeRef.current.panel === section && !claimPreview ? undefined : section));
  }, [navigate, libraryHover.claimPreview]);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && settingsSection === null && !document.querySelector('[role="dialog"]:not(#research-sidebar), [role="alertdialog"]')) {
        event.preventDefault();
        setPanel('history', true);
        document.querySelector<HTMLInputElement>('#research-sidebar input[aria-label^="Search"]')?.focus();
      }
    };
    window.addEventListener('keydown', search);
    return () => window.removeEventListener('keydown', search);
  }, [settingsSection, setPanel]);
  const mainRouteId = route.view === 'job' ? `job:${route.jobId}` : 'home';
  useEffect(() => { window.scrollTo(0, 0); }, [mainRouteId]);
  const openSettings = useCallback(() => setSettingsSection('connections'), []);
  const closeSettings = useCallback(() => setSettingsSection(null), []);
  const newResearch = useCallback(() => {
    navigate({ view: 'home' });
    window.requestAnimationFrame(() => {
      if (routeRef.current.view === 'home' && !routeRef.current.panel) {
        document.querySelector<HTMLTextAreaElement>('.canvas-home textarea')?.focus({ preventScroll: true });
      }
    });
  }, [navigate]);
  const selectResearch = useCallback((id: string) => {
    navigate(selectJob(routeRef.current, id));
  }, [navigate]);
  const selectResearchStage = useCallback((stage: StageId) => {
    const current = routeRef.current;
    if (current.view === 'job') navigate({ view: 'job', jobId: current.jobId, stage });
  }, [navigate]);
  const redo = useCallback((job: JobSummary) => {
    setPrefill({ topic: job.topic, attachmentPaths: job.attachments ?? [], nonce: ++requestNumber.current });
    newResearch();
  }, [newResearch]);
  const homeLink = routeHash({ view: 'home' });
  const followHome = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); newResearch();
  };

  return <ConfigProvider theme={theme}>
    <WorkspaceOverview active={isHome || route.panel === 'history'} readinessActive={settingsSection !== null} />
    <AmbientBackground subdued={route.view === 'job'} paused={route.view === 'job'} />
    <div className="canvas-shell">
      <a className="canvas-skip" href="#canvas-main" onClick={event => { event.preventDefault(); document.getElementById('canvas-main')?.focus(); }}>Skip to workspace</a>
      <nav className="canvas-rail" aria-label="Workspace">
        <a className="canvas-brand" href={homeLink} onClick={followHome} data-library-navigation aria-label="Go to co-inference home" title="co-inference"><span aria-hidden="true">co</span></a>
        <div className="canvas-rail-primary">
          <a href={homeLink} className={`canvas-rail-button ${isHome && !route.panel ? 'is-active' : ''}`} data-library-navigation aria-label="New research" title="New research" aria-current={isHome ? 'page' : undefined} onClick={followHome}><LuSquarePen /><span className="canvas-rail-label">New research</span></a>
          {libraryNavigation.map(item =>
            <button key={item.id} id={`sidebar-${item.id}-trigger`} type="button" className={`canvas-rail-button ${route.panel === item.id ? 'is-active' : ''}`} data-library-navigation aria-label={item.label} title={item.label} aria-expanded={route.panel === item.id} aria-controls="research-sidebar" onPointerEnter={(event) => libraryHover.pointerEnter(item.id, event)} onPointerLeave={libraryHover.pointerLeave} onClick={(event) => togglePanel(item.id, event.detail === 0 || !window.matchMedia('(pointer: coarse)').matches)}><item.icon /><span className="canvas-rail-label">{item.label}</span></button>)}
        </div>
        <div className="canvas-rail-bottom">
          <WorkspaceControls open={menuOpen} onOpenChange={setMenuOpen} onOpenSettings={setSettingsSection} />
          <span className="canvas-rail-monogram" title="co-inference research workspace" aria-hidden="true">co</span>
        </div>
      </nav>
      <LibraryPanel open={!!route.panel} section={route.panel ?? lastPanel.current} selectedJobId={route.view === 'job' ? route.jobId : undefined} focusSearch={librarySearchFocus} autoFocus={libraryAutoFocus} onClose={closePanel} onSelect={selectResearch} onRedo={redo} />
      <div className="canvas-content" id="canvas-main" tabIndex={-1}>
        <header className="canvas-topbar"><a className="canvas-home-link" href={homeLink} data-library-navigation onClick={followHome} aria-label="co-inference home"><BrandWordmark introReady={headlineIntroComplete} /></a>{route.view === 'job' && <button type="button" className="canvas-back" data-library-navigation onClick={() => setPanel('history')}>Research history</button>}</header>
        {(landingVisited || isHome) && <div hidden={!isHome}><ViewBoundary><PersistentLanding active={isHome} onIntroComplete={finishHeadlineIntro} onOpenSettings={openSettings} onSubmitted={selectResearch} prefillRequest={prefill} /></ViewBoundary></div>}
        {route.view === 'job' && <ViewBoundary key={route.jobId}><Suspense fallback={<ViewLoading />}><Dashboard key={route.jobId} jobId={route.jobId} initialStage={route.stage} onNavigateStage={selectResearchStage} onGoHome={newResearch} /></Suspense></ViewBoundary>}
      </div>
      {settingsSection !== null && <Suspense fallback={<ViewLoading />}><ViewBoundary><SettingsDrawer initialSection={settingsSection} onClose={closeSettings} /></ViewBoundary></Suspense>}
      <UpdateToast />
    </div>
  </ConfigProvider>;
}
