import { lazy, memo, Suspense, useEffect, useRef } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { JobSummary } from '@brainstorm-agentic/protocol';
import type { LibrarySection } from './routes';
import { ViewBoundary } from './ViewBoundary';
import './sidebar.css';

const LibraryList = memo(lazy(() => import('../features/library/LibraryList').then(module => ({ default: module.LibraryList }))));

type Props = {
  open: boolean; section: LibrarySection; selectedJobId?: string;
  focusSearch: boolean;
  autoFocus?: boolean;
  onClose: () => void;
  onSelect: (jobId: string) => void; onRedo: (job: JobSummary) => void;
};

/** One non-modal floating surface; dismissal never remounts the workspace or list. */
export function LibraryPanel({ open, section, selectedJobId, focusSearch, autoFocus = true, onClose, onSelect, onRedo }: Props) {
  const visited = useRef(open);
  if (open) visited.current = true;
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = true;
    if (!focusSearch) return;
    const frame = requestAnimationFrame(() => {
      const surface = panel.current;
      const focused = document.activeElement;
      if (surface?.contains(focused) || focused === document.body || focused === document.getElementById(`sidebar-${section}-trigger`)) {
        surface?.querySelector<HTMLInputElement>('input[aria-label^="Search"]')?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, section, focusSearch]);
  return <Dialog.Root open={open} modal={false}
    onOpenChange={(next, details) => {
      if (next) return;
      const target = details.reason === 'focus-out' ? (details.event as FocusEvent).relatedTarget : details.event.target;
      // These links/buttons own their navigation. Dismissing on pointerdown
      // would otherwise close the panel before their click toggles it open again.
      if ((details.reason === 'outside-press' || details.reason === 'focus-out') && target instanceof Element && target.closest('[data-library-navigation], .library-menu-positioner')) {
        details.cancel();
        return;
      }
      restoreFocus.current = details.reason !== 'outside-press' && details.reason !== 'focus-out';
      onClose();
    }}>
    <Dialog.Portal keepMounted>
      <Dialog.Popup ref={panel} id="research-sidebar" role="complementary" aria-label="Research library" className="library-panel"
        initialFocus={autoFocus ? () => focusSearch ? panel.current?.querySelector<HTMLInputElement>('input[aria-label^="Search"]') ?? panel.current : panel.current : false}
        finalFocus={() => {
          const focused = document.activeElement;
          if (!restoreFocus.current || (focused && focused !== document.body && focused !== document.documentElement && !panel.current?.contains(focused))) return false;
          return document.getElementById(`sidebar-${section}-trigger`) ?? false;
        }}>
        <div className="library-panel-content">
          {visited.current && <ViewBoundary><Suspense fallback={<p className="library-loading" role="status">Opening your library…</p>}>
            <LibraryList section={section} active={open} focusSearch={focusSearch} selectedJobId={selectedJobId} onSelect={onSelect} onRedo={onRedo} />
          </Suspense></ViewBoundary>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
