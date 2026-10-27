import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { LuArrowLeft, LuChevronRight, LuLoaderCircle, LuSettings2 } from 'react-icons/lu';
import type { QuickControlItem, QuickControlSubmenu } from './types';
import { ToggleMark } from '../settings/SettingsToggle';
import { useHoverMenuFocus } from '../../shell/useHoverMenuFocus';
import './quick-controls.css';

export type { QuickControlItem, QuickControlSubmenu } from './types';

export interface QuickControlsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly QuickControlItem[];
  footer?: readonly QuickControlItem[];
  loading?: boolean;
  error?: string;
}

const DRILL_IN_QUERY = '(max-width: 640px), (pointer: coarse)';
function useDrillInMenu() {
  const [compact, setCompact] = useState(() => window.matchMedia(DRILL_IN_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(DRILL_IN_QUERY);
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return compact;
}

function RowContent({ item }: { item: QuickControlItem }) {
  const explanation = item.reason ?? item.description;
  return <>
    {item.icon && <span className="quick-control-icon" aria-hidden="true">{item.icon}</span>}
    <span className="quick-control-copy">
      <span className="quick-control-label">{item.label}</span>
      {explanation && <span className="quick-control-description">{explanation}</span>}
      {item.scope && <span className="quick-control-scope">{item.scope}</span>}
      {item.error && <span className="quick-control-error" role="status">{item.error}</span>}
    </span>
    {item.pending && <LuLoaderCircle className="quick-control-spinner" aria-label="Saving" />}
    {item.kind === 'toggle' ? <ToggleMark checked={item.checked} />
      : item.kind === 'choice' ? <span className="quick-control-choice" data-selected={item.selected || undefined} aria-hidden="true"><span /></span>
        : <>{item.value && <span className="quick-control-value" title={item.value}>{item.value}</span>}{item.kind === 'submenu' && <LuChevronRight className="quick-control-chevron" aria-hidden="true" />}</>}
  </>;
}

function ControlRow({ item }: { item: Exclude<QuickControlItem, QuickControlSubmenu> }) {
  const disabled = item.disabled || item.pending;
  const props = {
    className: 'quick-control-row',
    label: item.label,
    'data-control-id': item.id,
    'aria-label': item.label,
    'aria-busy': item.pending || undefined,
    'aria-description': [item.description, item.reason, item.scope, item.error].filter(Boolean).join('. ') || undefined,
    disabled,
  };
  if (item.kind === 'toggle') {
    // Menu semantics preserve arrow-key navigation; the visual affordance is a
    // pill switch throughout the application, never a checkbox square.
    return <Menu.CheckboxItem {...props} checked={item.checked} onCheckedChange={item.onChange} closeOnClick={false}><RowContent item={item} /></Menu.CheckboxItem>;
  }
  if (item.kind === 'choice') {
    return <Menu.Item {...props} role="menuitemradio" aria-checked={item.selected} closeOnClick={false} onClick={item.onSelect}><RowContent item={item} /></Menu.Item>;
  }
  return <Menu.Item {...props} closeOnClick={!item.keepOpen} onClick={item.onSelect}><RowContent item={item} /></Menu.Item>;
}

function DesktopRows({ items, hoverFocus }: { items: readonly QuickControlItem[]; hoverFocus: ReturnType<typeof useHoverMenuFocus> }) {
  return <>{items.map(item => item.kind === 'submenu'
    ? <Menu.SubmenuRoot {...hoverFocus.rootProps} key={item.id} closeParentOnEsc={false}>
      <Menu.SubmenuTrigger {...hoverFocus.triggerProps} openOnHover delay={160} closeDelay={240} className="quick-control-row" label={item.label} aria-label={item.label} data-control-id={item.id} disabled={item.disabled || item.pending}>
        <RowContent item={item} />
      </Menu.SubmenuTrigger>
      <Menu.Portal><Menu.Positioner side="right" align="start" sideOffset={6} collisionPadding={12} className="quick-controls-positioner">
        <Menu.Popup {...hoverFocus.popupProps} className="quick-controls-popup" aria-label={item.label}>
          <div className="quick-controls-heading">{item.label}</div>
          {item.contentDescription && <div className="quick-controls-context">{item.contentDescription}</div>}
          <DesktopRows items={item.children} hoverFocus={hoverFocus} />
        </Menu.Popup>
      </Menu.Positioner></Menu.Portal>
    </Menu.SubmenuRoot>
    : <ControlRow key={item.id} item={item} />)}</>;
}

/** One rail entry point; desktop submenus become in-place tiers on touch screens. */
export function QuickControls({ open, onOpenChange, items, footer, loading, error }: QuickControlsProps) {
  const drillIn = useDrillInMenu();
  const hoverFocus = useHoverMenuFocus();
  const [path, setPath] = useState<string[]>([]);
  const popup = useRef<HTMLDivElement>(null);
  const changeOpen = useRef(onOpenChange);
  const focusAfterDrill = useRef<string | null>(null);
  const previousMode = useRef(drillIn);
  useLayoutEffect(() => { changeOpen.current = onOpenChange; }, [onOpenChange]);
  useEffect(() => {
    if (!open || !hoverFocus.preview) return;
    // Base UI keeps an entered submenu open. A pointer-only preview instead
    // dismisses as one tree after leaving all its portals, allowing the same
    // short bridge delay between trigger, parent menu, and nested tiers.
    let closeTimer: number | undefined;
    const insideTree = (target: EventTarget | null) => target instanceof Element
      && target.closest('#canvas-settings-trigger, .quick-controls-positioner') !== null;
    const clearClose = () => {
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      closeTimer = undefined;
    };
    const visit = (target: EventTarget | null) => {
      if (insideTree(target)) clearClose();
      else if (closeTimer === undefined) closeTimer = window.setTimeout(() => changeOpen.current(false), 240);
    };
    const over = (event: PointerEvent) => { if (event.pointerType === 'mouse') visit(event.target); };
    const out = (event: PointerEvent) => { if (event.pointerType === 'mouse') visit(event.relatedTarget); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    return () => {
      clearClose();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
    };
  }, [open, hoverFocus.preview]);
  useEffect(() => {
    if (!open || previousMode.current !== drillIn) setPath([]);
    previousMode.current = drillIn;
  }, [open, drillIn]);

  // Resolve IDs against the current data, rather than retaining stale settings
  // objects while an asynchronous save or options request updates the catalog.
  let visibleItems = items;
  let current: QuickControlSubmenu | undefined;
  let validDepth = 0;
  for (const id of path) {
    const next = visibleItems.find((item): item is QuickControlSubmenu => item.kind === 'submenu' && item.id === id);
    if (!next) break;
    current = next;
    visibleItems = next.children;
    validDepth += 1;
  }
  const levelKey = path.slice(0, validDepth).join('/');
  useLayoutEffect(() => {
    const target = focusAfterDrill.current;
    if (!open || !drillIn || target === null) return;
    focusAfterDrill.current = null;
    const frame = window.requestAnimationFrame(() => {
      const rows = Array.from(popup.current?.querySelectorAll<HTMLElement>('[data-control-id]:not([aria-disabled="true"])') ?? []);
      const next = rows.find(row => row.dataset.controlId === target) ?? rows[0];
      next?.focus({ preventScroll: true });
      popup.current?.scrollTo({ top: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [levelKey, open, drillIn]);

  const enter = (item: QuickControlSubmenu) => {
    focusAfterDrill.current = '';
    setPath(previous => [...previous.slice(0, validDepth), item.id]);
  };
  const back = () => {
    focusAfterDrill.current = path[validDepth - 1] ?? '';
    setPath(previous => previous.slice(0, Math.max(0, validDepth - 1)));
  };

  return <Menu.Root {...hoverFocus.rootProps} open={open} modal={false} onOpenChange={(next, details) => {
    if (!next && drillIn && validDepth > 0 && details.reason === 'escape-key') {
      details.cancel();
      back();
      return;
    }
    hoverFocus.onOpenChange(next, details);
    onOpenChange(next);
  }}>
    <Menu.Trigger {...hoverFocus.triggerProps} openOnHover delay={160} closeDelay={240} id="canvas-settings-trigger" className="canvas-rail-button" aria-label="Open settings menu"><LuSettings2 /><span className="canvas-rail-label">Settings</span></Menu.Trigger>
    <Menu.Portal><Menu.Positioner side={drillIn ? 'top' : 'right'} align="end" sideOffset={12} collisionPadding={12} className="quick-controls-positioner">
      <Menu.Popup {...hoverFocus.popupProps} ref={popup} className="quick-controls-popup" aria-label="Workspace settings" data-drill-in={drillIn || undefined} onKeyDown={event => {
        hoverFocus.popupProps.onKeyDown();
        if (drillIn && validDepth > 0 && event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}>
        {drillIn && current ? <div className="quick-controls-navigation">
          <Menu.Item className="quick-controls-back" aria-label="Back" label="Back" closeOnClick={false} onClick={back}><LuArrowLeft aria-hidden="true" />Back</Menu.Item>
          <span>{current.label}</span>
        </div> : <div className="quick-controls-heading">Your workspace</div>}
        {drillIn && current?.contentDescription && <div className="quick-controls-context">{current.contentDescription}</div>}
        {loading && <div className="quick-controls-notice" role="status"><LuLoaderCircle className="quick-control-spinner" />Loading settings…</div>}
        {error && <div className="quick-controls-notice quick-control-error" role="status">{error}</div>}
        {drillIn ? <div key={levelKey} className="quick-controls-tier">
          {visibleItems.map(item => item.kind === 'submenu'
            ? <Menu.Item key={item.id} className="quick-control-row" label={item.label} aria-label={item.label} data-control-id={item.id} disabled={item.disabled || item.pending} closeOnClick={false} onClick={() => enter(item)} onKeyDown={event => {
              if (event.key === 'ArrowRight') { event.preventDefault(); enter(item); }
            }}><RowContent item={item} /></Menu.Item>
            : <ControlRow key={item.id} item={item} />)}
        </div> : <DesktopRows items={items} hoverFocus={hoverFocus} />}
        {(!drillIn || validDepth === 0) && footer && footer.length > 0 && <><Menu.Separator className="quick-controls-separator" />{drillIn ? footer.map(item => item.kind !== 'submenu' && <ControlRow key={item.id} item={item} />) : <DesktopRows items={footer} hoverFocus={hoverFocus} />}</>}
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}
