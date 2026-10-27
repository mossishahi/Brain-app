import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { LibrarySection } from './routes';

const OPEN_DELAY = 160;
const CLOSE_DELAY = 240;
// Row menus are portaled by Base UI but belong to this same interaction surface.
const REGION = '#research-sidebar, #sidebar-history-trigger, #sidebar-trash-trigger, .library-menu-positioner';
const insideLibrary = (target: EventTarget | null) => target instanceof Element && !!target.closest(REGION);

/** Hover only previews a panel. Explicit activation can claim that preview without toggling it shut. */
export function useLibraryHover({ section, enabled, onOpen, onClose }: {
  section: LibrarySection | undefined;
  enabled: boolean;
  onOpen: (section: LibrarySection) => void;
  onClose: () => void;
}) {
  const current = useRef({ section, enabled, onOpen, onClose });
  current.current = { section, enabled, onOpen, onClose };
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpened = useRef<LibrarySection | null>(null);
  const pointerVisited = useRef(false);
  const clearOpen = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
    if (!current.current.section || !pointerVisited.current || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      hoverOpened.current = null;
      if (current.current.section) current.current.onClose();
    }, CLOSE_DELAY);
  }, []);

  const pointerEnter = useCallback((next: LibrarySection, event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse' || !current.current.enabled || !window.matchMedia('(any-hover: hover)').matches) return;
    pointerVisited.current = true;
    clearOpen();
    clearClose();
    if (current.current.section === next) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      if (!current.current.enabled) return;
      hoverOpened.current = next;
      current.current.onOpen(next);
    }, OPEN_DELAY);
  }, [clearOpen, clearClose]);
  const pointerLeave = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearOpen();
    if (!current.current.section) pointerVisited.current = false;
    if (!insideLibrary(event.relatedTarget)) scheduleClose();
  }, [clearOpen, scheduleClose]);
  const claimPreview = useCallback((next: LibrarySection) => {
    clearOpen();
    clearClose();
    const claimed = current.current.section === next && hoverOpened.current === next;
    hoverOpened.current = null;
    return claimed;
  }, [clearOpen, clearClose]);
  const cancelPending = useCallback(() => {
    clearOpen();
    clearClose();
    hoverOpened.current = null;
  }, [clearOpen, clearClose]);

  const open = section !== undefined;
  useEffect(() => {
    if (!open || !enabled) {
      clearOpen();
      clearClose();
      hoverOpened.current = null;
      pointerVisited.current = false;
      return;
    }
    // Native document boundaries also cover descendant portals, including moving
    // back from a row menu to the panel and crossing the gap beside the ribbon.
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      if (insideLibrary(event.target)) {
        pointerVisited.current = true;
        clearClose();
      }
      // Routed and keyboard-opened panels stay put until the pointer actually
      // visits their surface; incidental movement in the workspace is harmless.
      else scheduleClose();
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && insideLibrary(event.target) && !insideLibrary(event.relatedTarget)) scheduleClose();
    };
    document.addEventListener('pointerover', enter);
    document.addEventListener('pointerout', leave);
    return () => {
      document.removeEventListener('pointerover', enter);
      document.removeEventListener('pointerout', leave);
      clearClose();
    };
  }, [open, enabled, clearOpen, clearClose, scheduleClose]);
  useEffect(() => () => { clearOpen(); clearClose(); }, [clearOpen, clearClose]);

  return { pointerEnter, pointerLeave, claimPreview, cancelPending };
}
