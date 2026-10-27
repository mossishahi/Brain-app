import { Component, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { LuX } from 'react-icons/lu';
import './quick-editor.css';

/** An optional editor must never take the rail or the research draft down with it. */
export class QuickEditorBoundary extends Component<{
  children: ReactNode;
  onClose: () => void;
  onConfigure: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Popover.Root open onOpenChange={next => { if (!next) this.props.onClose(); }}>
      <Popover.Portal><Popover.Positioner anchor={() => document.getElementById('canvas-settings-trigger')} side="right" align="end" sideOffset={12} collisionPadding={12} className="quick-editor-positioner">
        <Popover.Popup className="quick-editor" aria-label="Editor unavailable" finalFocus={() => document.getElementById('canvas-settings-trigger')}>
          <header><Popover.Title>Editor unavailable</Popover.Title><button type="button" aria-label="Close editor" onClick={this.props.onClose}><LuX /></button></header>
          <Popover.Description>This editor could not load. Your research remains in place. You can change this option in Settings.</Popover.Description>
          <footer><button type="button" onClick={this.props.onClose}>Close</button><button type="button" className="quick-editor-apply" onClick={this.props.onConfigure}>Configure in Settings…</button></footer>
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>;
  }
}
